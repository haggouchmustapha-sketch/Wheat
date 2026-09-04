const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "reporting.ts");
let reporting;

test.beforeAll(async () => {
  reporting = tsxRequire(modulePath, __filename);
});

test("reporting cursor is deterministic, filter-bound, and rejects tampering", async () => {
  const cursor = reporting.encodeReportingCursor({
    scope: "scope-a",
    direction: "asc",
    date: "2026-01-31T00:00:00.000Z",
    id: "entry-1",
  });
  expect(reporting.decodeReportingCursor(cursor, "scope-a", "asc")).toEqual({
    v: 1,
    scope: "scope-a",
    direction: "asc",
    date: "2026-01-31T00:00:00.000Z",
    id: "entry-1",
  });
  expect(() => reporting.decodeReportingCursor(cursor, "scope-b", "asc")).toThrow(/filtres actuels/i);
  expect(() => reporting.decodeReportingCursor("not-json", "scope-a", "asc")).toThrow(/curseur/i);
});

test("reversal evidence must be the exact account and counterparty inverse", async () => {
  const original = [
    { accountId: "sales", counterpartyId: "customer", thirdParty: "Atlas", debitCents: 0n, creditCents: 10_000n },
    { accountId: "customer", counterpartyId: "customer", thirdParty: "Atlas", debitCents: 10_000n, creditCents: 0n },
  ];
  const inverse = [
    { accountId: "customer", counterpartyId: "customer", thirdParty: "Atlas", debitCents: 0n, creditCents: 10_000n },
    { accountId: "sales", counterpartyId: "customer", thirdParty: "Atlas", debitCents: 10_000n, creditCents: 0n },
  ];
  expect(reporting.entriesAreExactOpposites(original, inverse)).toBe(true);
  expect(reporting.entriesAreExactOpposites(original, inverse.map((line) => ({ ...line, counterpartyId: null })))).toBe(false);
});

test("aging is exact, cutoff-aware, and excludes legacy or voided evidence", async () => {
  const companyId = "company-1";
  const postedEntry = (id, date, status = "POSTED") => ({ id, companyId, date: new Date(`${date}T00:00:00.000Z`), status });
  const party = { id: "party-1", displayName: "Client Atlas" };
  const payment = {
    id: "payment-1",
    companyId,
    currency: "MAD",
    lifecycleStatus: "VOIDED",
    postedEntry: postedEntry("payment-entry", "2026-02-10", "REVERSED"),
    voidEntry: { ...postedEntry("payment-void", "2026-04-02"), reversalOfId: "payment-entry" },
  };
  const invoices = [
    {
      id: "invoice-1", companyId, kind: "SALE", currency: "MAD", lifecycleStatus: "POSTED",
      counterpartyId: party.id, counterpartyModel: party, invoiceNo: "FA-1",
      invoiceDate: new Date("2026-01-01T00:00:00.000Z"), dueDate: new Date("2026-02-28T00:00:00.000Z"), ttcCents: 10_000n,
      postedEntry: postedEntry("invoice-entry", "2026-01-01"), voidEntry: null,
      allocations: [{
        id: "allocation-1", amountCents: 2_500n, status: "REVERSED",
        createdAt: new Date("2026-02-10T12:00:00.000Z"), reversedAt: new Date("2026-04-02T12:00:00.000Z"),
        payment,
      }],
      creditNotes: [{
        id: "credit-1", companyId, creditedInvoiceId: "invoice-1", documentType: "CREDIT_NOTE", kind: "SALE", currency: "MAD",
        lifecycleStatus: "POSTED", ttcCents: 1_000n, postedEntry: postedEntry("credit-entry", "2026-02-20"), voidEntry: null,
      }],
    },
    {
      id: "invoice-void", companyId, kind: "SALE", currency: "MAD", lifecycleStatus: "VOIDED",
      counterpartyId: party.id, counterpartyModel: party, invoiceNo: "FA-VOID",
      invoiceDate: new Date("2026-01-01T00:00:00.000Z"), dueDate: new Date("2026-01-31T00:00:00.000Z"), ttcCents: 4_000n,
      postedEntry: postedEntry("void-origin", "2026-01-01", "REVERSED"),
      voidEntry: { ...postedEntry("void-reversal", "2026-03-01"), reversalOfId: "void-origin" }, allocations: [],
    },
    {
      id: "legacy", companyId, kind: "SALE", currency: "MAD", lifecycleStatus: "LEGACY",
      counterpartyId: party.id, counterpartyModel: party, invoiceNo: "OLD", invoiceDate: new Date(), dueDate: new Date(), ttcCents: 90_000n,
      postedEntry: null, voidEntry: null, allocations: [],
    },
  ];

  const result = reporting.deriveAgingReport(invoices, { companyId, kind: "SALE", currency: "MAD", asOf: new Date("2026-03-31T00:00:00.000Z") });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].outstandingCents).toBe("6500");
  expect(result.rows[0].bucket).toBe("days31To60");
  expect(result.totals).toMatchObject({ originalCents: "10000", allocatedCents: "3500", outstandingCents: "6500" });
  expect(result.exclusions).toEqual({ legacyExcludedCount: 1, invalidEvidenceExcludedCount: 0, missingDueDateExcludedCount: 0, missingDueDateOutstandingCents: "0", voidedAtCutoffCount: 1 });
});

