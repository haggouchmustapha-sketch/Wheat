import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Windows code signing, from the build side.
 *
 * Wheat carries **two independent signature systems** and this module is only
 * the first of them:
 *
 *   Windows Authenticode  proves *to Windows* who published this executable.
 *                         Without it Windows says "Unknown publisher", and on
 *                         Windows 11 Smart App Control blocks unsigned files
 *                         outright.
 *
 *   Wheat update signature (Ed25519, `scripts/lib/releaseManifest.mjs`)
 *                         proves *to Wheat* that a release came from Wheat.
 *
 * They answer different questions and neither replaces the other. Nothing here
 * may weaken the Ed25519 manifest signature, and the Ed25519 side must never be
 * asked to vouch for publisher identity.
 *
 * ## One publisher, both editions
 *
 * Standard and Lightweight are one product. The signing configuration is
 * composed here, once, and `editionBuilderConfig` merges it into both editions'
 * electron-builder configuration — so the two installers can only ever carry the
 * same publisher identity, and SmartScreen publisher reputation accumulates
 * across both rather than being split in half.
 *
 * ## Credentials
 *
 * Nothing in this file holds a certificate, a password or a token. Every secret
 * is read from the environment at build time and never written to a config
 * file, a log line or a release artifact. `.gitignore` already refuses
 * `*.pfx`, `*.p12`, `*.pem` and `*.key`.
 *
 * See `docs/wheat-code-signing.md`.
 */

/**
 * `off`       Unsigned. The default, and what every ordinary `npm run build`
 *             does: a developer must not need the production key to rebuild.
 * `signtool`  Authenticode via signtool.exe, with the private key held either
 *             in a hardware token / HSM surfaced through the Windows
 *             certificate store (the CA/Browser Forum has required hardware key
 *             storage for publicly trusted code signing certificates since
 *             June 2023) or, for a test certificate, in a PFX file.
 * `azure`     Azure Artifact Signing (formerly Trusted Signing). No key ever
 *             exists locally; the build authenticates to Microsoft Entra ID and
 *             the service signs.
 */
export const WHEAT_SIGNING_MODES = ["off", "signtool", "azure"];

/** RFC 3161 timestamp authority, so signatures outlive the certificate. */
export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

/**
 * SHA-256 only.
 *
 * electron-builder still defaults to `["sha1", "sha256"]` for compatibility with
 * Windows 7 and earlier. Wheat requires Windows 10, SHA-1 Authenticode has not
 * been trusted for years, and a dual signature doubles both the signing
 * operations and, on a metered signing service, their cost.
 */
export const SIGNING_HASH_ALGORITHMS = ["sha256"];

/**
 * Third-party binary trees Wheat packages but does not author.
 *
 * `resources/paddleocr/runtime` is a portable CPython installation: 53 `.exe`
 * files including `python.exe`, which carries a valid Authenticode signature
 * from the Python Software Foundation. electron-builder hands *every* packaged
 * `.exe` to the signer by default, so without this exclusion a Standard build
 * would strip the PSF's signature off Python and replace it with Wheat's — and
 * would spend 53 extra signing operations doing it.
 *
 * Wheat signs the program it wrote and ships: `Wheat.exe`, the elevation helper
 * it invokes, the installer and the uninstaller. The recognition runtime is
 * packaged payload and keeps whatever signatures its own publishers gave it.
 */
export const VENDOR_BINARY_TREES = ["resources/paddleocr"];

/**
 * The publisher identity, and the one place it is named.
 *
 * Passed to electron-builder as `publisherName` so the NSIS installer records
 * the same publisher the certificate carries. When it is unset, electron-builder
 * derives it from the certificate's common name, which is also correct — this
 * exists so a signing service whose certificate subject differs from the display
 * name Wheat wants can state it explicitly.
 */
function publisherName(env) {
  const value = env.WHEAT_SIGNING_PUBLISHER?.trim();
  return value || null;
}

/**
 * Decides how this build signs, from the environment alone.
 *
 * Returns the mode plus a human-readable account of *why*, which the release
 * report prints. It never returns a secret: `detail` names which variable
 * supplied the credential, never its value.
 */
