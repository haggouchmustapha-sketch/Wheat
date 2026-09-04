import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { createPublicKey, verify } from "node:crypto";
import { RELEASE_MANIFEST_ASSET, canonicalReleasePayload, hashFile, releaseTagFor } from "./lib/releaseManifest.mjs";
import { RELEASE_BRANCH, gh, ghIsAuthenticated, ghJson, readPackageMetadata, readSourceProvenance, remoteBranchHead, repositoryRoot, resolveReleaseRepository } from "./lib/releaseRepository.mjs";

/**
 * Publishes a prepared Wheat release to GitHub Releases.
 *
 * The only irreversible step in the pipeline, so it is the one that assumes
 * nothing. Every check `release-prepare.mjs` already made is made again here
 * against the bytes on disk right now, because "prepared" and "published" are
 * separated by however long the operator took to look at the plan, and anything
 * could have changed in between — a rebuild, an edit, a different branch.
 *
 * It fails closed on every one of them: unsigned, untested, digest mismatch,
 * missing asset, an already-published version, a downgrade. A release either
 * satisfies all of it or does not happen.
 *
 *   npm run release:publish
 *   npm run release:publish -- --version 2.1.2610   (publish a specific plan)
 */

const root = repositoryRoot();
const args = process.argv.slice(2);
const values = new Map();
const flags = new Set();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--draft" || argument === "--allow-unsigned") flags.add(argument);
  else if (argument === "--version") {
    const value = args[++index]?.trim();
    if (!value) throw new Error("--version requires a value.");
    values.set("--version", value);
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const repository = resolveReleaseRepository(root);
const version = values.get("--version") ?? readPackageMetadata(root).version;
const step = (message) => console.log(`\n── ${message}`);
const refuse = (message) => { throw new Error(`Refusing to publish: ${message}`); };

// ------------------------------------------------------------------ 1. plan
step("Prepared plan");
const releaseDirectory = path.join(root, "release", version);
const planPath = path.join(releaseDirectory, "publish-plan.json");
if (!fs.existsSync(planPath)) {
  refuse(`no prepared release for ${version}. Run: npm run release:prepare -- --notes <file> --sign <key.pem>`);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (plan.planVersion !== 1) refuse(`unsupported plan format (planVersion ${plan.planVersion}).`);
if (plan.version !== version) refuse(`the plan in ${path.relative(root, planPath)} is for ${plan.version}, not ${version}.`);
if (plan.repository !== repository.slug) refuse(`the plan targets ${plan.repository} but package.json names ${repository.slug}.`);
console.log(`  Wheat ${plan.version} → ${repository.url}, prepared ${plan.preparedAt}`);

// ------------------------------------------------------------- 2. gate checks
step("Gates");
if (plan.testsSkipped) refuse("the prepared release skipped its tests. Re-run release:prepare without --skip-tests.");
if (!plan.signed && !flags.has("--allow-unsigned")) {
  refuse("the prepared release is unsigned; every installed Wheat would reject it. Re-run release:prepare with --sign <key.pem>.");
}
if (!semver.valid(version)) refuse(`${version} is not valid SemVer.`);
console.log(`  Tests run: ${plan.testsRun.join(", ") || "none recorded"}`);
console.log(`  Signed: ${plan.signed ? "yes (ed25519)" : "NO — forced with --allow-unsigned"}`);

// ------------------------------------------------------ 3. source provenance
step("Source correspondence");
// A release tag is a claim that this commit produced this installer. If that
// cannot be *proven*, the release is refused: an unverifiable tag is worse than
// no tag, because it looks authoritative while misleading whoever later tries
// to reproduce, debug, audit or roll back the build — and under the GPL it is
// the pointer to the corresponding source.
if (!plan.source?.isRepository) refuse("the release was prepared outside a Git repository, so no commit can be tied to the installer. Commit the source and re-run release:prepare.");
if (plan.source.clean === false) refuse(`the release was prepared from a dirty working tree (commit ${plan.source.commit}), so the installer contains code no commit describes. Commit everything and re-run release:prepare.`);

const now = readSourceProvenance(root);
if (!now.isRepository) refuse("this is no longer a Git repository; source correspondence cannot be checked.");
if (now.head !== plan.source.commit) {
  refuse(`the source moved since this release was prepared (prepared at ${plan.source.commit}, now at ${now.head}). The prepared installer no longer matches HEAD; re-run release:prepare.`);
}
if (now.dirty) {
  refuse(`the working tree has uncommitted changes since the release was prepared (${now.dirtyFiles.join(", ")}). Commit them and re-run release:prepare, or stash them.`);
}
console.log(`  commit ${now.head} — matches the prepared build, working tree clean.`);

// ---------------------------------------------------------- 4. verify assets
step("Artifact integrity");
for (const asset of plan.assets) {
  const assetPath = path.join(root, asset.path);
  if (!fs.existsSync(assetPath)) refuse(`prepared asset is missing: ${asset.path}`);
  const stat = fs.statSync(assetPath);
  if (stat.size !== asset.bytes) refuse(`${asset.name} changed size since it was prepared (${stat.size} vs ${asset.bytes}).`);
  const digest = await hashFile(assetPath);
  if (digest !== asset.sha256) refuse(`${asset.name} no longer matches its prepared SHA-256. Re-run release:prepare.`);
  console.log(`  ${asset.name}  sha256 ok`);
}

// ------------------------------------------------------- 5. verify signature
step("Manifest signature");
const manifestAsset = plan.assets.find((asset) => asset.name === RELEASE_MANIFEST_ASSET);
if (!manifestAsset) refuse(`the plan has no ${RELEASE_MANIFEST_ASSET}; an installed Wheat has nothing to read.`);
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestAsset.path), "utf8"));
if (manifest.version !== version) refuse(`${RELEASE_MANIFEST_ASSET} names version ${manifest.version}, not ${version}.`);
const installerAsset = plan.assets.find((asset) => asset.name === path.basename(String(manifest.artifact).replaceAll("\\", "/")));
if (!installerAsset) refuse(`${RELEASE_MANIFEST_ASSET} names "${manifest.artifact}", which is not among the prepared assets.`);
if (installerAsset.sha256 !== String(manifest.sha256).toLowerCase()) refuse("the manifest digest does not match the installer it names.");
if (manifest.signature) {
  const compiledKey = readCompiledPublicKey();
  if (!compiledKey) refuse("no WHEAT_UPDATE_PUBLIC_KEY is compiled into this build, so the signature cannot be checked against what clients hold.");
  const ok = verify(null, Buffer.from(canonicalReleasePayload(manifest), "utf8"), createPublicKey(compiledKey), Buffer.from(manifest.signature.value, "base64"));
  if (!ok) refuse("the manifest signature does not verify against the public key compiled into Wheat.");
  console.log("  Signature verifies against the key compiled into Wheat.");
}

