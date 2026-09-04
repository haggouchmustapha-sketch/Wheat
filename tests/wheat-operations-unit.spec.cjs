const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const operationsModulePath = path.join(root, "electron", "operations13.ts");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let operations;
let prisma;
let temporaryRoot;
let service;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

async function createCompanyFixture(label = "Primary") {
  const company = await prisma.company.create({
    data: {
      name: `Wheat ${label}`,
      legalForm: "SARL",
      ice: "001234567890123",
      taxId: `IF-${label}`,
      city: "Casablanca",
      vatFrequency: "MONTHLY",
    },
  });
  const fiscalYear = await prisma.fiscalYear.create({
    data: {
      companyId: company.id,
      label: "Exercice 2026",
      startsOn: new Date("2026-01-01T00:00:00.000Z"),
      endsOn: new Date("2026-12-31T00:00:00.000Z"),
      status: "OPEN",
    },
  });
  const journal = await prisma.journal.create({
    data: { companyId: company.id, code: "OD", label: "Opérations diverses", nextNumber: 1 },
  });
  const debitAccount = await prisma.account.create({
    data: { companyId: company.id, code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
  });
  const creditAccount = await prisma.account.create({
    data: { companyId: company.id, code: "712000", label: "Ventes", classNo: 7, type: "REVENUE" },
  });
  return { company, fiscalYear, journal, debitAccount, creditAccount };
}

function importRow(overrides = {}) {
  return {
    sourceRow: 2,
    entryKey: "ENTRY-1",
    date: "2026-06-15",
    journalCode: "OD",
    pieceNumber: "PIECE-1",
    entryLabel: "Écriture importée",
    accountCode: "342100",
    lineLabel: "Débit client",
    debitCents: "12345",
    creditCents: "0",
    ...overrides,
  };
}

function stagePayload(companyId, sourceIdentity, rows) {
  return {
    companyId,
    sourceName: `${sourceIdentity}.csv`,
    sourceBytesBase64: Buffer.from(`atlas-ledger-${sourceIdentity}`, "utf8").toString("base64"),
    mapping: {
      date: "Date",
      journalCode: "Journal",
      accountCode: "Compte",
      debitCents: "Débit centimes",
      creditCents: "Crédit centimes",
    },
    rows,
  };
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  operations = tsxRequire(operationsModulePath, __filename);
});

