const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const source11 = path.join(root, "backups", "atlas-1.2-prework-20260812-001", "dev.db");
const migrationPath = path.join(root, "prisma", "migrations", "20260812160058_atlas_1_2_operational", "migration.sql");

function skipIfHistoricalFixtureIsUnavailable() {
  test.skip(!fs.existsSync(source11), `Historical backup fixture is unavailable: ${path.relative(root, source11)}`);
}

function scalar(database, sql) {
  return Object.values(database.prepare(sql).get())[0];
}

test("migrates a real 1.1 copy without guessing ledger links or losing exact cents", () => {
  skipIfHistoricalFixtureIsUnavailable();
  expect(fs.existsSync(source11)).toBeTruthy();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-12-migration-"));
  const databasePath = path.join(temporaryRoot, "atlas-1.1-copy.sqlite");
  fs.copyFileSync(source11, databasePath);
  const database = new DatabaseSync(databasePath);

  try {
    const before = {
      entries: scalar(database, 'SELECT count(*) FROM "Entry"'),
      invoices: scalar(database, 'SELECT count(*) FROM "Invoice"'),
      invoiceCents: scalar(database, 'SELECT coalesce(sum("ttcCents"), 0) FROM "Invoice"'),
      lines: scalar(database, 'SELECT count(*) FROM "EntryLine"'),
      paidDates: scalar(database, 'SELECT count(*) FROM "Invoice" WHERE "paymentDate" IS NOT NULL'),
      matchedClaims: scalar(database, 'SELECT count(*) FROM "BankMovement" WHERE upper("status") = \'MATCHED\''),
    };

    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("BEGIN IMMEDIATE");
    database.exec(fs.readFileSync(migrationPath, "utf8"));
    database.exec("COMMIT");
    database.exec("PRAGMA foreign_keys=ON");

    expect(scalar(database, 'SELECT count(*) FROM "Entry"')).toBe(before.entries);
    expect(scalar(database, 'SELECT count(*) FROM "EntryLine"')).toBe(before.lines);
    expect(scalar(database, 'SELECT count(*) FROM "Invoice"')).toBe(before.invoices);
    expect(scalar(database, 'SELECT sum("ttcCents") FROM "Invoice"')).toBe(before.invoiceCents);
    expect(scalar(database, 'SELECT count(*) FROM "Invoice" WHERE "postedEntryId" IS NOT NULL')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "Invoice" WHERE "lifecycleStatus" = \'LEGACY\' AND "needsReview" = true')).toBe(before.invoices);
    expect(scalar(database, 'SELECT count(*) FROM "InvoiceLine" WHERE "isLegacySummary" = true')).toBe(before.invoices);
    expect(scalar(database, 'SELECT count(*) FROM "Payment" WHERE "lifecycleStatus" = \'LEGACY\'')).toBe(before.paidDates);
    expect(scalar(database, 'SELECT count(*) FROM "PaymentAllocation"')).toBe(before.paidDates);
    expect(scalar(database, 'SELECT count(*) FROM "BankMovement" WHERE "legacyMatchClaimed" = true')).toBe(before.matchedClaims);
    expect(scalar(database, 'SELECT count(*) FROM "BankMovement" WHERE "status" = \'REVIEW_REQUIRED\'')).toBe(before.matchedClaims);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves 64-bit invoice cents and isolates duplicate or blank legacy identities", () => {
  skipIfHistoricalFixtureIsUnavailable();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-12-bigint-"));
  const databasePath = path.join(temporaryRoot, "atlas-1.1-copy.sqlite");
  fs.copyFileSync(source11, databasePath);
  const database = new DatabaseSync(databasePath);
  const huge = 4_000_000_000_000_001n;

  try {
    const first = database.prepare('SELECT "id", "companyId" FROM "Invoice" ORDER BY "id" LIMIT 1').get();
    database.prepare('UPDATE "Invoice" SET "ttcCents" = ?, "counterparty" = \'\', "ice" = NULL, "invoiceNo" = \'\' WHERE "id" = ?').run(huge, first.id);
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("BEGIN IMMEDIATE");
    database.exec(fs.readFileSync(migrationPath, "utf8"));
    database.exec("COMMIT");
    database.exec("PRAGMA foreign_keys=ON");

    expect(String(scalar(database, `SELECT "ttcCents" FROM "Invoice" WHERE "id" = '${first.id}'`))).toBe(huge.toString());
    expect(String(scalar(database, `SELECT "ttcCents" FROM "InvoiceLine" WHERE "invoiceId" = '${first.id}'`))).toBe(huge.toString());
    expect(String(scalar(database, `SELECT "numberKey" FROM "Invoice" WHERE "id" = '${first.id}'`))).toContain(`:LEGACY:${first.id}`);
    expect(scalar(database, `SELECT count(*) FROM "Counterparty" WHERE "companyId" = '${first.companyId}' AND "identityKey" = 'LEGACY_INVOICE:${first.id}'`)).toBe(1);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
