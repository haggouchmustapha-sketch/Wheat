const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const provenanceModulePath = path.join(cwd, "electron", "managedFileProvenance.ts");
const archiveModulePath = path.join(cwd, "electron", "archive.ts");
const temporaryDirectories = [];
let provenance;
let wheatArchive;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeTempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createEvidenceDatabase(databasePath, rows) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE Document (
      id TEXT PRIMARY KEY,
      storedPath TEXT,
      contentSha256 TEXT,
      byteSize BIGINT
    );
    CREATE TABLE BankStatementImport (
      id TEXT PRIMARY KEY,
      sourceStoredPath TEXT,
      sourceSha256 TEXT NOT NULL
    );
    CREATE TABLE LedgerImportBatch (
      id TEXT PRIMARY KEY,
      sourceStoredPath TEXT,
      sourceSha256 TEXT NOT NULL
    );
  `);
  const insertDocument = database.prepare(
    'INSERT INTO "Document" ("id", "storedPath", "contentSha256", "byteSize") VALUES (?, ?, ?, ?)',
  );
  const insertStatement = database.prepare(
    'INSERT INTO "BankStatementImport" ("id", "sourceStoredPath", "sourceSha256") VALUES (?, ?, ?)',
  );
  const insertLedger = database.prepare(
    'INSERT INTO "LedgerImportBatch" ("id", "sourceStoredPath", "sourceSha256") VALUES (?, ?, ?)',
  );
  for (const row of rows.documents ?? []) {
    insertDocument.run(row.id, row.storedPath, row.sha256 ?? null, row.byteSize ?? null);
  }
  for (const row of rows.statements ?? []) insertStatement.run(row.id, row.storedPath, row.sha256);
  for (const row of rows.ledgerImports ?? []) insertLedger.run(row.id, row.storedPath, row.sha256);
  database.close();
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  [provenance, wheatArchive] = await Promise.all([
    tsxRequire(provenanceModulePath, __filename),
    tsxRequire(archiveModulePath, __filename),
  ]);
});

test.afterEach(async () => {
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test.describe.configure({ mode: "serial" });

test("rejects a managed file changed after its database evidence was recorded, before backup creation", () => {
  const root = makeTempDirectory("atlas-1-3-provenance-create-");
  const filesRoot = path.join(root, "documents");
  const databasePath = path.join(root, "atlas.sqlite");
  const destinationPath = path.join(root, "must-not-exist.atlasbackup");
  const original = Buffer.from("facture fournisseur 1250,00 MAD\n", "utf8");
  const managedPath = path.join(filesRoot, "company-1", "invoice.txt");
  fs.mkdirSync(path.dirname(managedPath), { recursive: true });
  fs.writeFileSync(managedPath, original);
  createEvidenceDatabase(databasePath, {
    documents: [{
      id: "document-1",
      storedPath: managedPath,
      sha256: sha256(original),
      byteSize: original.length,
    }],
  });

  const verified = provenance.verifyManagedFileProvenance({
    databasePath,
    storedPathsRoot: filesRoot,
  });
  expect(verified.relativePaths).toEqual(["company-1/invoice.txt"]);

  fs.writeFileSync(managedPath, Buffer.from("facture falsifiée 9900,00 MAD\n", "utf8"));
  expect(() => provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: filesRoot }))
    .toThrow(/provenance SHA-256/i);
  expect(fs.existsSync(destinationPath)).toBe(false);
});

test("verifies Document size and the source hashes of bank-statement and ledger-import evidence", () => {
  const root = makeTempDirectory("atlas-1-3-provenance-all-");
  const filesRoot = path.join(root, "documents");
  const databasePath = path.join(root, "atlas.sqlite");
  const document = Buffer.from("scan", "utf8");
  const statement = Buffer.from("date,amount\n2026-08-01,450\n", "utf8");
  const ledger = Buffer.from("journal;debit;credit\nAC;100;0\n", "utf8");
  const paths = {
    document: path.join(filesRoot, "company-1", "scan.bin"),
    statement: path.join(filesRoot, "company-1", "bank-statements", "statement.csv"),
    ledger: path.join(filesRoot, "company-1", "ledger-imports", "ledger.csv"),
  };
  for (const [key, filePath] of Object.entries(paths)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, { document, statement, ledger }[key]);
  }
  createEvidenceDatabase(databasePath, {
    documents: [{ id: "document-1", storedPath: paths.document, sha256: sha256(document), byteSize: document.length + 1 }],
    statements: [{ id: "statement-1", storedPath: paths.statement, sha256: sha256(statement) }],
    ledgerImports: [{ id: "ledger-1", storedPath: paths.ledger, sha256: sha256(ledger) }],
  });

  expect(() => provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: filesRoot }))
    .toThrow(/provenance de taille/i);

  const database = new DatabaseSync(databasePath);
  database.prepare('UPDATE "Document" SET "byteSize" = ? WHERE "id" = ?').run(document.length, "document-1");
  database.close();
  const result = provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: filesRoot });
  expect(result.referencesChecked).toBe(3);
  expect(result.files).toHaveLength(3);

  fs.appendFileSync(paths.statement, "2026-08-02,900\n", "utf8");
  expect(() => provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: filesRoot }))
    .toThrow(/bank-statement statement-1/i);
  fs.writeFileSync(paths.statement, statement);
  fs.appendFileSync(paths.ledger, "VE;0;100\n", "utf8");
  expect(() => provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: filesRoot }))
    .toThrow(/ledger-import ledger-1/i);
});

test("rejects a manifest-valid staged restore whose attachment disagrees with SQLite provenance", async () => {
  const root = makeTempDirectory("atlas-1-3-provenance-restore-");
  const sourceRoot = path.join(root, "source-documents");
  const databasePath = path.join(root, "source.sqlite");
  const archivePath = path.join(root, "tampered-but-manifest-valid.atlasbackup");
  const stagedParent = path.join(root, "staging");
  const futureRoot = path.join(root, "future-live", "restored-files");
  const relativePath = "company-1/evidence.txt";
  const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
  const recordedBytes = Buffer.from("preuve comptable originale", "utf8");
  const substitutedBytes = Buffer.from("autre preuve de même archive", "utf8");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, substitutedBytes);
  createEvidenceDatabase(databasePath, {
    documents: [{
      id: "document-restore-1",
      storedPath: sourcePath,
      sha256: sha256(recordedBytes),
      byteSize: substitutedBytes.length,
    }],
  });

  await wheatArchive.createWheatBackup({
    destinationPath: archivePath,
    databasePath,
    managedAttachmentsRoot: sourceRoot,
    managedAttachmentPaths: [relativePath],
    appVersion: "1.3.0-test",
    workingDirectory: path.join(root, "create-staging"),
  });
  const staged = await wheatArchive.extractWheatBackupToStaging({
    archivePath,
    stagingParentDirectory: stagedParent,
  });
  const stagedDatabase = new DatabaseSync(staged.databasePath);
  stagedDatabase.prepare('UPDATE "Document" SET "storedPath" = ? WHERE "id" = ?')
    .run(path.join(futureRoot, ...relativePath.split("/")), "document-restore-1");
  stagedDatabase.close();

  expect(() => provenance.verifyManagedFileProvenance({
    databasePath: staged.databasePath,
    storedPathsRoot: futureRoot,
    physicalFilesRoot: staged.attachmentsDirectory,
  })).toThrow(/provenance SHA-256/i);
  expect(fs.existsSync(path.join(root, "future-live"))).toBe(false);
});

test("requires the staged archive file set to equal the database-referenced set", () => {
  expect(() => provenance.assertManagedFileSetMatchesArchive(
    ["company-1/document.txt"],
    ["company-1/document.txt", "company-1/unreferenced.txt"],
  )).toThrow(/exactement les fichiers gérés/i);
  expect(() => provenance.assertManagedFileSetMatchesArchive(
    ["company-1/document.txt"],
    ["company-1/document.txt"],
  )).not.toThrow();
});
