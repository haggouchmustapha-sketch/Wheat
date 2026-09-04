/**
 * One awkward filename must not make a dossier impossible to back up.
 *
 * The recogniser stored a managed document under a name derived from the source
 * file and the counterparty. Its sanitiser and the backup's path contract were
 * two different rules, and where they disagreed the backup refused the archive
 * outright — not the document, the whole dossier. Backup is the feature whose
 * failure is discovered at the worst possible moment, so the disagreement is
 * fixed at both ends: one rule, applied when the file is stored, and a repair
 * for the files stored before it existed.
 *
 * The names here are not exotic. They are a truncation that landed on a space,
 * a Windows device name, a decomposed Arabic vowel mark, and a colon in a
 * scanner's own filename — all of which arrive in an ordinary Moroccan dossier.
 */

const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const provenance = tsxRequire(path.join(cwd, "electron", "managedFileProvenance.ts"), __filename);
const archive = tsxRequire(path.join(cwd, "electron", "archive.ts"), __filename);

const temporary = [];

function root(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

test.afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function evidenceDatabase(databasePath, documents) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE Document (id TEXT PRIMARY KEY, storedPath TEXT, contentSha256 TEXT, byteSize BIGINT);
    CREATE TABLE BankStatementImport (id TEXT PRIMARY KEY, sourceStoredPath TEXT, sourceSha256 TEXT NOT NULL);
    CREATE TABLE LedgerImportBatch (id TEXT PRIMARY KEY, sourceStoredPath TEXT, sourceSha256 TEXT NOT NULL);
  `);
  const insert = database.prepare('INSERT INTO "Document" ("id", "storedPath", "contentSha256", "byteSize") VALUES (?, ?, ?, ?)');
  for (const document of documents) {
    insert.run(document.id, document.storedPath, document.sha256 ?? null, document.byteSize ?? null);
  }
  database.close();
}

function readStoredPaths(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare('SELECT "id", "storedPath" FROM "Document" ORDER BY "id"').all();
  } finally {
    database.close();
  }
}

test("the name a managed file is stored under is the one a backup can carry", () => {
  const cases = [
    // Truncation used to land on a space, which Windows silently drops.
    [`${"SOCIETE MAROCAINE DE DISTRIBUTION GENERALE ET DE SERVICES DIVERS".padEnd(79, "X")} `, /[^ .]$/],
    // A device name is not a file name on Windows.
    ["AUX", /^_AUX$/],
    ["CON.pdf", /^_CON\.pdf$/],
    // Punctuation a scanner puts in a filename.
    ["Scan 2026-07-09 15:46:15.pdf", /^[^:]+$/],
    ["facture <urgente>.pdf", /^[^<>]+$/],
    // Names that must survive untouched: none of these is a portability problem.
    ["Facture Été 2026.pdf", /^Facture Été 2026\.pdf$/],
    ["ANOUAL HEALTH SOLUTIONS", /^ANOUAL HEALTH SOLUTIONS$/],
    ["شركة المغرب", /^شركة المغرب$/],
  ];
  for (const [input, expected] of cases) {
    const segment = archive.portableArchiveSegment(input);
    expect(segment, input).toMatch(expected);
    expect(archive.isPortableArchiveRelativePath(`company/${segment}`), input).toBe(true);
    expect(segment.normalize("NFC"), input).toBe(segment);
  }
  // Nothing usable left still produces a name rather than an empty path.
  expect(archive.portableArchiveSegment("   ")).toBe("fichier");
  expect(archive.portableArchiveSegment("..")).toBe("fichier");
});

test("a dossier holding an unbackuppable attachment is repaired, not refused", () => {
  const directory = root("wheat-path-repair-");
  const documentsRoot = path.join(directory, "documents");
  const databasePath = path.join(directory, "wheat.sqlite");
  // The exact shape the recogniser used to produce: a trailing space left by
  // truncating a long counterparty name.
  const unsafeRelative = "ACME SARL /facture .pdf";
  const unsafePath = path.join(documentsRoot, ...unsafeRelative.split("/"));
  const bytes = Buffer.from("facture 1 250,00 MAD\n", "utf8");
  fs.mkdirSync(path.dirname(unsafePath), { recursive: true });
  fs.writeFileSync(unsafePath, bytes);

  const safeRelative = "ACME SARL/lisible.pdf";
  const safePath = path.join(documentsRoot, ...safeRelative.split("/"));
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, bytes);

  evidenceDatabase(databasePath, [
    { id: "doc-unsafe", storedPath: unsafePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length },
    { id: "doc-safe", storedPath: safePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length },
  ]);

  // Before: the archive's own contract refuses the path outright.
  expect(archive.isPortableArchiveRelativePath(unsafeRelative)).toBe(false);

  const result = provenance.repairNonPortableManagedPaths({ databasePath, storedPathsRoot: documentsRoot });
  expect(result.unrepairable).toEqual([]);
  expect(result.repaired).toHaveLength(1);
  expect(result.repaired[0].from).toBe(unsafeRelative);
  expect(archive.isPortableArchiveRelativePath(result.repaired[0].to)).toBe(true);

  // The bytes moved with the name, and the row moved with the file.
  const repairedPath = path.join(documentsRoot, ...result.repaired[0].to.split("/"));
  expect(fs.readFileSync(repairedPath)).toEqual(bytes);
  expect(fs.existsSync(unsafePath)).toBe(false);
  const rows = readStoredPaths(databasePath);
  expect(rows.find((row) => row.id === "doc-unsafe").storedPath).toBe(repairedPath);
  // The file that was already fine is untouched.
  expect(rows.find((row) => row.id === "doc-safe").storedPath).toBe(safePath);

  // After: every attachment can be carried, and the set is still complete.
  const verified = provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: documentsRoot });
  expect(verified.relativePaths).toHaveLength(2);
  for (const relativePath of verified.relativePaths) {
    expect(archive.isPortableArchiveRelativePath(relativePath), relativePath).toBe(true);
  }
});

test("repairing twice changes nothing the second time", () => {
  const directory = root("wheat-path-repair-idempotent-");
  const documentsRoot = path.join(directory, "documents");
  const databasePath = path.join(directory, "wheat.sqlite");
  const unsafePath = path.join(documentsRoot, "AUX", "relevé .pdf");
  const bytes = Buffer.from("relevé\n", "utf8");
  fs.mkdirSync(path.dirname(unsafePath), { recursive: true });
  fs.writeFileSync(unsafePath, bytes);
  evidenceDatabase(databasePath, [
    { id: "doc-1", storedPath: unsafePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length },
  ]);

  const first = provenance.repairNonPortableManagedPaths({ databasePath, storedPathsRoot: documentsRoot });
  expect(first.repaired).toHaveLength(1);
  const second = provenance.repairNonPortableManagedPaths({ databasePath, storedPathsRoot: documentsRoot });
  expect(second.repaired).toEqual([]);
  expect(second.unrepairable).toEqual([]);
});

test("two files whose portable names would collide keep two distinct names", () => {
  const directory = root("wheat-path-repair-collision-");
  const documentsRoot = path.join(directory, "documents");
  const databasePath = path.join(directory, "wheat.sqlite");
  const first = path.join(documentsRoot, "ACME", "facture .pdf");
  const second = path.join(documentsRoot, "ACME", "facture. pdf");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.writeFileSync(first, Buffer.from("un\n"));
  fs.writeFileSync(second, Buffer.from("deux\n"));
  evidenceDatabase(databasePath, [
    { id: "doc-a", storedPath: first },
    { id: "doc-b", storedPath: second },
  ]);

  const result = provenance.repairNonPortableManagedPaths({ databasePath, storedPathsRoot: documentsRoot });
  expect(result.unrepairable).toEqual([]);
  const destinations = result.repaired.map((item) => item.to);
  expect(new Set(destinations).size).toBe(destinations.length);
  // Both documents are still there, with their own contents.
  const rows = readStoredPaths(databasePath);
  expect(rows).toHaveLength(2);
  const contents = rows.map((row) => fs.readFileSync(row.storedPath, "utf8")).sort();
  expect(contents).toEqual(["deux\n", "un\n"]);
});

test("a row pointing at a file that is not there is left to the provenance check", () => {
  const directory = root("wheat-path-repair-missing-");
  const documentsRoot = path.join(directory, "documents");
  const databasePath = path.join(directory, "wheat.sqlite");
  fs.mkdirSync(documentsRoot, { recursive: true });
  const missing = path.join(documentsRoot, "ACME", "disparu .pdf");
  evidenceDatabase(databasePath, [{ id: "doc-missing", storedPath: missing }]);

  const result = provenance.repairNonPortableManagedPaths({ databasePath, storedPathsRoot: documentsRoot });
  // Repair invents nothing and hides nothing: the missing file is still missing
  // and the verification pass is the thing that says so.
  expect(result.repaired).toEqual([]);
  expect(result.unrepairable).toEqual([]);
  expect(() => provenance.verifyManagedFileProvenance({ databasePath, storedPathsRoot: documentsRoot })).toThrow();
});
