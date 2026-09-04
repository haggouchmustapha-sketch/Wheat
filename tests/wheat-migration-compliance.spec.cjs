const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const source13 = path.join(root, "backups", "atlas-1.4-prework-1.3-release-20260814-001", "dev.db");
const migrationName = "20260814090000_atlas_1_4_compliance_close";
const migrationPath = path.join(root, "prisma", "migrations", migrationName, "migration.sql");
const expectedDigest = "8eef9098d814915f80db42394c2679bef78d12cc540090793b1a5f51a90547de";

function skipIfHistoricalFixtureIsUnavailable() {
  test.skip(!fs.existsSync(source13), `Historical backup fixture is unavailable: ${path.relative(root, source13)}`);
}

function scalar(database, sql) {
  return Object.values(database.prepare(sql).get())[0];
}

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

function tableCounts(database, tables) {
  return Object.fromEntries(tables.map((table) => [
    table,
    scalar(database, `SELECT count(*) FROM "${table}"`),
  ]));
}

function exactMoney(database) {
  const expressions = {
    entryDebit: 'SELECT CAST(coalesce(sum("debitCents"), 0) AS TEXT) FROM "EntryLine"',
    entryCredit: 'SELECT CAST(coalesce(sum("creditCents"), 0) AS TEXT) FROM "EntryLine"',
    invoiceHt: 'SELECT CAST(coalesce(sum("htCents"), 0) AS TEXT) FROM "Invoice"',
    invoiceVat: 'SELECT CAST(coalesce(sum("vatCents"), 0) AS TEXT) FROM "Invoice"',
    invoiceTtc: 'SELECT CAST(coalesce(sum("ttcCents"), 0) AS TEXT) FROM "Invoice"',
    invoiceLineTtc: 'SELECT CAST(coalesce(sum("ttcCents"), 0) AS TEXT) FROM "InvoiceLine"',
    payment: 'SELECT CAST(coalesce(sum("amountCents"), 0) AS TEXT) FROM "Payment"',
    allocation: 'SELECT CAST(coalesce(sum("amountCents"), 0) AS TEXT) FROM "PaymentAllocation"',
    bankBalance: 'SELECT CAST(coalesce(sum("balanceCents"), 0) AS TEXT) FROM "BankAccount"',
    bankMovement: 'SELECT CAST(coalesce(sum("amountCents"), 0) AS TEXT) FROM "BankMovement"',
    payrollGross: 'SELECT CAST(coalesce(sum("grossSalaryCents"), 0) AS TEXT) FROM "PayrollRunLine"',
    legacyTaxDue: 'SELECT CAST(coalesce(sum("dueVatCents"), 0) AS TEXT) FROM "TaxPeriod"',
  };
  return Object.fromEntries(Object.entries(expressions).map(([key, sql]) => [key, String(scalar(database, sql))]));
}

function preservedLinks(database) {
  const expressions = {
    postedInvoices: 'SELECT count(*) FROM "Invoice" WHERE "postedEntryId" IS NOT NULL',
    voidInvoices: 'SELECT count(*) FROM "Invoice" WHERE "voidEntryId" IS NOT NULL',
    invoiceCounterparties: 'SELECT count(*) FROM "Invoice" WHERE "counterpartyId" IS NOT NULL',
    allocations: 'SELECT count(*) FROM "PaymentAllocation"',
    linkedDocuments: 'SELECT count(*) FROM "Document" WHERE "entryId" IS NOT NULL OR "invoiceId" IS NOT NULL OR "paymentId" IS NOT NULL',
    statementMovements: 'SELECT count(*) FROM "BankMovement" WHERE "statementId" IS NOT NULL',
    reconciliationLines: 'SELECT count(*) FROM "BankReconciliationAllocation"',
    reconciliationPayments: 'SELECT count(*) FROM "BankReconciliationPaymentEvidence"',
    importedDrafts: 'SELECT count(*) FROM "LedgerImportRow" WHERE "draftEntryId" IS NOT NULL',
  };
  return Object.fromEntries(Object.entries(expressions).map(([key, sql]) => [key, scalar(database, sql)]));
}