export function resolveSigningMode(env = process.env) {
  const requested = (env.WHEAT_SIGNING_MODE ?? "off").trim().toLowerCase();
  if (!WHEAT_SIGNING_MODES.includes(requested)) {
    throw new Error(
      `WHEAT_SIGNING_MODE must be one of ${WHEAT_SIGNING_MODES.join(", ")}; received "${env.WHEAT_SIGNING_MODE}".`,
    );
  }

  if (requested === "off") {
    return { mode: "off", detail: "WHEAT_SIGNING_MODE is off (or unset): this build is not Authenticode signed." };
  }

  if (requested === "signtool") {
    const certificateFile = env.WHEAT_SIGNING_CERTIFICATE_FILE?.trim();
    const subject = env.WHEAT_SIGNING_CERTIFICATE_SUBJECT?.trim();
    const sha1 = env.WHEAT_SIGNING_CERTIFICATE_SHA1?.trim();
    const supplied = [
      certificateFile && "WHEAT_SIGNING_CERTIFICATE_FILE",
      subject && "WHEAT_SIGNING_CERTIFICATE_SUBJECT",
      sha1 && "WHEAT_SIGNING_CERTIFICATE_SHA1",
    ].filter(Boolean);
    if (supplied.length === 0) {
      throw new Error(
        "WHEAT_SIGNING_MODE=signtool needs a certificate: set WHEAT_SIGNING_CERTIFICATE_SUBJECT or " +
        "WHEAT_SIGNING_CERTIFICATE_SHA1 to select one from the Windows certificate store (the normal case for a " +
        "hardware token or HSM), or WHEAT_SIGNING_CERTIFICATE_FILE for a PFX. See docs/wheat-code-signing.md.",
      );
    }
    if (supplied.length > 1) {
      throw new Error(`Set exactly one of ${supplied.join(", ")}; they select different certificates.`);
    }
    if (certificateFile && !fs.existsSync(certificateFile)) {
      throw new Error(`WHEAT_SIGNING_CERTIFICATE_FILE points at ${certificateFile}, which does not exist.`);
    }
    return { mode: "signtool", detail: `signtool.exe, certificate from ${supplied[0]}` };
  }

  const missing = ["WHEAT_SIGNING_AZURE_ENDPOINT", "WHEAT_SIGNING_AZURE_ACCOUNT", "WHEAT_SIGNING_AZURE_PROFILE"]
    .filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`WHEAT_SIGNING_MODE=azure needs ${missing.join(", ")}. See docs/wheat-code-signing.md.`);
  }
  if (!publisherName(env)) {
    // electron-builder requires it for Azure: there is no local certificate to
    // read a common name out of.
    throw new Error("WHEAT_SIGNING_MODE=azure needs WHEAT_SIGNING_PUBLISHER, the publisher name on the certificate profile.");
  }
  return { mode: "azure", detail: `Azure Artifact Signing, profile from WHEAT_SIGNING_AZURE_PROFILE` };
}

/**
 * Every `.exe` inside a packaged third-party tree, by file name.
 *
 * electron-builder's `signExts` matches with `String.endsWith` against the whole
 * path, so a bare file name excludes that file wherever it is copied to. The
 * list is computed from the tree on disk rather than written out, so a PaddleOCR
 * runtime that gains an executable is covered without anybody remembering to
 * come back here. `tests/wheat-code-signing.spec.cjs` asserts the coverage.
 */
export function vendorBinaryNames(root, trees = VENDOR_BINARY_TREES) {
  const names = new Set();
  for (const tree of trees) {
    const base = path.join(root, tree);
    if (!fs.existsSync(base)) continue;
    for (const file of walkFiles(base)) {
      if (file.toLowerCase().endsWith(".exe")) names.add(path.basename(file));
    }
  }
  return [...names].sort();
}

function* walkFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * The `win` configuration fragment for this build's signing mode.
 *
 * Merged into both editions by `editionBuilderConfig`, which is what guarantees
 * one publisher identity for the whole product family.
 */
export function signingBuilderOptions(root, env = process.env) {
  const { mode } = resolveSigningMode(env);

  if (mode === "off") {
    // Explicit, not merely absent: a stray CSC_LINK in the environment must not
    // be able to sign a development build with something nobody chose.
    // `signExecutable` skips signing while leaving resedit (icon, version
    // metadata, execution level) applied, which `signAndEditExecutable` would
    // not.
    return { signExecutable: false };
  }

  const publisher = publisherName(env);
  const signExts = vendorBinaryNames(root).map((name) => `!${name}`);

  if (mode === "azure") {
    return {
      signExts,
      azureSignOptions: {
        publisherName: publisher,
        endpoint: env.WHEAT_SIGNING_AZURE_ENDPOINT.trim(),
        codeSigningAccountName: env.WHEAT_SIGNING_AZURE_ACCOUNT.trim(),
        certificateProfileName: env.WHEAT_SIGNING_AZURE_PROFILE.trim(),
        fileDigest: "SHA256",
        timestampDigest: "SHA256",
        // Microsoft's own timestamp authority, which is what Artifact Signing
        // certificates are issued to use.
        timestampRfc3161: env.WHEAT_SIGNING_TIMESTAMP_URL?.trim() || "http://timestamp.acs.microsoft.com",
      },
    };
  }

  return {
    signExts,
    signtoolOptions: {
      signingHashAlgorithms: SIGNING_HASH_ALGORITHMS,
      rfc3161TimeStampServer: env.WHEAT_SIGNING_TIMESTAMP_URL?.trim() || DEFAULT_TIMESTAMP_URL,
      ...(publisher ? { publisherName: publisher } : {}),
      // The certificate itself. Exactly one of these is set — `resolveSigningMode`
      // has already refused anything else. The PFX password is deliberately NOT
      // placed here: electron-builder reads `WIN_CSC_KEY_PASSWORD` from the
      // environment, so it never reaches a file on disk.
      ...(env.WHEAT_SIGNING_CERTIFICATE_FILE?.trim()
        ? { certificateFile: env.WHEAT_SIGNING_CERTIFICATE_FILE.trim() }
        : {}),
      ...(env.WHEAT_SIGNING_CERTIFICATE_SUBJECT?.trim()
        ? { certificateSubjectName: env.WHEAT_SIGNING_CERTIFICATE_SUBJECT.trim() }
        : {}),
      ...(env.WHEAT_SIGNING_CERTIFICATE_SHA1?.trim()
        ? { certificateSha1: env.WHEAT_SIGNING_CERTIFICATE_SHA1.trim() }
        : {}),
    },
  };
}

