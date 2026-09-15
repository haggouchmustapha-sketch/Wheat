const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let portfolio;
let dashboard;
let prisma;
let temporaryRoot;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  portfolio = tsxRequire(path.join(root, "electron", "portfolio.ts"), __filename);
  dashboard = tsxRequire(path.join(root, "electron", "dashboard.ts"), __filename);
});

test.beforeEach(async () => {
  expect(fs.existsSync(migratedDatabasePath)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-portfolio-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
});

test("the overview covers every dossier on the machine, not the active one", async () => {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  expect(companies.length).toBeGreaterThan(1);

  const overview = await portfolio.buildPortfolioOverview(prisma);
  expect(overview.version).toBe("WHEAT_PORTFOLIO_1");
  expect(overview.dossiers.map((d) => d.companyId).sort()).toEqual(companies.map((c) => c.id).sort());
  expect(overview.totals.dossierCount).toBe(companies.length);
  // Sorted by name so the list does not reshuffle between reads.
  const names = overview.dossiers.map((d) => d.name);
  expect(names).toEqual([...names].sort());
});

test("receivables agree exactly with the single-dossier dashboard", async () => {
  // The portfolio and the dashboard compute the same money by different routes
  // (one grouped query across companies, one per company). They share the
  // settlement helper precisely so they can never drift; this proves it.
  const asOf = new Date("2026-09-08T00:00:00.000Z");
  const overview = await portfolio.buildPortfolioOverview(prisma, asOf);

  for (const dossier of overview.dossiers) {
    const metrics = await dashboard.buildDashboardMetrics(prisma, dossier.companyId, asOf);
    expect(dossier.outstandingReceivableCents).toBe(metrics.unpaidTotalCents);
    expect(dossier.overdueInvoiceCount).toBe(metrics.overdueCount);
    expect(dossier.bankTotalCents).toBe(metrics.bankTotalCents);
  }
});

test("a dossier is listed for attention only with a countable reason behind it", async () => {
  const overview = await portfolio.buildPortfolioOverview(prisma);

  for (const dossier of overview.dossiers) {
    for (const reason of dossier.attention) {
      expect(typeof reason.code).toBe("string");
      expect(reason.label.length).toBeGreaterThan(3);
      // Every reason but "no open fiscal year" is a count of real rows.
      if (reason.code !== "NO_OPEN_FISCAL_YEAR") expect(reason.count).toBeGreaterThan(0);
    }
    const quiet = dossier.draftEntryCount === 0
      && dossier.unfiledDocumentCount === 0
      && dossier.stagedImportCount === 0
      && dossier.unreconciledMovementCount === 0
      && dossier.unfiledVatPeriodCount === 0
      && dossier.overdueInvoiceCount === 0
      && dossier.openFiscalYear !== null;
    if (quiet) expect(dossier.attention).toHaveLength(0);
  }
  expect(overview.totals.needingAttentionCount).toBe(overview.dossiers.filter((d) => d.attention.length > 0).length);
});

test("a draft entry raises the dossier, and posting it settles the reason", async () => {
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } });
  const before = await portfolio.buildPortfolioOverview(prisma);
  const beforeRow = before.dossiers.find((d) => d.companyId === company.id);

  const journal = await prisma.journal.findFirstOrThrow({ where: { companyId: company.id } });
  const account = await prisma.account.findFirstOrThrow({ where: { companyId: company.id } });
  const draft = await prisma.entry.create({
    data: {
      companyId: company.id,
      journalId: journal.id,
      number: `BROUILLON-PORTFOLIO-${Date.now()}`,
      pieceNumber: `PORTFOLIO-${Date.now()}`,
      journalCodeSnapshot: journal.code,
      date: new Date("2026-06-15T00:00:00.000Z"),
      label: "Brouillon portefeuille",
      status: "DRAFT",
      lines: {
        create: [
          { accountId: account.id, label: "Débit", debitCents: 1000n, creditCents: 0n, position: 1, accountCodeSnapshot: account.code, accountLabelSnapshot: account.label },
          { accountId: account.id, label: "Crédit", debitCents: 0n, creditCents: 1000n, position: 2, accountCodeSnapshot: account.code, accountLabelSnapshot: account.label },
        ],
      },
    },
  });

  const after = await portfolio.buildPortfolioOverview(prisma);
  const afterRow = after.dossiers.find((d) => d.companyId === company.id);
  expect(afterRow.draftEntryCount).toBe(beforeRow.draftEntryCount + 1);
  expect(afterRow.attention.map((r) => r.code)).toContain("DRAFT_ENTRIES");

  await prisma.entry.update({ where: { id: draft.id }, data: { status: "POSTED" } });
  const settled = await portfolio.buildPortfolioOverview(prisma);
  const settledRow = settled.dossiers.find((d) => d.companyId === company.id);
  expect(settledRow.draftEntryCount).toBe(beforeRow.draftEntryCount);
});

test("the overview never asserts a statutory VAT deadline", async () => {
  // Filing deadlines are set by law and Wheat has not verified them. The screen
  // reports what it can stand behind — periods with no filed workpaper — and
  // must not grow a computed due date without that verification.
  const overview = await portfolio.buildPortfolioOverview(prisma);
  const serialised = JSON.stringify(overview, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  expect(serialised).not.toMatch(/dueDate|deadline|echeance|échéance|overdueVat|lateVat/i);
  for (const dossier of overview.dossiers) {
    expect(Object.keys(dossier)).not.toContain("vatDueOn");
    if (dossier.latestVatPeriod) expect(["DRAFT", "REVIEWED", "FILED"]).toContain(dossier.latestVatPeriod.status);
  }
});

test("money crosses the bridge as exact centime strings", async () => {
  const { rendererSerialize } = tsxRequire(path.join(root, "electron", "accounting.ts"), __filename);
  const overview = rendererSerialize(await portfolio.buildPortfolioOverview(prisma));
  for (const dossier of overview.dossiers) {
    expect(typeof dossier.outstandingReceivableCents).toBe("string");
    expect(dossier.outstandingReceivableCents).toMatch(/^-?\d+$/);
    expect(typeof dossier.bankTotalCents).toBe("string");
  }
  expect(typeof overview.totals.overdueReceivableCents).toBe("string");
});
