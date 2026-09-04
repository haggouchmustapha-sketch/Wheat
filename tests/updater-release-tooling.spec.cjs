const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The release tooling's refusals.
 *
 * Publishing is the one irreversible step in the pipeline, so what matters most
 * is what it *declines* to do. These tests drive `release-publish.mjs` against
 * prepared plans that are wrong in one specific way each, and assert it stops
 * before it reaches GitHub at all — the plan checks run before any `gh` call,
 * so none of this needs a network, a credential, or a repository.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const publishScript = path.join(root, "scripts", "release-publish.mjs");
let releaseManifest;

test.beforeAll(async () => {
  releaseManifest = await import(`file://${path.join(root, "scripts", "lib", "releaseManifest.mjs").replaceAll("\\", "/")}`);
});

/**
 * A disposable copy of the repository skeleton: package.json, the signature
 * source the scripts read the public key from, and a release directory. The
 * real project tree is never written to.
 */
/**
 * The repository every fixture targets.
 *
 * Deliberately NOT Wheat's own. These tests run `release-publish.mjs` for real,
 * and the machine running them may well hold a GitHub credential that can write
 * to Wheat — so a fixture that inherited the real slug would be one passing
 * assertion away from creating a genuine release. Pointing at a repository that
 * does not exist means the remote step can only ever fail, whatever else is
 * true, and no test can publish anything anywhere.
 */
const FIXTURE_REPOSITORY = "wheat-release-tooling-fixture/does-not-exist";

function fixtureRepository(version = "9.9.9") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-release-"));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    ...packageMetadata,
    version,
    repository: { type: "git", url: `https://github.com/${FIXTURE_REPOSITORY}.git` },
  }, null, 2));
  fs.mkdirSync(path.join(directory, "scripts", "lib"), { recursive: true });
  for (const file of ["release-publish.mjs", "release-prepare.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
  }
  for (const file of ["releaseManifest.mjs", "releaseRepository.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", "lib", file), path.join(directory, "scripts", "lib", file));
  }
  fs.mkdirSync(path.join(directory, "electron", "updater"), { recursive: true });
  fs.copyFileSync(path.join(root, "electron", "updater", "signature.ts"), path.join(directory, "electron", "updater", "signature.ts"));
  fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  // semver is imported by the scripts; symlinking beats reinstalling it.
  try {
    fs.symlinkSync(path.join(root, "node_modules", "semver"), path.join(directory, "node_modules", "semver"), "junction");
  } catch {
    fs.cpSync(path.join(root, "node_modules", "semver"), path.join(directory, "node_modules", "semver"), { recursive: true });
  }
  // A real (tiny) Git repository, because release-publish now proves that the
  // tag will point at the commit that produced the installer. A fixture that
  // was not a repository would stop at that gate and never reach the check each
  // test is actually about.
  // Mirrors the real repository's ignores: build output, signing keys and
  // dependencies must not make the tree dirty, which is exactly what publish
  // refuses to proceed with.
  fs.writeFileSync(path.join(directory, ".gitignore"), ["release/", "*.pem", "node_modules/", ""].join(os.EOL));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore", windowsHide: true });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Wheat Release Fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture source");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", windowsHide: true }).trim();

  return { directory, version, commit, releaseDirectory: path.join(directory, "release", version) };
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Writes a plan that would publish, so each test can spoil exactly one thing. */
async function preparePlan(fixture, { sign = true, testsSkipped = false, key } = {}) {
  fs.mkdirSync(fixture.releaseDirectory, { recursive: true });
  const installerPath = path.join(fixture.releaseDirectory, `WheatSetup-${fixture.version}.exe`);
  fs.writeFileSync(installerPath, Buffer.from(`fake NSIS installer for ${fixture.version}`));

  const manifest = await releaseManifest.buildReleaseManifest({
    version: fixture.version,
    artifactPath: installerPath,
    notes: ["Import bancaire amélioré", "Corrections de stabilité"],
    layout: "flat",
  });
  if (sign) {
    const keyPath = path.join(fixture.directory, "key.pem");
    fs.writeFileSync(keyPath, key.privatePem);
    manifest.signature = { algorithm: "ed25519", value: releaseManifest.signRelease(manifest, keyPath) };
  }
  const manifestPath = path.join(fixture.releaseDirectory, "latest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const relative = (target) => path.relative(fixture.directory, target).replaceAll("\\", "/");
  const plan = {
    planVersion: 1,
    preparedAt: new Date().toISOString(),
    version: fixture.version,
    tag: `v${fixture.version}`,
    repository: FIXTURE_REPOSITORY,
    repositoryUrl: `https://github.com/${FIXTURE_REPOSITORY}`,
    notes: manifest.notes,
    signed: sign,
    testsRun: testsSkipped ? [] : ["lint", "test:updater"],
    testsSkipped,
    source: { isRepository: true, commit: fixture.commit, branch: "main", clean: true },
    assets: [
      { name: path.basename(installerPath), path: relative(installerPath), sha256: manifest.sha256, bytes: fs.statSync(installerPath).size, purpose: "installer" },
      { name: "latest.json", path: relative(manifestPath), sha256: await releaseManifest.hashFile(manifestPath), bytes: fs.statSync(manifestPath).size, purpose: "manifest" },
    ],
  };
  // Commit the source as it stands, exactly as an operator does before building:
  // the plan then names the commit that produced these artifacts.
  const commitGit = (...args) => execFileSync("git", args, { cwd: fixture.directory, stdio: "ignore", windowsHide: true });
  commitGit("add", "-A");
  commitGit("commit", "--quiet", "--allow-empty", "-m", `prepare ${fixture.version}`);
  fixture.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.directory, encoding: "utf8", windowsHide: true }).trim();
  plan.source.commit = fixture.commit;

  const planPath = path.join(fixture.releaseDirectory, "publish-plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, manifest, manifestPath, installerPath };
}

