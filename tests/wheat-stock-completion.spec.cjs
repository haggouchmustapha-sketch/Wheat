const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The five Stock workflows that had a schema and no service: physical
 * inventory, impairment, spreadsheet import, unit conversion and the reports.
 *
 * What is proved here is the part that only means something against a real
 * database: that an inventory writes its écarts through the ordinary document
 * path and not around it, that a provision is blocked rather than guessed when
 * its accounts are missing, that a malformed spreadsheet leaves nothing behind,
 * that a quantity entered in cartons reaches the register in the article's own
 * unit exactly, and that changing a conversion afterwards moves nothing that is
 * already written.
 *
 * The verified core is not re-proved here; `wheat-stock-domain-unit.spec.cjs`
 * owns that. Every test runs against its own temporary SQLite file built from
 * the real migrations, and nothing touches `prisma/dev.db` or `%APPDATA%\Wheat`.
 */

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let prisma;
let temporaryRoot;
let units;
let conversion;
let inventory;
let impairment;
let stockImport;
let reports;
let validation;

function sqliteFileUrl(filePath) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

function applyAllMigrations(target) {
  const dir = path.join(cwd, "prisma", "migrations");
  const names = fs.readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, "migration.sql")))
    .sort();
  const database = new DatabaseSync(target);
  try {
    for (const name of names) {
      database.exec(fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }
}

test.beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-stock-completion-"));
  const databasePath = path.join(temporaryRoot, "stock.db");
  applyAllMigrations(databasePath);
  process.env.DATABASE_URL = sqliteFileUrl(databasePath);
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  units = tsxRequire(path.join(cwd, "electron", "stockUnits.ts"), __filename);
  conversion = tsxRequire(path.join(cwd, "electron", "stockUnitConversion.ts"), __filename);
  inventory = tsxRequire(path.join(cwd, "electron", "stockInventory.ts"), __filename);
  impairment = tsxRequire(path.join(cwd, "electron", "stockImpairment.ts"), __filename);
  stockImport = tsxRequire(path.join(cwd, "electron", "stockImport.ts"), __filename);
  reports = tsxRequire(path.join(cwd, "electron", "stockReports.ts"), __filename);
  validation = tsxRequire(path.join(cwd, "electron", "stockValidation.ts"), __filename);
});

test.afterAll(async () => {
  await prisma?.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const qty = (value) => units.qtyFromDecimal(value, "La quantité");
const money = (value) => units.moneyFromDecimal(value, "Le montant");

async function createDossier(options = {}) {
  const suffix = randomUUID().slice(0, 8);
  const company = await prisma.company.create({
    data: { name: `Stock ${suffix}`, legalForm: "SARL", ice: `ICE${suffix}`, taxId: `IF${suffix}`, city: "Casablanca" },
  });
  const user = await prisma.user.create({
    data: { name: `Comptable ${suffix}`, email: `stock-c-${suffix}@example.test`, role: "ACCOUNTANT" },
  });
  await prisma.companyUser.create({ data: { companyId: company.id, userId: user.id, role: "ACCOUNTANT" } });
  const fiscalYear = await prisma.fiscalYear.create({
    data: {
      companyId: company.id, label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)), endsOn: new Date(Date.UTC(2026, 11, 31)), status: "OPEN",
    },
  });
  const stockAccount = await prisma.account.create({
    data: { companyId: company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" },
  });
  const variationAccount = await prisma.account.create({
    data: { companyId: company.id, code: "6114", label: "Variation des stocks", classNo: 6, type: "EXPENSE" },
  });
  const provisionAccount = await prisma.account.create({
    data: { companyId: company.id, code: "3911", label: "Provision dépréciation stocks", classNo: 3, type: "ASSET" },
  });
  const chargeAccount = await prisma.account.create({
    data: { companyId: company.id, code: "6196", label: "Dotation provisions", classNo: 6, type: "EXPENSE" },
  });
  const reversalAccount = await prisma.account.create({
    data: { companyId: company.id, code: "7196", label: "Reprise provisions", classNo: 7, type: "REVENUE" },
  });
  const journal = await prisma.journal.create({ data: { companyId: company.id, code: "STK", label: "Journal des stocks" } });
  await prisma.stockSettings.create({
    data: {
      companyId: company.id,
      stockJournalId: journal.id,
      ...(options.impairmentAccounts === false ? {} : {
        impairmentAccountId: provisionAccount.id,
        impairmentChargeAccountId: chargeAccount.id,
        impairmentReversalAccountId: reversalAccount.id,
      }),
    },
  });
  await prisma.stockAccountMapping.create({
    data: {
      companyId: company.id, scope: "COMPANY", scopeKey: "COMPANY",
      stockAccountId: stockAccount.id, variationAccountId: variationAccount.id,
    },
  });
  const counterparty = await prisma.counterparty.create({
    data: {
      companyId: company.id,
      displayName: `Fournisseur ${suffix}`,
      kind: "SUPPLIER",
      identityKey: `supplier-${suffix}`,
    },
  });
  const unit = await prisma.stockUnit.create({ data: { companyId: company.id, code: "UN", label: "Unité" } });
  const warehouse = await prisma.stockWarehouse.create({ data: { companyId: company.id, code: "PRIN", name: "DEPOT PRINCIPAL" } });
  const secondWarehouse = await prisma.stockWarehouse.create({ data: { companyId: company.id, code: "SETT", name: "Magasin Settat" } });
  return {
    company, user, fiscalYear, unit, warehouse, secondWarehouse, journal, counterparty,
    stockAccount, variationAccount, provisionAccount, chargeAccount, reversalAccount,
  };
}

async function createArticle(dossier, options = {}) {
  return prisma.stockArticle.create({
    data: {
      companyId: dossier.company.id,
      sku: options.sku ?? `ART-${randomUUID().slice(0, 6)}`,
      designation: options.designation ?? "Produit Test",
      unitId: options.unitId ?? dossier.unit.id,
      valuationMethod: options.valuationMethod ?? "CMP",
    },
  });
}

async function validateDocument(dossier, input) {
  const document = await prisma.stockDocument.create({
    data: {
      companyId: dossier.company.id,
      fiscalYearId: dossier.fiscalYear.id,
      type: input.type,
      reference: `${input.type}-${randomUUID().slice(0, 8)}`,
      documentDate: input.date,
      warehouseId: (input.warehouse ?? dossier.warehouse).id,
      counterpartyId: input.counterpartyId ?? dossier.counterparty.id,
      createdByUserId: dossier.user.id,
      lines: {
        create: input.lines.map((line, index) => ({
          position: index + 1,
          articleId: line.article.id,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity ?? line.quantity,
          unitFactor: line.unitFactor ?? 1_000_000n,
          unitId: line.unitId ?? dossier.unit.id,
          warehouseId: (line.warehouse ?? input.warehouse ?? dossier.warehouse).id,
          unitValue: line.unitValue ?? null,
        })),
      },
    },
  });
  return prisma.$transaction(async (tx) => validation.validateStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: document.id, actorUserId: dossier.user.id,
  }));
}