/**
 * Hands the PFX password to electron-builder without writing it anywhere.
 *
 * electron-builder reads `WIN_CSC_KEY_PASSWORD`; Wheat's own variable is named
 * for Wheat. This copies one to the other in the child process' environment
 * only. A hardware token or HSM has no password to pass — the token's PIN is
 * entered into its own middleware, never seen by the build.
 */
export function signingChildEnvironment(env = process.env) {
  const password = env.WHEAT_SIGNING_CERTIFICATE_PASSWORD;
  return password ? { WIN_CSC_KEY_PASSWORD: password } : {};
}

/**
 * The PE files an official Wheat release must carry a signature on.
 *
 * `Wheat.exe` is what the Start menu launches and what Windows names in the UAC
 * prompt. `elevate.exe` is the helper it launches to request elevation, so an
 * unsigned one is the worst of the set. The installer is what SmartScreen
 * inspects on download, and the uninstaller is what Windows runs from
 * "Installed apps" — and, during an edition switch, what the incoming installer
 * runs to clear the old install.
 *
 * The uninstaller only exists inside the built installer, so it is verified
 * where it lands rather than here.
 */
export function signableArtifacts(root, version, { fileNames }) {
  const releaseDirectory = path.join(root, "release", version);
  const unpacked = path.join(releaseDirectory, "win-unpacked");
  return [
    // An installer that is not there is a failure, not an absence: it is the
    // file the release is *about*. The unpacked build is different - both
    // editions pack into one `win-unpacked`, so only the last one built is still
    // on disk at release time, and `package-edition.mjs` is what checks each
    // edition's own binaries while they exist.
    ...fileNames.map((name) => ({ role: "installer", path: path.join(releaseDirectory, name), required: true })),
    { role: "application", path: path.join(unpacked, "Wheat.exe") },
    { role: "elevation helper", path: path.join(unpacked, "resources", "elevate.exe") },
  ].filter((entry) => entry.required || fs.existsSync(entry.path));
}

/**
 * Reads the real Authenticode state of a file from Windows itself.
 *
 * Not "signtool returned 0": this asks the same API Explorer's Digital
 * Signatures tab and SmartScreen consult, so what it reports is what a user will
 * see. Returns the certificate subject, the chain status and whether the
 * signature carries a trusted countersignature (timestamp) — a signature
 * without one stops verifying the day the certificate expires.
 */