/** Runs release-publish and returns its combined output, whether it exits 0 or not. */
function runPublish(fixture, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(fixture.directory, "scripts", "release-publish.mjs"), ...args], {
      cwd: fixture.directory,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * Commits whatever the fixture currently holds and re-points its plan at that
 * commit. Needed by any test that changes the source after preparing: publish
 * refuses a dirty tree first, so without this it would never reach the gate the
 * test is about.
 */
function commitFixture(fixture, planPath) {
  const git = (...args) => execFileSync("git", args, { cwd: fixture.directory, stdio: "ignore", windowsHide: true });
  git("add", "-A");
  git("commit", "--quiet", "--allow-empty", "-m", "post-prepare change");
  fixture.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.directory, encoding: "utf8", windowsHide: true }).trim();
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.source.commit = fixture.commit;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
}

/**
 * Points the fixture's signature.ts at a given public key, as a build would.
 *
 * Asserts the substitution happened. It previously matched only the empty-string
 * form, so once a real key was compiled in it silently did nothing and the
 * fixtures kept Wheat's own key — every "refuses a bad signature" test then
 * passed for the wrong reason. A no-op here must be a failure, not a shrug.
 */
function compileKeyInto(fixture, publicPem) {
  const signaturePath = path.join(fixture.directory, "electron", "updater", "signature.ts");
  const source = fs.readFileSync(signaturePath, "utf8");
  const marker = "export const WHEAT_UPDATE_PUBLIC_KEY = ";
  const at = source.indexOf(marker);
  if (at < 0) throw new Error("The fixture's signature.ts does not declare WHEAT_UPDATE_PUBLIC_KEY.");
  // The constant may be a quoted string or a multi-line template literal, so the
  // declaration is replaced up to its terminating semicolon rather than matched.
  const end = source.indexOf(";", at + marker.length);
  if (end < 0) throw new Error("Could not find the end of the WHEAT_UPDATE_PUBLIC_KEY declaration.");
  const replacement = `${marker}\`${publicPem.trim()}\``;
  fs.writeFileSync(signaturePath, source.slice(0, at) + replacement + source.slice(end));
}

/* ------------------------------------------------------------- manifests --- */