/* ------------------------------------------------------- unit conversions */

test("a chain of conversions resolves exactly, and a palette is 480 unités", () => {
  const CARTON = "carton";
  const PALETTE = "palette";
  const UNIT = "unite";
  const edges = [
    { fromUnitId: CARTON, toUnitId: UNIT, factor: qty("12") },
    { fromUnitId: PALETTE, toUnitId: CARTON, factor: qty("40") },
  ];
  const factor = conversion.resolveUnitFactor(edges, PALETTE, UNIT, (id) => id);
  expect(units.qtyToDisplay(factor)).toBe("480.000000");
  // The reverse direction is derived from the same edge rather than configured
  // twice — 1 unité = 40 palettes⁻¹ resolves, because it divides.
  expect(units.qtyToDisplay(conversion.resolveUnitFactor(edges, CARTON, PALETTE, (id) => id))).toBe("0.025000");
  // But one twelfth is not expressible at six decimals, and Wheat refuses a
  // factor it could only store rounded rather than quietly storing 0,083333.
  expect(() => conversion.resolveUnitFactor(edges, UNIT, CARTON, (id) => id))
    .toThrow(/ne tombe pas juste à six décimales/);
  // An unconfigured pair is named, not guessed.
  expect(() => conversion.resolveUnitFactor([], "kg", "g", (id) => id))
    .toThrow(/Aucune conversion n'est paramétrée/);
});

test("a quantity that does not convert exactly is refused rather than rounded", () => {
  // Half a carton at a third of a unit each: 0,1666665, which six decimals
  // cannot hold. Wheat says so instead of writing 0,166667 into the register.
  expect(() => conversion.convertQuantity(qty("0.5"), qty("0.333333")))
    .toThrow(/ne se convertit pas exactement/);
  // What does divide, divides exactly.
  expect(units.qtyToDisplay(conversion.convertQuantity(qty("12"), qty("12")))).toBe("144.000000");
  expect(units.qtyToDisplay(conversion.convertQuantity(qty("2.5"), qty("12")))).toBe("30.000000");
});

test("a conversion that contradicts the existing graph is refused when it is saved", () => {
  const edges = [
    { fromUnitId: "A", toUnitId: "B", factor: qty("2") },
    { fromUnitId: "B", toUnitId: "C", factor: qty("2") },
  ];
  // The graph already says 1 A = 4 C. Saying 1 A = 5 C would make the same
  // question answerable two ways depending on the route taken.
  expect(() => conversion.assertConversionIsConsistent(edges, { fromUnitId: "A", toUnitId: "C", factor: qty("5") }, (id) => id))
    .toThrow(/contredit/);
  // Restating what the graph already implies is not a contradiction.
  expect(() => conversion.assertConversionIsConsistent(edges, { fromUnitId: "A", toUnitId: "C", factor: qty("4") }, (id) => id))
    .not.toThrow();
  expect(() => conversion.assertConversionIsConsistent([], { fromUnitId: "A", toUnitId: "A", factor: qty("3") }, (id) => id))
    .toThrow(/elle-même/);
  expect(() => conversion.requireConversionFactor(0n)).toThrow(/strictement positif/);
});

test("a line entered in cartons reaches the register in the article's own unit", async () => {
  const dossier = await createDossier();
  const carton = await prisma.stockUnit.create({ data: { companyId: dossier.company.id, code: "CT", label: "Carton" } });
  await prisma.stockUnitConversion.create({
    data: { companyId: dossier.company.id, fromUnitId: carton.id, toUnitId: dossier.unit.id, factor: qty("12") },
  });
  const article = await createArticle(dossier, { sku: `CV-${randomUUID().slice(0, 6)}` });

  // Ten cartons at 1 200 the carton: 120 unités worth 12 000.
  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 0, 10)),
    lines: [{
      article,
      quantity: qty("10"),
      unitId: carton.id,
      unitFactor: qty("12"),
      baseQuantity: conversion.convertQuantity(qty("10"), qty("12")),
      unitValue: money("1200"),
    }],
  });

  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(balance.quantity)).toBe("120.000000");
  expect(units.moneyToDisplay(balance.value)).toBe("12000.000000");
  const movement = await prisma.stockMovement.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(movement.quantity)).toBe("120.000000");
});

