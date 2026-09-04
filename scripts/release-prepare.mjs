import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import semver from "semver";
import {
  RELEASE_MANIFEST_ASSET,
  buildReleaseManifest,
  canonicalReleasePayload,
  hashFile,
  readReleaseNotes,
  releaseTagFor,
  signRelease,
} from "./lib/releaseManifest.mjs";
import { RELEASE_BRANCH, ghIsAuthenticated, ghJson, readPackageMetadata, readSourceProvenance, remoteBranchHead, repositoryRoot, resolveReleaseRepository } from "./lib/releaseRepository.mjs";
import { createPublicKey, verify } from "node:crypto";

/**
 * Prepares a Wheat release. Local, reversible, and publishes nothing.
 *
 * Everything that can go wrong should go wrong here, on this machine, where the
 * only cost is running it again — rather than after a release exists and every
 * installed Wheat has already seen it. So this script builds the real installer,
 * signs the real manifest, and then verifies its own output the same way an
 * installed Wheat will, before writing a plan that `release-publish.mjs` may
 * upload. It never talks to GitHub except to read what is already published.
 *
 *   npm run release:prepare -- --notes docs/wheat-2.1.2610-release-notes.md \
 *                              --sign ../wheat-release-key.pem
 *
 * Flags:
 *   --notes <file>       Required. Markdown bullets become the release notes.
 *   --sign <key.pem>     Required for a real release. Ed25519 private key.
 *   --version <semver>   Override package.json. Also rewrites package.json.
 *   --minimum-version    Refuse to update installs older than this.
 *   --skip-tests         Records the omission in the plan; publish will refuse.
 *   --skip-build         Reuse an installer already in release/<version>/.
 */

