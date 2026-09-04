const { test, expect } = require("@playwright/test");
const { createPublicKey } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Release-manifest signing, and the HTTPS channel that depends on it.
 *
 * Nothing here touches the network: `fetchImpl` is injected into the provider
 * and every response is a literal object. Keys are generated per test, so no
 * fixture key ever exists on disk.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let updater;

test.beforeAll(() => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-update-signature-"));
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const ARTIFACT_BYTES = Buffer.from("valid Wheat installer bytes");

function releaseObject(overrides = {}) {
  const version = overrides.version ?? "2.2.0";
  return {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-30",
    notes: ["Correction de bugs", "Wheat AI: relecture des documents"],
    artifact: `${version}/WheatSetup-${version}.exe`,
    sha256: createHash("sha256").update(ARTIFACT_BYTES).digest("hex"),
    artifactSize: ARTIFACT_BYTES.length,
    ...overrides,
  };
}

/** Signs exactly as the application expects, using the app's own payload rule. */
function signed(release, privateKey) {
  const normalised = updater.validateReleaseManifest(release);
  const payload = Buffer.from(updater.canonicalReleasePayload(normalised), "utf8");
  return { ...release, signature: { algorithm: "ed25519", value: sign(null, payload, privateKey).toString("base64") } };
}

/* ------------------------------------------------------------- signing ----- */

test("a manifest signed with the release key verifies", () => {
  const { publicPem, privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  expect(() => updater.verifyReleaseSignature(release, publicPem)).not.toThrow();
});

test("a manifest signed by a different key is rejected", () => {
  const mine = keyPair();
  const attacker = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), attacker.privateKey));
  expect(() => updater.verifyReleaseSignature(release, mine.publicPem)).toThrow(/failed signature verification/);
});

test("every field the installer acts on is covered by the signature", () => {
  const { publicPem, privateKey } = keyPair();
  const original = signed(releaseObject(), privateKey);

  // Each of these changes what Wheat downloads, installs, or tells the user it
  // is installing, so each must invalidate the signature.
  const tampered = {
    version: { version: "9.9.9" },
    checksum: { sha256: createHash("sha256").update("attacker bytes").digest("hex") },
    artifact: { artifact: "2.2.0/OtherSetup.exe" },
    size: { artifactSize: ARTIFACT_BYTES.length + 1 },
    notes: { notes: ["Mise a jour de securite urgente"] },
    releaseDate: { releaseDate: "2026-09-01" },
    minimumVersion: { minimumVersion: "2.0.0" },
  };
  for (const [field, patch] of Object.entries(tampered)) {
    const release = updater.validateReleaseManifest({ ...original, ...patch });
    expect(() => updater.verifyReleaseSignature(release, publicPem), field).toThrow(/failed signature verification/);
  }
});