test("changing a conversion afterwards leaves movements already written alone", async () => {
  const dossier = await createDossier();
  const carton = await prisma.stockUnit.create({ data: { companyId: dossier.company.id, code: "CT", label: "Carton" } });
  const configured = await prisma.stockUnitConversion.create({
    data: { companyId: dossier.company.id, fromUnitId: carton.id, toUnitId: dossier.unit.id, factor: qty("12") },
  });
  const article = await createArticle(dossier, { sku: `HC-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 0, 10)),
    lines: [{
      article, quantity: qty("10"), unitId: carton.id, unitFactor: qty("12"),
      baseQuantity: qty("120"), unitValue: money("1200"),
    }],
  });

  // The dossier repacks: a carton now holds six.
  await prisma.stockUnitConversion.update({ where: { id: configured.id }, data: { factor: qty("6") } });

  const line = await prisma.stockDocumentLine.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(line.unitFactor)).toBe("12.000000");
  expect(units.qtyToDisplay(line.baseQuantity)).toBe("120.000000");
  const movement = await prisma.stockMovement.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(movement.quantity)).toBe("120.000000");
  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(balance.quantity)).toBe("120.000000");
});

/* ----------------------------------------------------- physical inventory */

async function campaignWithCount(dossier, article, counted, options = {}) {
  const campaign = await prisma.$transaction(async (tx) => inventory.createCampaignInTransaction(tx, {
    companyId: dossier.company.id,
    warehouseId: options.warehouseId ?? null,
    countDate: options.countDate ?? new Date(Date.UTC(2026, 5, 30)),
    note: null,
    actorUserId: dossier.user.id,
  }));
  await prisma.$transaction(async (tx) => inventory.freezeCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  await prisma.$transaction(async (tx) => inventory.saveCountsInTransaction(tx, {
    companyId: dossier.company.id,
    campaignId: campaign.id,
    entries: [{
      articleId: article.id,
      warehouseId: (options.warehouse ?? dossier.warehouse).id,
      lotId: null,
      countedQuantity: counted,
      unitValue: options.unitValue ?? null,
      note: null,
    }],
    actorUserId: dossier.user.id,
  }));
  return campaign;
}

test("an inventory shortage becomes a validated adjustment with its accounting draft", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `IN-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("100"), unitValue: money("10") }],
  });

  const campaign = await campaignWithCount(dossier, article, qty("94"));

  const sheet = await reports.inventoryVarianceReport(prisma, {
    companyId: dossier.company.id, campaignId: campaign.id,
  });
  expect(sheet.summary.shortage).toBe(1);
  const row = sheet.rows[0];
  expect(units.qtyToDisplay(row.expectedQuantity)).toBe("100.000000");
  expect(units.qtyToDisplay(row.varianceQuantity)).toBe("-6.000000");
  // Six units out of a position worth 1 000: exactly 60, not a rounded share.
  expect(units.moneyToDisplay(row.varianceValue)).toBe("-60.000000");

  const result = await prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  expect(result.shortage).toBe(1);
  expect(result.documentIds).toHaveLength(1);

  const document = await prisma.stockDocument.findUnique({
    where: { id: result.documentIds[0] },
    include: { movements: true, accountingEntry: { include: { lines: true } } },
  });
  expect(document.type).toBe("INVENTORY_SHORTAGE");
  expect(document.status).toBe("VALIDATED");
  // The draft reference was replaced by a real number from the stock sequence.
  expect(document.reference).toMatch(/^IM-2026-\d{6}$/);
  expect(document.movements).toHaveLength(1);
  expect(units.qtyToDisplay(document.movements[0].quantity)).toBe("6.000000");
  expect(document.movements[0].direction).toBe("OUT");

  expect(document.accountingEntry.status).toBe("DRAFT");
  const debit = document.accountingEntry.lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const credit = document.accountingEntry.lines.reduce((sum, line) => sum + line.creditCents, 0n);
  expect(debit).toBe(credit);
  expect(debit).toBe(6000n);

  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(balance.quantity)).toBe("94.000000");
  expect(units.moneyToDisplay(balance.value)).toBe("940.000000");

  const campaignAfter = await prisma.stockInventoryCampaign.findUnique({ where: { id: campaign.id } });
  expect(campaignAfter.status).toBe("VALIDATED");
  // The count itself survives validation: the evidence is not consumed by it.
  const count = await prisma.stockInventoryCount.findFirst({ where: { campaignId: campaign.id } });
  expect(units.qtyToDisplay(count.countedQuantity)).toBe("94.000000");
  expect(units.qtyToDisplay(count.expectedQuantity)).toBe("100.000000");
});

