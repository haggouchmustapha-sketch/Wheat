const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationPath = path.join(root, "prisma", "migrations", "20260820010000_post_audit_fixes", "migration.sql");
const expectedDigest = "9e07bd28ea9cafc0365362b151ef12ce54b6776041c751583468c9291a030358";

function applySql(database, sql) {
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function preparePrePostAuditFixture(database) {
  database.exec(`
    DROP TABLE IF EXISTS "SageExportProfile";
    DROP INDEX IF EXISTS "CompanyUser_companyId_userId_key";
    DELETE FROM "_prisma_migrations"
    WHERE "migration_name" = '20260820010000_post_audit_fixes';
  `);
}

test("post-audit migration persists Sage profiles and enforces one company role per user", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  expect(crypto.createHash("sha256").update(sql).digest("hex")).toBe(expectedDigest);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-post-audit-migration-"));
  const databasePath = path.join(temporaryRoot, "atlas.sqlite");
  fs.copyFileSync(path.join(root, "prisma", "dev.db"), databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    preparePrePostAuditFixture(database);
    applySql(database, sql);
    const company = database.prepare('SELECT "id" FROM "Company" LIMIT 1').get();
    const membership = database.prepare('SELECT "companyId", "userId", "role" FROM "CompanyUser" LIMIT 1').get();
    expect(company).toBeTruthy();
    database.prepare(`INSERT INTO "SageExportProfile" ("id", "companyId", "profileType", "outputKind", "encoding") VALUES (?, ?, ?, ?, ?)`).run(
      "profile-test", company.id, "Sage 100 TXT", "TXT", "windows-1252",
    );
    expect(database.prepare('SELECT "outputKind" FROM "SageExportProfile" WHERE "companyId" = ?').get(company.id).outputKind).toBe("TXT");
    expect(() => database.prepare('INSERT INTO "CompanyUser" ("id", "companyId", "userId", "role") VALUES (?, ?, ?, ?)').run(
      "duplicate-membership", membership.companyId, membership.userId, membership.role,
    )).toThrow(/unique/i);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("conflicting pre-existing memberships fail transactionally instead of being silently discarded", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-post-audit-duplicate-"));
  const databasePath = path.join(temporaryRoot, "atlas.sqlite");
  fs.copyFileSync(path.join(root, "prisma", "dev.db"), databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    preparePrePostAuditFixture(database);
    const membership = database.prepare('SELECT "companyId", "userId" FROM "CompanyUser" LIMIT 1').get();
    database.prepare('INSERT INTO "CompanyUser" ("id", "companyId", "userId", "role") VALUES (?, ?, ?, ?)').run(
      "conflicting-membership", membership.companyId, membership.userId, "READ_ONLY",
    );
    expect(() => applySql(database, fs.readFileSync(migrationPath, "utf8"))).toThrow(/unique/i);
    expect(database.prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'SageExportProfile'`).get().count).toBe(0);
    expect(database.prepare('SELECT count(*) AS count FROM "CompanyUser" WHERE "companyId" = ? AND "userId" = ?').get(membership.companyId, membership.userId).count).toBe(2);
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
