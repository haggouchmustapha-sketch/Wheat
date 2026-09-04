import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import semver from "semver";
import { hashFile, signRelease } from "./lib/releaseManifest.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(root, "package.json");
const packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = packageMetadata.version;
if (!semver.valid(version)) throw new Error(`package.json version must be valid SemVer; received ${version}.`);

const args = process.argv.slice(2);
const values = new Map();
const notes = [];
const flags = new Set();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--force" || argument === "--no-publish") {
    flags.add(argument);
  } else if (argument === "--note") {
    const note = args[++index]?.trim();
    if (!note) throw new Error("--note requires text.");
    notes.push(note);
  } else if (["--notes-file", "--minimum-version", "--artifact", "--output", "--sign"].includes(argument)) {
    const value = args[++index]?.trim();
    if (!value) throw new Error(`${argument} requires a value.`);
    values.set(argument, value);
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const notesFile = values.get("--notes-file");
if (notesFile) {
  const text = fs.readFileSync(path.resolve(root, notesFile), "utf8");
  notes.push(...text.split(/\r?\n/).map((line) => line.trim().replace(/^[-*•]\s*/, "")).filter((line) => line && !line.startsWith("#")));
}
if (!notes.length) {
  throw new Error("Provide release notes with --notes-file <file> or one or more --note \"...\" arguments.");
}
if (notes.length > 100 || notes.some((note) => note.length > 500)) throw new Error("Release notes must contain at most 100 items of 500 characters or fewer.");

const minimumVersion = values.get("--minimum-version");
if (minimumVersion && !semver.valid(minimumVersion)) throw new Error("--minimum-version must be valid SemVer.");
if (minimumVersion && semver.gt(minimumVersion, version)) throw new Error("--minimum-version cannot be newer than this release.");

const configuredArtifact = values.get("--artifact");
const artifactPath = configuredArtifact
  ? path.resolve(root, configuredArtifact)
  : path.join(root, "release", version, `WheatSetup-${version}.exe`);
if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
  throw new Error(`Built NSIS installer not found at ${artifactPath}. Run npm run installer first or pass --artifact.`);
}
if (path.extname(artifactPath).toLowerCase() !== ".exe") throw new Error("The local Windows update artifact must be an NSIS .exe installer.");

const sha256 = await hashFile(artifactPath);
const artifactName = path.basename(artifactPath);
const release = {
  schemaVersion: 1,
  version,
  releaseDate: new Date().toISOString().slice(0, 10),
  notes,
  artifact: `${version}/${artifactName}`,
  sha256,
  artifactSize: fs.statSync(artifactPath).size,
  ...(minimumVersion ? { minimumVersion } : {}),
};

// Signing is what lets a release travel over a network: an HTTPS feed refuses
// every unsigned manifest. It stays optional here because the local channel —
// a folder inside the user's own profile — is trusted by other means and
// predates signing.
const signingKeyPath = values.get("--sign");
if (signingKeyPath) {
  release.signature = {
    algorithm: "ed25519",
    value: signRelease(release, path.resolve(root, signingKeyPath)),
  };
}

const repositoryFeed = values.get("--output") ? path.resolve(root, values.get("--output")) : path.join(root, "updates");
publishRelease(repositoryFeed, artifactPath, release, flags.has("--force"));

let localFeed = null;
if (!flags.has("--no-publish") && process.platform === "win32") {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is not available; use --no-publish to create only the repository feed.");
  localFeed = path.resolve(process.env.WHEAT_LOCAL_UPDATE_DIR || path.join(appData, "Wheat", "updates"));
  if (localFeed !== repositoryFeed) publishRelease(localFeed, artifactPath, release, flags.has("--force"));
}

console.log(`Created Wheat ${version} local update.`);
console.log(`Repository feed: ${repositoryFeed}`);
if (localFeed) console.log(`Installed-app feed: ${localFeed}`);
console.log(`SHA-256: ${sha256}`);
console.log(signingKeyPath
  ? "Signed: yes (ed25519). This release can be published to an HTTPS feed."
  : "Signed: no. An HTTPS update feed will refuse this release; pass --sign <key.pem> to sign it.");

function publishRelease(feedRoot, sourceArtifact, metadata, force) {
  if (path.parse(feedRoot).root === path.resolve(feedRoot)) throw new Error("Refusing to publish an update feed at a drive/filesystem root.");
  fs.mkdirSync(feedRoot, { recursive: true });
  const releaseDirectory = path.join(feedRoot, metadata.version);
  const targetArtifact = path.join(releaseDirectory, path.basename(sourceArtifact));
  if (fs.existsSync(releaseDirectory)) {
    const existingMatches = fs.existsSync(targetArtifact) && hashFileSync(targetArtifact) === metadata.sha256;
    if (!existingMatches && !force) throw new Error(`Release ${metadata.version} already exists with different bytes in ${feedRoot}. Use --force only if replacement is intentional.`);
  }
  const temporaryDirectory = path.join(feedRoot, `.release-${metadata.version}-${randomUUID()}.tmp`);
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  try {
    fs.copyFileSync(sourceArtifact, path.join(temporaryDirectory, path.basename(sourceArtifact)));
    fs.writeFileSync(path.join(temporaryDirectory, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (fs.existsSync(releaseDirectory)) fs.rmSync(releaseDirectory, { recursive: true, force: true });
    fs.renameSync(temporaryDirectory, releaseDirectory);
    writeJsonAtomically(path.join(feedRoot, "latest.json"), metadata);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function writeJsonAtomically(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
}

function hashFileSync(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
