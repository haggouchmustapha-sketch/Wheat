const { test, expect } = require("@playwright/test");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The GitHub Releases update channel.
 *
 * Every response is a literal object handed to an injected `fetchImpl`, so no
 * test opens a socket, resolves a name, or depends on a release existing on
 * GitHub. What is being tested is Wheat's side of the contract: which URLs it
 * builds, which redirects it will follow, and what it refuses.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let updater;

test.beforeAll(() => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
});

const REPO = { owner: "haggouchmustapha-sketch", repo: "Wheat", url: "https://github.com/haggouchmustapha-sketch/Wheat" };
const MANIFEST_URL = "https://github.com/haggouchmustapha-sketch/Wheat/releases/latest/download/latest.json";
const ASSET_URL = "https://github.com/haggouchmustapha-sketch/Wheat/releases/download/v2.2.0/WheatSetup-2.2.0.exe";
const PROBE_URL = "https://github.com/haggouchmustapha-sketch/Wheat/releases";
const ARTIFACT_BYTES = Buffer.from("valid Wheat installer bytes served from a GitHub release");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-update-github-"));
}

function releaseObject(overrides = {}) {
  const version = overrides.version ?? "2.2.0";
  return {
    schemaVersion: 1,
    version,
    releaseDate: "2026-09-03",
    notes: ["Import bancaire amélioré", "Corrections de stabilité"],
    // A GitHub release is a flat set of assets: the manifest names the file.
    artifact: `WheatSetup-${version}.exe`,
    sha256: createHash("sha256").update(ARTIFACT_BYTES).digest("hex"),
    artifactSize: ARTIFACT_BYTES.length,
    ...overrides,
  };
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

function signedRelease(release, privateKey) {
  const payload = Buffer.from(updater.canonicalReleasePayload(updater.validateReleaseManifest(release)), "utf8");
  return { ...release, signature: { algorithm: "ed25519", value: sign(null, payload, privateKey).toString("base64") } };
}

function headers(map = {}) {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => lower.get(String(name).toLowerCase()) ?? null };
}

function jsonResponse(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: true, status: 200, headers: headers({ "content-length": String(text.length) }), text: async () => text };
}

function bytesResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: headers({ "content-length": String(bytes.length) }),
    body: (async function* () { yield bytes; })(),
    arrayBuffer: async () => bytes,
  };
}

const NOT_FOUND = { ok: false, status: 404, headers: headers(), text: async () => "Not Found" };

function redirect(location) {
  return { ok: false, status: 302, headers: headers({ location }), text: async () => "" };
}

/** A fake GitHub. Records what was asked for, so "never fetched" is provable. */
function githubWith(routes) {
  const requested = [];
  return {
    requested,
    fetchImpl: async (url) => {
      requested.push(url);
      const route = routes[url];
      if (route === undefined) return NOT_FOUND;
      return typeof route === "function" ? route() : route;
    },
  };
}

function providerWith(routes, options = {}) {
  const github = githubWith(routes);
  return { github, provider: new updater.GitHubReleasesUpdateProvider(REPO, { fetchImpl: github.fetchImpl, ...options }) };
}

function serviceOn(provider, workspace, publicKey, currentVersion = "2.1.0") {
  return new updater.UpdateService({
    currentVersion,
    provider,
    publicKey,
    stateDirectory: path.join(workspace, "updater"),
    automaticInstallationEnabled: false,
  });
}

/* ------------------------------------------------------- source of truth --- */

test("the release repository is configured in exactly one place", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // package.json's `repository` is the only place the address is written; the
  // application and the release scripts both derive from it, so they cannot be
  // aimed at different repositories.
  expect(packageMetadata.repository.url).toBe("https://github.com/haggouchmustapha-sketch/Wheat.git");
  expect(updater.WHEAT_RELEASE_REPOSITORY).toMatchObject(REPO);
  expect(updater.releaseManifestUrl(updater.WHEAT_RELEASE_REPOSITORY)).toBe(MANIFEST_URL);
  expect(updater.releaseAssetUrl(updater.WHEAT_RELEASE_REPOSITORY, "2.2.0", "WheatSetup-2.2.0.exe")).toBe(ASSET_URL);
  expect(updater.releaseTagFor("2.1.260901")).toBe("v2.1.260901");
});

test("a repository URL that is not a GitHub repository is rejected rather than guessed at", () => {
  for (const candidate of ["", "git@github.com:o/r.git", "https://gitlab.com/o/r", "http://github.com/o/r", "https://github.com/o"]) {
    expect(updater.parseGitHubRepository(candidate), candidate).toBeNull();
  }
  expect(updater.parseGitHubRepository("https://github.com/o/r.git")).toMatchObject({ owner: "o", repo: "r", url: "https://github.com/o/r" });
});

