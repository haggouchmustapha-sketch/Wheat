const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(root, "electron", "compliance14.ts");
const databaseTemplate = path.join(root, "prisma", "dev.db");

let compliance;
let prisma;
let temporaryRoot;
let company;
let admin;
let fiscalYear;
let service;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

function day(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function configPayload(overrides = {}) {
  return {
    companyId: company.id,
    name: "TVA encaissements 2026",
    accountingBasis: "COLLECTION",
    frequency: "MONTHLY",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31",
    sourceReference: "Configuration locale documentée — revue requise avant usage",
    rates: [
      { code: "TVA20V", label: "TVA collectée 20 %", rateBps: 2_000, direction: "COLLECTED" },
      { code: "TVA10V", label: "TVA collectée 10 %", rateBps: 1_000, direction: "COLLECTED" },
      { code: "TVA20A", label: "TVA déductible 20 %", rateBps: 2_000, direction: "DEDUCTIBLE" },
    ],
    ...overrides,
  };
}

async function activeConfig(overrides = {}) {
  const draft = await service.saveTaxConfigDraft(configPayload(overrides));
  return service.activateTaxConfig({ companyId: company.id, id: draft.id, expectedVersion: draft.version });
}

async function createCollectedInvoiceAndPayment(configurationId) {
  const counterparty = await prisma.counterparty.create({
    data: {
      companyId: company.id,
      kind: "CUSTOMER",
      displayName: "Client Atlas Test",
      identityKey: `NAME:CLIENT ATLAS TEST ${Date.now()}`,
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      companyId: company.id,
      kind: "SALE",
      documentType: "INVOICE",
      counterparty: counterparty.displayName,
      counterpartyId: counterparty.id,
      counterpartyNameSnapshot: counterparty.displayName,
      invoiceNo: `FA-TEST-${Date.now()}`,
      numberKey: `SALE:TEST-${Date.now()}`,
      invoiceDate: day("2026-08-01"),
      dueDate: day("2026-08-31"),
      htCents: 15_000n,
      vatCents: 2_500n,
      ttcCents: 17_500n,
      status: "OPEN",
      lifecycleStatus: "POSTED",
      source: "WHEAT_1_4_TEST",
      needsReview: false,
      taxConfigurationVersionId: configurationId,
      lines: {
        create: [
          {
            position: 1,
            description: "Prestation 20 %",
            htCents: 10_000n,
            vatCents: 2_000n,
            ttcCents: 12_000n,
            vatRateBps: 2_000,
            taxRateCodeSnapshot: "TVA20V",
            taxRateLabelSnapshot: "TVA collectée 20 %",
            taxRateDirectionSnapshot: "COLLECTED",
            taxConfigurationRevisionSnapshot: 1,
          },
          {
            position: 2,
            description: "Prestation 10 %",
            htCents: 5_000n,
            vatCents: 500n,
            ttcCents: 5_500n,
            vatRateBps: 1_000,
            taxRateCodeSnapshot: "TVA10V",
            taxRateLabelSnapshot: "TVA collectée 10 %",
            taxRateDirectionSnapshot: "COLLECTED",
            taxConfigurationRevisionSnapshot: 1,
          },
        ],
      },
    },
    include: { lines: true },
  });
  const payment = await prisma.payment.create({
    data: {
      companyId: company.id,
      counterpartyId: counterparty.id,
      kind: "RECEIPT",
      paymentDate: day("2026-08-15"),
      method: "BANK_TRANSFER",
      amountCents: 8_750n,
      lifecycleStatus: "POSTED",
      source: "WHEAT_1_4_TEST",
    },
  });
  const allocation = await prisma.paymentAllocation.create({
    data: { paymentId: payment.id, invoiceId: invoice.id, amountCents: 8_750n, status: "ACTIVE" },
  });
  return { counterparty, invoice, payment, allocation };
}

async function hashedDocument(type, suffix) {
  const hash = require("node:crypto").createHash("sha256").update(`evidence:${suffix}`).digest("hex");
  return prisma.document.create({
    data: {
      companyId: company.id,
      title: `Evidence ${suffix}`,
      type,
      fiscalYear: "2026",
      tags: "test",
      storedPath: `managed/evidence-${suffix}.pdf`,
      contentSha256: hash,
      mimeType: "application/pdf",
      byteSize: 128n,
      ocrText: "",
      extracted: "{}",
      status: "REVIEWED",
    },
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  compliance = tsxRequire(modulePath, __filename);
});

test.beforeEach(async () => {
  expect(fs.existsSync(databaseTemplate)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-14-compliance-"));
  const databasePath = path.join(temporaryRoot, "atlas.sqlite");
  fs.copyFileSync(databaseTemplate, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  company = await prisma.company.create({
    data: { name: `Atlas Compliance ${Date.now()}`, legalForm: "SARL", ice: "001234567890123", taxId: "IF-C14", city: "Rabat" },
  });
  admin = await prisma.user.create({
    data: { name: "Admin Compliance", email: `admin-c14-${Date.now()}-${Math.random()}@atlas.local`, role: "ADMIN" },
  });
  await prisma.companyUser.create({ data: { companyId: company.id, userId: admin.id, role: "ADMIN" } });
  fiscalYear = await prisma.fiscalYear.create({
    data: { companyId: company.id, label: "2026", startsOn: day("2026-01-01"), endsOn: day("2026-12-31") },
  });
  service = compliance.createCompliance14Service({
    getPrisma: async () => prisma,
    getActorUserId: async () => admin.id,
    now: () => new Date("2027-01-15T12:00:00.000Z"),
  });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
});

test("exact cent allocation is deterministic for mixed rates and rejects renderer numbers", async () => {
  expect(() => compliance.exactMoneyString(8750, "Encaissement")).toThrow(/chaîne exacte de centimes/i);
  expect(compliance.exactMoneyString("9007199254740993")).toBe(9_007_199_254_740_993n);

  const allocation = compliance.allocateCollectionAcrossInvoiceLines("8750", {
    htCents: 15_000n,
    vatCents: 2_500n,
    ttcCents: 17_500n,
    lines: [
      { id: "line-b", position: 2, htCents: 5_000n, vatCents: 500n, ttcCents: 5_500n, vatRateBps: 1_000 },
      { id: "line-a", position: 1, htCents: 10_000n, vatCents: 2_000n, ttcCents: 12_000n, vatRateBps: 2_000 },
    ],
  });
  expect(allocation).toEqual([
    { invoiceLineId: "line-a", position: 1, rateBps: 2_000, grossCents: 6_000n, taxableCents: 5_000n, vatCents: 1_000n },
    { invoiceLineId: "line-b", position: 2, rateBps: 1_000, grossCents: 2_750n, taxableCents: 2_500n, vatCents: 250n },
  ]);
  expect(allocation.reduce((sum, row) => sum + row.grossCents, 0n)).toBe(8_750n);
  expect(compliance.largestRemainderAllocate(1n, [{ id: "z", weight: 1n }, { id: "a", weight: 1n }])).toEqual([
    { id: "a", amount: 1n },
    { id: "z", amount: 0n },
  ]);
});

test("activated tax configurations are immutable revisions and effective ranges cannot overlap", async () => {
  const activated = await activeConfig();
  expect(activated.status).toBe("ACTIVE");
  await expect(service.saveTaxConfigDraft(configPayload({ id: activated.id, expectedVersion: activated.version, name: "Mutated" }))).rejects.toThrow(/immuable/i);

  const clone = await service.cloneTaxConfig({ companyId: company.id, id: activated.id, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" });
  expect(clone).toMatchObject({ lineageKey: activated.lineageKey, revision: 2, status: "DRAFT" });
  const clonedActive = await service.activateTaxConfig({ companyId: company.id, id: clone.id, expectedVersion: clone.version });
  expect(clonedActive.status).toBe("ACTIVE");

  const overlap = await service.saveTaxConfigDraft(configPayload({
    name: "Overlapping",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31",
  }));
  await expect(service.activateTaxConfig({ companyId: company.id, id: overlap.id, expectedVersion: overlap.version })).rejects.toThrow(/chevauche/i);

  const stored = await prisma.taxConfigurationVersion.findUniqueOrThrow({ where: { id: activated.id } });
  expect(stored.status).toBe("ACTIVE");
  expect(stored.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("workpapers reproduce collection events, detect stale sources, require hashed evidence, and reopen by revision", async () => {
  const configuration = await activeConfig();
  const source = await createCollectedInvoiceAndPayment(configuration.id);
  let workpaper = await service.generateVatWorkpaper({
    companyId: company.id,
    taxConfigurationVersionId: configuration.id,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
  });
  expect(workpaper).toMatchObject({ status: "DRAFT", revision: 1, collectedVatCents: "1250", deductibleVatCents: "0", netVatDueCents: "1250" });
  expect(workpaper.lines.map((line) => line.vatCents)).toEqual(["1000", "250"]);

  await prisma.paymentAllocation.update({ where: { id: source.allocation.id }, data: { amountCents: 8_751n } });
  await expect(service.reviewVatWorkpaper({ companyId: company.id, id: workpaper.id, expectedVersion: workpaper.version })).rejects.toThrow(/sources comptables ont changé/i);
  expect((await prisma.vatWorkpaper.findUniqueOrThrow({ where: { id: workpaper.id } })).status).toBe("DRAFT");
  await prisma.paymentAllocation.update({ where: { id: source.allocation.id }, data: { amountCents: 8_750n } });

  await expect(service.addVatAdjustment({
    companyId: company.id,
    id: workpaper.id,
    expectedVersion: workpaper.version,
    direction: "DEDUCTIBLE",
    taxableCents: "100",
    vatCents: 20,
    reason: "Correction documentée",
    evidenceDocumentId: "not-used",
  })).rejects.toThrow(/chaîne exacte de centimes/i);

  const adjustmentEvidence = await hashedDocument("TAX_EVIDENCE", "adjustment");
  workpaper = await service.addVatAdjustment({
    companyId: company.id,
    id: workpaper.id,
    expectedVersion: workpaper.version,
    direction: "DEDUCTIBLE",
    taxableCents: "100",
    vatCents: "20",
    reason: "Correction documentée",
    evidenceDocumentId: adjustmentEvidence.id,
  });
  expect(workpaper).toMatchObject({ adjustmentVatCents: "-20", netVatDueCents: "1230" });

  workpaper = await service.reviewVatWorkpaper({ companyId: company.id, id: workpaper.id, expectedVersion: workpaper.version });
  expect(workpaper.status).toBe("REVIEWED");
  const receipt = await hashedDocument("FILING_RECEIPT", "filing");
  workpaper = await service.recordVatWorkpaperFiled({
    companyId: company.id,
    id: workpaper.id,
    expectedVersion: workpaper.version,
    filingReference: "RECU-EXTERNE-2026-08",
    filedOn: "2026-09-20",
    filingReceiptDocumentId: receipt.id,
  });
  expect(workpaper.status).toBe("FILED");
  expect(workpaper.notice).toMatch(/aucune transmission/i);

  await expect(service.attachVatEvidence({
    companyId: company.id,
    id: workpaper.id,
    expectedVersion: workpaper.version,
    documentId: adjustmentEvidence.id,
    role: "SUPPORT",
  })).rejects.toThrow(/brouillon/i);

  const reopened = await service.reopenVatWorkpaper({ companyId: company.id, id: workpaper.id, reason: "Correction après constat externe" });
  expect(reopened).toMatchObject({ status: "DRAFT", revision: 2, supersedesWorkpaperId: workpaper.id, filingReference: null });
  expect((await prisma.vatWorkpaper.findUniqueOrThrow({ where: { id: workpaper.id } })).status).toBe("SUPERSEDED");
  expect(reopened.evidence.some((evidence) => evidence.role === "FILING_RECEIPT")).toBe(false);
});

test("fiscal close rechecks its deterministic hash atomically and admin reopen is reverse-order with a new seal", async () => {
  const configuration = await activeConfig();
  await createCollectedInvoiceAndPayment(configuration.id);
  let workpaper = await service.generateVatWorkpaper({
    companyId: company.id,
    taxConfigurationVersionId: configuration.id,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
  });
  workpaper = await service.reviewVatWorkpaper({ companyId: company.id, id: workpaper.id, expectedVersion: workpaper.version });
  const receipt = await hashedDocument("FILING_RECEIPT", "close-filing");
  workpaper = await service.recordVatWorkpaperFiled({
    companyId: company.id,
    id: workpaper.id,
    expectedVersion: workpaper.version,
    filingReference: "CLOSE-TEST-RECEIPT",
    filedOn: "2026-09-20",
    filingReceiptDocumentId: receipt.id,
  });
  expect(workpaper.status).toBe("FILED");

  const preview = await service.previewFiscalClose({ companyId: company.id, fiscalYearId: fiscalYear.id });
  expect(preview.ready).toBe(true);
  expect(preview.checkHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(service.closeFiscalYear({ companyId: company.id, fiscalYearId: fiscalYear.id, checkHash: "0".repeat(64) })).rejects.toThrow(/données ont changé/i);
  expect((await prisma.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYear.id } })).status).toBe("OPEN");

  const closed = await service.closeFiscalYear({ companyId: company.id, fiscalYearId: fiscalYear.id, checkHash: preview.checkHash });
  expect(closed.fiscalYear).toMatchObject({ status: "CLOSED", closeRunId: closed.run.id });
  expect(closed.run).toMatchObject({ action: "CLOSE", status: "COMPLETED" });
  expect(closed.run.auditSeal).toMatchObject({ purpose: "FISCAL_CLOSE", payloadSha256: preview.checkHash });

  const reopened = await service.reopenFiscalYear({ companyId: company.id, fiscalYearId: fiscalYear.id, reason: "Correction comptable approuvée" });
  expect(reopened.fiscalYear).toMatchObject({ status: "OPEN", closeRunId: null, reopenReason: "Correction comptable approuvée" });
  expect(reopened.run).toMatchObject({ action: "REOPEN", status: "COMPLETED" });
  expect(reopened.run.auditSeal.purpose).toBe("FISCAL_REOPEN");
  expect(await prisma.auditSeal.count()).toBe(2);
});

test("local checkpoints verify their segment, report chain advancement, and detect tampering", async () => {
  await activeConfig();
  const checkpoint = await service.createAuditSeal({ companyId: company.id, note: "Checkpoint test" });
  expect(checkpoint.notice).toMatch(/aucune certification/i);
  let verification = await service.verifyAuditSeal({ companyId: company.id, sealId: checkpoint.seal.id });
  expect(verification).toMatchObject({ valid: true, isCurrentTerminal: true, chainAdvancedSinceSeal: false });

  await service.saveTaxConfigDraft(configPayload({ name: "Nouvelle activité", effectiveFrom: "2027-01-01", effectiveTo: "2027-01-31" }));
  verification = await service.verifyAuditSeal({ companyId: company.id, sealId: checkpoint.seal.id });
  expect(verification).toMatchObject({ valid: true, isCurrentTerminal: false, chainAdvancedSinceSeal: true });

  const event = await prisma.auditEvent.findFirstOrThrow({ where: { chainId: checkpoint.chain.id, sequence: checkpoint.seal.fromSequence } });
  await prisma.auditEvent.update({ where: { id: event.id }, data: { payloadJson: '{"tampered":true}' } });
  verification = await service.verifyAuditSeal({ companyId: company.id, sealId: checkpoint.seal.id });
  expect(verification.valid).toBe(false);
  expect(verification.problems.length).toBeGreaterThan(0);
});

test("IPC registration exposes the complete compliance surface exactly once", async () => {
  const registrations = new Map();
  const registered = compliance.registerCompliance14Ipc({
    ipcMain: {
      handle(channel, listener) {
        if (registrations.has(channel)) throw new Error(`duplicate ${channel}`);
        registrations.set(channel, listener);
      },
    },
    getPrisma: async () => prisma,
  });
  expect(registrations.size).toBe(Object.keys(compliance.COMPLIANCE_14_IPC_CHANNELS).length);
  expect(registrations.has("wheat:vat-workpaper:record-filed")).toBe(true);
  expect(registrations.has("wheat:fiscal-close:reopen")).toBe(true);
  expect(registrations.has("wheat:audit-seal:verify")).toBe(true);
  expect(typeof registered.taxWorkspace).toBe("function");
  expect(typeof registered.closeFiscalYear).toBe("function");
});