test("an inventory surplus on a held position enters at what the position is worth", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `SU-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("50"), unitValue: money("20") }],
  });

  const campaign = await campaignWithCount(dossier, article, qty("53"));
  const result = await prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  expect(result.surplus).toBe(1);

  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(balance.quantity)).toBe("53.000000");
  // Three more units at the position's own 20 the unit: 1 060 exactly.
  expect(units.moneyToDisplay(balance.value)).toBe("1060.000000");
});

test("a surplus on a position the dossier holds nothing of demands a cost", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `NV-${randomUUID().slice(0, 6)}` });
  // Nothing was ever received, so the freeze produces no row for this position
  // and the count creates one with a theoretical of nothing.
  const campaign = await campaignWithCount(dossier, article, qty("8"));

  await expect(prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/valeur d'acquisition unitaire/);
  expect(await prisma.stockMovement.count({ where: { articleId: article.id } })).toBe(0);

  // With a cost stated, the same campaign validates and the goods enter at it.
  await prisma.$transaction(async (tx) => inventory.saveCountsInTransaction(tx, {
    companyId: dossier.company.id,
    campaignId: campaign.id,
    entries: [{
      articleId: article.id, warehouseId: dossier.warehouse.id, lotId: null,
      countedQuantity: qty("8"), unitValue: money("15"), note: null,
    }],
    actorUserId: dossier.user.id,
  }));
  await prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.qtyToDisplay(balance.quantity)).toBe("8.000000");
  expect(units.moneyToDisplay(balance.value)).toBe("120.000000");
});

test("a locked period blocks an inventory validation and leaves nothing behind", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `LK-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("40"), unitValue: money("5") }],
  });
  const campaign = await campaignWithCount(dossier, article, qty("37"));

  await prisma.fiscalYear.update({
    where: { id: dossier.fiscalYear.id },
    data: { lockedTo: new Date(Date.UTC(2026, 8, 30)) },
  });

  await expect(prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/période est verrouillée/);

  // Atomic: no adjustment document, no movement, and the campaign still open.
  expect(await prisma.stockDocument.count({ where: { inventoryCampaignId: campaign.id } })).toBe(0);
  expect(await prisma.stockMovement.count({ where: { articleId: article.id } })).toBe(1);
  const after = await prisma.stockInventoryCampaign.findUnique({ where: { id: campaign.id } });
  expect(after.status).toBe("COUNTING");
});