test("stripping the signature is a rejection, never a pass", () => {
  const { publicPem, privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  delete release.signature;
  expect(() => updater.verifyReleaseSignature(release, publicPem)).toThrow(/not signed/);
});

test("an unconfigured signing key fails closed", () => {
  const { privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  expect(() => updater.verifyReleaseSignature(release, null)).toThrow(/No Wheat release signing key is configured/);
  expect(() => updater.verifyReleaseSignature(release, "")).toThrow(/No Wheat release signing key is configured/);
});

test("the algorithm is pinned, so a manifest cannot name a weaker one", () => {
  const { publicPem, privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  release.signature.algorithm = "none";
  expect(() => updater.verifyReleaseSignature(release, publicPem)).toThrow(/Unsupported update signature algorithm/);
});

test("a malformed signature is rejected without reaching the verifier", () => {
  const { publicPem, privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  for (const value of ["", "not base64!!", Buffer.alloc(8).toString("base64")]) {
    const candidate = { ...release, signature: { algorithm: "ed25519", value } };
    // An empty value is caught by the manifest schema; the rest by length.
    expect(() => updater.verifyReleaseSignature(candidate, publicPem)).toThrow();
  }
});

test("the signing script and the application agree on what is signed", () => {
  // The payload rule is implemented twice — once in TypeScript for the app,
  // once in the packaging script, which runs under plain node and cannot import
  // it. This is the test that keeps the two from drifting apart.
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privatePem } = keyPair();
    const keyPath = path.join(workspace, "release-key.pem");
    fs.writeFileSync(keyPath, privatePem);

    const productVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    const artifact = path.join(workspace, `WheatSetup-${productVersion}.exe`);
    const notes = path.join(workspace, "notes.md");
    fs.writeFileSync(artifact, ARTIFACT_BYTES);
    fs.writeFileSync(notes, `# Wheat ${productVersion}\n- Correction de bugs\n- Deuxieme note\n`);
    const feed = path.join(workspace, "feed");

    execFileSync(process.execPath, [
      path.join(root, "scripts", "package-update.mjs"),
      "--artifact", artifact,
      "--notes-file", notes,
      "--output", feed,
      "--sign", keyPath,
      "--no-publish",
    ], { cwd: root, stdio: "pipe" });

    const published = JSON.parse(fs.readFileSync(path.join(feed, "latest.json"), "utf8"));
    expect(published.signature.algorithm).toBe("ed25519");
    const release = updater.validateReleaseManifest(published);
    expect(() => updater.verifyReleaseSignature(release, publicPem)).not.toThrow();
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("the key generator produces a usable pair and refuses to overwrite one", () => {
  const workspace = temporaryDirectory();
  try {
    const keyPath = path.join(workspace, "release-key.pem");
    const output = execFileSync(process.execPath, [
      path.join(root, "scripts", "generate-update-key.mjs"), "--out", keyPath,
    ], { cwd: root, stdio: "pipe" }).toString();

    expect(output).toContain("WHEAT_UPDATE_PUBLIC_KEY");
    const publicPem = output.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/)[0];
    const privateKey = require("node:crypto").createPrivateKey(fs.readFileSync(keyPath, "utf8"));
    const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
    expect(() => updater.verifyReleaseSignature(release, publicPem)).not.toThrow();

    // A signing key is not something to clobber by rerunning a command.
    expect(() => execFileSync(process.execPath, [
      path.join(root, "scripts", "generate-update-key.mjs"), "--out", keyPath,
    ], { cwd: root, stdio: "pipe" })).toThrow(/already exists|Refusing/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("the compiled-in key is either absent or genuinely usable, never decorative", () => {
  // A key that looks configured but cannot be parsed is the worst of the three
  // states: it passes every eyeball check and then refuses every update at
  // runtime, on the accountant's machine, with nothing to point at. This is the
  // check that turns that into a build-time failure — it caught exactly that,
  // a public key pasted without its BEGIN/END lines.
  const compiled = updater.WHEAT_UPDATE_PUBLIC_KEY;
  if (compiled === "") return; // Unconfigured fails closed, which is a valid state.

  expect(compiled).toContain("-----BEGIN PUBLIC KEY-----");
  expect(compiled).toContain("-----END PUBLIC KEY-----");
  expect(createPublicKey(compiled).asymmetricKeyType).toBe("ed25519");

  // And it must behave as a real verifier: a release signed by anyone else is
  // rejected, which is the only property that matters to an installed Wheat.
  const { privateKey } = keyPair();
  const release = updater.validateReleaseManifest(signed(releaseObject(), privateKey));
  expect(() => updater.verifyReleaseSignature(release, compiled)).toThrow(/failed signature verification/);
});

test("a packaged build ignores a signing key from the environment", () => {
  // Otherwise a variable in a user's shell could redirect trust.
  const env = { WHEAT_UPDATE_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----" };
  expect(updater.resolveUpdatePublicKey({ isPackaged: true, env })).toBe(updater.WHEAT_UPDATE_PUBLIC_KEY || null);
  expect(updater.resolveUpdatePublicKey({ isPackaged: false, env })).toContain("BEGIN PUBLIC KEY");
});

/* ------------------------------------------------- signatures in the service */

function serviceWith(provider, { publicKey = null, stateDirectory, currentVersion = "2.1.0" }) {
  return new updater.UpdateService({ currentVersion, provider, stateDirectory, automaticInstallationEnabled: false, publicKey });
}

/** A provider double that serves one manifest and one artifact from memory. */
function memoryProvider(release, { requiresSignature = true } = {}) {
  return {
    name: "memory",
    requiresSignature,
    async getLatestRelease() { return updater.validateReleaseManifest(release); },
    async acquireUpdate(accepted, stagingDirectory) {
      fs.mkdirSync(stagingDirectory, { recursive: true });
      const artifactPath = path.join(stagingDirectory, "WheatSetup.exe");
      fs.writeFileSync(artifactPath, ARTIFACT_BYTES);
      return { release: accepted, artifactPath };
    },
    async validateUpdate(update) { await updater.verifyStagedArtifact(update.artifactPath, update.release); },
  };
}

test("a signature-requiring channel stages a correctly signed release", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const service = serviceWith(memoryProvider(signed(releaseObject(), privateKey)), {
      publicKey: publicPem,
      stateDirectory: path.join(workspace, "updater"),
    });
    const offered = await service.checkForUpdates();
    expect(offered.status).toMatchObject({ phase: "available", availableVersion: "2.2.0" });
    const result = await service.downloadOfferedUpdate();
    expect(result.status).toMatchObject({ phase: "ready", availableVersion: "2.2.0" });
    expect(fs.readFileSync(path.join(workspace, "updater", "updater.log"), "utf8")).toContain("signature-valid");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a signature-requiring channel refuses an unsigned release and downloads nothing", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem } = keyPair();
    const provider = memoryProvider(releaseObject());
    let downloaded = 0;
    const counting = { ...provider, acquireUpdate: (...args) => { downloaded += 1; return provider.acquireUpdate(...args); } };
    const service = serviceWith(counting, { publicKey: publicPem, stateDirectory: path.join(workspace, "updater") });

    const result = await service.checkForUpdates();
    expect(result.status.phase).toBe("error");
    expect(result.status.error).toMatch(/not signed/);
    // Verification happens before acquisition: nothing is fetched on the word
    // of a manifest that has not been authenticated.
    expect(downloaded).toBe(0);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("a local channel keeps working unsigned but still verifies a signature it is given", async () => {
  const workspace = temporaryDirectory();
  try {
    const { publicPem, privateKey } = keyPair();
    const unsigned = serviceWith(memoryProvider(releaseObject(), { requiresSignature: false }), {
      publicKey: publicPem,
      stateDirectory: path.join(workspace, "a"),
    });
    expect((await unsigned.checkForUpdates()).status.phase).toBe("available");
    expect((await unsigned.downloadOfferedUpdate()).status.phase).toBe("ready");

    // Present but wrong must fail, or a signature would be decorative.
    const attacker = keyPair();
    const badlySigned = serviceWith(memoryProvider(signed(releaseObject(), attacker.privateKey), { requiresSignature: false }), {
      publicKey: publicPem,
      stateDirectory: path.join(workspace, "b"),
    });
    expect((await badlySigned.checkForUpdates()).status.error).toMatch(/failed signature verification/);

    const properlySigned = serviceWith(memoryProvider(signed(releaseObject(), privateKey), { requiresSignature: false }), {
      publicKey: publicPem,
      stateDirectory: path.join(workspace, "c"),
    });
    expect((await properlySigned.checkForUpdates()).status.phase).toBe("available");
    expect((await properlySigned.downloadOfferedUpdate()).status.phase).toBe("ready");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("the existing local provider declares that it does not require a signature", () => {
  expect(new updater.LocalUpdateProvider(os.tmpdir()).requiresSignature).toBe(false);
  expect(new updater.HttpsUpdateProvider("https://updates.example.ma/wheat/").requiresSignature).toBe(true);
});
