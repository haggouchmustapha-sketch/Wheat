const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationName = "20260825000000_atlas_2_1_foundations";
const migrationPath = path.join(root, "prisma", "migrations", migrationName, "migration.sql");
const expectedDigest = "094cb89b2655de5b08b5e623ad3122f463ea1a2a4f1b81aeae19dc81950ea118";

function scalar(db, sql) { return Object.values(db.prepare(sql).get())[0]; }
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name)); }

test("2.1 migration is additive and preserves the complete 2.0 ledger evidence", () => {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(migrationPath)).digest("hex");
  expect(digest).toBe(expectedDigest);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-21-migration-"));
  const databasePath = path.join(temporary, "legacy-2.0.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name < migrationName)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of migrations) db.exec(fs.readFileSync(path.join(root, "prisma", "migrations", migration.name, "migration.sql"), "utf8"));

    const now = "2026-08-24T12:00:00.000Z";
    db.exec(`
      INSERT INTO "Company" ("id","name","legalForm","ice","taxId","city","updatedAt") VALUES ('c','Legacy Atlas','SARL','001','IF1','Casa','${now}');
      INSERT INTO "FiscalYear" ("id","companyId","label","startsOn","endsOn") VALUES ('fy','c','2026','2026-01-01','2026-12-31');
      INSERT INTO "Account" ("id","companyId","code","label","classNo","type") VALUES ('a1','c','234100','Matériel',2,'ASSET'),('a2','c','111100','Capital',1,'EQUITY');
      INSERT INTO "Journal" ("id","companyId","code","label") VALUES ('j','c','OD','Opérations diverses');
      INSERT INTO "Entry" ("id","companyId","journalId","number","date","pieceNumber","label","journalCodeSnapshot","updatedAt") VALUES ('e','c','j','OD-1','2026-05-29','LEGACY-42','Écriture exacte','OD','${now}');
      INSERT INTO "EntryLine" ("id","entryId","accountId","label","debitCents","creditCents","position","accountCodeSnapshot","accountLabelSnapshot") VALUES ('l1','e','a1','Débit',1234567890123,0,1,'234100','Matériel'),('l2','e','a2','Crédit',0,1234567890123,2,'111100','Capital');
      INSERT INTO "BankAccount" ("id","companyId","bankName","iban","balanceCents") VALUES ('b','c','Banque','MA00',1234567890123);
      INSERT INTO "BankStatementImport" ("id","bankAccountId","sourceName","sourceSha256","rowCount") VALUES ('s','b','legacy.csv','abc',1);
      INSERT INTO "BankMovement" ("id","bankAccountId","statementId","date","label","amountCents","reference","status","confidence","updatedAt") VALUES ('m','b','s','2026-05-29','Virement',1234567890123,'REF','PENDING',100,'${now}');
    `);
    const before = {
      entryCount: scalar(db, 'SELECT count(*) FROM "Entry"'),
      debit: String(scalar(db, 'SELECT CAST(sum("debitCents") AS TEXT) FROM "EntryLine"')),
      credit: String(scalar(db, 'SELECT CAST(sum("creditCents") AS TEXT) FROM "EntryLine"')),
      bank: String(scalar(db, 'SELECT CAST(sum("balanceCents") AS TEXT) FROM "BankAccount"')),
      movement: String(scalar(db, 'SELECT CAST(sum("amountCents") AS TEXT) FROM "BankMovement"')),
    };

    db.exec("BEGIN IMMEDIATE");
    try { db.exec(fs.readFileSync(migrationPath, "utf8")); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }

    const after = {
      entryCount: scalar(db, 'SELECT count(*) FROM "Entry"'),
      debit: String(scalar(db, 'SELECT CAST(sum("debitCents") AS TEXT) FROM "EntryLine"')),
      credit: String(scalar(db, 'SELECT CAST(sum("creditCents") AS TEXT) FROM "EntryLine"')),
      bank: String(scalar(db, 'SELECT CAST(sum("balanceCents") AS TEXT) FROM "BankAccount"')),
      movement: String(scalar(db, 'SELECT CAST(sum("amountCents") AS TEXT) FROM "BankMovement"')),
    };
    expect(after).toEqual(before);
    for (const required of ["parentCode", "isStandard", "reportNature", "searchText"]) expect(columns(db, "Account").has(required)).toBe(true);
    for (const required of ["pieceNumberRaw", "pieceNumberSearch", "pieceSequenceNo", "pieceFiscalYearId"]) expect(columns(db, "Entry").has(required)).toBe(true);
    for (const table of ["JournalPieceSequence", "OpeningBalanceRun", "OpeningBalanceLine", "ReportConfiguration", "FiscalPackage", "FiscalAdjustment", "AtlasAiSettings", "AtlasAiAuditEvent", "AtlasKnowledgePattern"]) {
      expect(scalar(db, `SELECT count(*) FROM "${table}"`)).toBe(0);
    }
    expect(scalar(db, 'SELECT "allowManualPieceOverride" FROM "Journal" WHERE "id" = \'j\'')).toBe(1);
    expect(db.prepare('SELECT "pieceNumber", "pieceNumberRaw", "pieceSequenceNo" FROM "Entry" WHERE "id" = \'e\'').get()).toEqual({ pieceNumber: "LEGACY-42", pieceNumberRaw: null, pieceSequenceNo: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