test("a theoretical position that moved since the freeze blocks validation by name", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `MV-${randomUUID().slice(0, 6)}`, designation: "Ciment gris" });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("30"), unitValue: money("10") }],
  });
  const campaign = await campaignWithCount(dossier, article, qty("28"));

  // Another receipt lands on the same day the inventory is dated, which the
  // register allows and the frozen snapshot did not see.
  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 5, 30)),
    lines: [{ article, quantity: qty("5"), unitValue: money("10") }],
  });

  await expect(prisma.$transaction(async (tx) => inventory.validateCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/Ciment gris.*a changé depuis le gel/s);

  // Refreshing keeps the counted quantity and restates the theoretical one.
  await prisma.$transaction(async (tx) => inventory.freezeCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  const refreshed = await prisma.stockInventoryCount.findFirst({ where: { campaignId: campaign.id } });
  expect(units.qtyToDisplay(refreshed.countedQuantity)).toBe("28.000000");
  expect(units.qtyToDisplay(refreshed.expectedQuantity)).toBe("35.000000");
});

test("a campaign over every dépôt counts each one separately", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `MD-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    warehouse: dossier.secondWarehouse,
    lines: [{ article, quantity: qty("4"), unitValue: money("10"), warehouse: dossier.secondWarehouse }],
  });

  const campaign = await prisma.$transaction(async (tx) => inventory.createCampaignInTransaction(tx, {
    companyId: dossier.company.id, warehouseId: null,
    countDate: new Date(Date.UTC(2026, 5, 30)), note: null, actorUserId: dossier.user.id,
  }));
  const frozen = await prisma.$transaction(async (tx) => inventory.freezeCampaignInTransaction(tx, {
    companyId: dossier.company.id, campaignId: campaign.id, actorUserId: dossier.user.id,
  }));
  expect(frozen.positions).toBe(2);

  const rows = await prisma.stockInventoryCount.findMany({ where: { campaignId: campaign.id } });
  expect(new Set(rows.map((row) => row.warehouseId))).toEqual(
    new Set([dossier.warehouse.id, dossier.secondWarehouse.id]),
  );
});

/* -------------------------------------------------------------- impairment */

test("an impairment is the exact difference, and its entry is a balanced draft", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `DP-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("200"), unitValue: money("12.5") }],
  });

  const created = await prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id,
    articleId: article.id,
    warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 11, 31)),
    recoverableValue: money("1800"),
    reason: "Rotation nulle depuis dix mois",
    note: null,
    supportingDocumentId: null,
    actorUserId: dossier.user.id,
  }));

  expect(units.moneyToDisplay(created.valueBefore)).toBe("2500.000000");
  expect(units.moneyToDisplay(created.recoverableValue)).toBe("1800.000000");
  expect(units.moneyToDisplay(created.amount)).toBe("700.000000");
  expect(units.qtyToDisplay(created.quantity)).toBe("200.000000");
  expect(created.reference).toMatch(/^DEP-2026-\d{6}$/);

  const entry = await prisma.entry.findUnique({ where: { id: created.accountingEntryId }, include: { lines: true } });
  expect(entry.status).toBe("DRAFT");
  const debit = entry.lines.find((line) => line.debitCents > 0n);
  const credit = entry.lines.find((line) => line.creditCents > 0n);
  expect(debit.accountId).toBe(dossier.chargeAccount.id);
  expect(credit.accountId).toBe(dossier.provisionAccount.id);
  expect(debit.debitCents).toBe(70000n);
  expect(credit.creditCents).toBe(70000n);

  // An impairment moves nothing: the register and the position are untouched.
  expect(await prisma.stockMovement.count({ where: { articleId: article.id } })).toBe(1);
  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  expect(units.moneyToDisplay(balance.value)).toBe("2500.000000");
});

test("a provision is released by a reprise, and the original keeps its figures", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `RP-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  const created = await prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 5, 30)),
    recoverableValue: money("600"), reason: "Détérioration", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }));

  // A second provision on the same position is refused while the first stands.
  await expect(prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 6, 30)),
    recoverableValue: money("500"), reason: "Encore", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/déjà active/);

  const reversal = await prisma.$transaction(async (tx) => impairment.reverseImpairmentInTransaction(tx, {
    companyId: dossier.company.id, impairmentId: created.id,
    date: new Date(Date.UTC(2026, 8, 30)), reason: null, actorUserId: dossier.user.id,
  }));
  expect(units.moneyToDisplay(reversal.amount)).toBe("400.000000");

  const entry = await prisma.entry.findUnique({ where: { id: reversal.accountingEntryId }, include: { lines: true } });
  expect(entry.lines.find((line) => line.debitCents > 0n).accountId).toBe(dossier.provisionAccount.id);
  expect(entry.lines.find((line) => line.creditCents > 0n).accountId).toBe(dossier.reversalAccount.id);

  const original = await prisma.stockImpairment.findUnique({ where: { id: created.id } });
  expect(original.status).toBe("REVERSED");
  expect(units.moneyToDisplay(original.amount)).toBe("400.000000");
  expect(units.moneyToDisplay(original.recoverableValue)).toBe("600.000000");
  expect(original.reversedAt).toBeTruthy();

  // Released, so a new provision may now be taken on the same position.
  await expect(prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 9, 30)),
    recoverableValue: money("300"), reason: "Nouvelle estimation", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }))).resolves.toBeTruthy();
});

test("an unconfigured provision account blocks the impairment rather than guessing 3911", async () => {
  const dossier = await createDossier({ impairmentAccounts: false });
  const article = await createArticle(dossier, { sku: `NA-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });

  await expect(prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 5, 30)),
    recoverableValue: money("50"), reason: "Test", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/compte de provision pour dépréciation des stocks.*ne sont pas paramétrés/s);
  expect(await prisma.stockImpairment.count({ where: { companyId: dossier.company.id } })).toBe(0);
});

