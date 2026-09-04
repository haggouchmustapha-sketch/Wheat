const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const source11 = path.join(root, "backups", "atlas-1.2-prework-20260812-001", "dev.db");
const sourceUser11 = path.join(root, "backups", "atlas-1.2-prework-20260812-001", "atlas-ledger-user.sqlite");
const source12 = path.join(root, "backups", "atlas-1.3-1.4-prework-20260813-001", "atlas-ledger-1.2-dev.db");
const migration11Path = path.join(root, "prisma", "migrations", "20260812000000_atlas_1_1_data_safety", "migration.sql");
const migration12Path = path.join(root, "prisma", "migrations", "20260812160058_atlas_1_2_operational", "migration.sql");
const migration13Path = path.join(root, "prisma", "migrations", "20260813090000_atlas_1_3_integrity_imports", "migration.sql");
const migration13RevisionsPath = path.join(root, "prisma", "migrations", "20260814010000_atlas_1_3_import_revisions", "migration.sql");

function skipIfHistoricalFixtureIsUnavailable(fixturePath) {
  test.skip(!fs.existsSync(fixturePath), `Historical backup fixture is unavailable: ${path.relative(root, fixturePath)}`);
}

function scalar(database, sql, ...params) {
  return Object.values(database.prepare(sql).get(...params))[0];
}

function applySql(database, sql) {
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys=ON");
  }
}

function applyAtlas13(database) {
  applySql(database, fs.readFileSync(migration13Path, "utf8"));
  applySql(database, fs.readFileSync(migration13RevisionsPath, "utf8"));
}

function migratedPreworkDatabase(prefix) {
  expect(fs.existsSync(source11)).toBeTruthy();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(temporaryRoot, "atlas-prework-copy.sqlite");
  fs.copyFileSync(source11, databasePath);
  const database = new DatabaseSync(databasePath);
  applySql(database, fs.readFileSync(migration12Path, "utf8"));
  return { database, temporaryRoot };
}