test("entry query is company-scoped, excludes drafts, paginates stably, and emits exact cents", async () => {
  let capturedWhere;
  const entries = [
    {
      id: "reversal", number: "OD-2", date: new Date("2026-02-02T00:00:00.000Z"), pieceNumber: "P-2", label: "Extourne",
      status: "POSTED", source: "REVERSAL", postedAt: new Date(), reversedAt: null, reversalOfId: "original",
      journal: { id: "journal", code: "OD", label: "Divers" }, lines: [{ debitCents: 9007199254740992n, creditCents: 9007199254740992n }],
    },
    {
      id: "original", number: "OD-1", date: new Date("2026-02-01T00:00:00.000Z"), pieceNumber: "P-1", label: "Original",
      status: "REVERSED", source: "MANUAL", postedAt: new Date(), reversedAt: new Date(), reversalOfId: null,
      journal: { id: "journal", code: "OD", label: "Divers" }, lines: [{ debitCents: 9007199254740992n, creditCents: 9007199254740992n }],
    },
  ];
  const prisma = {
    company: { findUnique: async () => ({ id: "company", name: "Atlas", baseCurrency: "MAD" }) },
    entry: { findMany: async (args) => { capturedWhere = args.where; return entries; } },
  };
  const service = reporting.createReportingService({ getPrisma: async () => prisma });
  const page = await service.queryEntries({ companyId: "company", pageSize: 1 });
  expect(JSON.stringify(capturedWhere)).toContain('"companyId":"company"');
  expect(JSON.stringify(capturedWhere)).toContain('"POSTED","REVERSED"');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ debitCents: "9007199254740992", creditCents: "9007199254740992", ledgerEvidence: "REVERSAL" });
  expect(page.nextCursor).toEqual(expect.any(String));
  expect(page.draftEntriesExcluded).toBe(true);
});

test("trial balance retains exact values above Number.MAX_SAFE_INTEGER", async () => {
  let groupCall = 0;
  const huge = 9_007_199_254_740_992n;
  const prisma = {
    company: { findUnique: async () => ({ id: "company", name: "Atlas", baseCurrency: "MAD" }) },
    account: { findMany: async () => [
      { id: "debit", code: "342100", label: "Clients", classNo: 3, type: "ASSET", active: true },
      { id: "credit", code: "712000", label: "Ventes", classNo: 7, type: "INCOME", active: true },
    ] },
    entryLine: { groupBy: async () => {
      groupCall += 1;
      if (groupCall === 1) return [];
      return [
        { accountId: "debit", _sum: { debitCents: huge, creditCents: 0n } },
        { accountId: "credit", _sum: { debitCents: 0n, creditCents: huge } },
      ];
    } },
  };
  const service = reporting.createReportingService({ getPrisma: async () => prisma, now: () => new Date("2026-12-31T00:00:00.000Z") });
  const result = await service.trialBalance({ companyId: "company", from: "2026-01-01", to: "2026-12-31" });
  expect(result.accounts[0].periodDebitCents).toBe("9007199254740992");
  expect(result.totals.periodDebitCents).toBe("9007199254740992");
  expect(result.totals.periodCreditCents).toBe("9007199254740992");
  expect(result.balanced).toBe(true);
});

test("IPC registration exposes the complete reporting surface", async () => {
  const registrations = new Map();
  const service = reporting.registerReportingIpc({
    ipcMain: { handle(channel, listener) { registrations.set(channel, listener); } },
    getPrisma: async () => ({}),
  });
  expect(registrations.size).toBe(Object.keys(reporting.REPORTING_IPC_CHANNELS).length);
  expect([...registrations.keys()]).toEqual(expect.arrayContaining([
    "wheat:reporting:entries",
    "wheat:reporting:trial-balance",
    "wheat:reporting:general-ledger",
    "wheat:reporting:aged-receivables",
    "wheat:reporting:integrity-checks",
  ]));
  expect(typeof service.counterpartyStatement).toBe("function");
});

test("all report query shapes execute against the migrated 1.2 SQLite schema", async () => {
  const { PrismaClient } = require("@prisma/client");
  const databasePath = path.join(cwd, "prisma", "dev.db").replace(/\\/g, "/");
  const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  try {
    const company = await prisma.company.findFirst();
    expect(company).toBeTruthy();
    const [journal, account, counterparty] = await Promise.all([
      prisma.journal.findFirst({ where: { companyId: company.id } }),
      prisma.account.findFirst({ where: { companyId: company.id } }),
      prisma.counterparty.findFirst({ where: { companyId: company.id } }),
    ]);
    const service = reporting.createReportingService({ getPrisma: async () => prisma });
    const entryPage = await service.queryEntries({ companyId: company.id, pageSize: 2 });
    const trial = await service.trialBalance({ companyId: company.id, from: "2026-01-01", to: "2026-12-31" });
    const ar = await service.agedReceivables({ companyId: company.id, asOf: "2026-12-31" });
    const ap = await service.agedPayables({ companyId: company.id, asOf: "2026-12-31" });
    const integrity = await service.integrityChecks({ companyId: company.id, maxIssues: 10 });
    expect(entryPage.draftEntriesExcluded).toBe(true);
    expect(Array.isArray(trial.accounts)).toBe(true);
    expect(ar.reportType).toBe("AGED_RECEIVABLES");
    expect(ap.reportType).toBe("AGED_PAYABLES");
    expect(integrity.summary.ledgerDebitCents).toMatch(/^-?\d+$/);
    if (journal) expect((await service.journal({ companyId: company.id, journalId: journal.id, pageSize: 2 })).journal.id).toBe(journal.id);
    if (account) expect((await service.generalLedger({ companyId: company.id, accountId: account.id, pageSize: 2 })).account.id).toBe(account.id);
    if (counterparty) expect((await service.counterpartyStatement({ companyId: company.id, counterpartyId: counterparty.id, pageSize: 2 })).counterparty.id).toBe(counterparty.id);
  } finally {
    await prisma.$disconnect();
  }
});
