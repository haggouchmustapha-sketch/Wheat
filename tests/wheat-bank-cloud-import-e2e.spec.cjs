const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * A scanned statement read in the cloud, all the way into the books.
 *
 * The unit suite proves what Wheat accepts from a provider. This proves the
 * other half, and the half that actually matters to an accountant: that what
 * comes back travels the *same* road as a CSV from the same bank — the same
 * column mapping, the same validation, the same duplicate detection, the same
 * import history — and that the movements are still there when Wheat is
 * reopened.
 *
 * There is deliberately no second persistence engine to test. If this suite had
 * needed one, the design would have been wrong.
 */

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationPath = path.join(cwd, "prisma", "migrations", "20260812160058_atlas_1_2_operational", "migration.sql");
const migration13Path = path.join(cwd, "prisma", "migrations", "20260813090000_atlas_1_3_integrity_imports", "migration.sql");
const seedDatabasePath = path.join(cwd, "prisma", "dev.db");

let importer;
let reconciliation;
let cloud;
let prisma;
let temporaryRoot;
let databasePath;

function sqliteFileUrl(filePath) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

function applyMigrations(target) {
  const database = new DatabaseSync(target);
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'BankReconciliation'").get()) {
      database.exec(fs.readFileSync(migrationPath, "utf8"));
    }
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'AuditChain'").get()) {
      database.exec(fs.readFileSync(migration13Path, "utf8"));
    }
  } finally {
    database.close();
  }
}

async function createBankAccount() {
  const suffix = randomUUID();
  const company = await prisma.company.create({
    data: {
      id: `company-${suffix}`,
      name: "Atlas cloud bank import",
      legalForm: "SARL",
      ice: `ICE-${suffix}`,
      taxId: `IF-${suffix}`,
      city: "Casablanca",
    },
  });
  const ledgerAccount = await prisma.account.create({
    data: { id: `account-${suffix}`, companyId: company.id, code: `514-${suffix}`, label: "Banque", classNo: 5, type: "ASSET" },
  });
  const bankAccount = await prisma.bankAccount.create({
    data: {
      id: `bank-${suffix}`,
      companyId: company.id,
      bankName: "Attijariwafa test",
      iban: `MA64-${suffix}`,
      balanceCents: 0n,
      ledgerAccountId: ledgerAccount.id,
      balanceSource: "STATEMENT",
    },
  });
  return { company, bankAccount };
}

/** A Lightweight machine: packaged, with no PaddleOCR anywhere it would look. */
function lightweightApp() {
  const empty = path.join(os.tmpdir(), "wheat-bank-cloud-e2e-resources");
  fs.mkdirSync(empty, { recursive: true });
  Object.defineProperty(process, "resourcesPath", { value: empty, configurable: true, writable: true });
  return { isPackaged: true, getPath: () => os.tmpdir() };
}

/** One page of a Moroccan statement, as a provider transcribes it. */
const PAGE = {
  currency: "MAD",
  confidence: 84,
  rows: [
    { line: 1, kind: "HEADER", label: "DATE LIBELLE CAPITAUX DEBIT CREDIT" },
    { line: 2, kind: "OPENING_BALANCE", label: "SOLDE INITIAL AU 01 06 2026", balance: "12 500,00" },
    { line: 3, kind: "TRANSACTION", date: "25 06", valueDate: "25 06 2026", label: "VIREMENT RECU CHANI", reference: "VIR0091", debit: "", credit: "18 334,42" },
    { line: 4, kind: "TRANSACTION", date: "26 06", valueDate: "26 06 2026", label: "CHEQUE 4410021", reference: "4410021", debit: "3 200,00", credit: "" },
    { line: 5, kind: "CLOSING_BALANCE", label: "SOLDE FINAL AU 30 06 2026", balance: "27 634,42" },
  ],
};

function provider(reply = PAGE) {
  const calls = [];
  return {
    calls,
    isConnected: () => true,
    runVision: async (request) => {
      calls.push(request);
      return { text: JSON.stringify(reply), provider: "OpenRouter", modelId: "some/vision-model:free" };
    },
  };
}

function lightweightPlan(runtime) {
  return cloud.resolveRecognitionPlan({
    hasBundledLocalOcr: false,
    cloud: { runtime, enabled: true, consentGiven: true },
  });
}

