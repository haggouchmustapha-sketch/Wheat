const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationName = "20260820180000_bank_import_2_0";
const migrationPath = path.join(root, "prisma", "migrations", migrationName, "migration.sql");
const expectedDigest = "ad4057fe25167275cd3c277fe8f3bc9c4e3245a5353087fa382b08ab813920b3";

test("2.0 bank import history migration preserves prior imports and is registered for runtime upgrades", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  expect(crypto.createHash("sha256").update(sql).digest("hex")).toBe(expectedDigest);
  const databaseSource = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
  expect(databaseSource).toContain(`name: "${migrationName}"`);
  expect(databaseSource).toContain(`checksum: "${expectedDigest}"`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bank-migration-2-"));
  const database = new DatabaseSync(path.join(temporaryRoot, "atlas.sqlite"));
  try {
    database.exec(`
      CREATE TABLE "BankStatementImport" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "bankAccountId" TEXT NOT NULL,
        "sourceName" TEXT NOT NULL,
        "sourceStoredPath" TEXT,
        "sourceSha256" TEXT NOT NULL,
        "startsOn" DATETIME,
        "endsOn" DATETIME,
        "openingBalanceCents" BIGINT,
        "closingBalanceCents" BIGINT,
        "rowCount" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "voidedAt" DATETIME,
        "voidReason" TEXT
      );
      INSERT INTO "BankStatementImport" ("id", "bankAccountId", "sourceName", "sourceSha256", "rowCount")
      VALUES ('old-import', 'bank-1', 'old.csv', '${"a".repeat(64)}', 3);
      BEGIN IMMEDIATE;
      ${sql}
      COMMIT;
    `);
    const columns = new Set(database.prepare('PRAGMA table_info("BankStatementImport")').all().map((column) => column.name));
    for (const column of ["sourceFormat", "importedCount", "skippedCount", "errorCount", "duplicateCount"]) expect(columns.has(column)).toBeTruthy();
    expect(database.prepare('SELECT "sourceFormat", "rowCount", "importedCount", "skippedCount", "errorCount", "duplicateCount" FROM "BankStatementImport" WHERE "id" = ?').get("old-import")).toEqual({
      sourceFormat: "UNKNOWN",
      rowCount: 3,
      importedCount: 3,
      skippedCount: 0,
      errorCount: 0,
      duplicateCount: 0,
    });
    expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