const root = repositoryRoot();
const args = process.argv.slice(2);
const values = new Map();
const flags = new Set();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--skip-tests" || argument === "--skip-build") {
    flags.add(argument);
  } else if (["--notes", "--notes-file", "--sign", "--version", "--minimum-version"].includes(argument)) {
    const value = args[++index]?.trim();
    if (!value) throw new Error(`${argument} requires a value.`);
    values.set(argument === "--notes-file" ? "--notes" : argument, value);
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const repository = resolveReleaseRepository(root);
const step = (message) => console.log(`\n── ${message}`);

/**
 * Runs one npm script, inheriting the terminal.
 *
 * `shell: true` because npm on Windows is `npm.cmd`, and Node refuses to spawn
 * a .cmd without a shell (EINVAL) since the CVE-2024-27980 fix. The arguments
 * are literals in this file, never anything the operator typed, so there is
 * nothing for a shell to interpolate.
 */
function runNpmScript(script) {
  console.log(`  npm run ${script}`);
  // One shell string rather than execFileSync(..., { shell: true }): npm on
  // Windows is npm.cmd, which Node refuses to spawn without a shell since the
  // CVE-2024-27980 fix, and passing an argv array *with* a shell is deprecated
  // (DEP0190) precisely because the arguments would not be escaped. `script` is
  // a literal from the list below, never anything the operator typed.
  execSync(`npm run ${script}`, { cwd: root, stdio: "inherit", windowsHide: true });
}

// ---------------------------------------------------------------- 1. version
step("Version");
const packagePath = path.join(root, "package.json");
let version = readPackageMetadata(root).version;
const requested = values.get("--version");
if (requested) {
  if (!semver.valid(requested)) throw new Error(`--version must be valid SemVer; received ${requested}.`);
  if (semver.lt(requested, version)) throw new Error(`--version ${requested} is older than package.json's ${version}. Wheat does not publish downgrades.`);
  if (requested !== version) {
    // package.json is the single authoritative version: the Electron build, the
    // About panel, the installer file name, the manifest and the Git tag all
    // derive from it, so it is rewritten here rather than passed around.
    const raw = fs.readFileSync(packagePath, "utf8");
    const updated = raw.replace(/(\n\s*"version":\s*")([^"]+)(")/, `$1${requested}$3`);
    if (updated === raw) throw new Error("Could not rewrite the version in package.json.");
    fs.writeFileSync(packagePath, updated, "utf8");
    console.log(`  package.json version ${version} → ${requested}`);
  }
  version = requested;
}
if (!semver.valid(version)) throw new Error(`package.json version must be valid SemVer; received ${version}.`);
console.log(`  Releasing Wheat ${version} to ${repository.url}`);

// ------------------------------------------------------- 2. source provenance
step("Source");
const provenance = readSourceProvenance(root);
if (!provenance.isRepository) {
  console.log("  WARNING: this is not a Git repository, so the release tag cannot be tied to a commit.");
  console.log("           release:publish will refuse this plan.");
} else {
  console.log(`  HEAD    ${provenance.head} (${provenance.branch})`);
  if (provenance.dirty) {
    // The installer is built from the working tree, so uncommitted changes mean
    // the shipped binary contains code no commit describes. The tag would then
    // be a claim nobody can verify.
    console.log(`  WORKING TREE NOT CLEAN — ${provenance.dirtyFiles.length} path(s):`);
    for (const entry of provenance.dirtyFiles) console.log(`    ${entry}`);
    console.log("  Commit or stash before preparing a release; release:publish will refuse this plan.");
  } else {
    console.log("  Working tree clean.");
  }
  const remoteHead = remoteBranchHead(repository, RELEASE_BRANCH);
  console.log(remoteHead
    ? `  remote ${RELEASE_BRANCH}  ${remoteHead}${remoteHead === provenance.head ? " (matches HEAD)" : " — DOES NOT MATCH HEAD; push before publishing"}`
    : `  remote ${RELEASE_BRANCH}  not readable or not yet pushed`);
}

// -------------------------------------------------------- 3. release history
step("Published releases");
let publishedVersions = [];
let historyKnown = false;
if (ghIsAuthenticated()) {
  try {
    const releases = ghJson(["release", "list", "--repo", repository.slug, "--limit", "100", "--json", "tagName,isDraft"]) ?? [];
    publishedVersions = releases
      .filter((release) => !release.isDraft)
      .map((release) => semver.valid(String(release.tagName).replace(/^v/, "")))
      .filter(Boolean);
    historyKnown = true;
    const newest = publishedVersions.sort(semver.rcompare)[0];
    console.log(newest ? `  Latest published: ${newest}` : "  No release published yet.");
    if (publishedVersions.includes(version)) {
      throw new Error(`Wheat ${version} is already published at ${repository.url}/releases/tag/${releaseTagFor(version)}. Choose a newer version.`);
    }
    if (newest && !semver.gt(version, newest)) {
      throw new Error(`Wheat ${version} is not newer than the published ${newest}. An installed Wheat would refuse it as a downgrade.`);
    }
  } catch (error) {
    if (/already published|not newer/.test(error.message)) throw error;
    // Not being able to read the history is not a reason to refuse to build.
    // It is a reason for publish to check again before it uploads anything.
    console.log(`  Could not read published releases: ${error.message}`);
  }
} else {
  console.log("  GitHub CLI not authenticated; skipping the published-release check.");
}

// ------------------------------------------------------------------ 4. notes
step("Release notes");
const notesPath = values.get("--notes");
if (!notesPath) throw new Error("--notes <file> is required: an accountant reads these, so they are written deliberately, not generated from commits.");
const resolvedNotes = path.resolve(root, notesPath);
if (!fs.existsSync(resolvedNotes)) throw new Error(`Release notes not found at ${resolvedNotes}.`);
const notes = readReleaseNotes(resolvedNotes);
console.log(`  ${notes.length} note(s) from ${path.relative(root, resolvedNotes)}`);
for (const note of notes) console.log(`    • ${note}`);

// ------------------------------------------------------------------ 5. tests
step("Tests");
const testsRun = [];
if (flags.has("--skip-tests")) {
  console.log("  SKIPPED (--skip-tests). release:publish will refuse this plan.");
} else {
  for (const suite of ["lint", "test:updater"]) {
    runNpmScript(suite);
    testsRun.push(suite);
  }
}

// ------------------------------------------------- 6. build the real installer
step("Production package");
const releaseDirectory = path.join(root, "release", version);
const artifactPath = path.join(releaseDirectory, `WheatSetup-${version}.exe`);
if (flags.has("--skip-build")) {
  console.log("  SKIPPED (--skip-build); reusing the existing installer.");
} else {
  runNpmScript("installer");
}
if (!fs.existsSync(artifactPath)) throw new Error(`The installer was not produced at ${artifactPath}.`);
console.log(`  ${path.relative(root, artifactPath)} (${(fs.statSync(artifactPath).size / (1024 * 1024)).toFixed(1)} MB)`);

// --------------------------------------------------------------- 7. manifest
step("Update metadata");
const manifest = await buildReleaseManifest({
  version,
  artifactPath,
  notes,
  minimumVersion: values.get("--minimum-version"),
  // A GitHub release is a flat set of assets, so the manifest names the file
  // and Wheat builds the URL around it from the repository and the tag.
  layout: "flat",
});
const signingKeyPath = values.get("--sign");
if (signingKeyPath) {
  manifest.signature = { algorithm: "ed25519", value: signRelease(manifest, path.resolve(root, signingKeyPath)) };
} else {
  console.log("  WARNING: unsigned. Every installed Wheat will refuse this release. Pass --sign <key.pem>.");
}
const manifestPath = path.join(releaseDirectory, RELEASE_MANIFEST_ASSET);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`  SHA-256 ${manifest.sha256}`);
console.log(`  ${path.relative(root, manifestPath)}`);

// ------------------------------------------------------------ 8. verify self
step("Verification");
const rehashed = await hashFile(artifactPath);
if (rehashed !== manifest.sha256) throw new Error("The installer changed while the manifest was being written.");
console.log("  Installer digest matches the manifest.");

if (manifest.signature) {
  // Verified against the key compiled into *this* build, which is the key every
  // installed Wheat has. Signing with the wrong key is otherwise invisible
  // until a release is live and every client silently refuses it.
  const compiledKey = readCompiledPublicKey();
  if (!compiledKey) {
    console.log("  WARNING: no WHEAT_UPDATE_PUBLIC_KEY is compiled into this build; the signature could not be checked against what clients hold.");
  } else {
    const payload = Buffer.from(canonicalReleasePayload(manifest), "utf8");
    const ok = verify(null, payload, createPublicKey(compiledKey), Buffer.from(manifest.signature.value, "base64"));
    if (!ok) {
      throw new Error(
        "The manifest signature does not verify against the public key compiled into Wheat. " +
        "The signing key does not match WHEAT_UPDATE_PUBLIC_KEY in electron/updater/signature.ts — publishing this would ship an update every client refuses.",
      );
    }
    console.log("  Signature verifies against the key compiled into Wheat.");
  }
}

const blockmapPath = `${artifactPath}.blockmap`;
const assets = [
  { name: path.basename(artifactPath), path: artifactPath, sha256: manifest.sha256, purpose: "The NSIS installer Wheat downloads and runs." },
  { name: RELEASE_MANIFEST_ASSET, path: manifestPath, sha256: await hashFile(manifestPath), purpose: "The signed manifest an installed Wheat reads first." },
];
if (fs.existsSync(blockmapPath)) {
  assets.push({
    name: path.basename(blockmapPath),
    path: blockmapPath,
    sha256: await hashFile(blockmapPath),
    purpose: "electron-builder's block map. Not read by Wheat's updater; published so the installer can be diffed and verified externally.",
  });
}

// -------------------------------------------------------------- 9. the plan
step("Publication plan");
const plan = {
  planVersion: 1,
  preparedAt: new Date().toISOString(),
  version,
  tag: releaseTagFor(version),
  repository: repository.slug,
  repositoryUrl: repository.url,
  notesFile: path.relative(root, resolvedNotes),
  notes,
  signed: Boolean(manifest.signature),
  testsRun,
  testsSkipped: flags.has("--skip-tests"),
  buildSkipped: flags.has("--skip-build"),
  publishedVersionsAtPrepare: historyKnown ? publishedVersions : null,
  // What the tag will claim. Re-checked at publish, because the working tree can
  // change between somebody reading the plan and somebody uploading it.
  source: {
    isRepository: provenance.isRepository,
    commit: provenance.head,
    branch: provenance.branch,
    clean: provenance.isRepository ? !provenance.dirty : null,
  },
  assets: assets.map((asset) => ({ name: asset.name, path: path.relative(root, asset.path), sha256: asset.sha256, bytes: fs.statSync(asset.path).size, purpose: asset.purpose })),
};
const planPath = path.join(releaseDirectory, "publish-plan.json");
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

console.log(`\nPrepared Wheat ${version}. Nothing has been published.`);
console.log(`  Release      ${repository.url}/releases/tag/${plan.tag}`);
console.log(`  Plan         ${path.relative(root, planPath)}`);
console.log("  Assets that WOULD be uploaded:");
for (const asset of plan.assets) console.log(`    ${asset.name}  ${(asset.bytes / (1024 * 1024)).toFixed(1)} MB  sha256=${asset.sha256.slice(0, 16)}…`);
if (!plan.signed) console.log("\n  This release is UNSIGNED and release:publish will refuse it.");
if (plan.testsSkipped) console.log("\n  Tests were skipped and release:publish will refuse this plan.");
console.log(`\nWhen you are satisfied:  npm run release:publish\n`);

/** Reads WHEAT_UPDATE_PUBLIC_KEY out of the application source. */
function readCompiledPublicKey() {
  const source = fs.readFileSync(path.join(root, "electron", "updater", "signature.ts"), "utf8");
  const match = /export const WHEAT_UPDATE_PUBLIC_KEY = ([`"'])([\s\S]*?)\1;/.exec(source);
  const key = match?.[2]?.trim();
  return key || null;
}
