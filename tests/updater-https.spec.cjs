const { test, expect } = require("@playwright/test");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The HTTPS update channel.
 *
 * Every response is a literal object handed to an injected `fetchImpl`, so no
 * test opens a socket, resolves a name, or depends on a release host existing.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const FEED = "https://updates.example.ma/wheat/";
let updater;

test.beforeAll(() => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-update-https-"));
}

const ARTIFACT_BYTES = Buffer.from("valid Wheat installer bytes for the https channel");

function releaseObject(overrides = {}) {
  const version = overrides.version ?? "2.2.0";
  return {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-30",
    notes: ["Correction de bugs"],
    artifact: `${version}/WheatSetup-${version}.exe`,
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

function jsonResponse(body, extra = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: true, status: 200, headers: headers({ "content-length": String(text.length) }), text: async () => text, ...extra };
}

function bytesResponse(bytes, extra = {}) {
  return {
    ok: true,
    status: 200,
    headers: headers({ "content-length": String(bytes.length) }),
    body: (async function* () { yield new Uint8Array(bytes); })(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...extra,
  };
}

/** Records every URL requested, so path and origin rules can be asserted. */
function feedWith(routes) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const handler = routes[url];
    if (typeof handler === "function") return handler();
    if (handler) return handler;
    return { ok: false, status: 404, headers: headers(), text: async () => "not found" };
  };
  return { requested, fetchImpl };
}

/* ------------------------------------------------------------ feed URL ----- */

test("the feed must be HTTPS and must not carry credentials", () => {
  expect(() => new updater.HttpsUpdateProvider("http://updates.example.ma/wheat/")).toThrow(/must be served over HTTPS/);
  expect(() => new updater.HttpsUpdateProvider("ftp://updates.example.ma/wheat/")).toThrow(/must be served over HTTPS/);
  expect(() => new updater.HttpsUpdateProvider("https://user:pass@updates.example.ma/wheat/")).toThrow(/must not embed credentials/);
  expect(() => new updater.HttpsUpdateProvider("not a url")).toThrow(/not a valid URL/);
  expect(() => new updater.HttpsUpdateProvider(FEED)).not.toThrow();
});

test("a feed without a trailing slash still resolves inside its own directory", async () => {
  const feed = feedWith({ "https://updates.example.ma/wheat/latest.json": jsonResponse(releaseObject()) });
  const provider = new updater.HttpsUpdateProvider("https://updates.example.ma/wheat", { fetchImpl: feed.fetchImpl });
  await provider.getLatestRelease();
  // Without the normalisation this would have asked for /latest.json at the
  // site root, which is a different directory and possibly a different owner.
  expect(feed.requested).toEqual(["https://updates.example.ma/wheat/latest.json"]);
});

/* ----------------------------------------------------------- manifest ------ */

test("a published manifest is fetched and validated", async () => {
  const feed = feedWith({ [`${FEED}latest.json`]: jsonResponse(releaseObject()) });
  const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
  const release = await provider.getLatestRelease();
  expect(release).toMatchObject({ version: "2.2.0", schemaVersion: 1 });
});

test("a feed that has published nothing is not an error", async () => {
  const feed = feedWith({});
  const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
  expect(await provider.getLatestRelease()).toBeNull();
});

test("a malformed or oversized manifest is refused", async () => {
  const broken = new updater.HttpsUpdateProvider(FEED, {
    fetchImpl: feedWith({ [`${FEED}latest.json`]: jsonResponse("{not json") }).fetchImpl,
  });
  await expect(broken.getLatestRelease()).rejects.toThrow(/not valid JSON/);

  const huge = new updater.HttpsUpdateProvider(FEED, {
    fetchImpl: async () => ({ ok: true, status: 200, headers: headers({ "content-length": String(64 * 1024 * 1024) }), text: async () => "{}" }),
  });
  await expect(huge.getLatestRelease()).rejects.toThrow(/too large/);
});

/* ------------------------------------------------------------ transport ---- */

test("an unreachable server is a network failure, not a bad update", async () => {
  const provider = new updater.HttpsUpdateProvider(FEED, {
    fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
  });
  await expect(provider.getLatestRelease()).rejects.toThrow(updater.UpdateNetworkError);
});

test("a server fault or a rate limit is also a network failure", async () => {
  for (const status of [500, 503, 429]) {
    const provider = new updater.HttpsUpdateProvider(FEED, {
      fetchImpl: async () => ({ ok: false, status, headers: headers(), text: async () => "" }),
    });
    await expect(provider.getLatestRelease(), String(status)).rejects.toThrow(updater.UpdateNetworkError);
  }
});