/* -------------------------------------------------------------- manifest --- */

test("the manifest is read from the latest release's permalink, not the API", async () => {
  const { github, provider } = providerWith({ [MANIFEST_URL]: () => jsonResponse(releaseObject()) });
  expect(await provider.getLatestRelease()).toMatchObject({ version: "2.2.0" });
  // The REST API spends one of sixty unauthenticated requests per hour per IP,
  // which a shared office address can exhaust. The download permalink does not.
  expect(github.requested).toEqual([MANIFEST_URL]);
  expect(github.requested.some((url) => url.includes("api.github.com"))).toBe(false);
});

test("a repository with no release yet is up to date, not an error", async () => {
  const { provider } = providerWith({ [PROBE_URL]: () => jsonResponse("<html>releases</html>") });
  expect(await provider.getLatestRelease()).toBeNull();
});

test("a repository Wheat cannot read is reported instead of passing for up to date", async () => {
  // GitHub answers 404 for a private repository exactly as for a missing one.
  // Reading that as "no update" would leave a private or misconfigured channel
  // looking healthy forever, which is the failure that hides itself.
  const { github, provider } = providerWith({});
  await expect(provider.getLatestRelease()).rejects.toThrow(/private or does not exist/);
  expect(github.requested).toEqual([MANIFEST_URL, PROBE_URL]);
});

test("a malformed manifest is refused", async () => {
  const { provider } = providerWith({ [MANIFEST_URL]: () => jsonResponse("{broken") });
  await expect(provider.getLatestRelease()).rejects.toThrow(/not valid JSON/);

  const { provider: wrongSchema } = providerWith({ [MANIFEST_URL]: () => jsonResponse({ ...releaseObject(), schemaVersion: 99 }) });
  await expect(wrongSchema.getLatestRelease()).rejects.toThrow(/Unsupported update metadata schema/);

  const { provider: badVersion } = providerWith({ [MANIFEST_URL]: () => jsonResponse({ ...releaseObject(), version: "two point two" }) });
  await expect(badVersion.getLatestRelease()).rejects.toThrow(/invalid semantic version/);
});

/* ---------------------------------------------------------------- assets --- */

