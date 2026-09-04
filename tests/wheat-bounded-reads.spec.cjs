const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let prisma;
let temporaryRoot;
let subledgerService;
let operationsService;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

async function createCompany() {
  return prisma.company.create({
    data: {
      name: "Atlas bounded reads",
      legalForm: "SARL",
      ice: "001122334455667",
      taxId: "IF-PAGING",
      city: "Casablanca",
    },
  });
}

async function collectPages(readPage) {
  const ids = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const page = await readPage(cursor);
    pageCount += 1;
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    expect(page.hasMore).toBe(Boolean(cursor));
    expect(page.items.length).toBeLessThanOrEqual(page.limit);
  } while (cursor);
  return { ids, pageCount };
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  // The synchronous CJS transform avoids the Windows ESM-loader contention
  // that previously made this file's beforeAll depend on full-suite scheduling.
  const subledger = tsxRequire(path.join(root, "electron", "subledger.ts"), __filename);
  const operations = tsxRequire(path.join(root, "electron", "operations13.ts"), __filename);
  test.info().annotations.push({ type: "modules", description: "Wheat bounded read services" });
  globalThis.__atlasBoundedModules = { subledger, operations };
});

test.beforeEach(async () => {
  expect(fs.existsSync(migratedDatabasePath)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-13-bounded-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  subledgerService = globalThis.__atlasBoundedModules.subledger.createSubledgerService({ getPrisma: async () => prisma });
  operationsService = globalThis.__atlasBoundedModules.operations.createOperations13Service({ getPrisma: async () => prisma });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
});

test("counterparties, invoices, and payments traverse stable bounded pages without duplicates", async () => {
  const company = await createCompany();
  await prisma.counterparty.createMany({
    data: [
      { id: "cp-a", companyId: company.id, kind: "CUSTOMER", displayName: "Alpha", identityKey: "NAME:ALPHA", active: true },
      { id: "cp-b", companyId: company.id, kind: "BOTH", displayName: "Même nom", identityKey: "NAME:MEME-B", active: true },
      { id: "cp-c", companyId: company.id, kind: "BOTH", displayName: "Même nom", identityKey: "NAME:MEME-C", active: true },
      { id: "cp-d", companyId: company.id, kind: "SUPPLIER", displayName: "Archivé A", identityKey: "NAME:ARCHIVE-A", active: false },
      { id: "cp-e", companyId: company.id, kind: "SUPPLIER", displayName: "Archivé B", identityKey: "NAME:ARCHIVE-B", active: false },
    ],
  });
  const commonDate = new Date("2026-07-10T00:00:00.000Z");
  const commonCreatedAt = new Date("2026-07-11T10:00:00.000Z");
  await prisma.invoice.createMany({
    data: ["a", "b", "c", "d", "e"].map((suffix, index) => ({
      id: `inv-${suffix}`,
      companyId: company.id,
      kind: index === 4 ? "PURCHASE" : "SALE",
      counterparty: "Alpha",
      invoiceNo: `F-${suffix}`,
      invoiceDate: commonDate,
      dueDate: commonDate,
      htCents: 1_000n,
      vatCents: 200n,
      ttcCents: 1_200n,
      status: "DRAFT",
      numberKey: `SALE:F-${suffix}`,
      lifecycleStatus: "DRAFT",
      createdAt: commonCreatedAt,
    })),
  });
  await prisma.payment.createMany({
    data: ["a", "b", "c", "d"].map((suffix) => ({
      id: `pay-${suffix}`,
      companyId: company.id,
      counterpartyId: "cp-a",
      kind: "RECEIPT",
      paymentDate: commonDate,
      reference: `P-${suffix}`,
      method: "Virement",
      amountCents: 1_200n,
      createdAt: commonCreatedAt,
    })),
  });

  const counterparties = await collectPages((cursor) => subledgerService.listCounterparties({ companyId: company.id, includeArchived: true, limit: 2, cursor }));
  expect(counterparties.ids).toEqual(["cp-a", "cp-b", "cp-c", "cp-d", "cp-e"]);
  expect(new Set(counterparties.ids).size).toBe(5);

  const sales = await collectPages((cursor) => subledgerService.listInvoices({ companyId: company.id, kind: "SALE", limit: 2, cursor }));
  expect(sales.ids).toEqual(["inv-d", "inv-c", "inv-b", "inv-a"]);
  expect(new Set(sales.ids).size).toBe(4);

  const payments = await collectPages((cursor) => subledgerService.listPayments({ companyId: company.id, kind: "RECEIPT", limit: 2, cursor }));
  expect(payments.ids).toEqual(["pay-d", "pay-c", "pay-b", "pay-a"]);
  expect(new Set(payments.ids).size).toBe(4);

  const firstSales = await subledgerService.listInvoices({ companyId: company.id, kind: "SALE", limit: 2 });
  expect(firstSales).toMatchObject({ totalCount: 4, limit: 2, hasMore: true });
  await expect(subledgerService.listInvoices({ companyId: company.id, kind: "PURCHASE", limit: 2, cursor: firstSales.nextCursor })).rejects.toThrow(/curseur/i);
  await expect(subledgerService.listPayments({ companyId: company.id, limit: 101 })).rejects.toThrow(/limite/i);
  await expect(subledgerService.listCounterparties({ companyId: company.id, limit: 0 })).rejects.toThrow(/limite/i);
});

test("ledger import history returns bounded summaries and a separate bounded row detail", async () => {
  const company = await createCompany();
  const importedAt = new Date("2026-07-12T12:00:00.000Z");
  for (const suffix of ["a", "b", "c"]) {
    await prisma.ledgerImportBatch.create({
      data: {
        id: `batch-${suffix}`,
        companyId: company.id,
        sourceName: `${suffix}.csv`,
        sourceSha256: suffix.repeat(64),
        scopeSha256: suffix.repeat(64),
        revision: 1,
        mappingJson: "{}",
        status: suffix === "a" ? "REVIEW_REQUIRED" : "STAGED",
        importedAt,
        rows: {
          create: [
            { id: `row-${suffix}-1`, sourceRow: 2, rawJson: "{}", fingerprint: `${suffix}-1`, validationStatus: "VALID" },
            { id: `row-${suffix}-2`, sourceRow: 3, rawJson: "{}", fingerprint: `${suffix}-2`, validationStatus: suffix === "a" ? "INVALID" : "VALID", validationError: suffix === "a" ? "Compte absent" : null },
            { id: `row-${suffix}-3`, sourceRow: 4, rawJson: "{}", fingerprint: `${suffix}-3`, validationStatus: "PENDING" },
          ],
        },
      },
    });
  }

  const first = await operationsService.listLedgerImports({ companyId: company.id, limit: 2 });
  expect(first).toMatchObject({ mode: "summary", totalCount: 3, limit: 2, hasMore: true });
  expect(first.items.map((item) => item.id)).toEqual(["batch-c", "batch-b"]);
  expect(first.items[0].rows).toBeUndefined();
  expect(first.items[0]).toMatchObject({ rowCount: 3, validRowCount: 2, invalidRowCount: 0, pendingRowCount: 1, revision: 1 });
  const second = await operationsService.listLedgerImports({ companyId: company.id, limit: 2, cursor: first.nextCursor });
  expect(second.items.map((item) => item.id)).toEqual(["batch-a"]);
  expect(second.items[0]).toMatchObject({ rowCount: 3, validRowCount: 1, invalidRowCount: 1, pendingRowCount: 1 });

  const detailFirst = await operationsService.listLedgerImports({ companyId: company.id, batchId: "batch-a", limit: 2 });
  expect(detailFirst).toMatchObject({ mode: "detail", totalCount: 3, limit: 2, hasMore: true });
  expect(detailFirst.items.map((item) => item.sourceRow)).toEqual([2, 3]);
  expect(detailFirst.batch).toMatchObject({ id: "batch-a", rowCount: 3, invalidRowCount: 1 });
  const detailSecond = await operationsService.listLedgerImports({ companyId: company.id, batchId: "batch-a", limit: 2, cursor: detailFirst.nextCursor });
  expect(detailSecond.items.map((item) => item.sourceRow)).toEqual([4]);
  await expect(operationsService.listLedgerImports({ companyId: company.id, batchId: "batch-b", cursor: detailFirst.nextCursor })).rejects.toThrow(/curseur/i);
  await expect(operationsService.listLedgerImports({ companyId: company.id, limit: 101 })).rejects.toThrow(/limite/i);
});