export function verifyAuthenticode(filePaths) {
  if (process.platform !== "win32") {
    return filePaths.map((file) => ({ path: file, status: "UNAVAILABLE", signed: false, message: "Authenticode can only be read on Windows." }));
  }
  if (!filePaths.length) return [];

  // The file list is passed on stdin as JSON rather than interpolated into the
  // script text: a path is attacker-influenced in exactly the way a command
  // string must never be, and Wheat's paths contain spaces already.
  const script = `
$ErrorActionPreference = 'Stop'
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @()
foreach ($p in @($paths)) {
  $s = Get-AuthenticodeSignature -LiteralPath $p
  $cert = $s.SignerCertificate
  $ts = $s.TimeStamperCertificate
  $out += [pscustomobject]@{
    path        = $p
    status      = [string]$s.Status
    message     = [string]$s.StatusMessage
    subject     = if ($cert) { [string]$cert.Subject } else { $null }
    issuer      = if ($cert) { [string]$cert.Issuer } else { $null }
    thumbprint  = if ($cert) { [string]$cert.Thumbprint } else { $null }
    notAfter    = if ($cert) { $cert.NotAfter.ToString('o') } else { $null }
    timestamped = [bool]$ts
    timestamper = if ($ts) { [string]$ts.Subject } else { $null }
  }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input: JSON.stringify(filePaths), encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    ...entry,
    signed: entry.status === "Valid",
  }));
}

/** One line per artifact, safe to print and to keep in a release report. */
export function describeSignature(result) {
  if (result.status === "UNAVAILABLE") return "not checked (not Windows)";
  if (result.status === "MISSING") return "NOT BUILT";
  if (result.status === "NotSigned") return "NOT SIGNED";
  const subject = commonNameOf(result.subject) ?? result.subject ?? "unknown subject";
  const timestamp = result.timestamped ? "timestamped" : "NOT timestamped";
  return `${result.status} — ${subject} — ${timestamp}`;
}

/** `CN=Wheat, O=…` → `Wheat`. Public certificate data; never a secret. */
export function commonNameOf(subject) {
  const match = /(?:^|,\s*)CN=("([^"]*)"|[^,]*)/.exec(String(subject ?? ""));
  return match ? (match[2] ?? match[1]).trim() : null;
}

/**
 * The signature state of one built release, as data.
 *
 * Shared by `scripts/verify-signatures.mjs` and `release-prepare.mjs` so the
 * report a release records and the report the command prints cannot disagree.
 * The installer file names are passed in rather than derived here: this module
 * owns what signing is, not what an edition is called.
 */
export function buildSigningReport(projectRoot, releaseVersion, { fileNames, env = process.env }) {
  const signing = resolveSigningMode(env);
  const expected = signableArtifacts(projectRoot, releaseVersion, { fileNames });

  // electron-builder writes the uninstaller beside the installer while it builds
  // and signs it there before embedding it. If it is still on disk it is worth
  // checking, because it is the binary Windows runs from "Installed apps" and
  // the one an incoming installer runs to clear the previous edition.
  const releaseDirectory = path.join(projectRoot, "release", releaseVersion);
  if (fs.existsSync(releaseDirectory)) {
    for (const name of fs.readdirSync(releaseDirectory)) {
      if (name.endsWith("__uninstaller.exe")) expected.push({ role: "uninstaller", path: path.join(releaseDirectory, name) });
    }
  }

  const present = expected.filter((entry) => fs.existsSync(entry.path));
  const results = new Map();
  verifyAuthenticode(present.map((entry) => entry.path)).forEach((result, index) => results.set(present[index].path, result));
  const artifacts = expected.map((entry) => {
    const result = results.get(entry.path) ?? { status: "MISSING", signed: false };
    return {
      role: entry.role,
      name: path.relative(projectRoot, entry.path).replaceAll("\\", "/"),
      path: entry.path,
      status: result.status,
      signed: Boolean(result.signed),
      subject: result.subject ?? null,
      publisher: commonNameOf(result.subject),
      issuer: result.issuer ?? null,
      thumbprint: result.thumbprint ?? null,
      notAfter: result.notAfter ?? null,
      timestamped: Boolean(result.timestamped),
      summary: describeSignature(result),
    };
  });

  const unsigned = artifacts.filter((artifact) => !artifact.signed);
  const untimestamped = artifacts.filter((artifact) => artifact.signed && !artifact.timestamped);
  const publishers = [...new Set(artifacts.map((artifact) => artifact.publisher).filter(Boolean))];

  let verdict;
  let failure = null;
  if (signing.mode === "off") {
    // Not "FAIL": nothing was claimed. An unsigned development build is a
    // correct outcome of an unsigned development build, and saying PASS here
    // would be the lie this whole pipeline exists to make impossible.
    verdict = artifacts.some((artifact) => artifact.signed) ? "UNEXPECTEDLY SIGNED" : "NOT SIGNED (signing is off)";
    failure = "signing is off, so there is no Authenticode signature to verify. Set WHEAT_SIGNING_MODE and re-build.";
  } else if (unsigned.length) {
    verdict = "FAIL";
    failure = `signing mode is "${signing.mode}" but ${unsigned.length} artifact(s) are not validly signed: ${unsigned.map((artifact) => `${artifact.name} (${artifact.status})`).join(", ")}`;
  } else if (untimestamped.length) {
    verdict = "FAIL";
    failure = `signed but not timestamped: ${untimestamped.map((artifact) => artifact.name).join(", ")}. An untimestamped signature stops verifying when the certificate expires.`;
  } else if (publishers.length > 1) {
    verdict = "FAIL";
    failure = `one release must have one publisher; found ${publishers.join(", ")}.`;
  } else {
    verdict = "PASS";
  }

  return { mode: signing.mode, modeDetail: signing.detail, artifacts, publishers, verdict, failure };
}