test("stock worth at least what it cost is not an impairment", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `NI-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });
  await expect(prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 5, 30)),
    recoverableValue: money("100"), reason: "Test", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/pas de dépréciation à constater/);
});

/* ------------------------------------------------------------------ import */

const CATALOGUE_CSV = [
  "Reference;Designation;Unite;Valorisation;Stock mini",
  "ART-001;Ciment gris 50kg;UN;CMP;10",
  "ART-002;Sable lavé;UN;FIFO;0",
  "ART-003;Gravette 15/25;UN;CMP;5",
].join("\r\n");

function importContext(dossier, overrides = {}) {
  return {
    companyId: dossier.company.id,
    kind: "ARTICLES",
    conflictMode: "REFUSE",
    defaultUnitId: dossier.unit.id,
    defaultWarehouseId: dossier.warehouse.id,
    defaultValuationMethod: "CMP",
    documentDate: null,
    ...overrides,
  };
}

test("a catalogue import previews without writing, then writes what was previewed", async () => {
  const dossier = await createDossier();
  const context = importContext(dossier);
  const plan = await stockImport.planImport(prisma, {
    context, bytes: Buffer.from(CATALOGUE_CSV, "utf8"), fileName: "catalogue.csv", mapping: null,
  });

  expect(plan.format).toBe("CSV");
  expect(plan.errors).toEqual([]);
  expect(plan.totals.create).toBe(3);
  expect(plan.articles.map((article) => article.sku)).toEqual(["ART-001", "ART-002", "ART-003"]);
  expect(plan.articles[1].valuationMethod).toBe("FIFO");
  // The preview wrote nothing.
  expect(await prisma.stockArticle.count({ where: { companyId: dossier.company.id } })).toBe(0);

  const result = await prisma.$transaction(async (tx) => stockImport.commitImportInTransaction(tx, {
    context, plan, actorUserId: dossier.user.id,
  }));
  expect(result).toMatchObject({ created: 3, updated: 0, skipped: 0 });
  const written = await prisma.stockArticle.findMany({ where: { companyId: dossier.company.id }, orderBy: { sku: "asc" } });
  expect(written.map((article) => article.designation)).toEqual(["Ciment gris 50kg", "Sable lavé", "Gravette 15/25"]);
  expect(units.qtyToDisplay(written[0].minQuantity)).toBe("10.000000");
});

test("a duplicate reference is refused unless the person chose what to do with it", async () => {
  const dossier = await createDossier();
  await prisma.stockArticle.create({
    data: {
      companyId: dossier.company.id, sku: "ART-001", designation: "Ancien libellé",
      unitId: dossier.unit.id, valuationMethod: "CMP",
    },
  });

  const refused = await stockImport.planImport(prisma, {
    context: importContext(dossier),
    bytes: Buffer.from(CATALOGUE_CSV, "utf8"), fileName: "catalogue.csv", mapping: null,
  });
  expect(refused.errors[0].message).toMatch(/existe déjà.*explicitement/s);
  expect(refused.errors[0].row).toBe(2);

  const updating = importContext(dossier, { conflictMode: "UPDATE" });
  const plan = await stockImport.planImport(prisma, {
    context: updating, bytes: Buffer.from(CATALOGUE_CSV, "utf8"), fileName: "catalogue.csv", mapping: null,
  });
  expect(plan.errors).toEqual([]);
  expect(plan.totals).toMatchObject({ create: 2, update: 1 });
  await prisma.$transaction(async (tx) => stockImport.commitImportInTransaction(tx, {
    context: updating, plan, actorUserId: dossier.user.id,
  }));
  const updated = await prisma.stockArticle.findFirst({ where: { companyId: dossier.company.id, sku: "ART-001" } });
  expect(updated.designation).toBe("Ciment gris 50kg");

  // And SKIP leaves the existing article exactly as it stands.
  const skipping = importContext(dossier, { conflictMode: "SKIP" });
  const skipPlan = await stockImport.planImport(prisma, {
    context: skipping,
    bytes: Buffer.from("Reference;Designation;Unite\r\nART-001;Autre chose;UN", "utf8"),
    fileName: "catalogue.csv", mapping: null,
  });
  await prisma.$transaction(async (tx) => stockImport.commitImportInTransaction(tx, {
    context: skipping, plan: skipPlan, actorUserId: dossier.user.id,
  }));
  const untouched = await prisma.stockArticle.findFirst({ where: { companyId: dossier.company.id, sku: "ART-001" } });
  expect(untouched.designation).toBe("Ciment gris 50kg");
});

test("a row naming a unit the dossier does not have refuses the row, and names it", async () => {
  const dossier = await createDossier();
  const plan = await stockImport.planImport(prisma, {
    context: importContext(dossier),
    bytes: Buffer.from("Reference;Designation;Unite\r\nART-009;Palette bois;PAL", "utf8"),
    fileName: "catalogue.csv", mapping: null,
  });
  expect(plan.errors[0].message).toMatch(/L'unité « PAL » n'existe pas/);
  expect(plan.errors[0].message).toMatch(/n'invente pas d'unité/);
});

test("a duplicate inside the file is caught before the catalogue is touched", async () => {
  const dossier = await createDossier();
  const plan = await stockImport.planImport(prisma, {
    context: importContext(dossier),
    bytes: Buffer.from("Reference;Designation\r\nART-A;Un\r\nART-A;Deux", "utf8"),
    fileName: "catalogue.csv", mapping: null,
  });
  expect(plan.errors[0].message).toMatch(/apparaît déjà ligne 2 du même fichier/);
});

test("a malformed spreadsheet leaves no partially imported catalogue", async () => {
  const dossier = await createDossier();
  const context = importContext(dossier);
  // Three good rows and one that names a family the dossier does not have.
  const csv = [
    "Reference;Designation;Famille",
    "OK-1;Bon un;",
    "OK-2;Bon deux;",
    "KO-3;Mauvais;FAMILLE-INEXISTANTE",
  ].join("\r\n");
  const plan = await stockImport.planImport(prisma, {
    context, bytes: Buffer.from(csv, "utf8"), fileName: "catalogue.csv", mapping: null,
  });
  expect(plan.errors).toHaveLength(1);

  await expect(prisma.$transaction(async (tx) => stockImport.commitImportInTransaction(tx, {
    context, plan, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/erreur\(s\)/);
  expect(await prisma.stockArticle.count({ where: { companyId: dossier.company.id } })).toBe(0);
});

test("an opening-stock import validates its documents and reaches the register", async () => {
  const dossier = await createDossier();
  const context = importContext(dossier, {
    kind: "OPENING_STOCK",
    documentDate: new Date(Date.UTC(2026, 0, 1)),
  });
  const csv = [
    "Reference;Designation;Quantite;Valeur unitaire;Depot",
    "OS-1;Ciment;100;12,50;PRIN",
    "OS-2;Sable;40;8;SETT",
  ].join("\r\n");
  const plan = await stockImport.planImport(prisma, {
    context, bytes: Buffer.from(csv, "utf8"), fileName: "ouverture.csv", mapping: null,
  });
  expect(plan.errors).toEqual([]);
  expect(plan.totals.quantity).toBe("140.000000");
  expect(plan.totals.value).toBe("1570.000000");

  const result = await prisma.$transaction(async (tx) => stockImport.commitImportInTransaction(tx, {
    context, plan, actorUserId: dossier.user.id,
  }));
  expect(result.created).toBe(2);
  // One document per dépôt, each validated through the ordinary path.
  expect(result.documentIds).toHaveLength(2);
  const documents = await prisma.stockDocument.findMany({
    where: { id: { in: result.documentIds } },
    include: { movements: true },
  });
  for (const document of documents) {
    expect(document.status).toBe("VALIDATED");
    expect(document.reference).toMatch(/^SI-2026-\d{6}$/);
    expect(document.movements.length).toBeGreaterThan(0);
  }
  const balances = await prisma.stockBalance.findMany({ where: { companyId: dossier.company.id } });
  const total = balances.reduce((sum, balance) => sum + balance.value, 0n);
  expect(units.moneyToDisplay(total)).toBe("1570.000000");
});

test("an XLSX catalogue is read the same way a CSV one is", async () => {
  const dossier = await createDossier();
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Articles");
  sheet.addRow(["Reference", "Designation", "Unite"]);
  sheet.addRow(["XL-1", "Article tableur", "UN"]);
  sheet.addRow(["XL-2", "Deuxième article", "UN"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  const plan = await stockImport.planImport(prisma, {
    context: importContext(dossier), bytes, fileName: "catalogue.xlsx", mapping: null,
  });
  expect(plan.format).toBe("XLSX");
  expect(plan.errors).toEqual([]);
  expect(plan.articles.map((article) => article.sku)).toEqual(["XL-1", "XL-2"]);
});

/* ----------------------------------------------------------------- reports */

test("the valuation report rebuilds the position as at a date, not as at today", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `VR-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT", date: new Date(Date.UTC(2026, 5, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
  });

  const atMarch = await reports.stockValuationReport(prisma, {
    companyId: dossier.company.id, asOf: new Date(Date.UTC(2026, 2, 31)), groupBy: "ARTICLE",
  });
  expect(units.qtyToDisplay(atMarch.totals.quantity)).toBe("10.000000");
  expect(units.moneyToDisplay(atMarch.totals.value)).toBe("1000.000000");

  const atYearEnd = await reports.stockValuationReport(prisma, {
    companyId: dossier.company.id, asOf: new Date(Date.UTC(2026, 11, 31)), groupBy: "ARTICLE",
  });
  expect(units.qtyToDisplay(atYearEnd.totals.quantity)).toBe("20.000000");
  expect(units.moneyToDisplay(atYearEnd.totals.value)).toBe("2200.000000");
  expect(units.moneyToDisplay(atYearEnd.rows[0].unitCost)).toBe("110.000000");

  // A provision reduces the net value and leaves the gross one alone.
  await prisma.$transaction(async (tx) => impairment.createImpairmentInTransaction(tx, {
    companyId: dossier.company.id, articleId: article.id, warehouseId: null,
    impairmentDate: new Date(Date.UTC(2026, 11, 31)),
    recoverableValue: money("2000"), reason: "Baisse du marché", note: null,
    supportingDocumentId: null, actorUserId: dossier.user.id,
  }));
  const net = await reports.stockValuationReport(prisma, {
    companyId: dossier.company.id, asOf: new Date(Date.UTC(2026, 11, 31)), groupBy: "ARTICLE",
  });
  expect(units.moneyToDisplay(net.totals.value)).toBe("2200.000000");
  expect(units.moneyToDisplay(net.totals.impairment)).toBe("200.000000");
  expect(units.moneyToDisplay(net.totals.netValue)).toBe("2000.000000");
});

