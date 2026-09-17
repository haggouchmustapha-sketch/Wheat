const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

/**
 * One dossier, both builds, in both directions.
 *
 * Wheat ships as two builds from one source tree, and the promise attached to
 * that is total: a dossier created by one opens unchanged in the other. Stock
 * is the newest thing that promise has to cover, so this spec does the awkward
 * thing rather than the convenient one — it runs each step in a separate
 * process, under a different `WHEAT_EDITION`, against a single SQLite file, and
 * compares what each one reads back.
 *
 * Alternating the builds is the part that matters. A test that wrote everything
 * with one and read with the other would miss a difference in how the second
 * one *writes*; this one hands the file back and forth.
 */

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const helper = path.join(__dirname, "helpers", "stock-edition-step.cjs");

let temporaryRoot;
let databasePath;
let prisma;

function sqliteFileUrl(filePath) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

/** Runs one step in its own process, as the named build. */
function runAs(edition, step) {
  const stdout = execFileSync(process.execPath, [helper, databasePath, step], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WHEAT_EDITION: edition, WHEAT_CWD: cwd, DATABASE_URL: sqliteFileUrl(databasePath) },
  });
  return JSON.parse(stdout);
}

test.beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-stock-parity-"));
  databasePath = path.join(temporaryRoot, "dossier.db");

  const migrations = path.join(cwd, "prisma", "migrations");
  const database = new DatabaseSync(databasePath);
  try {
    for (const name of fs.readdirSync(migrations).filter((entry) => fs.existsSync(path.join(migrations, entry, "migration.sql"))).sort()) {
      database.exec(fs.readFileSync(path.join(migrations, name, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }

  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  const suffix = randomUUID().slice(0, 8);
  const company = await prisma.company.create({
    data: { name: `Parité ${suffix}`, legalForm: "SARL", ice: `ICE${suffix}`, taxId: `IF${suffix}`, city: "Casablanca" },
  });
  const user = await prisma.user.create({
    data: { name: "Administrateur local", email: `parity-${suffix}@example.test`, role: "ADMIN" },
  });
  await prisma.companyUser.create({ data: { companyId: company.id, userId: user.id, role: "ADMIN" } });
  await prisma.fiscalYear.create({
    data: {
      companyId: company.id, label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)), endsOn: new Date(Date.UTC(2026, 11, 31)), status: "OPEN",
    },
  });
  const journal = await prisma.journal.create({ data: { companyId: company.id, code: "STK", label: "Journal des stocks" } });
  const stockAccount = await prisma.account.create({
    data: { companyId: company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" },
  });
  const variationAccount = await prisma.account.create({
    data: { companyId: company.id, code: "6114", label: "Variation des stocks", classNo: 6, type: "EXPENSE" },
  });
  await prisma.stockSettings.create({ data: { companyId: company.id, stockJournalId: journal.id } });
  await prisma.stockAccountMapping.create({
    data: {
      companyId: company.id, scope: "COMPANY", scopeKey: "COMPANY",
      stockAccountId: stockAccount.id, variationAccountId: variationAccount.id,
    },
  });
  const unit = await prisma.stockUnit.create({ data: { companyId: company.id, code: "UN", label: "Unité" } });
  await prisma.stockWarehouse.create({ data: { companyId: company.id, code: "PRIN", name: "DEPOT PRINCIPAL" } });
  await prisma.stockArticle.create({
    data: { companyId: company.id, sku: "ART-001", designation: "Produit Test", unitId: unit.id, valuationMethod: "CMP" },
  });
});

test.afterAll(async () => {
  await prisma?.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("one dossier, written and read by both builds, holds the same stock", () => {
  // Standard validates the opening stock.
  const afterOpening = runAs("standard", "opening");
  expect(afterOpening.edition).toBe("standard");
  expect(afterOpening.quantity).toBe("10.000000");
  expect(afterOpening.value).toBe("1000.000000");

  // The same file, opened by Lightweight, with no conversion step in between.
  const lightweightSees = runAs("lightweight", "read");
  expect(lightweightSees.edition).toBe("lightweight");
  expect(lightweightSees).toMatchObject({
    quantity: afterOpening.quantity,
    value: afterOpening.value,
    unitCost: afterOpening.unitCost,
    rows: afterOpening.rows,
    totalValue: afterOpening.totalValue,
    references: afterOpening.references,
    entries: afterOpening.entries,
  });

  // Now Lightweight writes: it validates the next receipt into the same file.
  const afterReceipt = runAs("lightweight", "receipt");
  expect(afterReceipt.quantity).toBe("20.000000");
  expect(afterReceipt.value).toBe("2200.000000");
  expect(afterReceipt.unitCost).toBe("110.000000");

  // And Standard reads back what Lightweight wrote, unchanged.
  const standardSees = runAs("standard", "read");
  expect(standardSees.edition).toBe("standard");
  expect(standardSees).toMatchObject({
    quantity: afterReceipt.quantity,
    value: afterReceipt.value,
    unitCost: afterReceipt.unitCost,
    rows: afterReceipt.rows,
    totalValue: afterReceipt.totalValue,
    references: afterReceipt.references,
    entries: afterReceipt.entries,
  });

  // The issue is valued by Standard, against a position Lightweight last
  // touched — the acceptance figures, reached across the two builds.
  const afterIssue = runAs("standard", "issue");
  expect(afterIssue.quantity).toBe("15.000000");
  expect(afterIssue.value).toBe("1650.000000");
  expect(afterIssue.unitCost).toBe("110.000000");

  const lightweightFinal = runAs("lightweight", "read");
  expect(lightweightFinal).toMatchObject({
    quantity: afterIssue.quantity,
    value: afterIssue.value,
    unitCost: afterIssue.unitCost,
    rows: afterIssue.rows,
    totalValue: afterIssue.totalValue,
    references: afterIssue.references,
    entries: afterIssue.entries,
  });

  // Three documents, each carrying a DRAFT accounting entry, identical in both.
  expect(lightweightFinal.entries).toHaveLength(3);
  expect(lightweightFinal.entries.every((entry) => entry.status === "DRAFT")).toBe(true);
  expect(lightweightFinal.references).toEqual(["BP-2026-000001", "CI-2026-000001", "SI-2026-000001"]);
});

test("neither build writes a schema the other does not have", () => {
  // The dossier carries one set of stock tables, created by one migration, with
  // nothing edition-specific alongside them.
  const database = new DatabaseSync(databasePath);
  try {
    const applied = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Stock%' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(applied.length).toBe(21);
    expect(applied.some((name) => /standard|lightweight|lite/i.test(name))).toBe(false);

    const triggers = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'Stock%' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(triggers).toEqual([
      "StockFifoConsumption_append_only_delete",
      "StockFifoConsumption_append_only_update",
      "StockMovement_append_only_delete",
      "StockMovement_append_only_update",
    ]);
  } finally {
    database.close();
  }
});
