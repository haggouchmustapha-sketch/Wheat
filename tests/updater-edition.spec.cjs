const { test, expect } = require("@playwright/test");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Editions and the updater.
 *
 * One release publishes both installers. Every installed Wheat has to pick its
 * own out of it — always, and never by reading a file name or guessing. Getting
 * this wrong is not cosmetic: a Lightweight machine would receive a gigabyte of
 * local recognition runtime it has no room for, and a Standard machine would
 * silently lose the local recognition it was using.
 *
 * Nothing here touches the network.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let updater;
let manifestLib;

test.beforeAll(async () => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
  manifestLib = await import(new URL(`file:///${path.join(root, "scripts", "lib", "releaseManifest.mjs").replaceAll("\\", "/")}`).href);
});

const STANDARD_BYTES = Buffer.from("the Standard installer, with the recognition runtime inside it");
const LIGHTWEIGHT_BYTES = Buffer.from("the Lightweight installer");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
}

function twoEditionRelease(overrides = {}) {
  return {
    schemaVersion: 1,
    version: "2.7.0",
    releaseDate: "2026-09-15",
    notes: ["Deux éditions, une seule comptabilité."],
    // The top-level fields stay the Standard installer, for every Wheat
    // released before editions existed.
    artifact: "Wheat-Standard-2.7.0-Setup.exe",
    sha256: digest(STANDARD_BYTES),
    artifactSize: STANDARD_BYTES.length,
    editions: {
      standard: { artifact: "Wheat-Standard-2.7.0-Setup.exe", sha256: digest(STANDARD_BYTES), artifactSize: STANDARD_BYTES.length },
      lightweight: { artifact: "Wheat-Lightweight-2.7.0-Setup.exe", sha256: digest(LIGHTWEIGHT_BYTES), artifactSize: LIGHTWEIGHT_BYTES.length },
    },
    ...overrides,
  };
}

/** Signs the editions map exactly as the release tooling does. */
function signedEditions(release, privateKey) {
  const normalised = updater.validateReleaseManifest(release);
  const payload = Buffer.from(updater.canonicalEditionsPayload(normalised), "utf8");
  return { algorithm: "ed25519", value: sign(null, payload, privateKey).toString("base64") };
}

function project(release, edition, key, { requiresSignature = true } = {}) {
  return updater.projectReleaseForEdition(updater.validateReleaseManifest(release), {
    edition,
    publicKey: key,
    requiresSignature,
  });
}

/* ---------------------------------------------------------- manifest shape */

test("a per-edition installer map is validated as strictly as the artifact itself", () => {
  const cases = [
    [{ standard: { artifact: "../escape.exe", sha256: digest(STANDARD_BYTES) } }, /unsafe artifact path/i],
    [{ standard: { artifact: "C:/absolute.exe", sha256: digest(STANDARD_BYTES) } }, /unsafe artifact path/i],
    [{ standard: { artifact: "setup.msi", sha256: digest(STANDARD_BYTES) } }, /NSIS \.exe/i],
    [{ standard: { artifact: "setup.exe", sha256: "not-a-digest" } }, /invalid SHA-256/i],
    [{ standard: { artifact: "setup.exe", sha256: digest(STANDARD_BYTES), artifactSize: -1 } }, /invalid artifactSize/i],
    [{ premium: { artifact: "setup.exe", sha256: digest(STANDARD_BYTES) } }, /unknown Wheat edition/i],
    [{}, /empty editions map/i],
    ["not an object", /invalid editions map/i],
  ];
  for (const [editions, message] of cases) {
    expect(() => updater.validateReleaseManifest(twoEditionRelease({ editions }))).toThrow(message);
  }
});

test("a manifest with no editions map is still accepted, so old releases keep working", () => {
  const release = twoEditionRelease();
  delete release.editions;
  const validated = updater.validateReleaseManifest(release);
  expect(validated.editions).toBeUndefined();
});

