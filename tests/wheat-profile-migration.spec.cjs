const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let profile;

test.beforeAll(() => {
  profile = tsxRequire(path.join(root, "electron", "profileMigration.ts"), __filename);
});

function appDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-profile-"));
}

/** A profile as it exists on disk before the rename, with real user data in it. */
function seedLegacyProfile(appData) {
  const legacy = path.join(appData, "Atlas Ledger");
  fs.mkdirSync(path.join(legacy, "documents"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "backups"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "updater"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "atlas-ledger.sqlite"), "the live accounting database");
  fs.writeFileSync(path.join(legacy, "atlas-ledger.sqlite-wal"), "uncheckpointed transactions");
  fs.writeFileSync(path.join(legacy, "atlas-ledger-main-errors.log"), "past errors");
  fs.writeFileSync(path.join(legacy, "documents", "facture-2026-001.pdf"), "scanned source document");
  fs.writeFileSync(path.join(legacy, "backups", "wheat-2026-08-01.sqlite"), "an archive");
  fs.writeFileSync(path.join(legacy, "updater", "state.json"), "{}");
  return legacy;
}

test("a pre-rename profile is moved whole, with database, documents and backups intact", () => {
  const appData = appDataRoot();
  try {
    const legacy = seedLegacyProfile(appData);
    const result = profile.resolveProfileDirectory(appData);
    const moved = path.join(appData, "Wheat");

    expect(result.profileDirectory).toBe(moved);
    expect(fs.existsSync(legacy)).toBe(false);
    // The database follows the product name, and its write-ahead log with it.
    expect(fs.readFileSync(path.join(moved, "wheat.sqlite"), "utf8")).toBe("the live accounting database");
    expect(fs.readFileSync(path.join(moved, "wheat.sqlite-wal"), "utf8")).toBe("uncheckpointed transactions");
    expect(fs.readFileSync(path.join(moved, "wheat-main-errors.log"), "utf8")).toBe("past errors");
    // Everything the user cannot reconstruct travels untouched.
    expect(fs.readFileSync(path.join(moved, "documents", "facture-2026-001.pdf"), "utf8")).toBe("scanned source document");
    expect(fs.readFileSync(path.join(moved, "backups", "wheat-2026-08-01.sqlite"), "utf8")).toBe("an archive");
    expect(fs.readFileSync(path.join(moved, "updater", "state.json"), "utf8")).toBe("{}");
    expect(result.events.join(" ")).toMatch(/profile-moved/);
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test("when both profiles exist the current one wins and the legacy one is left untouched", () => {
  const appData = appDataRoot();
  try {
    const legacy = seedLegacyProfile(appData);
    const current = path.join(appData, "Wheat");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, "wheat.sqlite"), "the current database");

    const result = profile.resolveProfileDirectory(appData);
    expect(result.profileDirectory).toBe(current);
    expect(fs.readFileSync(path.join(current, "wheat.sqlite"), "utf8")).toBe("the current database");
    // Never merged: the old profile keeps every byte it had.
    expect(fs.readFileSync(path.join(legacy, "atlas-ledger.sqlite"), "utf8")).toBe("the live accounting database");
    expect(fs.existsSync(path.join(current, "documents"))).toBe(false);
    expect(result.events.join(" ")).toMatch(/legacy-profile-ignored/);
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test("a migration interrupted after the move still opens the database, and finishes next launch", () => {
  const appData = appDataRoot();
  try {
    // The crash window: the directory moved, the file rename never ran.
    const moved = path.join(appData, "Wheat");
    fs.mkdirSync(moved, { recursive: true });
    fs.writeFileSync(path.join(moved, "atlas-ledger.sqlite"), "the live accounting database");

    // The app finds the data rather than starting on an empty database.
    expect(profile.resolveProfileDatabaseFile(moved)).toBe(path.join(moved, "atlas-ledger.sqlite"));

    // The next launch completes the rename, and the data is still there.
    const result = profile.resolveProfileDirectory(appData);
    expect(result.profileDirectory).toBe(moved);
    expect(fs.readFileSync(path.join(moved, "wheat.sqlite"), "utf8")).toBe("the live accounting database");
    expect(profile.resolveProfileDatabaseFile(moved)).toBe(path.join(moved, "wheat.sqlite"));
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test("a fresh install with no legacy profile simply uses the Wheat profile", () => {
  const appData = appDataRoot();
  try {
    const result = profile.resolveProfileDirectory(appData);
    expect(result.profileDirectory).toBe(path.join(appData, "Wheat"));
    expect(result.events).toEqual([]);
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test("the Wheat AI table rename preserves every existing row, index and foreign key", () => {
  const appData = appDataRoot();
  try {
    const db = new DatabaseSync(path.join(appData, "rename.sqlite"));
    db.exec([
      'CREATE TABLE "Company" ("id" TEXT NOT NULL PRIMARY KEY);',
      'CREATE TABLE "AtlasAiSettings" ("id" TEXT NOT NULL PRIMARY KEY, "companyId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,',
      '  CONSTRAINT "AtlasAiSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE);',
      'CREATE TABLE "AtlasAiAuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "companyId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "toolName" TEXT NOT NULL, "createdAt" TEXT NOT NULL,',
      '  CONSTRAINT "AtlasAiAuditEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE);',
      'CREATE TABLE "AtlasKnowledgePattern" ("id" TEXT NOT NULL PRIMARY KEY, "companyId" TEXT NOT NULL, "kind" TEXT NOT NULL, "key" TEXT NOT NULL, "valueJson" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,',
      '  CONSTRAINT "AtlasKnowledgePattern_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE);',
      'CREATE UNIQUE INDEX "AtlasAiSettings_companyId_key" ON "AtlasAiSettings"("companyId");',
      'CREATE INDEX "AtlasAiAuditEvent_companyId_createdAt_idx" ON "AtlasAiAuditEvent"("companyId", "createdAt");',
      'CREATE INDEX "AtlasAiAuditEvent_sessionId_createdAt_idx" ON "AtlasAiAuditEvent"("sessionId", "createdAt");',
      'CREATE UNIQUE INDEX "AtlasKnowledgePattern_companyId_kind_key_key" ON "AtlasKnowledgePattern"("companyId", "kind", "key");',
      'CREATE INDEX "AtlasKnowledgePattern_companyId_kind_active_idx" ON "AtlasKnowledgePattern"("companyId", "kind", "active");',
      "INSERT INTO \"Company\" (\"id\") VALUES ('c1');",
      "INSERT INTO \"AtlasAiSettings\" (\"id\",\"companyId\",\"enabled\") VALUES ('s1','c1',true);",
      "INSERT INTO \"AtlasAiAuditEvent\" (\"id\",\"companyId\",\"sessionId\",\"toolName\",\"createdAt\") VALUES ('a1','c1','sess','company.get','2026-08-01');",
      "INSERT INTO \"AtlasKnowledgePattern\" (\"id\",\"companyId\",\"kind\",\"key\",\"valueJson\") VALUES ('k1','c1','RULE','tva-20','{\"rate\":20}');",
    ].join("\n"));

    db.exec(fs.readFileSync(path.join(root, "prisma", "migrations", "20260830120000_wheat_ai_model_rename", "migration.sql"), "utf8"));

    expect(db.prepare("SELECT enabled FROM \"WheatAiSettings\" WHERE id='s1'").get().enabled).toBe(1);
    expect(db.prepare("SELECT toolName FROM \"WheatAiAuditEvent\" WHERE id='a1'").get().toolName).toBe("company.get");
    expect(db.prepare("SELECT valueJson FROM \"WheatKnowledgePattern\" WHERE id='k1'").get().valueJson).toBe('{"rate":20}');
    // Nothing named Atlas survives, and the indexes came across under new names.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'Atlas%'").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'Wheat%' ORDER BY name").all().map((row) => row.name)).toEqual([
      "WheatAiAuditEvent_companyId_createdAt_idx",
      "WheatAiAuditEvent_sessionId_createdAt_idx",
      "WheatAiSettings_companyId_key",
      "WheatKnowledgePattern_companyId_kind_active_idx",
      "WheatKnowledgePattern_companyId_kind_key_key",
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});