test("the movement report filters the register without changing its order", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `MR-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });
  await validateDocument(dossier, {
    type: "SALES_ISSUE", date: new Date(Date.UTC(2026, 1, 1)),
    lines: [{ article, quantity: qty("4") }],
  });

  const all = await reports.stockMovementReport(prisma, { companyId: dossier.company.id, articleId: article.id });
  expect(all.movements).toHaveLength(2);
  expect(all.movements[0].documentType).toBe("OPENING_STOCK");
  expect(units.qtyToDisplay(all.totals.inQuantity)).toBe("10.000000");
  expect(units.qtyToDisplay(all.totals.outQuantity)).toBe("4.000000");

  const issuesOnly = await reports.stockMovementReport(prisma, {
    companyId: dossier.company.id, articleId: article.id, direction: "OUT",
  });
  expect(issuesOnly.movements).toHaveLength(1);
  expect(units.moneyToDisplay(issuesOnly.totals.outValue)).toBe("40.000000");
});

test("the anomaly report is silent on a healthy dossier and speaks on a broken position", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `AN-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });
  const healthy = await reports.stockAnomalyReport(prisma, { companyId: dossier.company.id });
  expect(healthy.anomalies).toEqual([]);

  // A balance cache forced into a state no sequence of real events produces.
  const balance = await prisma.stockBalance.findFirst({ where: { articleId: article.id } });
  await prisma.stockBalance.update({ where: { id: balance.id }, data: { quantity: 0n, value: money("1") } });
  const broken = await reports.stockAnomalyReport(prisma, { companyId: dossier.company.id });
  expect(broken.anomalies.map((anomaly) => anomaly.kind)).toContain("VALUE_WITHOUT_QUANTITY");
});

test("the ageing report measures days since the last movement, and names never-issued stock", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: `AG-${randomUUID().slice(0, 6)}` });
  await validateDocument(dossier, {
    type: "OPENING_STOCK", date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  });

  const report = await reports.stockAgeingReport(prisma, {
    companyId: dossier.company.id, asOf: new Date(Date.UTC(2026, 2, 2)),
  });
  const row = report.rows.find((candidate) => candidate.articleId === article.id);
  expect(row.days).toBe(60);
  expect(row.lastIssueDate).toBeNull();
  const bucket = report.buckets.find((candidate) => candidate.label === "31–90 jours");
  expect(bucket.positions).toBeGreaterThan(0);
});
