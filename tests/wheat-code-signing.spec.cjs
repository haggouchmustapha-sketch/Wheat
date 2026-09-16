const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Windows code signing: the configuration, not the certificate.
 *
 * Wheat has no production signing certificate yet, so none of this can prove
 * that a real signature verifies. What it can prove — and what actually breaks
 * silently if nobody checks — is the shape of the pipeline around one:
 *
 *   • both editions sign as the *same publisher*, because they are one product;
 *   • a development build is unsigned deliberately rather than by accident;
 *   • the third-party recognition runtime keeps its own vendors' signatures;
 *   • SHA-1 is never used;
 *   • signatures are timestamped;
 *   • no certificate, password or token can reach the repository or an artifact.
 *
 * `docs/wheat-code-signing.md` is the prose version.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let signing;
let editions;

test.beforeAll(async () => {
  signing = await import(pathToFileUrl(path.join(root, "scripts", "lib", "wheatSigning.mjs")));
  editions = await import(pathToFileUrl(path.join(root, "scripts", "lib", "wheatEditions.mjs")));
});

function pathToFileUrl(target) {
  return new URL(`file://${target.replaceAll("\\", "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
}

const SIGNTOOL_ENV = {
  WHEAT_SIGNING_MODE: "signtool",
  WHEAT_SIGNING_CERTIFICATE_SUBJECT: "Wheat",
  WHEAT_SIGNING_PUBLISHER: "Wheat",
};

/* ------------------------------------------------------------------ modes */

test("signing is off unless a mode is chosen, and off means deliberately unsigned", () => {
  expect(signing.resolveSigningMode({}).mode).toBe("off");
  expect(signing.resolveSigningMode({ WHEAT_SIGNING_MODE: "off" }).mode).toBe("off");

  // Not merely "no certificate configured": electron-builder would otherwise
  // pick up a stray CSC_LINK from the environment and sign a development build
  // with a certificate nobody in this repository chose.
  const options = signing.signingBuilderOptions(root, {});
  expect(options.signExecutable).toBe(false);
  expect(options.signtoolOptions).toBeUndefined();
  expect(options.azureSignOptions).toBeUndefined();
});

test("an unknown signing mode fails loudly instead of quietly not signing", () => {
  expect(() => signing.resolveSigningMode({ WHEAT_SIGNING_MODE: "maybe" })).toThrow(/WHEAT_SIGNING_MODE must be one of/);
});

test("signtool mode refuses to guess which certificate to use", () => {
  expect(() => signing.resolveSigningMode({ WHEAT_SIGNING_MODE: "signtool" })).toThrow(/needs a certificate/);
  expect(() => signing.resolveSigningMode({
    WHEAT_SIGNING_MODE: "signtool",
    WHEAT_SIGNING_CERTIFICATE_SUBJECT: "Wheat",
    WHEAT_SIGNING_CERTIFICATE_SHA1: "aabb",
  })).toThrow(/exactly one of/);
});

test("azure mode refuses to start without an endpoint, an account and a profile", () => {
  expect(() => signing.resolveSigningMode({ WHEAT_SIGNING_MODE: "azure" })).toThrow(/WHEAT_SIGNING_AZURE_ENDPOINT/);
});

/* --------------------------------------------------------- what is signed */

test("signatures are SHA-256 and timestamped, never SHA-1", () => {
  const options = signing.signingBuilderOptions(root, SIGNTOOL_ENV);
  expect(options.signtoolOptions.signingHashAlgorithms).toEqual(["sha256"]);
  // electron-builder's own default is ["sha1", "sha256"]. SHA-1 Authenticode has
  // not been trusted by Windows for years and Wheat requires Windows 10.
  expect(options.signtoolOptions.signingHashAlgorithms).not.toContain("sha1");

  // Without a trusted timestamp a signature stops verifying the day the
  // certificate expires — which for code signing certificates is every year or
  // three, while an installed Wheat may sit untouched for longer than that.
  expect(options.signtoolOptions.rfc3161TimeStampServer).toMatch(/^https?:\/\//);
});

test("the third-party recognition runtime keeps its own vendors' signatures", () => {
  const runtime = path.join(root, "resources", "paddleocr");
  test.skip(!fs.existsSync(runtime), "PaddleOCR runtime not installed in this checkout");

  const excluded = new Set(signing.vendorBinaryNames(root));
  const packaged = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".exe")) packaged.push(entry.name);
    }
  };
  walk(runtime);

  // Every executable in the bundled Python runtime must be excluded from
  // signing. python.exe carries a valid signature from the Python Software
  // Foundation; re-signing it would replace theirs with Wheat's, which is both
  // wrong and, on a metered signing service, paid for.
  expect(packaged.length).toBeGreaterThan(0);
  for (const name of packaged) expect(excluded.has(name)).toBe(true);

  const options = signing.signingBuilderOptions(root, SIGNTOOL_ENV);
  for (const name of packaged) expect(options.signExts).toContain(`!${name}`);

  // And Wheat's own executable is still signed: the exclusions are negative
  // patterns, so anything not named by one keeps electron-builder's default.
  expect(options.signExts).not.toContain("!Wheat.exe");
});

/* ----------------------------------------------------------- one publisher */

test("both editions sign as the same publisher", () => {
  const { version, build } = editions.readPackageBuildConfig(root);
  const standard = editions.editionBuilderConfig(build, "standard", version, { root, env: SIGNTOOL_ENV });
  const lightweight = editions.editionBuilderConfig(build, "lightweight", version, { root, env: SIGNTOOL_ENV });

  // Standard and Lightweight are one product. Two publisher identities would
  // tell a user switching edition that they are installing software from
  // somebody else, and would split SmartScreen publisher reputation in half.
  expect(lightweight.win.signtoolOptions).toEqual(standard.win.signtoolOptions);
  expect(lightweight.win.signExts).toEqual(standard.win.signExts);
  expect(standard.win.signtoolOptions.publisherName).toBe("Wheat");

  // The icon and target the base configuration already declared survive the
  // merge; signing adds to `win`, it does not replace it.
  expect(standard.win.icon).toBe(build.win.icon);
  expect(standard.win.target).toEqual(build.win.target);
});

test("an unsigned build is unsigned in both editions", () => {
  const { version, build } = editions.readPackageBuildConfig(root);
  for (const edition of editions.WHEAT_EDITIONS) {
    const config = editions.editionBuilderConfig(build, edition, version, { root, env: {} });
    expect(config.win.signExecutable).toBe(false);
  }
});

/* ------------------------------------------------------------- the secrets */

test("no signing credential is written into the build configuration", () => {
  const env = {
    ...SIGNTOOL_ENV,
    WHEAT_SIGNING_CERTIFICATE_SUBJECT: undefined,
    WHEAT_SIGNING_CERTIFICATE_FILE: undefined,
    WHEAT_SIGNING_CERTIFICATE_SHA1: "1234567890ABCDEF",
    WHEAT_SIGNING_CERTIFICATE_PASSWORD: "hunter2-not-a-real-password",
  };
  const options = signing.signingBuilderOptions(root, env);
  const serialized = JSON.stringify(options);

  // The certificate *selector* is configuration and may be written down. The
  // password is a secret and reaches electron-builder only as an environment
  // variable of the packaging child process.
  expect(serialized).toContain("1234567890ABCDEF");
  expect(serialized).not.toContain("hunter2-not-a-real-password");
  expect(signing.signingChildEnvironment(env)).toEqual({ WIN_CSC_KEY_PASSWORD: "hunter2-not-a-real-password" });
  expect(signing.signingChildEnvironment({})).toEqual({});
});

test("certificates and keys cannot be committed", () => {
  const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const pattern of ["*.pem", "*.key", "*.p12", "*.pfx"]) {
    expect(ignored).toContain(pattern);
  }
});

/* -------------------------------------------------------------- reporting */

test("an unsigned release reports NOT SIGNED rather than PASS", () => {
  const { version } = editions.readPackageBuildConfig(root);
  const fileNames = editions.editionArtifactPaths(root, version).map((entry) => entry.fileName);
  const report = signing.buildSigningReport(root, version, { fileNames, env: {} });

  // The failure mode this guards against is a release report that says PASS
  // because nothing was checked. "Signing is off" is a distinct, honest answer.
  expect(report.mode).toBe("off");
  expect(report.verdict).not.toBe("PASS");
  expect(report.verdict).toMatch(/NOT SIGNED|UNEXPECTEDLY SIGNED/);
});

test("the release pipeline verifies Authenticode before it hashes anything", () => {
  // Order is the whole point: a signature changes the bytes, so a SHA-256
  // computed before signing describes a file that no longer exists. The manifest,
  // the Ed25519 signature, the website metadata and the publish plan all describe
  // the post-signing bytes.
  const prepare = fs.readFileSync(path.join(root, "scripts", "release-prepare.mjs"), "utf8");
  const authenticodeStep = prepare.indexOf('step("Windows Authenticode")');
  const manifestStep = prepare.indexOf('step("Update metadata")');
  expect(authenticodeStep).toBeGreaterThan(0);
  expect(manifestStep).toBeGreaterThan(authenticodeStep);

  // And a configured-but-broken signature stops the release rather than warning.
  expect(prepare).toMatch(/signingReport\.mode !== "off" && signingReport\.verdict !== "PASS"/);
  expect(prepare).toContain("throw new Error(");
});

test("publishing an unsigned release requires saying so", () => {
  const publish = fs.readFileSync(path.join(root, "scripts", "release-publish.mjs"), "utf8");
  expect(publish).toContain("--allow-unsigned-windows");
  expect(publish).toMatch(/windowsSigning\.mode !== "off" && windowsSigning\.verdict !== "PASS"/);

  // The Ed25519 release signature is a separate system and keeps its own gate.
  // Authenticode does not replace it and must not be allowed to look like it has.
  expect(publish).toContain("the prepared release is unsigned; every installed Wheat would reject it");
});