test("a release manifest is built with the digest and size of the real installer", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-manifest-"));
  try {
    const installer = path.join(workspace, "WheatSetup-2.2.0.exe");
    const bytes = Buffer.from("installer bytes");
    fs.writeFileSync(installer, bytes);
    const manifest = await releaseManifest.buildReleaseManifest({
      version: "2.2.0",
      artifactPath: installer,
      notes: ["Une note"],
      layout: "flat",
    });
    expect(manifest.artifact).toBe("WheatSetup-2.2.0.exe");
    expect(manifest.artifactSize).toBe(bytes.length);
    expect(manifest.sha256).toBe(await releaseManifest.hashFile(installer));

    // The folder-feed layout keeps its version directory; a GitHub release is flat.
    const nested = await releaseManifest.buildReleaseManifest({ version: "2.2.0", artifactPath: installer, notes: ["Une note"], layout: "nested" });
    expect(nested.artifact).toBe("2.2.0/WheatSetup-2.2.0.exe");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("the tooling and the application agree, byte for byte, on what a signature covers", async () => {
  const updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-manifest-"));
  try {
    const installer = path.join(workspace, "WheatSetup-2.2.0.exe");
    fs.writeFileSync(installer, Buffer.from("installer bytes"));
    const manifest = await releaseManifest.buildReleaseManifest({
      version: "2.2.0",
      artifactPath: installer,
      notes: ["Une note", "Une autre"],
      minimumVersion: "2.0.0",
      layout: "flat",
    });
    // Two implementations of the signed payload — one in the scripts, one in
    // the application — and if they ever disagree, every installed Wheat
    // silently refuses every update. This is the test that stops that.
    expect(releaseManifest.canonicalReleasePayload(manifest))
      .toBe(updater.canonicalReleasePayload(updater.validateReleaseManifest(manifest)));
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a manifest is refused rather than published with unusable notes or a bad version", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-manifest-"));
  try {
    const installer = path.join(workspace, "WheatSetup-2.2.0.exe");
    fs.writeFileSync(installer, Buffer.from("installer bytes"));
    const base = { version: "2.2.0", artifactPath: installer, notes: ["Une note"], layout: "flat" };
    await expect(releaseManifest.buildReleaseManifest({ ...base, version: "not-semver" })).rejects.toThrow(/valid SemVer/);
    await expect(releaseManifest.buildReleaseManifest({ ...base, notes: [] })).rejects.toThrow(/at least one release note/);
    await expect(releaseManifest.buildReleaseManifest({ ...base, notes: ["x".repeat(501)] })).rejects.toThrow(/500 characters/);
    await expect(releaseManifest.buildReleaseManifest({ ...base, minimumVersion: "3.0.0" })).rejects.toThrow(/cannot be newer/);
    await expect(releaseManifest.buildReleaseManifest({ ...base, artifactPath: path.join(workspace, "absent.exe") })).rejects.toThrow(/not found/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("release notes are the bullet list, not every line of the file", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-notes-"));
  try {
    const notesFile = path.join(workspace, "notes.md");
    // A real notes file: a title, a wrapped paragraph of context, then the list.
    // Only the list is what an accountant sees beside a version number, and an
    // earlier parser turned the paragraph into three meaningless fragments.
    fs.writeFileSync(notesFile, [
      "# Wheat 2.1.260904",
      "",
      "Wheat se met désormais à jour tout seul. Cette version est la première",
      "à être publiée par ce mécanisme.",
      "",
      "- Import bancaire amélioré",
      "- Rien n'est installé sans votre accord : vous décidez quand redémarrer",
      "  et la mise à jour reste disponible",
      "* Corrections de stabilité",
      "",
    ].join("\n"));

    const notes = releaseManifest.readReleaseNotes(notesFile);
    expect(notes).toEqual([
      "Import bancaire amélioré",
      "Rien n'est installé sans votre accord : vous décidez quand redémarrer et la mise à jour reste disponible",
      "Corrections de stabilité",
    ]);

    // A file with prose but no list is a mistake worth stopping for, not an
    // empty update dialog.
    const proseOnly = path.join(workspace, "prose.md");
    fs.writeFileSync(proseOnly, "# Wheat\n\nQuelques améliorations.\n");
    expect(() => releaseManifest.readReleaseNotes(proseOnly)).toThrow(/No release notes found/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

/* --------------------------------------------------------------- publish --- */

test("publishing refuses a version that was never prepared", () => {
  const fixture = fixtureRepository();
  try {
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no prepared release for 9\.9\.9/);
    expect(result.output).toMatch(/npm run release:prepare/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses a release whose tests were skipped", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    await preparePlan(fixture, { key, testsSkipped: true });
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/skipped its tests/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses an unsigned release, which every client would reject anyway", async () => {
  const fixture = fixtureRepository();
  try {
    await preparePlan(fixture, { sign: false, key: keyPair() });
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/unsigned/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses an installer that changed after it was prepared", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    const prepared = await preparePlan(fixture, { key });
    // Somebody rebuilt, or edited, between prepare and publish. The plan's
    // digests are re-checked against the bytes on disk right now.
    fs.appendFileSync(prepared.installerPath, "tampered");
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/changed size since it was prepared|no longer matches its prepared SHA-256/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses a manifest signed with a key clients do not hold", async () => {
  const fixture = fixtureRepository();
  try {
    // Signed with one key, but the build carries another. Without this check
    // the release would publish cleanly and be refused by every installation.
    const prepared = await preparePlan(fixture, { key: keyPair() });
    compileKeyInto(fixture, keyPair().publicPem);
    commitFixture(fixture, prepared.planPath);
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/signature does not verify against the public key compiled into Wheat/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses a plan whose manifest names an asset that is not there", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    const prepared = await preparePlan(fixture, { key });
    const plan = JSON.parse(fs.readFileSync(prepared.planPath, "utf8"));
    plan.assets = plan.assets.filter((asset) => asset.name === "latest.json");
    fs.writeFileSync(prepared.planPath, JSON.stringify(plan, null, 2));
    const result = runPublish(fixture);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/which is not among the prepared assets/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses when the tag would not point at the shipped source", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    const prepared = await preparePlan(fixture, { key });

    // 1. The source moved after the installer was built. The prepared binary no
    //    longer corresponds to HEAD, so the tag would be a false claim.
    fs.writeFileSync(path.join(fixture.directory, "NEW-SOURCE.md"), "a later change");
    const git = (...args) => execFileSync("git", args, { cwd: fixture.directory, stdio: "ignore", windowsHide: true });
    git("add", "-A");
    git("commit", "--quiet", "-m", "source moved on");
    expect(runPublish(fixture).output).toMatch(/source moved since this release was prepared/);

    // 2. Uncommitted work: the installer contains code no commit describes.
    const plan = JSON.parse(fs.readFileSync(prepared.planPath, "utf8"));
    plan.source.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.directory, encoding: "utf8", windowsHide: true }).trim();
    fs.writeFileSync(prepared.planPath, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(fixture.directory, "UNCOMMITTED.md"), "typed but never committed");
    expect(runPublish(fixture).output).toMatch(/uncommitted changes since the release was prepared/);

    // 3. Prepared outside Git at all: nothing can tie a commit to the binary.
    git("add", "-A");
    git("commit", "--quiet", "-m", "settle");
    const settled = JSON.parse(fs.readFileSync(prepared.planPath, "utf8"));
    settled.source = { isRepository: false, commit: null, branch: null, clean: null };
    fs.writeFileSync(prepared.planPath, JSON.stringify(settled, null, 2));
    expect(runPublish(fixture).output).toMatch(/prepared outside a Git repository/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("publishing refuses a plan prepared for a different version or repository", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    const prepared = await preparePlan(fixture, { key });

    const plan = JSON.parse(fs.readFileSync(prepared.planPath, "utf8"));
    plan.repository = "someone-else/Wheat";
    fs.writeFileSync(prepared.planPath, JSON.stringify(plan, null, 2));
    expect(runPublish(fixture).output).toMatch(/targets someone-else\/Wheat but package\.json names/);

    plan.repository = FIXTURE_REPOSITORY;
    plan.version = "8.8.8";
    fs.writeFileSync(prepared.planPath, JSON.stringify(plan, null, 2));
    expect(runPublish(fixture).output).toMatch(/is for 8\.8\.8, not 9\.9\.9/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("a well-formed plan passes every local gate and still publishes nothing", async () => {
  const fixture = fixtureRepository();
  try {
    const key = keyPair();
    compileKeyInto(fixture, key.publicPem);
    await preparePlan(fixture, { key });

    // Everything local succeeds — digests, manifest, signature — and the run
    // still ends without a release, because the remote it targets does not
    // exist. That ordering is the point: nothing is uploaded until after every
    // integrity check has already passed.
    const result = runPublish(fixture);
    expect(result.output).toMatch(/sha256 ok/);
    expect(result.output).toMatch(/Signature verifies against the key compiled into Wheat/);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/GitHub CLI|gh auth login|not installed|Could not resolve|not found|gh release list failed|HTTP 404/i);
    expect(result.output).not.toMatch(/^Published Wheat/m);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------- prepare --- */

test("preparing refuses to start without deliberately written release notes", () => {
  const fixture = fixtureRepository();
  try {
    const result = (() => {
      try {
        return { ok: true, output: execFileSync(process.execPath, [path.join(fixture.directory, "scripts", "release-prepare.mjs")], { cwd: fixture.directory, encoding: "utf8", stdio: "pipe", windowsHide: true }) };
      } catch (error) {
        return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    })();
    expect(result.ok).toBe(false);
    // An accountant reads these. They are written, not generated from commits.
    expect(result.output).toMatch(/--notes <file> is required/);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("the release repository is read from package.json by the tooling too", async () => {
  const releaseRepository = await import(`file://${path.join(root, "scripts", "lib", "releaseRepository.mjs").replaceAll("\\", "/")}`);
  const repository = releaseRepository.resolveReleaseRepository(root);
  expect(repository).toMatchObject({
    owner: "haggouchmustapha-sketch",
    repo: "Wheat",
    slug: "haggouchmustapha-sketch/Wheat",
    url: "https://github.com/haggouchmustapha-sketch/Wheat",
  });
});