test("the artifact URL is built by Wheat, never taken from the manifest", async () => {
  const workspace = temporaryDirectory();
  try {
    // The manifest is attacker-controlled until its signature verifies, so it is
    // never allowed to supply a location. A manifest that tries to is refused
    // outright at validation, before any provider sees it.
    for (const hostile of ["https://evil.example.com/payload.exe", "C:\Windows\System32\payload.exe", "../../../payload.exe"]) {
      expect(() => updater.validateReleaseManifest(releaseObject({ artifact: hostile })), hostile)
        .toThrow(/unsafe artifact path/);
    }

    // And where the name is innocuous, the download still resolves only to this
    // repository's release for this version: the origin, the repository and the
    // tag are Wheat's own, so only the file name ever comes from the manifest.
    const release = updater.validateReleaseManifest(releaseObject({ artifact: "WheatSetup-2.2.0.exe" }));
    const { github, provider } = providerWith({ [ASSET_URL]: () => bytesResponse(ARTIFACT_BYTES) });
    await provider.acquireUpdate(release, path.join(workspace, "staging"));
    expect(github.requested).toEqual([ASSET_URL]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a directory-shaped artifact path collapses to the asset in the tagged release", async () => {
  const workspace = temporaryDirectory();
  try {
    // A manifest written for the folder-feed layout still resolves correctly:
    // a GitHub release is flat, so the version directory is dropped.
    const release = updater.validateReleaseManifest(releaseObject({ artifact: "2.2.0/WheatSetup-2.2.0.exe" }));
    const { github, provider } = providerWith({ [ASSET_URL]: () => bytesResponse(ARTIFACT_BYTES) });
    const acquired = await provider.acquireUpdate(release, path.join(workspace, "staging"));
    expect(github.requested).toEqual([ASSET_URL]);
    expect(path.basename(acquired.artifactPath)).toBe("WheatSetup-2.2.0.exe");
    expect(fs.readFileSync(acquired.artifactPath)).toEqual(ARTIFACT_BYTES);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("GitHub's redirect to its own blob storage is followed, and nothing else is", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const blob = "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x";
    const { github, provider } = providerWith({
      [ASSET_URL]: () => redirect(blob),
      [blob]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const acquired = await provider.acquireUpdate(release, path.join(workspace, "staging"));
    expect(github.requested).toEqual([ASSET_URL, blob]);
    expect(fs.readFileSync(acquired.artifactPath)).toEqual(ARTIFACT_BYTES);

    for (const hostile of [
      "https://evil.example.com/payload.exe",
      "http://objects.githubusercontent.com/asset",
      "https://objects.githubusercontent.com.evil.example.com/asset",
    ]) {
      const { provider: refusing } = providerWith({ [ASSET_URL]: () => redirect(hostile) });
      await expect(refusing.acquireUpdate(release, path.join(workspace, "hostile")), hostile)
        .rejects.toThrow(/does not trust for updates/);
    }
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an asset missing from the release fails loudly rather than retrying forever", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const { provider } = providerWith({});
    await expect(provider.acquireUpdate(release, path.join(workspace, "staging")))
      .rejects.toThrow(/installer is missing from release 2\.2\.0/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("bytes that do not match the signed digest or size are refused", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const corrupted = Buffer.concat([ARTIFACT_BYTES.subarray(0, ARTIFACT_BYTES.length - 1), Buffer.from("X")]);
    const { provider } = providerWith({ [ASSET_URL]: () => bytesResponse(corrupted) });
    const acquired = await provider.acquireUpdate(release, path.join(workspace, "staging"));
    await expect(provider.validateUpdate(acquired)).rejects.toThrow(/SHA-256 verification/);

    // Larger than the manifest declares is stopped while writing, not after, so
    // a server ignoring its own content-length cannot fill the disk first.
    const oversized = Buffer.concat([ARTIFACT_BYTES, Buffer.alloc(4096, 0x41)]);
    const { provider: overrun } = providerWith({
      [ASSET_URL]: () => ({ ok: true, status: 200, headers: headers(), body: (async function* () { yield oversized; })(), arrayBuffer: async () => oversized }),
    });
    await expect(overrun.acquireUpdate(release, path.join(workspace, "big"))).rejects.toThrow(/larger than its metadata declares/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an interrupted download leaves no artifact behind to be mistaken for a complete one", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const staging = path.join(workspace, "staging");
    const { provider } = providerWith({
      [ASSET_URL]: () => ({
        ok: true,
        status: 200,
        headers: headers({ "content-length": String(ARTIFACT_BYTES.length) }),
        body: (async function* () {
          yield ARTIFACT_BYTES.subarray(0, 10);
          throw new Error("socket hang up");
        })(),
      }),
    });
    await expect(provider.acquireUpdate(release, staging)).rejects.toThrow(/did not complete/);
    const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    expect(leftovers).toEqual([]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a timeout and an outage are network conditions, not bad releases", async () => {
  const provider = new updater.GitHubReleasesUpdateProvider(REPO, {
    fetchImpl: async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const error = new Error("aborted");
      if (init?.signal?.aborted) throw error;
      throw error;
    },
    manifestTimeoutMs: 10,
  });
  await expect(provider.getLatestRelease()).rejects.toThrow(updater.UpdateNetworkError);

  const { provider: unavailable } = providerWith({
    [MANIFEST_URL]: () => ({ ok: false, status: 503, headers: headers(), text: async () => "" }),
  });
  await expect(unavailable.getLatestRelease()).rejects.toThrow(/unavailable \(HTTP 503\)/);

  const { provider: rateLimited } = providerWith({
    [MANIFEST_URL]: () => ({ ok: false, status: 429, headers: headers(), text: async () => "" }),
  });
  await expect(rateLimited.getLatestRelease()).rejects.toThrow(/unavailable \(HTTP 429\)/);
});

/* ------------------------------------------------------ end-to-end paths --- */

test("a signed GitHub release is offered, then downloaded on request, then ready", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const { github, provider } = providerWith({
      [MANIFEST_URL]: () => jsonResponse(signedRelease(releaseObject(), privateKey)),
      [ASSET_URL]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const service = serviceOn(provider, workspace, publicPem);

    const offered = await service.checkForUpdates();
    expect(offered.status).toMatchObject({ phase: "available", availableVersion: "2.2.0", source: "github" });
    expect(offered.status.availableRelease.notes).toEqual(["Import bancaire amélioré", "Corrections de stabilité"]);
    // Nothing was downloaded: the accountant has not agreed to anything yet.
    expect(github.requested).toEqual([MANIFEST_URL]);

    const ready = await service.downloadOfferedUpdate();
    expect(ready.status.phase).toBe("ready");
    expect(fs.readFileSync(ready.pending.artifactPath)).toEqual(ARTIFACT_BYTES);
    expect(github.requested).toEqual([MANIFEST_URL, ASSET_URL]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an unsigned or wrongly signed GitHub release is refused before anything is fetched", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem } = keyPair();
    const attacker = keyPair();
    for (const [name, manifest] of [
      ["unsigned", releaseObject()],
      ["signed by someone else", signedRelease(releaseObject(), attacker.privateKey)],
    ]) {
      const { github, provider } = providerWith({
        [MANIFEST_URL]: () => jsonResponse(manifest),
        [ASSET_URL]: () => bytesResponse(ARTIFACT_BYTES),
      });
      const result = await serviceOn(provider, path.join(workspace, name), publicPem).checkForUpdates();
      expect(result.status.phase, name).toBe("error");
      // GitHub serving a file is not a reason to run it. Whoever controls the
      // account, the repository or the CDN still cannot choose the bytes.
      expect(github.requested, name).toEqual([MANIFEST_URL]);
    }
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an older or equal published release is never installed", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    for (const [version, expected] of [["2.1.0", "up-to-date"], ["2.0.9", "error"]]) {
      const { provider } = providerWith({
        [MANIFEST_URL]: () => jsonResponse(signedRelease(releaseObject({ version }), privateKey)),
      });
      const result = await serviceOn(provider, path.join(workspace, version), publicPem, "2.1.0").checkForUpdates();
      expect(result.status.phase, version).toBe(expected);
      if (expected === "error") expect(result.status.error).toMatch(/Downgrade rejected/);
    }
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a release deleted between the check and the download fails without corrupting anything", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    let assetExists = true;
    const { provider } = providerWith({
      [MANIFEST_URL]: () => jsonResponse(signedRelease(releaseObject(), privateKey)),
      [ASSET_URL]: () => (assetExists ? bytesResponse(ARTIFACT_BYTES) : NOT_FOUND),
    });
    const service = serviceOn(provider, workspace, publicPem);
    await service.checkForUpdates();
    assetExists = false;

    const failed = await service.downloadOfferedUpdate();
    expect(failed.status.phase).toBe("error");
    expect(failed.pending).toBeUndefined();

    // Retrying after the release comes back works; a failure poisons nothing.
    assetExists = true;
    const recovered = await service.downloadOfferedUpdate();
    expect(recovered.status.phase).toBe("ready");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an offline machine keeps working and the unattended check stays quiet", async () => {
  const workspace = temporaryDirectory();
  try {
    const provider = new updater.GitHubReleasesUpdateProvider(REPO, {
      fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }); },
    });
    const service = serviceOn(provider, workspace, keyPair().publicPem);

    // Wheat is local-first. A launch check that could not reach GitHub has
    // learned nothing, so it must not put a permanent warning in front of every
    // accountant with an intermittent connection.
    const automatic = await service.checkForUpdates({ automatic: true });
    expect(automatic.status.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "updater", "updater.log"), "utf8")).toContain("check-unreachable");

    // A check somebody asked for says plainly that it could not be done.
    const manual = await service.checkForUpdates();
    expect(manual.status.phase).toBe("error");
    expect(manual.status.error).toMatch(/could not be reached/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("Plus tard keeps the offer without interrupting, and a newer version asks again", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    let version = "2.2.0";
    const { provider } = providerWith({
      [MANIFEST_URL]: () => jsonResponse(signedRelease(releaseObject({ version }), privateKey)),
    });
    const service = serviceOn(provider, workspace, publicPem);
    await service.checkForUpdates();

    const postponed = await service.postponeUpdate();
    expect(postponed).toMatchObject({ phase: "available", availableVersion: "2.2.0", postponed: true });

    // The same version stays postponed across a later check and a restart.
    expect((await service.checkForUpdates()).status.postponed).toBe(true);
    expect((await serviceOn(provider, workspace, publicPem).getStatus()).postponed).toBe(true);

    // A newer version is a new decision, so it is offered again.
    version = "2.3.0";
    const next = await service.checkForUpdates();
    expect(next.status).toMatchObject({ availableVersion: "2.3.0" });
    expect(next.status.postponed).toBeUndefined();
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a verified update survives a restart without being downloaded again", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const { github, provider } = providerWith({
      [MANIFEST_URL]: () => jsonResponse(signedRelease(releaseObject(), privateKey)),
      [ASSET_URL]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const service = serviceOn(provider, workspace, publicPem);
    await service.checkForUpdates();
    await service.downloadOfferedUpdate();
    expect(github.requested).toEqual([MANIFEST_URL, ASSET_URL]);

    // Somebody chose "Plus tard" at the restart prompt and came back on Monday.
    const afterRestart = serviceOn(provider, workspace, publicPem);
    const rechecked = await afterRestart.checkForUpdates();
    expect(rechecked.status.phase).toBe("ready");
    // The installer was fetched once, not twice.
    expect(github.requested.filter((url) => url === ASSET_URL)).toHaveLength(1);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