test.beforeEach(async () => {
  expect(fs.existsSync(migratedDatabasePath)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-13-operations-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  service = operations.createOperations13Service({ getPrisma: async () => prisma });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
  service = null;
});

test("staging reviews every row and rejects invalid, unbalanced, or inconsistent entry groups", async () => {
  const { company } = await createCompanyFixture();

  const invalidLine = await service.stageLedgerImport(stagePayload(company.id, "invalid-line", [
    importRow({ debitCents: "1000", creditCents: "1000" }),
  ]));
  expect(invalidLine.status).toBe("REVIEW_REQUIRED");
  expect(invalidLine.rows).toHaveLength(1);
  expect(invalidLine.rows[0]).toMatchObject({ validationStatus: "INVALID" });
  expect(invalidLine.rows[0].validationError).toMatch(/débit|crédit|exclusivement/i);

  const unbalanced = await service.stageLedgerImport(stagePayload(company.id, "unbalanced-group", [
    importRow({ sourceRow: 10, debitCents: "1000", creditCents: "0" }),
    importRow({ sourceRow: 11, accountCode: "712000", lineLabel: "Crédit vente", debitCents: "0", creditCents: "999" }),
  ]));
  expect(unbalanced.status).toBe("REVIEW_REQUIRED");
  expect(unbalanced.rows).toHaveLength(2);
  expect(unbalanced.rows.every((row) => row.validationStatus === "INVALID")).toBe(true);
  expect(unbalanced.rows.every((row) => /équilibr|centime/i.test(row.validationError))).toBe(true);
  await expect(service.confirmLedgerImport({ companyId: company.id, batchId: unbalanced.id })).rejects.toThrow(/valide|préparé/i);

  const inconsistent = await service.stageLedgerImport(stagePayload(company.id, "inconsistent-group", [
    importRow({ sourceRow: 20 }),
    importRow({ sourceRow: 21, accountCode: "712000", pieceNumber: "OTHER-PIECE", debitCents: "0", creditCents: "12345" }),
  ]));
  expect(inconsistent.status).toBe("REVIEW_REQUIRED");
  expect(inconsistent.rows.every((row) => row.validationStatus === "INVALID")).toBe(true);
  expect(inconsistent.rows.every((row) => /en-tête|partag/i.test(row.validationError))).toBe(true);
});

test("staging preserves exact integer-cent strings and refuses unsafe JavaScript numbers", async () => {
  const { company } = await createCompanyFixture();
  const exact = "9007199254740993";
  const staged = await service.stageLedgerImport(stagePayload(company.id, "exact-cents", [
    importRow({ sourceRow: 30, debitCents: exact, creditCents: "0" }),
    importRow({ sourceRow: 31, accountCode: "712000", debitCents: "0", creditCents: exact }),
  ]));
  expect(staged.status).toBe("STAGED");
  expect(JSON.parse(staged.rows[0].normalizedJson).debitCents).toBe(exact);
  expect(JSON.parse(staged.rows[1].normalizedJson).creditCents).toBe(exact);

  const unsafeNumber = await service.stageLedgerImport(stagePayload(company.id, "unsafe-number", [
    importRow({ sourceRow: 40, debitCents: Number.MAX_SAFE_INTEGER + 2, creditCents: "0" }),
    importRow({ sourceRow: 41, accountCode: "712000", debitCents: "0", creditCents: "9007199254740993" }),
  ]));
  expect(unsafeNumber.status).toBe("REVIEW_REQUIRED");
  expect(unsafeNumber.rows[0].validationStatus).toBe("INVALID");
  expect(unsafeNumber.rows[0].validationError).toMatch(/sûr|précis|entier|invalide/i);
});

test("an active evidence scope cannot be staged twice, while source identity remains company-local", async () => {
  const { company } = await createCompanyFixture();
  const rows = [
    importRow(),
    importRow({ sourceRow: 3, accountCode: "712000", debitCents: "0", creditCents: "12345" }),
  ];
  const payload = stagePayload(company.id, "duplicate-source", rows);
  const first = await service.stageLedgerImport(payload);
  expect(first.status).toBe("STAGED");
  expect(first).toMatchObject({ revision: 1, supersedesBatchId: null });
  expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.scopeSha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(service.stageLedgerImport({ ...payload, sourceName: "renamed.csv" })).rejects.toThrow(/déjà préparées|lot/i);

  const secondCompany = await createCompanyFixture("Secondary");
  const independent = await service.stageLedgerImport({ ...payload, companyId: secondCompany.company.id });
  expect(independent.companyId).toBe(secondCompany.company.id);
  expect(independent.sourceSha256).toBe(first.sourceSha256);
});

test("the same workbook can stage independent sheets or mappings without losing its source hash", async () => {
  const { company } = await createCompanyFixture("Workbook");
  const rows = [
    importRow(),
    importRow({ sourceRow: 3, accountCode: "712000", debitCents: "0", creditCents: "12345" }),
  ];
  const base = stagePayload(company.id, "multi-sheet-workbook", rows);
  const first = await service.stageLedgerImport({ ...base, mapping: { ...base.mapping, sheet: "Ventes" } });
  const second = await service.stageLedgerImport({ ...base, mapping: { ...base.mapping, sheet: "Achats" } });

  expect(second.sourceSha256).toBe(first.sourceSha256);
  expect(second.scopeSha256).not.toBe(first.scopeSha256);
  expect(first).toMatchObject({ revision: 1, supersedesBatchId: null });
  expect(second).toMatchObject({ revision: 1, supersedesBatchId: null });
});

test("review-required and voided evidence can only be revised through an explicit linear supersession", async () => {
  const { company } = await createCompanyFixture("Revisions");
  const invalidPayload = stagePayload(company.id, "review-revision", [
    importRow({ debitCents: "1000", creditCents: "1000" }),
  ]);
  const review = await service.stageLedgerImport(invalidPayload);
  expect(review.status).toBe("REVIEW_REQUIRED");
  await expect(service.stageLedgerImport(invalidPayload)).rejects.toThrow(/Reprendre cet import|explicitement/i);

  const reviewRevision = await service.stageLedgerImport({ ...invalidPayload, supersedesBatchId: review.id });
  expect(reviewRevision).toMatchObject({ status: "REVIEW_REQUIRED", revision: 2, supersedesBatchId: review.id });
  await expect(service.stageLedgerImport({ ...invalidPayload, supersedesBatchId: review.id })).rejects.toThrow(/Reprendre cet import|lot/i);

  const validPayload = stagePayload(company.id, "void-revision", [
    importRow(),
    importRow({ sourceRow: 3, accountCode: "712000", debitCents: "0", creditCents: "12345" }),
  ]);
  const staged = await service.stageLedgerImport(validPayload);
  await service.cancelLedgerImport({ companyId: company.id, batchId: staged.id, reason: "Mapping à reprendre" });
  await prisma.ledgerImportBatch.update({ where: { id: staged.id }, data: { scopeSha256: "" } });
  await expect(service.stageLedgerImport(validPayload)).rejects.toThrow(/Reprendre cet import|explicitement/i);
  await expect(service.stageLedgerImport({
    ...validPayload,
    mapping: { ...validPayload.mapping, sheet: "Autre feuille" },
    supersedesBatchId: staged.id,
  })).rejects.toThrow(/ne correspondent pas|preuves différentes/i);
  const voidRevision = await service.stageLedgerImport({ ...validPayload, supersedesBatchId: staged.id });
  expect(voidRevision).toMatchObject({ status: "STAGED", revision: 2, supersedesBatchId: staged.id });
  expect((await prisma.ledgerImportBatch.findUnique({ where: { id: staged.id } })).scopeSha256).toBe(staged.scopeSha256);
});

test("identical evidence stays blocked after confirmation even when a predecessor id is supplied", async () => {
  const { company } = await createCompanyFixture("ImportedDuplicate");
  const payload = stagePayload(company.id, "confirmed-evidence", [
    importRow(),
    importRow({ sourceRow: 3, accountCode: "712000", debitCents: "0", creditCents: "12345" }),
  ]);
  const staged = await service.stageLedgerImport(payload);
  await service.confirmLedgerImport({ companyId: company.id, batchId: staged.id });
  await expect(service.stageLedgerImport({ ...payload, supersedesBatchId: staged.id })).rejects.toThrow(/déjà été importées|double comptabilisation/i);
});

test("confirmation creates one balanced draft per entry key and links every source row", async () => {
  const { company } = await createCompanyFixture();
  const exact = "9007199254740993";
  const staged = await service.stageLedgerImport(stagePayload(company.id, "multi-entry-confirm", [
    importRow({ sourceRow: 50, entryKey: "ENTRY-A", pieceNumber: "A-1", debitCents: exact, creditCents: "0" }),
    importRow({ sourceRow: 51, entryKey: "ENTRY-A", pieceNumber: "A-1", accountCode: "712000", debitCents: "0", creditCents: exact }),
    importRow({ sourceRow: 52, entryKey: "ENTRY-B", pieceNumber: "B-1", entryLabel: "Deuxième écriture", debitCents: "1250", creditCents: "0" }),
    importRow({ sourceRow: 53, entryKey: "ENTRY-B", pieceNumber: "B-1", entryLabel: "Deuxième écriture", accountCode: "712000", debitCents: "0", creditCents: "1250" }),
  ]));
  expect(staged.status).toBe("STAGED");

  const confirmed = await service.confirmLedgerImport({ companyId: company.id, batchId: staged.id });
  expect(confirmed).toMatchObject({ batchId: staged.id, status: "IMPORTED", rowCount: 4 });
  expect(confirmed.entries).toHaveLength(2);
  expect(confirmed.entries.every((entry) => entry.companyId === company.id && entry.status === "DRAFT")).toBe(true);

  const rows = await prisma.ledgerImportRow.findMany({ where: { batchId: staged.id }, orderBy: { sourceRow: "asc" } });
  expect(rows.every((row) => row.validationStatus === "IMPORTED" && row.draftEntryId)).toBe(true);
  expect(rows[0].draftEntryId).toBe(rows[1].draftEntryId);
  expect(rows[2].draftEntryId).toBe(rows[3].draftEntryId);
  expect(rows[0].draftEntryId).not.toBe(rows[2].draftEntryId);

  const entries = await prisma.entry.findMany({
    where: { id: { in: confirmed.entries.map((entry) => entry.id) } },
    include: { lines: { orderBy: { position: "asc" } } },
    orderBy: { pieceNumber: "asc" },
  });
  expect(entries).toHaveLength(2);
  expect(entries[0].lines).toHaveLength(2);
  expect(entries[0].lines[0].debitCents).toBe(BigInt(exact));
  expect(entries[0].lines[1].creditCents).toBe(BigInt(exact));
  for (const entry of entries) {
    const debit = entry.lines.reduce((sum, line) => sum + line.debitCents, 0n);
    const credit = entry.lines.reduce((sum, line) => sum + line.creditCents, 0n);
    expect(debit).toBe(credit);
  }
});

test("import confirmation and resulting books stay inside the selected company", async () => {
  const first = await createCompanyFixture("First");
  const second = await createCompanyFixture("Second");
  const staged = await service.stageLedgerImport(stagePayload(first.company.id, "company-isolation", [
    importRow(),
    importRow({ sourceRow: 3, accountCode: "712000", debitCents: "0", creditCents: "12345" }),
  ]));

  await expect(service.confirmLedgerImport({ companyId: second.company.id, batchId: staged.id })).rejects.toThrow(/n'existe plus/i);
  expect(await prisma.entry.count({ where: { companyId: second.company.id, source: "LEDGER_IMPORT_1_3" } })).toBe(0);

  await service.confirmLedgerImport({ companyId: first.company.id, batchId: staged.id });
  const importedEntries = await prisma.entry.findMany({
    where: { source: "LEDGER_IMPORT_1_3", companyId: first.company.id },
    include: { lines: { include: { account: true } } },
  });
  expect(importedEntries).toHaveLength(1);
  expect(importedEntries[0].lines.every((line) => line.account.companyId === first.company.id)).toBe(true);
  expect(await prisma.entry.count({ where: { companyId: second.company.id, source: "LEDGER_IMPORT_1_3" } })).toBe(0);
});

test("posted payroll voiding creates an exact reversal once and closes the lifecycle", async () => {
  const fixture = await createCompanyFixture("Payroll");
  const postedEntry = await prisma.entry.create({
    data: {
      companyId: fixture.company.id,
      journalId: fixture.journal.id,
      journalCodeSnapshot: fixture.journal.code,
      number: "OD-2026-PAY-001",
      date: new Date("2026-06-30T00:00:00.000Z"),
      pieceNumber: "PAY-2026-06",
      label: "Paie juin 2026",
      status: "POSTED",
      source: "PAYROLL",
      postedAt: new Date("2026-06-30T12:00:00.000Z"),
      lines: {
        create: [
          {
            position: 1,
            accountId: fixture.debitAccount.id,
            accountCodeSnapshot: fixture.debitAccount.code,
            accountLabelSnapshot: fixture.debitAccount.label,
            label: "Charge salariale",
            debitCents: 500000n,
            creditCents: 0n,
          },
          {
            position: 2,
            accountId: fixture.creditAccount.id,
            accountCodeSnapshot: fixture.creditAccount.code,
            accountLabelSnapshot: fixture.creditAccount.label,
            label: "Dette salariale",
            debitCents: 0n,
            creditCents: 500000n,
          },
        ],
      },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  const payroll = await prisma.payrollRun.create({
    data: {
      companyId: fixture.company.id,
      period: "2026-06",
      status: "POSTED",
      postedEntryId: postedEntry.id,
      postedAt: new Date("2026-06-30T12:00:00.000Z"),
    },
  });

  const result = await service.voidPayrollRun({
    companyId: fixture.company.id,
    payrollRunId: payroll.id,
    expectedVersion: 1,
    reason: "Erreur de paramétrage validée par le comptable",
    date: "2026-07-01",
  });
  expect(result.payrollRun).toMatchObject({ id: payroll.id, status: "VOIDED", version: 2, voidEntryId: result.voidEntry.id });
  expect(result.voidEntry).toMatchObject({ status: "POSTED", source: "PAYROLL_VOID", reversalOfId: postedEntry.id });
  expect(result.voidEntry.lines).toHaveLength(2);
  expect(result.voidEntry.lines[0]).toMatchObject({ debitCents: 0n, creditCents: 500000n });
  expect(result.voidEntry.lines[1]).toMatchObject({ debitCents: 500000n, creditCents: 0n });
  expect((await prisma.entry.findUniqueOrThrow({ where: { id: postedEntry.id } })).status).toBe("REVERSED");

  await expect(service.voidPayrollRun({
    companyId: fixture.company.id,
    payrollRunId: payroll.id,
    expectedVersion: 2,
    reason: "Tentative répétée",
    date: "2026-07-02",
  })).rejects.toThrow(/Seule une paie comptabilisée|déjà/i);
  expect(await prisma.entry.count({ where: { reversalOfId: postedEntry.id, source: "PAYROLL_VOID" } })).toBe(1);
});
