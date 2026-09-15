import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, sign as signPayload } from "node:crypto";
import semver from "semver";

/**
 * The release manifest, from the publishing side.
 *
 * Shared by `package-update.mjs` (local rehearsal feed) and
 * `release-prepare.mjs` / `release-publish.mjs` (GitHub Releases) so there is
 * exactly one definition of what a Wheat release manifest is and exactly one
 * implementation of what a signature covers. Two would eventually disagree, and
 * the failure mode of disagreeing about a signature is every installed Wheat
 * refusing every update.
 */

export const RELEASE_MANIFEST_ASSET = "latest.json";
export const UPDATE_SCHEMA_VERSION = 1;

/**
 * The exact bytes a release signature covers.
 *
 * Must stay byte-identical to `canonicalReleasePayload` in
 * electron/updater/signature.ts — a JSON array of fields in a fixed order, so
 * there is no key ordering to agree on and no delimiter a release note could
 * contain. `tests/updater-signature.spec.cjs` signs with this module and
 * verifies with the application's implementation, so the two cannot drift apart
 * unnoticed.
 */
export function canonicalReleasePayload(metadata) {
  return JSON.stringify([
    metadata.schemaVersion,
    metadata.version,
    metadata.releaseDate,
    metadata.artifact.replaceAll("\\", "/"),
    metadata.sha256.toLowerCase(),
    metadata.artifactSize ?? null,
    metadata.minimumVersion ?? null,
    metadata.notes,
  ]);
}

/**
 * The exact bytes an editions signature covers.
 *
 * Must stay byte-identical to `canonicalEditionsPayload` in
 * electron/updater/signature.ts. Bound to the release version so a signed
 * editions map cannot be lifted onto a different release, and emitted in sorted
 * edition order so signer and verifier cannot disagree about ordering.
 */
export function canonicalEditionsPayload(metadata) {
  const editions = metadata.editions ?? {};
  return JSON.stringify([
    "wheat-editions",
    1,
    metadata.version,
    Object.keys(editions).sort().map((edition) => [
      edition,
      editions[edition].artifact.replaceAll("\\", "/"),
      editions[edition].sha256.toLowerCase(),
      editions[edition].artifactSize ?? null,
    ]),
  ]);
}

function readSigningKey(keyPath) {
  let key;
  try {
    key = createPrivateKey(fs.readFileSync(keyPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the release signing key at ${keyPath}: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The release signing key must be an Ed25519 private key.");
  return key;
}

/** Signs the per-edition installer map, alongside `signRelease`. */
export function signEditions(metadata, keyPath) {
  if (!metadata.editions) throw new Error("This release publishes no per-edition installers to sign.");
  return signPayload(null, Buffer.from(canonicalEditionsPayload(metadata), "utf8"), readSigningKey(keyPath)).toString("base64");
}

export function signRelease(metadata, keyPath) {
  // Ed25519 signs the message directly, hence the null digest algorithm.
  return signPayload(null, Buffer.from(canonicalReleasePayload(metadata), "utf8"), readSigningKey(keyPath)).toString("base64");
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function hashFileSync(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Reads the release notes an accountant will see, from a Markdown file.
 *
 * **Only bullet lines become notes.** A notes file also holds a title and often
 * a sentence or two of context, and those are for whoever opens the file — not
 * for the update dialog, which shows a short list beside a version number. An
 * earlier version of this took every non-heading line, which turned a wrapped
 * introductory paragraph into three meaningless "notes" reading as fragments.
 *
 * A bullet may wrap across lines; an indented continuation is joined onto the
 * bullet above it rather than dropped.
 */
export function readReleaseNotes(notesFile) {
  const notes = [];
  for (const raw of fs.readFileSync(notesFile, "utf8").split(/\r?\n/)) {
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(raw);
    if (bullet) {
      notes.push(bullet[1].trim());
      continue;
    }
    // A continuation line: indented, non-empty, and following a bullet.
    if (notes.length && /^\s+\S/.test(raw) && !raw.trimStart().startsWith("#")) {
      notes[notes.length - 1] = `${notes[notes.length - 1]} ${raw.trim()}`;
    }
  }
  if (!notes.length) {
    throw new Error(`No release notes found in ${notesFile}. Write them as a Markdown bullet list ("- Import bancaire amélioré").`);
  }
  assertNotesAreUsable(notes);
  return notes;
}

export function assertNotesAreUsable(notes) {
  if (!notes.length) throw new Error("A release must carry at least one release note.");
  if (notes.length > 100) throw new Error("A release may carry at most 100 release notes.");
  const tooLong = notes.find((note) => note.length > 500);
  if (tooLong) throw new Error(`Release notes must be 500 characters or fewer: "${tooLong.slice(0, 60)}…"`);
}

/**
 * Builds the manifest for one built installer.
 *
 * `artifact` is the *file name* for a GitHub release (a flat set of assets) and
 * `<version>/<file name>` for the local folder feed (a directory per version).
 * The application accepts either — it takes the basename for GitHub and
 * resolves the relative path for a folder — but the two must be generated
 * deliberately rather than by accident, because the value is signed.
 */
export async function buildReleaseManifest({ version, artifactPath, notes, minimumVersion, layout = "flat", releaseDate, editionArtifacts }) {
  if (!semver.valid(version)) throw new Error(`Release version must be valid SemVer; received ${version}.`);
  assertNotesAreUsable(notes);
  if (minimumVersion && !semver.valid(minimumVersion)) throw new Error("minimumVersion must be valid SemVer.");
  if (minimumVersion && semver.gt(minimumVersion, version)) throw new Error("minimumVersion cannot be newer than this release.");
  assertBuiltInstaller(artifactPath);

  const artifactName = path.basename(artifactPath);
  const locate = (name) => (layout === "flat" ? name : `${version}/${name}`);

  /**
   * `artifact`/`sha256` stay the **Standard** installer.
   *
   * Every Wheat released before editions existed reads only those two fields,
   * and those installations must keep updating — to Standard, which is what
   * they are. The editions map below is additive: a build that understands it
   * picks its own installer out of it, a build that does not never sees it.
   */
  const manifest = {
    schemaVersion: UPDATE_SCHEMA_VERSION,
    version,
    releaseDate: releaseDate ?? new Date().toISOString().slice(0, 10),
    notes,
    artifact: locate(artifactName),
    sha256: await hashFile(artifactPath),
    artifactSize: fs.statSync(artifactPath).size,
    ...(minimumVersion ? { minimumVersion } : {}),
  };

  if (editionArtifacts?.length) {
    const editions = {};
    for (const entry of editionArtifacts) {
      assertBuiltInstaller(entry.path);
      editions[entry.edition] = {
        artifact: locate(path.basename(entry.path)),
        sha256: await hashFile(entry.path),
        artifactSize: fs.statSync(entry.path).size,
      };
    }
    manifest.editions = editions;
  }

  return manifest;
}

function assertBuiltInstaller(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error(`Built installer not found at ${artifactPath}.`);
  }
  if (path.extname(artifactPath).toLowerCase() !== ".exe") throw new Error("The Windows update artifact must be an NSIS .exe installer.");
}

export function releaseTagFor(version) {
  return `v${version}`;
}