test.beforeAll(async () => {
  importer = tsxRequire(path.join(cwd, "electron", "bankStatementImporter.ts"), __filename);
  reconciliation = tsxRequire(path.join(cwd, "electron", "reconciliation.ts"), __filename);
  cloud = tsxRequire(path.join(cwd, "electron", "cloudOcr.ts"), __filename);
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-bank-cloud-e2e-"));
  databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(seedDatabasePath, databasePath);
  applyMigrations(databasePath);
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  await prisma.$connect();
});

test.afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("a cloud-read statement is mapped, validated, imported and still there after a restart", async () => {
  const { bankAccount } = await createBankAccount();
  const runtime = provider();
  const bytes = fs.readFileSync(path.join(cwd, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png"));

  /* ------------------------------------------------------- read the pages */
  const parsed = await importer.parseBankStatement({
    sourceName: "releve-scanne.png",
    bytesBase64: bytes.toString("base64"),
    app: lightweightApp(),
    recognition: lightweightPlan(runtime),
  });
  expect(parsed.ocr.local).toBe(false);
  expect(parsed.rowCount).toBe(2);
  // The mapping Wheat proposes is the ordinary one, produced by the ordinary
  // suggester from the table's own headings.
  const mapping = parsed.suggestedMapping;
  expect(mapping.debit).toBe("Débit");
  expect(mapping.credit).toBe("Crédit");

  /* ---------------------------------------------- the ordinary checks run */
  const service = reconciliation.createReconciliationService(prisma);
  const sourceSha256 = reconciliation.statementBytesSha256(bytes);
  const review = await service.reviewStatement({
    bankAccountId: bankAccount.id,
    sourceSha256,
    rows: parsed.rows,
    mapping,
    sourceCurrency: parsed.currency,
  });
  expect(review.canImport).toBe(true);
  expect(review.errorCount).toBe(0);
  expect(review.readyCount).toBe(2);

  /* ------------------------------------- nothing exists until it is asked */
  expect(await prisma.bankMovement.count({ where: { bankAccountId: bankAccount.id } })).toBe(0);

  const imported = await service.importStatement({
    bankAccountId: bankAccount.id,
    sourceName: "releve-scanne.png",
    sourceSha256,
    sourceFormat: parsed.format,
    sourceCurrency: parsed.currency,
    rows: parsed.rows,
    mapping,
  });
  expect(imported.movements).toHaveLength(2);

  /* ------------------------------------------ the amounts, exactly, in cents */
  const movements = await prisma.bankMovement.findMany({
    where: { bankAccountId: bankAccount.id },
    orderBy: { date: "asc" },
  });
  expect(movements.map((movement) => movement.amountCents)).toEqual([1_833_442n, -320_000n]);
  expect(movements.map((movement) => movement.label)).toEqual(["VIREMENT RECU CHANI", "CHEQUE 4410021"]);
  // The bare "25 06" resolved against the year the statement states elsewhere.
  expect(movements[0].date.toISOString().slice(0, 10)).toBe("2026-06-25");

  /* ------------------------ nothing was reconciled or posted on Wheat's say-so */
  for (const movement of movements) expect(movement.status).toBe("TO_REVIEW");
  // Scoped to this dossier: the seed database carries reconciliations of its
  // own, and a global count would say nothing about what this import did.
  expect(await prisma.bankReconciliation.count({ where: { movement: { bankAccountId: bankAccount.id } } })).toBe(0);
  expect(await prisma.entry.count({ where: { companyId: bankAccount.companyId } })).toBe(0);

  /* ---------------------------------- the same import history as any other */
  const statement = await prisma.bankStatementImport.findFirst({ where: { bankAccountId: bankAccount.id } });
  expect(statement).toBeTruthy();
  expect(statement.sourceFormat).toBe("IMAGE_OCR");
  expect(statement.sourceSha256).toBe(sourceSha256);

  /* --------------------------------------------- and still there on reopening */
  await prisma.$disconnect();
  const reopened = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  await reopened.$connect();
  const afterRestart = await reopened.bankMovement.findMany({ where: { bankAccountId: bankAccount.id }, orderBy: { date: "asc" } });
  expect(afterRestart.map((movement) => movement.amountCents)).toEqual([1_833_442n, -320_000n]);
  await reopened.$disconnect();
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  await prisma.$connect();
});

test("the same statement offered twice is caught by the ordinary duplicate guard", async () => {
  const { bankAccount } = await createBankAccount();
  const bytes = fs.readFileSync(path.join(cwd, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png"));
  const parsed = await importer.parseBankStatement({
    sourceName: "releve-scanne.png",
    bytesBase64: bytes.toString("base64"),
    app: lightweightApp(),
    recognition: lightweightPlan(provider()),
  });
  const service = reconciliation.createReconciliationService(prisma);
  const sourceSha256 = reconciliation.statementBytesSha256(bytes);
  const payload = {
    bankAccountId: bankAccount.id,
    sourceName: "releve-scanne.png",
    sourceSha256,
    sourceFormat: parsed.format,
    sourceCurrency: parsed.currency,
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
  };
  await service.importStatement(payload);

  // Offered again under a different name, the content is still recognised.
  const second = await service.reviewStatement({
    bankAccountId: bankAccount.id,
    sourceSha256,
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
    sourceCurrency: parsed.currency,
  });
  expect(second.exactFileDuplicate).toBe(true);
  expect(second.canImport).toBe(false);
  expect(await prisma.bankMovement.count({ where: { bankAccountId: bankAccount.id } })).toBe(2);
});

test("a row the reading could not settle cannot pass as a complete statement", async () => {
  const { bankAccount } = await createBankAccount();
  const bytes = fs.readFileSync(path.join(cwd, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png"));
  const parsed = await importer.parseBankStatement({
    sourceName: "releve-ambigu.png",
    bytesBase64: bytes.toString("base64"),
    app: lightweightApp(),
    recognition: lightweightPlan(provider({
      currency: "MAD",
      rows: [
        { line: 1, kind: "TRANSACTION", date: "25 06", valueDate: "25 06 2026", label: "VIREMENT RECU", credit: "18 334,42" },
        { line: 2, kind: "TRANSACTION", date: "26 06", valueDate: "26 06 2026", label: "OPERATION AMBIGUE", debit: "1 000,00", credit: "1 000,00" },
      ],
    })),
  });

  // Named up front, in a place the review screen refuses to confirm past.
  expect(parsed.ocr.cloud.blockingIssues.join(" ")).toContain("débit et un crédit");
  // And refused again by the deterministic service, which knows nothing about
  // where the row came from — the guarantee does not depend on the AI layer.
  const service = reconciliation.createReconciliationService(prisma);
  const review = await service.reviewStatement({
    bankAccountId: bankAccount.id,
    sourceSha256: reconciliation.statementBytesSha256(bytes),
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
    sourceCurrency: parsed.currency,
  });
  expect(review.canImport).toBe(false);
  expect(JSON.stringify(review.errors)).toMatch(/debit and a credit|débit/i);

  await expect(service.importStatement({
    bankAccountId: bankAccount.id,
    sourceName: "releve-ambigu.png",
    sourceSha256: reconciliation.statementBytesSha256(bytes),
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
  })).rejects.toThrow();
  expect(await prisma.bankMovement.count({ where: { bankAccountId: bankAccount.id } })).toBe(0);
});

test("corrections made during review are what gets imported", async () => {
  const { bankAccount } = await createBankAccount();
  const bytes = fs.readFileSync(path.join(cwd, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png"));
  const parsed = await importer.parseBankStatement({
    sourceName: "releve-corrige.png",
    bytesBase64: bytes.toString("base64"),
    app: lightweightApp(),
    recognition: lightweightPlan(provider({
      currency: "MAD",
      rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", valueDate: "25 06 2026", label: "VIREMENT RECU", credit: "18 334,42" }],
    })),
  });

  // What the review screen does when somebody retypes a misread figure: the
  // row, corrected, is the row that is checked and the row that is imported.
  const corrected = parsed.rows.map((row) => ({ ...row, "Crédit": "18 344,42" }));
  const service = reconciliation.createReconciliationService(prisma);
  const sourceSha256 = reconciliation.statementBytesSha256(bytes);
  const review = await service.reviewStatement({
    bankAccountId: bankAccount.id,
    sourceSha256,
    rows: corrected,
    mapping: parsed.suggestedMapping,
    sourceCurrency: parsed.currency,
  });
  expect(review.canImport).toBe(true);

  await service.importStatement({
    bankAccountId: bankAccount.id,
    sourceName: "releve-corrige.png",
    sourceSha256,
    sourceFormat: parsed.format,
    sourceCurrency: parsed.currency,
    rows: corrected,
    mapping: parsed.suggestedMapping,
  });
  const movements = await prisma.bankMovement.findMany({ where: { bankAccountId: bankAccount.id } });
  expect(movements.map((movement) => movement.amountCents)).toEqual([1_834_442n]);
});