test("a request that hangs is abandoned rather than hanging Wheat", async () => {
  const provider = new updater.HttpsUpdateProvider(FEED, {
    manifestTimeoutMs: 40,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  await expect(provider.getLatestRelease()).rejects.toThrow(/did not respond in time/);
});

test("a same-origin HTTPS redirect is followed", async () => {
  const feed = feedWith({
    [`${FEED}latest.json`]: { ok: false, status: 302, headers: headers({ location: `${FEED}v2/latest.json` }), text: async () => "" },
    [`${FEED}v2/latest.json`]: jsonResponse(releaseObject()),
  });
  const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
  expect(await provider.getLatestRelease()).toMatchObject({ version: "2.2.0" });
});

test("a redirect off the feed's origin or off HTTPS is refused", async () => {
  // A CDN with someone else's certificate, an http:// mirror, or a captive
  // portal must not get to decide what Wheat installs.
  for (const location of ["https://evil.example.com/latest.json", "http://updates.example.ma/wheat/latest.json"]) {
    const feed = feedWith({
      [`${FEED}latest.json`]: { ok: false, status: 302, headers: headers({ location }), text: async () => "" },
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    await expect(provider.getLatestRelease(), location).rejects.toThrow(/redirected to a location Wheat does not trust/);
  }
});

test("a redirect loop terminates", async () => {
  const feed = feedWith({
    [`${FEED}latest.json`]: () => ({ ok: false, status: 302, headers: headers({ location: `${FEED}latest.json` }), text: async () => "" }),
  });
  const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
  await expect(provider.getLatestRelease()).rejects.toThrow(/redirected too many times/);
});

/* ------------------------------------------------------------- artifact ---- */

test("the artifact is downloaded from under the feed and checksum-validated", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const feed = feedWith({ [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => bytesResponse(ARTIFACT_BYTES) });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });

    const acquired = await provider.acquireUpdate(release, path.join(workspace, "staging"));
    expect(fs.readFileSync(acquired.artifactPath)).toEqual(ARTIFACT_BYTES);
    await expect(provider.validateUpdate(acquired)).resolves.toBeUndefined();
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an artifact path that escapes the feed is refused", async () => {
  const workspace = temporaryDirectory();
  try {
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: async () => { throw new Error("must not be reached"); } });
    // `validateReleaseManifest` rejects traversal outright, so the provider's
    // own prefix check is exercised with a manifest that bypassed it.
    const escaping = { ...updater.validateReleaseManifest(releaseObject()), artifact: "../elsewhere/Setup.exe" };
    await expect(provider.acquireUpdate(escaping, path.join(workspace, "staging"))).rejects.toThrow(/outside the configured update feed/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a body larger than the signed size is cut off instead of filling the disk", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    // Honest content-length, dishonest body: the limit has to hold while
    // writing, not merely be checked against a header.
    const feed = feedWith({
      [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => ({
        ok: true,
        status: 200,
        headers: headers({ "content-length": String(ARTIFACT_BYTES.length) }),
        body: (async function* () {
          yield new Uint8Array(ARTIFACT_BYTES);
          yield new Uint8Array(Buffer.alloc(4096, 1));
        })(),
      }),
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const staging = path.join(workspace, "staging");
    await expect(provider.acquireUpdate(release, staging)).rejects.toThrow(/larger than its metadata declares/);
    // The partial download is not left behind.
    expect(fs.existsSync(staging) ? fs.readdirSync(staging) : []).toEqual([]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a content-length disagreeing with the signed size is refused before downloading", async () => {
  const workspace = temporaryDirectory();
  try {
    const release = updater.validateReleaseManifest(releaseObject());
    const feed = feedWith({
      [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => ({
        ok: true,
        status: 200,
        headers: headers({ "content-length": String(ARTIFACT_BYTES.length + 999) }),
        body: (async function* () { yield new Uint8Array(ARTIFACT_BYTES); })(),
      }),
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    await expect(provider.acquireUpdate(release, path.join(workspace, "staging"))).rejects.toThrow(/size does not match/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("corrupted bytes that match no checksum are rejected at validation", async () => {
  const workspace = temporaryDirectory();
  try {
    const corrupt = Buffer.alloc(ARTIFACT_BYTES.length, 7);
    const release = updater.validateReleaseManifest(releaseObject());
    const feed = feedWith({ [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => bytesResponse(corrupt) });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const acquired = await provider.acquireUpdate(release, path.join(workspace, "staging"));
    await expect(provider.validateUpdate(acquired)).rejects.toThrow(/SHA-256 verification/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

/* ------------------------------------------------- end to end, and offline -- */

function serviceOn(provider, workspace, publicKey, currentVersion = "2.1.0") {
  return new updater.UpdateService({
    currentVersion,
    provider,
    publicKey,
    stateDirectory: path.join(workspace, "updater"),
    automaticInstallationEnabled: false,
  });
}

test("a signed release is offered first and only downloaded when asked for", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const feed = feedWith({
      [`${FEED}latest.json`]: () => jsonResponse(signedRelease(releaseObject(), privateKey)),
      [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const service = serviceOn(provider, workspace, publicPem);

    // The check reads the manifest and stops. Nobody has agreed to a download,
    // so no installer byte is fetched: an accountant mid-invoice is not made to
    // share their connection with a background transfer.
    const offered = await service.checkForUpdates();
    expect(offered.status).toMatchObject({ phase: "available", availableVersion: "2.2.0", source: "https" });
    expect(offered.status.availableRelease.notes).toEqual(["Correction de bugs"]);
    expect(offered.pending).toBeUndefined();
    expect(feed.requested).toEqual([`${FEED}latest.json`]);

    const progress = [];
    const ready = await service.downloadOfferedUpdate();
    expect(ready.status).toMatchObject({ phase: "ready", availableVersion: "2.2.0" });
    expect(fs.existsSync(ready.pending.artifactPath)).toBe(true);
    expect(feed.requested).toContain(`${FEED}2.2.0/WheatSetup-2.2.0.exe`);
    expect(progress).toEqual([]);

    const log = fs.readFileSync(path.join(workspace, "updater", "updater.log"), "utf8");
    expect(log).toContain("signature-valid");
    expect(log).toContain("download-started");
    expect(log).toContain("artifact-valid");
    expect(log).toContain("update-ready");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("real download progress is reported, and never invented", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const feed = feedWith({
      [`${FEED}latest.json`]: () => jsonResponse(signedRelease(releaseObject(), privateKey)),
      [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const seen = [];
    const service = new updater.UpdateService({
      currentVersion: "2.1.0",
      provider,
      publicKey: publicPem,
      stateDirectory: path.join(workspace, "updater"),
      automaticInstallationEnabled: false,
      onStatus: (status) => { if (status.download) seen.push(status.download); },
    });
    await service.checkForUpdates();
    await service.downloadOfferedUpdate();

    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    // The figures are the bytes actually written, not a timer.
    expect(last.transferredBytes).toBe(ARTIFACT_BYTES.length);
    expect(last.totalBytes).toBe(ARTIFACT_BYTES.length);
    expect(last.percent).toBe(100);
    expect(seen.every((entry) => entry.transferredBytes <= ARTIFACT_BYTES.length)).toBe(true);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an unsigned release over HTTPS is refused and never downloaded", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem } = keyPair();
    const feed = feedWith({
      [`${FEED}latest.json`]: () => jsonResponse(releaseObject()),
      [`${FEED}2.2.0/WheatSetup-2.2.0.exe`]: () => bytesResponse(ARTIFACT_BYTES),
    });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const result = await serviceOn(provider, workspace, publicPem).checkForUpdates();

    expect(result.status.phase).toBe("error");
    expect(result.status.error).toMatch(/not signed/);
    expect(feed.requested).toEqual([`${FEED}latest.json`]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("an HTTPS channel with no signing key refuses everything rather than trusting it", async () => {
  const workspace = temporaryDirectory();
  try {
    const { privateKey } = keyPair();
    const feed = feedWith({ [`${FEED}latest.json`]: () => jsonResponse(signedRelease(releaseObject(), privateKey)) });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const result = await serviceOn(provider, workspace, null).checkForUpdates();
    expect(result.status.error).toMatch(/No Wheat release signing key is configured/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("the unattended launch check stays quiet when the machine is offline", async () => {
  const workspace = temporaryDirectory();
  try {
    // Wheat is local-first and must be usable with no connection at all. An
    // automatic check that could not reach the server has learned nothing, so
    // it must not put a permanent error in front of the user.
    const provider = new updater.HttpsUpdateProvider(FEED, {
      fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
    });
    const service = serviceOn(provider, workspace, keyPair().publicPem);
    const result = await service.checkForUpdates({ automatic: true });

    expect(result.status.phase).not.toBe("error");
    expect(result.status.error).toBeUndefined();
    // The reason is still recorded where a developer can find it.
    expect(fs.readFileSync(path.join(workspace, "updater", "updater.log"), "utf8")).toContain("check-unreachable");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a check the user asked for reports that the server is unreachable", async () => {
  const workspace = temporaryDirectory();
  try {
    const provider = new updater.HttpsUpdateProvider(FEED, {
      fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
    });
    const result = await serviceOn(provider, workspace, keyPair().publicPem).checkForUpdates();
    expect(result.status.phase).toBe("error");
    expect(result.status.error).toMatch(/could not be reached/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a rejected update is still reported to an automatic check", async () => {
  const workspace = temporaryDirectory();
  try {
    // Silence is only for the network. A manifest that fails verification is a
    // real finding and must surface however the check was started.
    const attacker = keyPair();
    const feed = feedWith({ [`${FEED}latest.json`]: () => jsonResponse(signedRelease(releaseObject(), attacker.privateKey)) });
    const provider = new updater.HttpsUpdateProvider(FEED, { fetchImpl: feed.fetchImpl });
    const result = await serviceOn(provider, workspace, keyPair().publicPem).checkForUpdates({ automatic: true });
    expect(result.status.phase).toBe("error");
    expect(result.status.error).toMatch(/failed signature verification/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------- channel ---- */

test("an unpackaged build with nothing configured uses the local folder", () => {
  // The developer and rehearsal channel: `npm run update:package` fills it, and
  // it is how a release is tried before anybody publishes it.
  const channel = updater.resolveUpdateChannel({ isPackaged: false, localDirectory: os.tmpdir(), env: {} });
  expect(channel.provider.name).toBe("local");
  expect(channel.source).toMatchObject({ kind: "local" });
});

test("a packaged build uses the GitHub releases of the repository in package.json", () => {
  const channel = updater.resolveUpdateChannel({ isPackaged: true, localDirectory: os.tmpdir(), env: {} });
  expect(channel.provider.name).toBe("github");
  expect(channel.source).toMatchObject(updater.WHEAT_RELEASE_REPOSITORY);
  expect(channel.provider.description).toBe(`${updater.WHEAT_RELEASE_REPOSITORY.url}/releases`);
});

test("a configured feed selects the HTTPS channel", () => {
  const env = { WHEAT_UPDATE_FEED_URL: FEED, WHEAT_UPDATE_PUBLIC_KEY: keyPair().publicPem };
  const channel = updater.resolveUpdateChannel({ isPackaged: false, localDirectory: os.tmpdir(), env });
  expect(channel.provider.name).toBe("https");
  expect(channel.publicKey).toContain("BEGIN PUBLIC KEY");
  expect(channel.misconfiguration).toBeUndefined();
});

test("a network channel is never silently downgraded when it cannot be verified", () => {
  const channel = updater.resolveUpdateChannel({ isPackaged: false, localDirectory: os.tmpdir(), env: { WHEAT_UPDATE_FEED_URL: FEED } });
  // Falling back to the local folder would turn a deployment mistake into a
  // silently weaker update path, so the HTTPS provider is kept either way.
  expect(channel.provider.name).toBe("https");

  if (updater.WHEAT_UPDATE_PUBLIC_KEY === "") {
    // An unconfigured build keeps the provider and refuses every manifest for
    // want of a key, saying so rather than quietly doing something weaker.
    expect(channel.publicKey).toBeNull();
    expect(channel.misconfiguration).toMatch(/no release signing key/);
  } else {
    // A configured build has nothing to report: the channel can verify.
    expect(channel.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(channel.misconfiguration).toBeUndefined();
  }
});

test("an unusable feed URL leaves Wheat with a working local channel and a reason", () => {
  const channel = updater.resolveUpdateChannel({
    isPackaged: false,
    localDirectory: os.tmpdir(),
    env: { WHEAT_UPDATE_FEED_URL: "http://insecure.example.ma/wheat/" },
  });
  expect(channel.provider.name).toBe("local");
  expect(channel.misconfiguration).toMatch(/HTTPS/);
});

test("a packaged build ignores an update source from the environment", () => {
  // Otherwise a variable in a user's shell could point an installed Wheat at
  // another release host. A packaged Wheat trusts only what it was built with.
  const env = { WHEAT_UPDATE_FEED_URL: FEED, WHEAT_UPDATE_REPOSITORY: "https://github.com/attacker/wheat" };
  const channel = updater.resolveUpdateChannel({ isPackaged: true, localDirectory: os.tmpdir(), env });
  expect(channel.provider.name).toBe("github");
  expect(channel.source).toMatchObject(updater.WHEAT_RELEASE_REPOSITORY);
});