// ------------------------------------------------------- 6. remote state
step("GitHub");
if (!ghIsAuthenticated()) {
  refuse("the GitHub CLI is not authenticated. Run `gh auth login` (this credential stays on this machine and is never built into Wheat).");
}
const tag = releaseTagFor(version);
const existing = ghJson(["release", "list", "--repo", repository.slug, "--limit", "100", "--json", "tagName,isDraft"]) ?? [];
const published = existing.filter((release) => !release.isDraft).map((release) => semver.valid(String(release.tagName).replace(/^v/, ""))).filter(Boolean);
if (existing.some((release) => release.tagName === tag)) {
  refuse(`${tag} already exists at ${repository.url}/releases/tag/${tag}. A published release is never overwritten; publish a newer version instead.`);
}
const newest = published.sort(semver.rcompare)[0];
if (newest && !semver.gt(version, newest)) {
  refuse(`${version} is not newer than the published ${newest}. Installed Wheat would reject it as a downgrade.`);
}
console.log(`  ${newest ? `Latest published: ${newest}` : "No release published yet"} → publishing ${version}`);

// The tag must point at the commit that produced this installer, so that commit
// has to be on the remote already. GitHub cannot tag what it has not received.
const remoteHead = remoteBranchHead(repository, RELEASE_BRANCH);
if (!remoteHead) refuse(`${repository.url} has no ${RELEASE_BRANCH} branch yet, so the tag would have nothing to point at. Push the source first.`);
if (remoteHead !== now.head) {
  refuse(`remote ${RELEASE_BRANCH} is at ${remoteHead} but this installer was built from ${now.head}. The tag would point at source that did not produce it. Push your commits first.`);
}
console.log(`  remote ${RELEASE_BRANCH} is at ${remoteHead} — the tag will point at the source that built this installer.`);

