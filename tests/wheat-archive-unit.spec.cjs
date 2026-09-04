const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const archiver = require("archiver");
const unzipper = require("unzipper");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const archiveModulePath = path.join(cwd, "electron", "archive.ts");
const temporaryDirectories = [];
let wheatArchive;

function makeTempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createSqliteDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE Company (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE Document (
      id TEXT PRIMARY KEY,
      companyId TEXT NOT NULL REFERENCES Company(id),
      storedPath TEXT
    );
    INSERT INTO Company VALUES ('company-1', 'Wheat Test');
    INSERT INTO Document VALUES ('document-1', 'company-1', 'documents/recu.txt');
  `);
  database.close();
}

function manifestFor(files, overrides = {}) {
  return {
    format: "wheat-backup",
    version: 1,
    backupId: randomUUID(),
    createdAt: "2026-08-12T12:00:00.000Z",
    appVersion: "1.2.0-test",
    files,
    ...overrides,
  };
}

function fileManifest(archivePath, kind, content, overrides = {}) {
  return {
    path: archivePath,
    kind,
    size: content.length,
    sha256: sha256(content),
    ...overrides,
  };
}

async function writeRawArchive(archivePath, entries) {
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  const output = fs.createWriteStream(archivePath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.once("warning", reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.content, {
      name: entry.name,
      mode: entry.mode ?? 0o600,
      date: new Date("2000-01-01T00:00:00.000Z"),
    });
  }
  await archive.finalize();
  await completed;
}

async function archiveEntryNames(archivePath) {
  const directory = await unzipper.Open.file(archivePath);
  return directory.files.map((entry) => entry.path);
}

function rewriteZipEntryName(archivePath, originalName, replacementName) {
  expect(Buffer.byteLength(originalName)).toBe(Buffer.byteLength(replacementName));
  const archiveBytes = fs.readFileSync(archivePath);
  const originalBytes = Buffer.from(originalName);
  const replacementBytes = Buffer.from(replacementName);
  let replacements = 0;
  let offset = 0;
  while ((offset = archiveBytes.indexOf(originalBytes, offset)) >= 0) {
    replacementBytes.copy(archiveBytes, offset);
    offset += replacementBytes.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThanOrEqual(2); // local header and central-directory record
  fs.writeFileSync(archivePath, archiveBytes);
}

test.beforeAll(async () => {
  wheatArchive = tsxRequire(archiveModulePath, __filename);
});

test.afterEach(async () => {
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test.describe.configure({ mode: "serial" });

test("creates, validates, and stages a complete managed Wheat backup without collecting unrelated files", async () => {
  const root = makeTempDirectory("atlas-1-2-archive-valid-");
  const databasePath = path.join(root, "live", "wheat.sqlite");
  const attachmentsRoot = path.join(root, "live", "attachments");
  const destinationPath = path.join(root, "exports", "atlas-full.atlasbackup");
  const stagingParent = path.join(root, "restore-staging");
  createSqliteDatabase(databasePath);
  fs.mkdirSync(path.join(attachmentsRoot, "documents"), { recursive: true });
  fs.writeFileSync(path.join(attachmentsRoot, "documents", "recu.txt"), "Reçu Atlas — 1250,00 MAD\n", "utf8");
  fs.writeFileSync(path.join(attachmentsRoot, "documents", "unlisted-private.txt"), "must stay outside backup", "utf8");
  fs.writeFileSync(path.join(attachmentsRoot, "scan.bin"), Buffer.from([0, 1, 2, 3, 255]));

  const created = await wheatArchive.createWheatBackup({
    destinationPath,
    databasePath,
    managedAttachmentsRoot: attachmentsRoot,
    managedAttachmentPaths: ["documents/recu.txt", "scan.bin"],
    appVersion: "1.2.0",
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
    workingDirectory: path.join(root, "create-staging"),
  });

  expect(created.archivePath).toBe(path.resolve(destinationPath));
  expect(created.archiveSize).toBeGreaterThan(0);
  expect(created.manifest.format).toBe("wheat-backup");
  expect(created.manifest.version).toBe(1);
  expect(created.manifest.files.map((file) => [file.kind, file.path])).toEqual([
    ["database", "database/wheat.sqlite"],
    ["attachment", "attachments/documents/recu.txt"],
    ["attachment", "attachments/scan.bin"],
  ]);
  expect((await archiveEntryNames(destinationPath)).sort()).toEqual([
    "attachments/documents/recu.txt",
    "attachments/scan.bin",
    "database/wheat.sqlite",
    "manifest.json",
  ]);

  const validated = await wheatArchive.validateWheatBackup(destinationPath, {
    workingDirectory: path.join(root, "validation-staging"),
  });
  expect(validated.manifest.backupId).toBe(created.manifest.backupId);
  expect(validated.totalPayloadBytes).toBe(created.totalPayloadBytes);
  expect(fs.readdirSync(path.join(root, "validation-staging"))).toEqual([]);

  const sentinelPath = path.join(root, "existing-live-data.txt");
  fs.writeFileSync(sentinelPath, "do not replace", "utf8");
  const staged = await wheatArchive.extractWheatBackupToStaging({ archivePath: destinationPath, stagingParentDirectory: stagingParent });
  expect(staged.stagingDirectory.startsWith(path.resolve(stagingParent))).toBe(true);
  expect(fs.readFileSync(staged.databasePath).subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
  expect(fs.readFileSync(path.join(staged.attachmentsDirectory, "documents", "recu.txt"), "utf8")).toContain("1250,00 MAD");
  expect(fs.readFileSync(path.join(staged.attachmentsDirectory, "scan.bin"))).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  expect(fs.existsSync(path.join(staged.attachmentsDirectory, "documents", "unlisted-private.txt"))).toBe(false);
  expect(fs.readFileSync(sentinelPath, "utf8")).toBe("do not replace");
  wheatArchive.validateWheatSqliteDatabase(staged.databasePath);
  await fsp.rm(staged.stagingDirectory, { recursive: true, force: true });

  const originalArchive = fs.readFileSync(destinationPath);
  await expect(wheatArchive.createWheatBackup({
    destinationPath,
    databasePath,
    appVersion: "1.2.0",
  })).rejects.toThrow(/already exists/i);
  expect(fs.readFileSync(destinationPath)).toEqual(originalArchive);
});

test("a backup written before the Wheat rename still validates and restores", async () => {
  const root = makeTempDirectory("wheat-archive-legacy-");
  const databasePath = path.join(root, "valid.sqlite");
  createSqliteDatabase(databasePath);
  const databaseBytes = fs.readFileSync(databasePath);
  // Exactly what Atlas Ledger wrote: the old format marker, and the database
  // stored under the old name inside the archive.
  const manifest = manifestFor([fileManifest("database/atlas-ledger.sqlite", "database", databaseBytes)], {
    format: "atlas-ledger-backup",
  });
  const archivePath = path.join(root, "legacy.atlasbackup");
  await writeRawArchive(archivePath, [
    { name: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
    { name: "database/atlas-ledger.sqlite", content: databaseBytes },
  ]);

  const validated = await wheatArchive.validateWheatBackup(archivePath, {
    workingDirectory: path.join(root, "legacy-staging"),
  });
  // Reported as the format it actually is, rather than relabelled.
  expect(validated.manifest.format).toBe("atlas-ledger-backup");
  expect(validated.manifest.files.map((file) => file.path)).toEqual(["database/atlas-ledger.sqlite"]);

  // Restoring finds the database where that archive really put it.
  const staged = await wheatArchive.extractWheatBackupToStaging({
    archivePath,
    stagingParentDirectory: path.join(root, "legacy-restore"),
  });
  expect(fs.readFileSync(staged.databasePath)).toEqual(databaseBytes);
  wheatArchive.validateWheatSqliteDatabase(staged.databasePath);
  fs.rmSync(staged.stagingDirectory, { recursive: true, force: true });
});

test("rejects traversal, duplicate, case-alias, and prefix-collision ZIP entries before they can escape staging", async () => {
  const root = makeTempDirectory("atlas-1-2-archive-paths-");
  const databasePath = path.join(root, "valid.sqlite");
  createSqliteDatabase(databasePath);
  const databaseBytes = fs.readFileSync(databasePath);
  const baseManifest = manifestFor([
    fileManifest("database/wheat.sqlite", "database", databaseBytes),
  ]);
  const manifestBytes = Buffer.from(JSON.stringify(baseManifest));

  const hostileCases = [
    {
      name: "traversal",
      entries: [
        { name: "manifest.json", content: manifestBytes },
        { name: "database/wheat.sqlite", content: databaseBytes },
        { name: "xx/escaped.txt", content: Buffer.from("escape") },
      ],
      rewrite: ["xx/escaped.txt", "../escaped.txt"],
      message: /relative|unsafe path segment|canonical/i,
    },
    {
      name: "exact-duplicate",
      entries: [
        { name: "manifest.json", content: manifestBytes },
        { name: "database/wheat.sqlite", content: databaseBytes },
        { name: "attachments/same.txt", content: Buffer.from("one") },
        { name: "attachments/same.txt", content: Buffer.from("two") },
      ],
      message: /duplicate|case-colliding/i,
    },
    {
      name: "case-alias",
      entries: [
        { name: "manifest.json", content: manifestBytes },
        { name: "database/wheat.sqlite", content: databaseBytes },
        { name: "attachments/Report.txt", content: Buffer.from("one") },
        { name: "attachments/report.txt", content: Buffer.from("two") },
      ],
      message: /duplicate|case-colliding/i,
    },
    {
      name: "prefix-collision",
      entries: [
        { name: "manifest.json", content: manifestBytes },
        { name: "database/wheat.sqlite", content: databaseBytes },
        { name: "attachments/node", content: Buffer.from("file") },
        { name: "attachments/node/child.txt", content: Buffer.from("child") },
      ],
      message: /prefix collision/i,
    },
  ];

  for (const hostile of hostileCases) {
    const archivePath = path.join(root, `${hostile.name}.atlasbackup`);
    const stagingParent = path.join(root, `${hostile.name}-staging`);
    await writeRawArchive(archivePath, hostile.entries);
    if (hostile.rewrite) rewriteZipEntryName(archivePath, ...hostile.rewrite);
    await expect(wheatArchive.extractWheatBackupToStaging({ archivePath, stagingParentDirectory: stagingParent }))
      .rejects.toThrow(hostile.message);
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
    expect(fs.existsSync(stagingParent) ? fs.readdirSync(stagingParent) : []).toEqual([]);
  }
});

test("rejects unmanifested payloads, checksum tampering, invalid SQLite, and extraction limit violations", async () => {
  const root = makeTempDirectory("atlas-1-2-archive-integrity-");
  const databasePath = path.join(root, "valid.sqlite");
  createSqliteDatabase(databasePath);
  const databaseBytes = fs.readFileSync(databasePath);

  const wrongHashManifest = manifestFor([
    fileManifest("database/wheat.sqlite", "database", databaseBytes, { sha256: "0".repeat(64) }),
  ]);
  const wrongHashArchive = path.join(root, "wrong-hash.atlasbackup");
  await writeRawArchive(wrongHashArchive, [
    { name: "manifest.json", content: Buffer.from(JSON.stringify(wrongHashManifest)) },
    { name: "database/wheat.sqlite", content: databaseBytes },
  ]);
  await expect(wheatArchive.validateWheatBackup(wrongHashArchive)).rejects.toThrow(/SHA-256 verification failed/i);

  const unlistedArchive = path.join(root, "unlisted.atlasbackup");
  const validManifest = manifestFor([fileManifest("database/wheat.sqlite", "database", databaseBytes)]);
  await writeRawArchive(unlistedArchive, [
    { name: "manifest.json", content: Buffer.from(JSON.stringify(validManifest)) },
    { name: "database/wheat.sqlite", content: databaseBytes },
    { name: "attachments/not-in-manifest.txt", content: Buffer.from("surprise") },
  ]);
  await expect(wheatArchive.validateWheatBackup(unlistedArchive)).rejects.toThrow(/absent from its manifest/i);

  const corruptDatabase = Buffer.from("not a SQLite database");
  const corruptArchive = path.join(root, "corrupt-database.atlasbackup");
  const corruptManifest = manifestFor([
    fileManifest("database/wheat.sqlite", "database", corruptDatabase),
  ]);
  await writeRawArchive(corruptArchive, [
    { name: "manifest.json", content: Buffer.from(JSON.stringify(corruptManifest)) },
    { name: "database/wheat.sqlite", content: corruptDatabase },
  ]);
  await expect(wheatArchive.validateWheatBackup(corruptArchive)).rejects.toThrow(/database validation failed/i);

  const sizeLimitedArchive = path.join(root, "size-limit.atlasbackup");
  await writeRawArchive(sizeLimitedArchive, [
    { name: "manifest.json", content: Buffer.from(JSON.stringify(validManifest)) },
    { name: "database/wheat.sqlite", content: databaseBytes },
  ]);
  await expect(wheatArchive.validateWheatBackup(sizeLimitedArchive, {
    limits: { maxFileBytes: 1024, maxManifestBytes: 512 },
  })).rejects.toThrow(/declared size|per-file|size limit/i);

  await expect(wheatArchive.validateWheatBackup(sizeLimitedArchive, {
    limits: { maxEntries: 1 },
  })).rejects.toThrow(/entry-count/i);
});

test("rejects unsafe creation inputs and preserves every existing destination byte", async () => {
  const root = makeTempDirectory("atlas-1-2-archive-create-guards-");
  const databasePath = path.join(root, "wheat.sqlite");
  const attachmentsRoot = path.join(root, "attachments");
  createSqliteDatabase(databasePath);
  fs.mkdirSync(attachmentsRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "outside.txt"), "outside Atlas", "utf8");
  fs.writeFileSync(path.join(attachmentsRoot, "inside.txt"), "managed", "utf8");

  await expect(wheatArchive.createWheatBackup({
    destinationPath: path.join(root, "wrong-extension.zip"),
    databasePath,
    appVersion: "1.2.0",
  })).rejects.toThrow(/\.wheatbackup ou \.atlasbackup/i);

  await expect(wheatArchive.createWheatBackup({
    destinationPath: path.join(root, "traversal.atlasbackup"),
    databasePath,
    managedAttachmentsRoot: attachmentsRoot,
    managedAttachmentPaths: ["../outside.txt"],
    appVersion: "1.2.0",
  })).rejects.toThrow(/unsafe path segment|canonical/i);

  await expect(wheatArchive.createWheatBackup({
    destinationPath: path.join(root, "duplicate.atlasbackup"),
    databasePath,
    managedAttachmentsRoot: attachmentsRoot,
    managedAttachmentPaths: ["inside.txt", "inside.txt"],
    appVersion: "1.2.0",
  })).rejects.toThrow(/duplicate|case-colliding/i);

  fs.writeFileSync(`${databasePath}-wal`, "uncheckpointed data", "utf8");
  await expect(wheatArchive.createWheatBackup({
    destinationPath: path.join(root, "active-wal.atlasbackup"),
    databasePath,
    appVersion: "1.2.0",
  })).rejects.toThrow(/active wal sidecar/i);
  fs.rmSync(`${databasePath}-wal`);

  const existingDestination = path.join(root, "existing.atlasbackup");
  const sentinel = Buffer.from("existing bytes must survive");
  fs.writeFileSync(existingDestination, sentinel);
  await expect(wheatArchive.createWheatBackup({
    destinationPath: existingDestination,
    databasePath,
    managedAttachmentsRoot: attachmentsRoot,
    managedAttachmentPaths: ["inside.txt"],
    appVersion: "1.2.0",
  })).rejects.toThrow(/already exists/i);
  expect(fs.readFileSync(existingDestination)).toEqual(sentinel);
});