test("1.4 upgrades the preserved 1.3 release without rewriting money, links, legacy tax periods, or audit evidence", () => {
  skipIfHistoricalFixtureIsUnavailable();
  expect(fs.existsSync(source13)).toBeTruthy();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-14-preserve-"));
  const databasePath = path.join(temporaryRoot, "atlas-1.3-release-copy.sqlite");
  fs.copyFileSync(source13, databasePath);
  const database = new DatabaseSync(databasePath);

  const legacyTables = [
    "Company", "FiscalYear", "Account", "Journal", "Entry", "EntryLine", "Counterparty",
    "Invoice", "InvoiceLine", "Payment", "PaymentAllocation", "Document", "BankAccount",
    "BankStatementImport", "BankMovement", "BankReconciliation", "BankReconciliationAllocation",
    "BankReconciliationPaymentEvidence", "Employee", "PayrollRun", "PayrollRunLine", "TaxPeriod",
    "ActivityLog", "CompanyUser", "User", "LedgerImportBatch", "LedgerImportRow", "BankImportProfile",
    "AuditChain", "AuditEvent", "AuditSeal",
  ];

  try {
    const before = {
      counts: tableCounts(database, legacyTables),
      money: exactMoney(database),
      links: preservedLinks(database),
      taxPeriodShape: database.prepare('PRAGMA table_info("TaxPeriod")').all(),
      audit: {
        events: scalar(database, 'SELECT count(*) FROM "AuditEvent"'),
        chained: scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "eventHash" IS NOT NULL'),
        legacyUnsealed: scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "integrityStatus" = \'IMPORTED_UNSEALED\''),
        lastSequences: database.prepare('SELECT "companyId", CAST("lastSequence" AS TEXT) AS "lastSequence", "lastEventHash" FROM "AuditChain" ORDER BY "companyId"').all(),
        eventHashes: database.prepare('SELECT "chainId", CAST("sequence" AS TEXT) AS "sequence", "previousHash", "eventHash", "integrityStatus" FROM "AuditEvent" ORDER BY "chainId", "sequence"').all(),
      },
    };

    applySql(database, fs.readFileSync(migrationPath, "utf8"));

    expect(tableCounts(database, legacyTables)).toEqual(before.counts);
    expect(exactMoney(database)).toEqual(before.money);
    expect(preservedLinks(database)).toEqual(before.links);
    expect(database.prepare('PRAGMA table_info("TaxPeriod")').all()).toEqual(before.taxPeriodShape);
    expect({
      events: scalar(database, 'SELECT count(*) FROM "AuditEvent"'),
      chained: scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "eventHash" IS NOT NULL'),
      legacyUnsealed: scalar(database, 'SELECT count(*) FROM "AuditEvent" WHERE "integrityStatus" = \'IMPORTED_UNSEALED\''),
      lastSequences: database.prepare('SELECT "companyId", CAST("lastSequence" AS TEXT) AS "lastSequence", "lastEventHash" FROM "AuditChain" ORDER BY "companyId"').all(),
      eventHashes: database.prepare('SELECT "chainId", CAST("sequence" AS TEXT) AS "sequence", "previousHash", "eventHash", "integrityStatus" FROM "AuditEvent" ORDER BY "chainId", "sequence"').all(),
    }).toEqual(before.audit);

    const newTables = [
      "InvoiceArtifact", "TaxConfigurationVersion", "TaxRateDefinition", "VatWorkpaper",
      "VatWorkpaperLine", "VatWorkpaperAdjustment", "VatWorkpaperEvidence", "FiscalCloseRun",
    ];
    expect(tableCounts(database, newTables)).toEqual(Object.fromEntries(newTables.map((table) => [table, 0])));
    expect(scalar(database, `SELECT count(*) FROM "Invoice" WHERE "documentType" <> 'INVOICE' OR "creditedInvoiceId" IS NOT NULL OR "taxConfigurationVersionId" IS NOT NULL OR "artifactRequired" <> 0`)).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "InvoiceLine" WHERE "creditedInvoiceLineId" IS NOT NULL OR "taxRateDefinitionId" IS NOT NULL OR "taxRateCodeSnapshot" IS NOT NULL')).toBe(0);
    expect(scalar(database, 'SELECT count(*) FROM "FiscalYear" WHERE "closedAt" IS NOT NULL OR "closeRunId" IS NOT NULL OR "reopenedAt" IS NOT NULL')).toBe(0);
    expect(scalar(database, `SELECT count(*) FROM "AuditSeal" WHERE "verificationStatus" <> 'UNVERIFIED' OR "payloadSha256" IS NOT NULL`)).toBe(0);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("immutable invoice artifacts reject in-place mutation and deletion at the SQLite boundary", () => {
  skipIfHistoricalFixtureIsUnavailable();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-14-artifact-"));
  const databasePath = path.join(temporaryRoot, "atlas-1.3-release-copy.sqlite");
  fs.copyFileSync(source13, databasePath);
  const database = new DatabaseSync(databasePath);

  try {
    applySql(database, fs.readFileSync(migrationPath, "utf8"));
    const invoice = database.prepare('SELECT "id", "companyId" FROM "Invoice" ORDER BY "createdAt" LIMIT 1').get();
    database.prepare(`
      INSERT INTO "InvoiceArtifact"
        ("id", "companyId", "invoiceId", "kind", "revision", "pdfBytes", "byteSize", "contentSha256", "payloadJson", "payloadSha256", "immutable")
      VALUES (?, ?, ?, 'IMMUTABLE_PDF', 1, ?, ?, ?, ?, ?, true)
    `).run("artifact-1", invoice.companyId, invoice.id, Buffer.from("%PDF-1.4\noriginal"), 17, "content-hash", "{\"invoice\":1}", "payload-hash");

    expect(() => database.prepare('UPDATE "InvoiceArtifact" SET "payloadJson" = ? WHERE "id" = ?').run("{}", "artifact-1")).toThrow(/append a revision/i);
    expect(() => database.prepare('UPDATE "InvoiceArtifact" SET "immutable" = false WHERE "id" = ?').run("artifact-1")).toThrow(/append a revision/i);
    expect(() => database.prepare('DELETE FROM "InvoiceArtifact" WHERE "id" = ?').run("artifact-1")).toThrow(/cannot be deleted/i);
    expect(scalar(database, 'SELECT count(*) FROM "InvoiceArtifact" WHERE "id" = \'artifact-1\'')).toBe(1);
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

/**
 * The shipped release. Every version location has to agree with it, which is
 * what this constant exists to enforce: bumping the product means changing it
 * here once, and the test then proves package.json, the lockfile and the
 * renderer's derived version all moved together.
 */
const RELEASE_VERSION = "2.1.260901";

test("the 1.4 migration stays embedded while the runtime reports the current schema version", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  expect(crypto.createHash("sha256").update(sql).digest("hex")).toBe(expectedDigest);
  const databaseSource = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
  // The embedded path is the contract; the local import name is incidental.
  expect(databaseSource).toContain(`from "../prisma/migrations/${migrationName}/migration.sql?raw";`);
  expect(databaseSource).toContain(`name: "${migrationName}"`);
  expect(databaseSource).toContain(`checksum: "${expectedDigest}"`);
  expect(databaseSource).toContain("schema=2.1.0");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  expect(packageJson.name).toBe("wheat");
  expect(packageJson.version).toBe(RELEASE_VERSION);
  expect(packageJson.atlasVersion).toBeUndefined();
  expect(packageJson.build.buildNumber).toBeUndefined();
  expect(packageJson.build.buildVersion).toBeUndefined();
  expect(packageJson.build.artifactName).toBe("WheatSetup-${version}.${ext}");
  expect(packageJson.build.directories.output).toBe("release/${version}");
  expect(fs.readFileSync(path.join(root, "src", "appVersion.ts"), "utf8")).toContain("packageMetadata.version");
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  expect(packageLock).toMatchObject({ name: "wheat", version: RELEASE_VERSION });
  expect(packageLock.packages[""]).toMatchObject({ name: "wheat", version: RELEASE_VERSION });
});

test("a fresh database applies every migration and seeds without inventing compliance evidence", () => {
  test.setTimeout(120_000);
  // Prisma resolves relative SQLite URLs from the schema directory. Keeping
  // this isolated test database there avoids platform-specific absolute URL
  // parsing while the unique directory remains safe to remove in finally.
  const temporaryRoot = fs.mkdtempSync(path.join(root, "prisma", ".atlas-14-fresh-"));
  const databasePath = path.join(temporaryRoot, "fresh.sqlite");
  const databaseUrl = `file:./${path.basename(temporaryRoot)}/fresh.sqlite`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, RUST_BACKTRACE: "1", RUST_LOG: "info" };

  try {
    execFileSync(process.execPath, [path.join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "reset", "--force", "--skip-seed"], { cwd: root, env, stdio: "pipe", timeout: 60_000 });
    execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], { cwd: root, env, stdio: "pipe", timeout: 60_000 });
    const database = new DatabaseSync(databasePath);
    try {
      // Derived from what is on disk rather than written down. A hardcoded count
      // is a number that goes stale on the next migration and then reports a
      // healthy database as broken — which is what it had already done.
      const migrationCount = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
      expect(scalar(database, 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL')).toBe(migrationCount);
      expect(scalar(database, 'SELECT count(*) FROM "Company"')).toBeGreaterThan(0);
      expect(scalar(database, `SELECT count(*) FROM "Invoice" WHERE "documentType" <> 'INVOICE' OR "artifactRequired" <> 0 OR "taxConfigurationVersionId" IS NOT NULL`)).toBe(0);
      for (const table of ["InvoiceArtifact", "TaxConfigurationVersion", "TaxRateDefinition", "VatWorkpaper", "VatWorkpaperLine", "VatWorkpaperAdjustment", "VatWorkpaperEvidence", "FiscalCloseRun"]) {
        expect(scalar(database, `SELECT count(*) FROM "${table}"`), table).toBe(0);
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(scalar(database, "PRAGMA integrity_check")).toBe("ok");
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