test("signing an editions map that is not there is refused", () => {
  const release = twoEditionRelease();
  delete release.editions;
  release.editionsSignature = { algorithm: "ed25519", value: "AAAA" };
  expect(() => updater.validateReleaseManifest(release)).toThrow(/signs an editions map it does not contain/i);
});

/* ------------------------------------------------------------- projection */

test("each edition receives its own artifact, digest and size", () => {
  const { publicPem, privateKey } = keyPair();
  const release = twoEditionRelease();
  release.editionsSignature = signedEditions(release, privateKey);

  const standard = project(release, "standard", publicPem);
  expect(standard.artifact).toBe("Wheat-Standard-2.7.0-Setup.exe");
  expect(standard.sha256).toBe(digest(STANDARD_BYTES));
  expect(standard.artifactSize).toBe(STANDARD_BYTES.length);

  const lightweight = project(release, "lightweight", publicPem);
  expect(lightweight.artifact).toBe("Wheat-Lightweight-2.7.0-Setup.exe");
  expect(lightweight.sha256).toBe(digest(LIGHTWEIGHT_BYTES));
  expect(lightweight.artifactSize).toBe(LIGHTWEIGHT_BYTES.length);

  // One release, one version, one set of notes — the edition is separate
  // metadata and never a separate version number.
  expect(lightweight.version).toBe(standard.version);
  expect(lightweight.notes).toEqual(standard.notes);
});

test("an edition never inherits the other edition's declared size", () => {
  const { publicPem, privateKey } = keyPair();
  const release = twoEditionRelease();
  delete release.editions.lightweight.artifactSize;
  release.editionsSignature = signedEditions(release, privateKey);
  const lightweight = project(release, "lightweight", publicPem);
  // Inheriting the top-level (Standard) size would make the download enforce a
  // length against the wrong file and fail every single time.
  expect(lightweight.artifactSize).toBeUndefined();
});

test("Lightweight refuses a release that publishes no Lightweight installer", () => {
  const { publicPem, privateKey } = keyPair();
  const release = twoEditionRelease();
  delete release.editions.lightweight;
  release.editionsSignature = signedEditions(release, privateKey);
  expect(() => project(release, "lightweight", publicPem)).toThrow(/ne publie pas d'installateur pour l'édition lightweight/i);
});

test("Lightweight refuses a pre-edition release rather than installing Standard over itself", () => {
  const release = twoEditionRelease();
  delete release.editions;
  expect(() => project(release, "lightweight", null)).toThrow(/n'installe jamais l'autre édition/i);
});

test("Standard reads a pre-edition release exactly as it always did", () => {
  const release = twoEditionRelease();
  delete release.editions;
  const projected = project(release, "standard", null);
  expect(projected.artifact).toBe("Wheat-Standard-2.7.0-Setup.exe");
  expect(projected.sha256).toBe(digest(STANDARD_BYTES));
});

/* -------------------------------------------------------------- signatures */

test("an unsigned editions map is refused on a channel that requires signatures", () => {
  const { publicPem } = keyPair();
  expect(() => project(twoEditionRelease(), "lightweight", publicPem)).toThrow(/not signed/i);
});

test("an editions map signed by the wrong key is refused", () => {
  const { privateKey } = keyPair();
  const other = keyPair();
  const release = twoEditionRelease();
  release.editionsSignature = signedEditions(release, privateKey);
  expect(() => project(release, "lightweight", other.publicPem)).toThrow(/failed signature verification/i);
});

test("a tampered edition artifact invalidates the signature", () => {
  const { publicPem, privateKey } = keyPair();
  const release = twoEditionRelease();
  release.editionsSignature = signedEditions(release, privateKey);
  // Exactly the attack the signature exists to stop: swap which bytes a
  // Lightweight install is told to download.
  release.editions.lightweight.sha256 = digest(Buffer.from("something else entirely"));
  expect(() => project(release, "lightweight", publicPem)).toThrow(/failed signature verification/i);
});

