const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationName = "20260831120000_invoice_optional_due_date";
const migrationPath = path.join(root, "prisma", "migrations", migrationName, "migration.sql");
const expectedDigest = "7d81f08726194a22fc1cf10ea3a6ea2a54147f068aad1a2304ec1d8915bb25b5";

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Migration section not found: ${start}`);
  return text.slice(from, to).trim();
}

test("the nullable due-date migration preserves invoices, constraints and runtime registration", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  expect(crypto.createHash("sha256").update(sql).digest("hex")).toBe(expectedDigest);
  const databaseSource = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
  expect(databaseSource).toContain(`name: "${migrationName}"`);
  expect(databaseSource).toContain(`checksum: "${expectedDigest}"`);
  expect(databaseSource).toMatch(new RegExp(`name: "${migrationName}"[\\s\\S]{0,240}disablesForeignKeys: true`));

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-null-due-migration-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(path.join(root, "prisma", "dev.db"), databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    const createCurrent = section(sql, 'CREATE TABLE "new_Invoice"', 'INSERT INTO "new_Invoice"');
    const copyCurrent = section(sql, 'INSERT INTO "new_Invoice"', 'DROP TABLE "Invoice";');
    const indexSql = section(sql, 'CREATE UNIQUE INDEX "Invoice_postedEntryId_key"', 'PRAGMA foreign_keys=ON;');
    const createOld = createCurrent
      .replace('CREATE TABLE "new_Invoice"', 'CREATE TABLE "old_Invoice"')
      .replace('"dueDate" DATETIME,', '"dueDate" DATETIME NOT NULL,');
    const copyOld = copyCurrent.replace('INSERT INTO "new_Invoice"', 'INSERT INTO "old_Invoice"');

    database.exec("PRAGMA foreign_keys=OFF");
    database.exec(`${createOld}\n${copyOld}\nDROP TABLE "Invoice";\nALTER TABLE "old_Invoice" RENAME TO "Invoice";\n${indexSql}`);
    const before = database.prepare('SELECT "id", CAST("ttcCents" AS TEXT) AS "ttcCents", "dueDate" FROM "Invoice" ORDER BY "id"').all();
    expect(before.length).toBeGreaterThan(0);
    expect(database.prepare('PRAGMA table_info("Invoice")').all().find((column) => column.name === "dueDate").notnull).toBe(1);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      database.exec("PRAGMA foreign_keys=ON");
    }

    expect(database.prepare('SELECT "id", CAST("ttcCents" AS TEXT) AS "ttcCents", "dueDate" FROM "Invoice" ORDER BY "id"').all()).toEqual(before);
    const columns = database.prepare('PRAGMA table_info("Invoice")').all();
    expect(columns.find((column) => column.name === "dueDate").notnull).toBe(0);
    expect(database.prepare('PRAGMA index_list("Invoice")').all().map((index) => index.name).filter((name) => !name.startsWith("sqlite_autoindex_")).sort()).toEqual([
      "Invoice_companyId_kind_invoiceDate_idx",
      "Invoice_companyId_lifecycleStatus_dueDate_idx",
      "Invoice_companyId_numberKey_key",
      "Invoice_counterpartyId_dueDate_idx",
      "Invoice_creditedInvoiceId_documentType_idx",
      "Invoice_postedEntryId_key",
      "Invoice_taxConfigurationVersionId_idx",
      "Invoice_voidEntryId_key",
    ].sort());

    const columnNames = columns.map((column) => column.name);
    const selectExpressions = columnNames.map((name) => {
      if (name === "id") return "'invoice-null-due-test'";
      if (name === "invoiceNo") return "'NULL-DUE-TEST'";
      if (name === "numberKey") return "'NULL-DUE-TEST'";
      if (["dueDate", "postedEntryId", "voidEntryId", "creditedInvoiceId"].includes(name)) return "NULL";
      return `"${name}"`;
    });
    database.prepare(`INSERT INTO "Invoice" (${columnNames.map((name) => `"${name}"`).join(",")}) SELECT ${selectExpressions.join(",")} FROM "Invoice" ORDER BY "id" LIMIT 1`).run();
    expect(database.prepare('SELECT "dueDate" FROM "Invoice" WHERE "id" = ?').get("invoice-null-due-test").dueDate).toBeNull();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