// ------------------------------------------------------------ 7. publish
step("Publishing");
const notesBody = [
  `Wheat ${version}`,
  "",
  "Nouveautés :",
  "",
  ...plan.notes.map((note) => `• ${note}`),
  "",
  "---",
  "",
  "Wheat installé se met à jour tout seul : il détecte cette version, vous la propose, et l'installe quand vous l'acceptez.",
  "Vos dossiers, écritures, documents et sauvegardes ne sont pas touchés par une mise à jour.",
].join("\n");
const notesBodyPath = path.join(releaseDirectory, "release-body.md");
fs.writeFileSync(notesBodyPath, `${notesBody}\n`, "utf8");

const createArgs = [
  "release", "create", tag,
  "--repo", repository.slug,
  "--title", `Wheat ${version}`,
  "--notes-file", notesBodyPath,
  // Pinned explicitly: without --target, GitHub tags whatever the default
  // branch happens to point at when the request lands, which is not necessarily
  // the commit this installer was built from.
  "--target", now.head,
  ...(flags.has("--draft") ? ["--draft"] : ["--latest"]),
  ...plan.assets.map((asset) => path.join(root, asset.path)),
];
gh(createArgs, { inherit: true });

// --------------------------------------------------- 8. verify what landed
step("Remote verification");
const remote = ghJson(["release", "view", tag, "--repo", repository.slug, "--json", "tagName,isDraft,assets"]);
const remoteNames = new Set((remote?.assets ?? []).map((asset) => asset.name));
const missing = plan.assets.filter((asset) => !remoteNames.has(asset.name));
if (missing.length) {
  throw new Error(
    `Published ${tag}, but these assets are missing from the release: ${missing.map((asset) => asset.name).join(", ")}. ` +
    `Upload them with: gh release upload ${tag} --repo ${repository.slug} <file>`,
  );
}
for (const asset of remote.assets) console.log(`  ${asset.name} (${asset.size} bytes)`);

// A published-but-unreadable release is the failure that matters most: it looks
// finished from here and is invisible to every installed Wheat. So the manifest
// is fetched back the way a client fetches it, without any credential.
step("Client reachability");
const manifestUrl = `${repository.url}/releases/latest/download/${RELEASE_MANIFEST_ASSET}`;
let reachable = false;
try {
  const response = await fetch(manifestUrl, { redirect: "follow" });
  reachable = response.ok && JSON.parse(await response.text()).version === version;
} catch { /* reported below */ }
if (reachable) {
  console.log(`  ${manifestUrl} is readable without credentials. Installed Wheat will find this release.`);
} else {
  console.log(`  ${manifestUrl} is NOT readable without credentials.`);
  console.log("  The release exists, but no installed Wheat can see it while this repository is private.");
  console.log(`  Make ${repository.url} public — or its releases otherwise anonymously readable — for automatic updates to reach clients.`);
}

console.log(`\nPublished Wheat ${version}.`);
console.log(`  ${repository.url}/releases/tag/${tag}`);
console.log(`  Clients reachable: ${reachable ? "yes" : "NO (repository not publicly readable)"}\n`);

function readCompiledPublicKey() {
  const source = fs.readFileSync(path.join(root, "electron", "updater", "signature.ts"), "utf8");
  const match = /export const WHEAT_UPDATE_PUBLIC_KEY = ([`"'])([\s\S]*?)\1;/.exec(source);
  const key = match?.[2]?.trim();
  return key || null;
}