test("an editions signature cannot be lifted onto a different release", () => {
  const { publicPem, privateKey } = keyPair();
  const original = twoEditionRelease();
  const signature = signedEditions(original, privateKey);
  // The payload is bound to the version, so a signature minted for 2.7.0 says
  // nothing about 2.8.0 even with an identical editions map.
  const replayed = twoEditionRelease({ version: "2.8.0", editionsSignature: signature });
  expect(() => project(replayed, "lightweight", publicPem)).toThrow(/failed signature verification/i);
});

test("a local rehearsal folder may serve an unsigned editions map", () => {
  // The same rule the manifest itself follows: a folder inside the user's own
  // profile is trusted by other means, anything off a network is not.
  const projected = project(twoEditionRelease(), "lightweight", null, { requiresSignature: false });
  expect(projected.artifact).toBe("Wheat-Lightweight-2.7.0-Setup.exe");
});

/* ------------------------------------------- tooling / application agreement */

test("the release tooling and the application sign the same editions bytes", () => {
  // Two implementations of one payload eventually differ, and the failure mode
  // of differing about a signature is every installed Wheat refusing every
  // update. So one signs and the other verifies.
  const { publicPem, privateKey } = keyPair();
  const release = twoEditionRelease();
  const normalised = updater.validateReleaseManifest(release);

  const toolingPayload = manifestLib.canonicalEditionsPayload({
    version: normalised.version,
    editions: Object.fromEntries(Object.entries(normalised.editions).map(([id, entry]) => [id, {
      artifact: entry.artifact,
      sha256: entry.sha256,
      artifactSize: entry.artifactSize,
    }])),
  });
  expect(toolingPayload).toBe(updater.canonicalEditionsPayload(normalised));

  release.editionsSignature = { algorithm: "ed25519", value: sign(null, Buffer.from(toolingPayload, "utf8"), privateKey).toString("base64") };
  expect(() => project(release, "lightweight", publicPem)).not.toThrow();
});

test("the base signature keeps covering exactly what it covered before editions existed", () => {
  // Enlarging the existing payload would make every installed Wheat reject
  // every future release, which is why the editions map carries its own.
  const withEditions = updater.validateReleaseManifest(twoEditionRelease());
  const plain = twoEditionRelease();
  delete plain.editions;
  expect(updater.canonicalReleasePayload(withEditions)).toBe(updater.canonicalReleasePayload(updater.validateReleaseManifest(plain)));
});

/* --------------------------------------------------------------- tooling */

test("buildReleaseManifest emits both editions and keeps Standard on top", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-editions-"));
  const standardPath = path.join(directory, "Wheat-Standard-2.7.0-Setup.exe");
  const lightweightPath = path.join(directory, "Wheat-Lightweight-2.7.0-Setup.exe");
  fs.writeFileSync(standardPath, STANDARD_BYTES);
  fs.writeFileSync(lightweightPath, LIGHTWEIGHT_BYTES);

  const manifest = await manifestLib.buildReleaseManifest({
    version: "2.7.0",
    artifactPath: standardPath,
    notes: ["Deux éditions."],
    layout: "flat",
    editionArtifacts: [
      { edition: "standard", path: standardPath },
      { edition: "lightweight", path: lightweightPath },
    ],
  });

  expect(manifest.artifact).toBe("Wheat-Standard-2.7.0-Setup.exe");
  expect(manifest.sha256).toBe(digest(STANDARD_BYTES));
  expect(manifest.editions.standard.sha256).toBe(digest(STANDARD_BYTES));
  expect(manifest.editions.lightweight.sha256).toBe(digest(LIGHTWEIGHT_BYTES));
  // And the application accepts what the tooling produced.
  expect(() => updater.validateReleaseManifest(manifest)).not.toThrow();
  fs.rmSync(directory, { recursive: true, force: true });
});