test("1.3 migration preserves the real prework ledger and backfills immutable snapshots deterministically", () => {
  skipIfHistoricalFixtureIsUnavailable(source11);
  const { database, temporaryRoot } = migratedPreworkDatabase("atlas-13-preserve-");
  const hugeCents = 9_007_199_254_740_992n;

  try {
    const beforeCounts = Object.fromEntries([
      "Company", "FiscalYear", "Account", "Journal", "Entry", "EntryLine", "Document",
      "BankAccount", "Invoice", "Payment", "PayrollRun", "ActivityLog",
    ].map((table) => [table, scalar(database, `SELECT count(*) FROM "${table}"`)]));
    const targetLine = database.prepare('SELECT "id" FROM "EntryLine" ORDER BY "id" LIMIT 1').get();
    database.prepare('UPDATE "EntryLine" SET "debitCents" = ? WHERE "id" = ?').run(hugeCents, targetLine.id);

    const expectedEntries = database.prepare(`
      SELECT e."id", j."code" AS "journalCode"
      FROM "Entry" e JOIN "Journal" j ON j."id" = e."journalId"
      ORDER BY e."id"
    `).all();
    const expectedLines = database.prepare(`
      SELECT el."id", el."entryId", a."code" AS "accountCode", a."label" AS "accountLabel"
      FROM "EntryLine" el JOIN "Account" a ON a."id" = el."accountId"
      ORDER BY el."entryId", el."id"
    `).all();
    const expectedPositionById = new Map();
    let previousEntryId = null;
    let position = 0;
    for (const line of expectedLines) {
      if (line.entryId !== previousEntryId) {
        previousEntryId = line.entryId;
        position = 1;
      } else {
        position += 1;
      }
      expectedPositionById.set(line.id, position);
    }

    applyAtlas13(database);

    for (const [table, count] of Object.entries(beforeCounts)) {
      expect(scalar(database, `SELECT count(*) FROM "${table}"`), `${table} row count`).toBe(count);
    }
    expect(scalar(database, 'SELECT CAST("debitCents" AS TEXT) FROM "EntryLine" WHERE "id" = ?', targetLine.id)).toBe(hugeCents.toString());

    const migratedEntries = database.prepare('SELECT "id", "journalCodeSnapshot", "version" FROM "Entry" ORDER BY "id"').all();
    expect(migratedEntries).toHaveLength(expectedEntries.length);
    for (const entry of migratedEntries) {
      expect(entry.journalCodeSnapshot).toBe(expectedEntries.find((item) => item.id === entry.id).journalCode);
      expect(entry.version).toBe(1);
    }

    const migratedLines = database.prepare(`
      SELECT "id", "position", "accountCodeSnapshot", "accountLabelSnapshot"
      FROM "EntryLine" ORDER BY "entryId", "position"
    `).all();
    expect(migratedLines).toHaveLength(expectedLines.length);
    for (const line of migratedLines) {
      const expected = expectedLines.find((item) => item.id === line.id);
      expect(line.position).toBe(expectedPositionById.get(line.id));
      expect(line.accountCodeSnapshot).toBe(expected.accountCode);
      expect(line.accountLabelSnapshot).toBe(expected.accountLabel);
    }
    expect(database.prepare(`
      SELECT "entryId", "position", count(*) AS "count"
      FROM "EntryLine" GROUP BY "entryId", "position" HAVING count(*) > 1
    `).all()).toEqual([]);

    for (const table of ["Company", "FiscalYear", "Account", "Journal", "BankAccount", "Entry", "PayrollRun"]) {
      expect(scalar(database, `SELECT count(*) FROM "${table}" WHERE "version" <> 1`), `${table} version`).toBe(0);
    }
    expect(scalar(database, 'SELECT count(*) FROM "Journal" WHERE "active" <> true')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "BankAccount" WHERE "active" <> true')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "PayrollRun" WHERE "voidEntryId" IS NOT NULL OR "voidedAt" IS NOT NULL OR "voidReason" IS NOT NULL')).toBe(0);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy activity is imported as unsealed provenance without fabricated hashes", () => {
  skipIfHistoricalFixtureIsUnavailable(source11);
  const { database, temporaryRoot } = migratedPreworkDatabase("atlas-13-audit-");

  try {
    const legacyRows = database.prepare(`
      SELECT "id", "companyId", "userId", "action", "entity", "entityId", "description", "detailsJson", "createdAt"
      FROM "ActivityLog" ORDER BY "companyId", "createdAt", "id"
    `).all();
    const companyCount = scalar(database, 'SELECT count(*) FROM "Company"');
    applyAtlas13(database);

    expect(scalar(database, 'SELECT count(*) FROM "AuditChain"')).toBe(companyCount);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent"')).toBe(legacyRows.length);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "integrityStatus" <> \'IMPORTED_UNSEALED\'')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "previousHash" IS NOT NULL OR "eventHash" IS NOT NULL')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "AuditSeal"')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE NOT json_valid("payloadJson")')).toBe(0);

    for (const legacy of legacyRows) {
      const imported = database.prepare(`
        SELECT ae.*, ac."companyId"
        FROM "AuditEvent" ae JOIN "AuditChain" ac ON ac."id" = ae."chainId"
        WHERE ae."legacyActivityLogId" = ?
      `).get(legacy.id);
      expect(imported).toBeTruthy();
      expect(imported.companyId).toBe(legacy.companyId);
      expect(imported.actorUserId).toBe(legacy.userId);
      expect(imported.action).toBe(legacy.action);
      expect(imported.entityType).toBe(legacy.entity);
      expect(imported.entityId).toBe(legacy.entityId);
      expect(imported.previousHash).toBeNull();
      expect(imported.eventHash).toBeNull();
      expect(JSON.parse(imported.payloadJson)).toEqual({
        description: legacy.description,
        legacyDetailsJson: legacy.detailsJson,
      });
    }

    const chainCounts = database.prepare(`
      SELECT ac."companyId", ac."lastSequence", count(ae."id") AS "eventCount"
      FROM "AuditChain" ac LEFT JOIN "AuditEvent" ae ON ae."chainId" = ac."id"
      GROUP BY ac."id" ORDER BY ac."companyId"
    `).all();
    for (const chain of chainCounts) expect(Number(chain.lastSequence)).toBe(chain.eventCount);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ledger-import storage retains source rows and supports scoped linear revisions", () => {
  skipIfHistoricalFixtureIsUnavailable(source11);
  const { database, temporaryRoot } = migratedPreworkDatabase("atlas-13-import-");

  try {
    applyAtlas13(database);
    const companyId = scalar(database, 'SELECT "id" FROM "Company" ORDER BY "id" LIMIT 1');
    const entryId = scalar(database, 'SELECT "id" FROM "Entry" WHERE "companyId" = ? ORDER BY "id" LIMIT 1', companyId);
    database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "mappingJson")
      VALUES ('batch-1', ?, 'journal.csv', 'abc123', '{}')
    `).run(companyId);
    const insertRow = database.prepare(`
      INSERT INTO "LedgerImportRow"
        ("id", "batchId", "sourceRow", "rawJson", "fingerprint", "validationStatus", "draftEntryId")
      VALUES (?, 'batch-1', ?, ?, ?, 'VALID', ?)
    `);
    insertRow.run("row-1", 2, '{"debit":"100.00"}', "fp-1", entryId);
    insertRow.run("row-2", 3, '{"credit":"100.00"}', "fp-2", entryId);

    expect(scalar(database, 'SELECT count(*) FROM "LedgerImportRow" WHERE "draftEntryId" = ?', entryId)).toBe(2);
    expect(() => insertRow.run("row-duplicate", 3, '{}', "fp-3", entryId)).toThrow();
    expect(() => database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "mappingJson")
      VALUES ('batch-duplicate', ?, 'again.csv', 'abc123', '{}')
    `).run(companyId)).toThrow();
    database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "scopeSha256", "revision", "mappingJson", "supersedesBatchId")
      VALUES ('batch-revision', ?, 'again.csv', 'abc123', '', 2, '{}', 'batch-1')
    `).run(companyId);
    database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "scopeSha256", "revision", "mappingJson")
      VALUES ('batch-other-scope', ?, 'other-sheet.csv', 'abc123', 'other-scope', 1, '{}')
    `).run(companyId);
    expect(scalar(database, 'SELECT count(*) FROM "LedgerImportBatch" WHERE "sourceSha256" = ?', "abc123")).toBe(3);
    expect(() => database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "scopeSha256", "revision", "mappingJson", "supersedesBatchId")
      VALUES ('batch-branch', ?, 'branch.csv', 'abc123', '', 3, '{}', 'batch-1')
    `).run(companyId)).toThrow();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the additive revision migration upgrades an existing 1.3 import without changing its rows", () => {
  skipIfHistoricalFixtureIsUnavailable(source11);
  const { database, temporaryRoot } = migratedPreworkDatabase("atlas-13-revision-forward-");

  try {
    applySql(database, fs.readFileSync(migration13Path, "utf8"));
    const companyId = scalar(database, 'SELECT "id" FROM "Company" ORDER BY "id" LIMIT 1');
    database.prepare(`
      INSERT INTO "LedgerImportBatch"
        ("id", "companyId", "sourceName", "sourceSha256", "mappingJson", "status")
      VALUES ('legacy-13-batch', ?, 'legacy.xlsx', 'legacy-source-hash', '{"sheet":"Journal"}', 'REVIEW_REQUIRED')
    `).run(companyId);
    database.prepare(`
      INSERT INTO "LedgerImportRow"
        ("id", "batchId", "sourceRow", "rawJson", "fingerprint", "validationStatus", "validationError")
      VALUES ('legacy-13-row', 'legacy-13-batch', 7, '{"Date":"2026-01-01"}', 'legacy-row-hash', 'INVALID', 'Compte manquant')
    `).run();

    applySql(database, fs.readFileSync(migration13RevisionsPath, "utf8"));

    expect(database.prepare('SELECT "sourceSha256", "scopeSha256", "revision", "supersedesBatchId" FROM "LedgerImportBatch" WHERE "id" = ?').get("legacy-13-batch")).toEqual({
      sourceSha256: "legacy-source-hash",
      scopeSha256: "",
      revision: 1,
      supersedesBatchId: null,
    });
    expect(database.prepare('SELECT "sourceRow", "rawJson", "validationStatus", "validationError" FROM "LedgerImportRow" WHERE "id" = ?').get("legacy-13-row")).toEqual({
      sourceRow: 7,
      rawJson: '{"Date":"2026-01-01"}',
      validationStatus: "INVALID",
      validationError: "Compte manquant",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the full saved pre-1.2 user database upgrades through 1.2 and 1.3 without losing links", () => {
  skipIfHistoricalFixtureIsUnavailable(sourceUser11);
  expect(fs.existsSync(sourceUser11)).toBeTruthy();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-13-full-user-"));
  const databasePath = path.join(temporaryRoot, "atlas-user-copy.sqlite");
  fs.copyFileSync(sourceUser11, databasePath);
  const database = new DatabaseSync(databasePath);

  try {
    const before = Object.fromEntries(["Company", "Entry", "EntryLine", "Invoice", "Document", "BankAccount", "BankMovement", "ActivityLog"]
      .map((table) => [table, scalar(database, `SELECT count(*) FROM "${table}"`)]));
    const bankColumns = database.prepare('PRAGMA table_info("BankAccount")').all().map((column) => column.name);
    if (!bankColumns.includes("balanceCents")) applySql(database, fs.readFileSync(migration11Path, "utf8"));
    applySql(database, fs.readFileSync(migration12Path, "utf8"));
    applyAtlas13(database);

    for (const [table, count] of Object.entries(before)) {
      expect(scalar(database, `SELECT count(*) FROM "${table}"`), `${table} row count`).toBe(count);
    }
    expect(scalar(database, 'SELECT count(*) FROM "Entry" WHERE "journalCodeSnapshot" IS NULL OR "journalCodeSnapshot" = \'\'')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "EntryLine" WHERE "position" < 1 OR "accountCodeSnapshot" = \'\' OR "accountLabelSnapshot" = \'\'')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent"')).toBe(before.ActivityLog);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "integrityStatus" = \'IMPORTED_UNSEALED\'')).toBe(before.ActivityLog);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the two 1.3 migrations are embedded under their exact SHA-256 checksums", () => {
  const migrationFolders = fs.readdirSync(path.join(root, "prisma", "migrations"))
    .filter((name) => name.includes("atlas_1_3"));
  expect(migrationFolders).toEqual([
    "20260813090000_atlas_1_3_integrity_imports",
    "20260814010000_atlas_1_3_import_revisions",
  ]);

  const sql = fs.readFileSync(migration13Path, "utf8");
  const digest = crypto.createHash("sha256").update(sql).digest("hex");
  expect(digest).toBe("11e76ba0f37d36fa057884256c5dbf1e3e8db0df59e323f8db754011ac755b81");
  const revisionsSql = fs.readFileSync(migration13RevisionsPath, "utf8");
  const revisionsDigest = crypto.createHash("sha256").update(revisionsSql).digest("hex");
  expect(revisionsDigest).toBe("6676f3844306b876df1feb5a6c259fc58e15e74947119ea074b1e60e6d8871f0");
  const databaseSource = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
  // The embedded path is the contract; the local import name is incidental.
  expect(databaseSource).toMatch(/import \w+ from "\.\.\/prisma\/migrations\/20260813090000_atlas_1_3_integrity_imports\/migration\.sql\?raw";/);
  expect(databaseSource).toMatch(/import \w+ from "\.\.\/prisma\/migrations\/20260814010000_atlas_1_3_import_revisions\/migration\.sql\?raw";/);
  expect(databaseSource).toContain(`checksum: "${digest}"`);
  expect(databaseSource).toContain(`checksum: "${revisionsDigest}"`);
});

test("the final Wheat release database upgrades in place with all operational links intact", () => {
  skipIfHistoricalFixtureIsUnavailable(source12);
  expect(fs.existsSync(source12)).toBeTruthy();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-13-release12-"));
  const databasePath = path.join(temporaryRoot, "atlas-1.2-release-copy.sqlite");
  fs.copyFileSync(source12, databasePath);
  const database = new DatabaseSync(databasePath);

  try {
    const before = Object.fromEntries([
      "Company", "FiscalYear", "Account", "Journal", "Entry", "EntryLine", "Invoice",
      "InvoiceLine", "Payment", "PaymentAllocation", "Document", "BankAccount",
      "BankStatementImport", "BankMovement", "BankReconciliation",
      "BankReconciliationAllocation", "BankReconciliationPaymentEvidence", "PayrollRun",
      "PayrollRunLine", "ActivityLog",
    ].map((table) => [table, scalar(database, `SELECT count(*) FROM "${table}"`)]));
    const exactSums = {
      debit: String(scalar(database, 'SELECT coalesce(sum("debitCents"), 0) FROM "EntryLine"')),
      credit: String(scalar(database, 'SELECT coalesce(sum("creditCents"), 0) FROM "EntryLine"')),
      invoice: String(scalar(database, 'SELECT coalesce(sum("ttcCents"), 0) FROM "Invoice"')),
      payment: String(scalar(database, 'SELECT coalesce(sum("amountCents"), 0) FROM "Payment"')),
      bank: String(scalar(database, 'SELECT coalesce(sum("amountCents"), 0) FROM "BankMovement"')),
    };
    const links = {
      invoicePosts: scalar(database, 'SELECT count(*) FROM "Invoice" WHERE "postedEntryId" IS NOT NULL'),
      paymentPosts: scalar(database, 'SELECT count(*) FROM "Payment" WHERE "postedEntryId" IS NOT NULL'),
      payrollPosts: scalar(database, 'SELECT count(*) FROM "PayrollRun" WHERE "postedEntryId" IS NOT NULL'),
      documentLinks: scalar(database, 'SELECT count(*) FROM "Document" WHERE "entryId" IS NOT NULL OR "invoiceId" IS NOT NULL OR "paymentId" IS NOT NULL'),
    };

    applyAtlas13(database);

    for (const [table, count] of Object.entries(before)) {
      expect(scalar(database, `SELECT count(*) FROM "${table}"`), `${table} row count`).toBe(count);
    }
    expect(String(scalar(database, 'SELECT coalesce(sum("debitCents"), 0) FROM "EntryLine"'))).toBe(exactSums.debit);
    expect(String(scalar(database, 'SELECT coalesce(sum("creditCents"), 0) FROM "EntryLine"'))).toBe(exactSums.credit);
    expect(String(scalar(database, 'SELECT coalesce(sum("ttcCents"), 0) FROM "Invoice"'))).toBe(exactSums.invoice);
    expect(String(scalar(database, 'SELECT coalesce(sum("amountCents"), 0) FROM "Payment"'))).toBe(exactSums.payment);
    expect(String(scalar(database, 'SELECT coalesce(sum("amountCents"), 0) FROM "BankMovement"'))).toBe(exactSums.bank);
    expect(scalar(database, 'SELECT count(*) FROM "Invoice" WHERE "postedEntryId" IS NOT NULL')).toBe(links.invoicePosts);
    expect(scalar(database, 'SELECT count(*) FROM "Payment" WHERE "postedEntryId" IS NOT NULL')).toBe(links.paymentPosts);
    expect(scalar(database, 'SELECT count(*) FROM "PayrollRun" WHERE "postedEntryId" IS NOT NULL')).toBe(links.payrollPosts);
    expect(scalar(database, 'SELECT count(*) FROM "Document" WHERE "entryId" IS NOT NULL OR "invoiceId" IS NOT NULL OR "paymentId" IS NOT NULL')).toBe(links.documentLinks);
    expect(scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "integrityStatus" = \'IMPORTED_UNSEALED\'')).toBe(before.ActivityLog);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