/* --------------------------------------------- the service, end to end ---- */

test("the running service downloads its own edition's bytes, not the other's", async () => {
  /*
   * The projection tested above only matters if the service actually applies
   * it. So this drives the real check → download path twice against one
   * two-edition feed and looks at what landed on disk.
   */
  const fs = require("node:fs");
  const os = require("node:os");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-edition-feed-"));
  const feed = path.join(workspace, "updates");
  const releaseDirectory = path.join(feed, "2.7.0");
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(releaseDirectory, "Wheat-Standard-2.7.0-Setup.exe"), STANDARD_BYTES);
  fs.writeFileSync(path.join(releaseDirectory, "Wheat-Lightweight-2.7.0-Setup.exe"), LIGHTWEIGHT_BYTES);

  const manifest = twoEditionRelease({
    artifact: "2.7.0/Wheat-Standard-2.7.0-Setup.exe",
    editions: {
      standard: { artifact: "2.7.0/Wheat-Standard-2.7.0-Setup.exe", sha256: digest(STANDARD_BYTES), artifactSize: STANDARD_BYTES.length },
      lightweight: { artifact: "2.7.0/Wheat-Lightweight-2.7.0-Setup.exe", sha256: digest(LIGHTWEIGHT_BYTES), artifactSize: LIGHTWEIGHT_BYTES.length },
    },
  });
  fs.writeFileSync(path.join(feed, "latest.json"), JSON.stringify(manifest));

  const staged = {};
  for (const edition of ["standard", "lightweight"]) {
    const service = new updater.UpdateService({
      currentVersion: "2.6.0",
      edition,
      provider: new updater.LocalUpdateProvider(feed),
      stateDirectory: path.join(workspace, "profile", edition),
      automaticInstallationEnabled: false,
    });
    const offered = await service.checkForUpdates();
    expect(offered.status.phase).toBe("available");
    // One release, one version, whichever edition is asking.
    expect(offered.status.availableVersion).toBe("2.7.0");

    const downloaded = await service.downloadOfferedUpdate();
    expect(downloaded.status.phase).toBe("ready");
    staged[edition] = fs.readFileSync(downloaded.pending.artifactPath);
    expect(path.basename(downloaded.pending.artifactPath)).toContain(edition === "standard" ? "Standard" : "Lightweight");
  }

  // The bytes themselves, not just the file names.
  expect(staged.standard.equals(STANDARD_BYTES)).toBe(true);
  expect(staged.lightweight.equals(LIGHTWEIGHT_BYTES)).toBe(true);
  expect(staged.standard.equals(staged.lightweight)).toBe(false);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("a Lightweight install is never offered a release it cannot install", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-edition-feed-"));
  const feed = path.join(workspace, "updates");
  const releaseDirectory = path.join(feed, "2.7.0");
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(releaseDirectory, "Wheat-Standard-2.7.0-Setup.exe"), STANDARD_BYTES);

  const manifest = twoEditionRelease({ artifact: "2.7.0/Wheat-Standard-2.7.0-Setup.exe" });
  delete manifest.editions;
  fs.writeFileSync(path.join(feed, "latest.json"), JSON.stringify(manifest));

  const service = new updater.UpdateService({
    currentVersion: "2.6.0",
    edition: "lightweight",
    provider: new updater.LocalUpdateProvider(feed),
    stateDirectory: path.join(workspace, "profile"),
    automaticInstallationEnabled: false,
  });
  const checked = await service.checkForUpdates();
  // Reported as a problem to look at, never as an offer to accept — and above
  // all never as a Standard installer for a Lightweight machine.
  expect(checked.status.phase).toBe("error");
  expect(checked.status.error).toMatch(/n'installe jamais l'autre édition/i);
  expect(checked.status.availableVersion).toBeUndefined();

  fs.rmSync(workspace, { recursive: true, force: true });
});
