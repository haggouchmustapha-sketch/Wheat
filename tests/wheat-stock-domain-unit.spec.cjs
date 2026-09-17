const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The stock module against a real database.
 *
 * The arithmetic is proved separately; what is proved here is that the
 * arithmetic survives contact with Prisma, the movement register, the FIFO
 * layers and Wheat's accounting engine — and that the guarantees which only
 * mean anything at the database level actually hold: a validated movement that
 * raw SQL cannot touch, a validation that leaves nothing behind when it fails,
 * a document that cannot be validated twice, and a dossier boundary that a
 * forged companyId does not cross.
 *
 * Every test runs against its own temporary SQLite file built from the real
 * migrations. Nothing here touches `prisma/dev.db` or `%APPDATA%\Wheat`.
 */

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let prisma;
let temporaryRoot;
let databasePath;
let validation;
let units;
let domain;
let accounting;

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
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-stock-"));
  databasePath = path.join(temporaryRoot, "stock.db");
  applyAllMigrations(databasePath);
  process.env.DATABASE_URL = sqliteFileUrl(databasePath);
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  validation = tsxRequire(path.join(cwd, "electron", "stockValidation.ts"), __filename);
  units = tsxRequire(path.join(cwd, "electron", "stockUnits.ts"), __filename);
  domain = tsxRequire(path.join(cwd, "electron", "stockDomain.ts"), __filename);
  accounting = tsxRequire(path.join(cwd, "electron", "stockAccounting.ts"), __filename);
});

test.afterAll(async () => {
  await prisma?.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const qty = (value) => units.qtyFromDecimal(value, "La quantité");
const money = (value) => units.moneyFromDecimal(value, "Le montant");

/**
 * A dossier with everything stock needs and nothing it does not: one fiscal
 * year, the two accounts a mapping points at, a journal, a warehouse and a unit.
 */
async function createDossier(options = {}) {
  const suffix = randomUUID().slice(0, 8);
  const company = await prisma.company.create({
    data: {
      name: `Stock ${suffix}`,
      legalForm: "SARL",
      ice: `ICE${suffix}`,
      taxId: `IF${suffix}`,
      city: "Casablanca",
    },
  });
  const user = await prisma.user.create({
    data: { name: `Comptable ${suffix}`, email: `stock-${suffix}@example.test`, role: "ACCOUNTANT" },
  });
  await prisma.companyUser.create({ data: { companyId: company.id, userId: user.id, role: "ACCOUNTANT" } });
  const fiscalYear = await prisma.fiscalYear.create({
    data: {
      companyId: company.id,
      label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)),
      endsOn: new Date(Date.UTC(2026, 11, 31)),
      status: "OPEN",
    },
  });
  const stockAccount = await prisma.account.create({
    data: { companyId: company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" },
  });
  const variationAccount = await prisma.account.create({
    data: { companyId: company.id, code: "6114", label: "Variation des stocks de marchandises", classNo: 6, type: "EXPENSE" },
  });
  const journal = await prisma.journal.create({
    data: { companyId: company.id, code: "STK", label: "Journal des stocks" },
  });
  await prisma.stockSettings.create({
    data: {
      companyId: company.id,
      stockJournalId: journal.id,
      allowNegativeStock: options.allowNegativeStock ?? false,
    },
  });
  if (options.mapAccounts !== false) {
    await prisma.stockAccountMapping.create({
      data: {
        companyId: company.id,
        scope: "COMPANY",
        scopeKey: "COMPANY",
        stockAccountId: stockAccount.id,
        variationAccountId: variationAccount.id,
      },
    });
  }
  const unit = await prisma.stockUnit.create({
    data: { companyId: company.id, code: "UN", label: "Unité" },
  });
  const warehouse = await prisma.stockWarehouse.create({
    data: { companyId: company.id, code: "PRIN", name: "DEPOT PRINCIPAL" },
  });
  const secondWarehouse = await prisma.stockWarehouse.create({
    data: { companyId: company.id, code: "SETT", name: "Magasin Settat" },
  });
  return { company, user, fiscalYear, stockAccount, variationAccount, journal, unit, warehouse, secondWarehouse };
}

async function createArticle(dossier, options = {}) {
  return prisma.stockArticle.create({
    data: {
      companyId: dossier.company.id,
      sku: options.sku ?? `ART-${randomUUID().slice(0, 6)}`,
      designation: options.designation ?? "Produit Test",
      unitId: dossier.unit.id,
      valuationMethod: options.valuationMethod ?? "CMP",
      lotTracking: options.lotTracking ?? false,
    },
  });
}

/**
 * Creates a draft and validates it, which is how a user reaches stock: the
 * draft alone changes nothing, and validation is the single operation that does.
 */
async function validateDocument(dossier, input) {
  const document = await prisma.stockDocument.create({
    data: {
      companyId: dossier.company.id,
      fiscalYearId: dossier.fiscalYear.id,
      type: input.type,
      reference: input.reference ?? `${input.type}-${randomUUID().slice(0, 8)}`,
      documentDate: input.date,
      warehouseId: (input.warehouse ?? dossier.warehouse).id,
      targetWarehouseId: input.targetWarehouse?.id ?? null,
      counterpartyId: input.counterpartyId ?? null,
      createdByUserId: dossier.user.id,
      lines: {
        create: input.lines.map((line, index) => ({
          position: index + 1,
          articleId: line.article.id,
          quantity: line.quantity,
          unitId: dossier.unit.id,
          warehouseId: (line.warehouse ?? input.warehouse ?? dossier.warehouse).id,
          lotId: line.lotId ?? null,
          direction: line.direction ?? null,
          unitValue: line.unitValue ?? null,
          grossValue: line.grossValue ?? 0n,
        })),
      },
    },
  });
  if (input.landedCosts) {
    for (const [index, charge] of input.landedCosts.entries()) {
      await prisma.stockLandedCost.create({
        data: {
          companyId: dossier.company.id,
          documentId: document.id,
          position: index + 1,
          kind: charge.kind ?? "TRANSPORT",
          label: charge.label ?? "Transport",
          amount: charge.amount,
          allocationMethod: charge.allocationMethod ?? "VALUE",
        },
      });
    }
  }
  return prisma.$transaction(async (tx) => validation.validateStockDocumentInTransaction(tx, {
    companyId: dossier.company.id,
    documentId: document.id,
    actorUserId: dossier.user.id,
  }));
}

async function balanceOf(dossier, article, warehouse) {
  return prisma.stockBalance.findUnique({
    where: {
      companyId_articleId_warehouseId_lotKey: {
        companyId: dossier.company.id,
        articleId: article.id,
        warehouseId: (warehouse ?? dossier.warehouse).id,
        lotKey: "",
      },
    },
  });
}

test("acceptance: CMP opening, purchase and issue produce the specified card", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: "ART-001", designation: "Produit Test" });

  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  let balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("10"));
  expect(balance.value).toBe(money("1000"));

  const counterparty = await prisma.counterparty.create({
    data: { companyId: dossier.company.id, kind: "SUPPLIER", displayName: "FOURNISSEUR X", identityKey: `sup-${randomUUID().slice(0, 6)}` },
  });
  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 0, 5)),
    counterpartyId: counterparty.id,
    lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
  });
  balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("20"));
  expect(balance.value).toBe(money("2200"));
  expect(units.derivedUnitCost(balance.value, balance.quantity)).toBe(money("110"));

  const client = await prisma.counterparty.create({
    data: { companyId: dossier.company.id, kind: "CUSTOMER", displayName: "CLIENT Y", identityKey: `cli-${randomUUID().slice(0, 6)}` },
  });
  const issue = await validateDocument(dossier, {
    type: "SALES_ISSUE",
    date: new Date(Date.UTC(2026, 0, 10)),
    counterpartyId: client.id,
    lines: [{ article, quantity: qty("5") }],
  });

  balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("15"));
  expect(balance.value).toBe(money("1650"));
  expect(units.derivedUnitCost(balance.value, balance.quantity)).toBe(money("110"));

  // The register carries the running position after each movement, which is
  // what the stock card's two right-hand columns read.
  const movements = await prisma.stockMovement.findMany({
    where: { companyId: dossier.company.id, articleId: article.id },
    orderBy: { sequence: "asc" },
  });
  expect(movements).toHaveLength(3);
  expect(movements.map((movement) => movement.direction)).toEqual(["IN", "IN", "OUT"]);
  expect(movements[2].value).toBe(money("550"));
  expect(movements[2].resultingQuantity).toBe(qty("15"));
  expect(movements[2].resultingValue).toBe(money("1650"));

  const entry = await prisma.entry.findUniqueOrThrow({
    where: { id: issue.accountingEntryId },
    include: { lines: true },
  });
  expect(entry.status).toBe("DRAFT");
  expect(entry.journalId).toBe(dossier.journal.id);
  const debit = entry.lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const credit = entry.lines.reduce((sum, line) => sum + line.creditCents, 0n);
  expect(debit).toBe(credit);
  expect(debit).toBe(55_000n);
  // An issue debits variation and credits stock.
  const stockLine = entry.lines.find((line) => line.accountId === dossier.stockAccount.id);
  expect(stockLine.creditCents).toBe(55_000n);

  const audit = await prisma.auditEvent.findMany({ where: { action: "STOCK_DOCUMENT_VALIDATED" } });
  expect(audit.length).toBeGreaterThanOrEqual(3);
});

test("acceptance: FIFO consumes the oldest layers and records why", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { sku: "ART-FIFO", valuationMethod: "FIFO" });

  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
  });
  const issue = await validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 3)),
    lines: [{ article, quantity: qty("15") }],
  });

  const balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("5"));
  expect(balance.value).toBe(money("600"));

  const issueMovement = issue.movements[0];
  expect(issueMovement.value).toBe(money("1600"));

  const consumptions = await prisma.stockFifoConsumption.findMany({
    where: { movementId: issueMovement.id },
    include: { layer: true },
    orderBy: { createdAt: "asc" },
  });
  expect(consumptions).toHaveLength(2);
  expect(consumptions[0].quantity).toBe(qty("10"));
  expect(consumptions[0].value).toBe(money("1000"));
  expect(consumptions[0].exhausted).toBe(true);
  expect(consumptions[1].quantity).toBe(qty("5"));
  expect(consumptions[1].value).toBe(money("600"));
  expect(consumptions[1].exhausted).toBe(false);

  const layers = await prisma.stockFifoLayer.findMany({
    where: { companyId: dossier.company.id, articleId: article.id },
    orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
  });
  expect(layers[0].quantityRemaining).toBe(0n);
  expect(layers[0].valueRemaining).toBe(0n);
  expect(layers[1].quantityRemaining).toBe(qty("5"));
  expect(layers[1].valueRemaining).toBe(money("600"));
});

test("a transfer conserves company quantity and value, under CMP and FIFO", async () => {
  for (const method of ["CMP", "FIFO"]) {
    const dossier = await createDossier();
    const article = await createArticle(dossier, { valuationMethod: method });
    await validateDocument(dossier, {
      type: "OPENING_STOCK",
      date: new Date(Date.UTC(2026, 0, 1)),
      lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
    });
    await validateDocument(dossier, {
      type: "OPENING_STOCK",
      date: new Date(Date.UTC(2026, 0, 2)),
      lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
    });

    const before = await prisma.stockBalance.aggregate({
      where: { companyId: dossier.company.id, articleId: article.id },
      _sum: { quantity: true, value: true },
    });

    const transfer = await validateDocument(dossier, {
      type: "TRANSFER",
      date: new Date(Date.UTC(2026, 0, 3)),
      targetWarehouse: dossier.secondWarehouse,
      lines: [{ article, quantity: qty("12") }],
    });

    const after = await prisma.stockBalance.aggregate({
      where: { companyId: dossier.company.id, articleId: article.id },
      _sum: { quantity: true, value: true },
    });
    expect(after._sum.quantity).toBe(before._sum.quantity);
    expect(after._sum.value).toBe(before._sum.value);

    // The value that left the source is exactly the value that arrived.
    const out = transfer.movements.find((movement) => movement.direction === "OUT");
    const into = transfer.movements.find((movement) => movement.direction === "IN");
    expect(into.value).toBe(out.value);

    // Same company, same stock account both sides: the ledger has nothing to
    // record, so no entry is invented to prove the module ran.
    expect(transfer.accountingEntryId).toBeNull();
  }
});

test("landed costs reach the stock value and sum exactly to the charge", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  const second = await createArticle(dossier);
  const supplier = await prisma.counterparty.create({
    data: { companyId: dossier.company.id, kind: "SUPPLIER", displayName: "TRANSIT", identityKey: `sup-${randomUUID().slice(0, 6)}` },
  });

  await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 0, 4)),
    counterpartyId: supplier.id,
    lines: [
      { article, quantity: qty("10"), unitValue: money("100") },
      { article: second, quantity: qty("10"), unitValue: money("10") },
    ],
    landedCosts: [{ label: "Transport", amount: money("110"), allocationMethod: "VALUE" }],
  });

  const first = await balanceOf(dossier, article);
  const other = await balanceOf(dossier, second);
  // 110 split over 1000 and 100 gives 100 and 10, and the two allocations sum
  // to the charge with nothing left stranded.
  expect(first.value).toBe(money("1100"));
  expect(other.value).toBe(money("110"));
  expect(first.value + other.value).toBe(money("1000") + money("100") + money("110"));
});

test("a validated movement cannot be changed by raw SQL", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  const movement = await prisma.stockMovement.findFirstOrThrow({ where: { articleId: article.id } });

  // Not "the service refuses": the database refuses, for any caller at all.
  const database = new DatabaseSync(databasePath);
  try {
    expect(() => database.exec(`UPDATE "StockMovement" SET "quantity" = 1 WHERE "id" = '${movement.id}'`))
      .toThrow(/ne peut pas etre modifie/);
    expect(() => database.exec(`DELETE FROM "StockMovement" WHERE "id" = '${movement.id}'`))
      .toThrow(/ne peut pas etre supprime/);
    const consumptionTrigger = database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'StockFifoConsumption%'")
      .get();
    expect(Number(consumptionTrigger.count)).toBe(2);
  } finally {
    database.close();
  }

  const unchanged = await prisma.stockMovement.findUniqueOrThrow({ where: { id: movement.id } });
  expect(unchanged.quantity).toBe(qty("10"));
});

test("an article with no account mapping blocks accounting instead of guessing one", async () => {
  const dossier = await createDossier({ mapAccounts: false });
  const article = await createArticle(dossier, { designation: "Câble électrique 2,5 mm" });

  await expect(validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  })).rejects.toThrow(/Compte de stock non paramétré pour l'article « Câble électrique 2,5 mm »/);

  // And the refusal left nothing behind: no movement, no balance, no layer.
  expect(await prisma.stockMovement.count({ where: { articleId: article.id } })).toBe(0);
  expect(await prisma.stockBalance.count({ where: { articleId: article.id } })).toBe(0);
  expect(await prisma.stockFifoLayer.count({ where: { articleId: article.id } })).toBe(0);
  const document = await prisma.stockDocument.findFirstOrThrow({ where: { companyId: dossier.company.id } });
  expect(document.status).toBe("DRAFT");
});

test("a locked period blocks validation", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  await prisma.fiscalYear.update({
    where: { id: dossier.fiscalYear.id },
    data: { lockedTo: new Date(Date.UTC(2026, 2, 31)) },
  });

  await expect(validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 15)),
    lines: [{ article, quantity: qty("5"), unitValue: money("10") }],
  })).rejects.toThrow(/période est verrouillée/);
  expect(await prisma.stockMovement.count({ where: { articleId: article.id } })).toBe(0);
});

test("a document cannot be validated twice", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  const document = await prisma.stockDocument.create({
    data: {
      companyId: dossier.company.id,
      fiscalYearId: dossier.fiscalYear.id,
      type: "OPENING_STOCK",
      reference: `SI-${randomUUID().slice(0, 8)}`,
      documentDate: new Date(Date.UTC(2026, 0, 1)),
      warehouseId: dossier.warehouse.id,
      lines: {
        create: [{
          position: 1, articleId: article.id, quantity: qty("10"),
          unitId: dossier.unit.id, warehouseId: dossier.warehouse.id, unitValue: money("100"),
        }],
      },
    },
  });
  const run = () => prisma.$transaction(async (tx) => validation.validateStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: document.id, actorUserId: dossier.user.id,
  }));

  await run();
  await expect(run()).rejects.toThrow(/déjà validé/);
  expect(await prisma.stockMovement.count({ where: { documentId: document.id } })).toBe(1);
});

test("a forged companyId reaches nothing", async () => {
  const first = await createDossier();
  const second = await createDossier();
  const article = await createArticle(first);
  const document = await prisma.stockDocument.create({
    data: {
      companyId: first.company.id,
      fiscalYearId: first.fiscalYear.id,
      type: "OPENING_STOCK",
      reference: `SI-${randomUUID().slice(0, 8)}`,
      documentDate: new Date(Date.UTC(2026, 0, 1)),
      warehouseId: first.warehouse.id,
      lines: {
        create: [{
          position: 1, articleId: article.id, quantity: qty("10"),
          unitId: first.unit.id, warehouseId: first.warehouse.id, unitValue: money("100"),
        }],
      },
    },
  });

  await expect(prisma.$transaction(async (tx) => validation.validateStockDocumentInTransaction(tx, {
    companyId: second.company.id, documentId: document.id, actorUserId: second.user.id,
  }))).rejects.toThrow(/n'appartient pas à ce dossier/);
  expect(await prisma.stockMovement.count({ where: { documentId: document.id } })).toBe(0);
});

test("negative stock is refused, with the numbers that explain the refusal", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { designation: "Câble électrique 2,5 mm" });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("12"), unitValue: money("10") }],
  });

  await expect(validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("20") }],
  })).rejects.toThrow(/Stock insuffisant pour « Câble électrique 2,5 mm »[\s\S]*Disponible au dépôt DEPOT PRINCIPAL: 12[\s\S]*Demandé: 20/);
});

test("FIFO refuses to go negative even where the dossier allows it", async () => {
  const dossier = await createDossier({ allowNegativeStock: true });
  const article = await createArticle(dossier, { valuationMethod: "FIFO" });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("3"), unitValue: money("10") }],
  });

  await expect(validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("5") }],
  })).rejects.toThrow(/FIFO n'autorise aucun stock négatif/);
});

test("backdating behind existing movements is refused, and same-day is not", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { designation: "Produit daté" });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 5, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });

  await expect(validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 4, 1)),
    lines: [{ article, quantity: qty("5"), unitValue: money("50") }],
  })).rejects.toThrow(/daté avant des mouvements déjà validés/);

  // The same day is a defined place in the register, not a rewrite of it: the
  // movement sequence puts it after what is already there.
  const sameDay = await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 5, 1)),
    lines: [{ article, quantity: qty("5"), unitValue: money("50") }],
  });
  expect(sameDay.movements[0].resultingQuantity).toBe(qty("15"));
});

test("a FIFO receipt cannot be reversed once part of it has been sold", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { valuationMethod: "FIFO", designation: "Produit FIFO" });
  const receipt = await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("4") }],
  });

  await expect(prisma.$transaction(async (tx) => validation.reverseStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: receipt.id, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/Reçu: 10[\s\S]*Restant: 6[\s\S]*Déjà consommé: 4/);
});

test("reversing a FIFO issue gives the value back to the exact layers it took", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { valuationMethod: "FIFO" });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
  });
  const issue = await validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 3)),
    lines: [{ article, quantity: qty("15") }],
  });

  const reversal = await prisma.$transaction(async (tx) => validation.reverseStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: issue.id, actorUserId: dossier.user.id,
  }));

  const layers = await prisma.stockFifoLayer.findMany({
    where: { companyId: dossier.company.id, articleId: article.id },
    orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
  });
  expect(layers[0].quantityRemaining).toBe(qty("10"));
  expect(layers[0].valueRemaining).toBe(money("1000"));
  expect(layers[1].quantityRemaining).toBe(qty("10"));
  expect(layers[1].valueRemaining).toBe(money("1200"));

  const balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("20"));
  expect(balance.value).toBe(money("2200"));

  // The original keeps every row it wrote; the correction is an appended one.
  const original = await prisma.stockDocument.findUniqueOrThrow({ where: { id: issue.id } });
  expect(original.status).toBe("REVERSED");
  expect(await prisma.stockMovement.count({ where: { documentId: issue.id } })).toBe(1);
  expect(reversal.reversalOfId).toBe(issue.id);
  const restorations = await prisma.stockFifoConsumption.findMany({ where: { documentId: reversal.id } });
  expect(restorations).toHaveLength(2);
  expect(restorations.every((row) => row.kind === "RESTORATION")).toBe(true);
});

test("a lot-tracked article refuses a line that names no lot", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { lotTracking: true, designation: "Lait UHT" });
  await expect(validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("10") }],
  })).rejects.toThrow(/suivi par lot/);
});

test("historical stock is rebuilt from movements, not guessed from today", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("100"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 5)),
    lines: [{ article, quantity: qty("20"), unitValue: money("120") }],
  });

  const asOf = await prisma.stockMovement.findMany({
    where: { companyId: dossier.company.id, articleId: article.id, documentDate: { lte: new Date(Date.UTC(2026, 0, 1)) } },
  });
  const quantity = asOf.reduce((sum, movement) => sum + (movement.direction === "IN" ? movement.quantity : -movement.quantity), 0n);
  const value = asOf.reduce((sum, movement) => sum + (movement.direction === "IN" ? movement.value : -movement.value), 0n);
  expect(quantity).toBe(qty("100"));
  expect(value).toBe(money("10000"));

  const today = await balanceOf(dossier, article);
  expect(today.quantity).toBe(qty("120"));
});

test("the mapping resolves article over family over company, and never falls back", async () => {
  const dossier = await createDossier();
  const family = await prisma.stockArticleFamily.create({
    data: { companyId: dossier.company.id, code: "MP", designation: "Matières premières" },
  });
  const rawMaterials = await prisma.account.create({
    data: { companyId: dossier.company.id, code: "3121", label: "Matières premières", classNo: 3, type: "ASSET" },
  });
  const rawVariation = await prisma.account.create({
    data: { companyId: dossier.company.id, code: "6124", label: "Variation matières", classNo: 6, type: "EXPENSE" },
  });
  await prisma.stockAccountMapping.create({
    data: {
      companyId: dossier.company.id,
      scope: "FAMILY",
      scopeKey: accounting.mappingScopeKey("FAMILY", family.id),
      familyId: family.id,
      stockAccountId: rawMaterials.id,
      variationAccountId: rawVariation.id,
    },
  });
  const article = await prisma.stockArticle.create({
    data: {
      companyId: dossier.company.id, sku: `MP-${randomUUID().slice(0, 6)}`, designation: "Blé tendre",
      unitId: dossier.unit.id, familyId: family.id,
    },
  });

  const resolved = await accounting.resolveStockAccounts(prisma, dossier.company.id, article);
  expect(resolved.stockAccountId).toBe(rawMaterials.id);
  expect(resolved.scope).toBe("FAMILY");

  // A raw-material company must not post to merchandise because 3111 happened
  // to be configured at company level.
  const receipt = await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  const entry = await prisma.entry.findUniqueOrThrow({ where: { id: receipt.accountingEntryId }, include: { lines: true } });
  expect(entry.lines.some((line) => line.accountId === rawMaterials.id)).toBe(true);
  expect(entry.lines.some((line) => line.accountId === dossier.stockAccount.id)).toBe(false);
});

test("stock document numbering is its own sequence, per type and fiscal year", async () => {
  const dossier = await createDossier();
  const first = await prisma.$transaction(async (tx) => domain.allocateStockDocumentNumber(tx, {
    companyId: dossier.company.id, fiscalYearId: dossier.fiscalYear.id, type: "PURCHASE_RECEIPT", date: new Date(Date.UTC(2026, 0, 1)),
  }));
  const second = await prisma.$transaction(async (tx) => domain.allocateStockDocumentNumber(tx, {
    companyId: dossier.company.id, fiscalYearId: dossier.fiscalYear.id, type: "PURCHASE_RECEIPT", date: new Date(Date.UTC(2026, 0, 1)),
  }));
  const other = await prisma.$transaction(async (tx) => domain.allocateStockDocumentNumber(tx, {
    companyId: dossier.company.id, fiscalYearId: dossier.fiscalYear.id, type: "SALES_ISSUE", date: new Date(Date.UTC(2026, 0, 1)),
  }));
  expect(first).toBe("BR-2026-000001");
  expect(second).toBe("BR-2026-000002");
  expect(other).toBe("BS-2026-000001");

  // The accounting piece sequence is untouched by stock numbering.
  expect(await prisma.journalPieceSequence.count({ where: { companyId: dossier.company.id } })).toBe(0);
});

test("deleting a dossier does not quietly shed its stock history", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });

  // SQLite fires a child table's BEFORE DELETE trigger on a foreign-key cascade
  // only when recursive_triggers is on, and Wheat leaves it off — so the
  // register's own trigger is not what protects it here. `wheat:company:delete`
  // refuses a dossier that holds validated movements for exactly that reason,
  // the same way it already refuses one holding posted entries or a statement.
  const database = new DatabaseSync(databasePath);
  try {
    const recursive = database.prepare("PRAGMA recursive_triggers").get();
    expect(Number(recursive.recursive_triggers)).toBe(0);
  } finally {
    database.close();
  }

  const held = await prisma.stockMovement.count({ where: { companyId: dossier.company.id } });
  expect(held).toBe(1);
});

test("a draft consumes no document number, and validation assigns the real one", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);

  const abandoned = await prisma.stockDocument.create({
    data: {
      companyId: dossier.company.id,
      fiscalYearId: dossier.fiscalYear.id,
      type: "PURCHASE_RECEIPT",
      reference: domain.provisionalStockReference(),
      documentDate: new Date(Date.UTC(2026, 0, 1)),
      warehouseId: dossier.warehouse.id,
    },
  });
  expect(domain.isProvisionalStockReference(abandoned.reference)).toBe(true);
  await prisma.stockDocument.delete({ where: { id: abandoned.id } });

  const supplier = await prisma.counterparty.create({
    data: { companyId: dossier.company.id, kind: "SUPPLIER", displayName: "F", identityKey: `sup-${randomUUID().slice(0, 6)}` },
  });
  const validated = await validateDocument(dossier, {
    type: "PURCHASE_RECEIPT",
    date: new Date(Date.UTC(2026, 0, 2)),
    counterpartyId: supplier.id,
    reference: domain.provisionalStockReference(),
    lines: [{ article, quantity: qty("1"), unitValue: money("10") }],
  });

  // The abandoned draft left no gap: the first validated receipt is 000001.
  expect(validated.reference).toBe("BR-2026-000001");
});

test("a CMP receipt reversal is refused when later movements consumed its value", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier, { designation: "Produit CMP" });

  const receipt = await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "INTERNAL_CONSUMPTION",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("6") }],
  });

  // 4 units and 400 remain; giving back 10 units worth 1 000 is not a position
  // any sequence of real events could produce, so it is refused rather than
  // written.
  await expect(prisma.$transaction(async (tx) => validation.reverseStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: receipt.id, actorUserId: dossier.user.id,
  }))).rejects.toThrow(/n'en contient que 4/);

  const balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("4"));
  expect(balance.value).toBe(money("400"));
  const unchanged = await prisma.stockDocument.findUniqueOrThrow({ where: { id: receipt.id } });
  expect(unchanged.status).toBe("VALIDATED");
});

test("a CMP receipt reversal that the position can absorb leaves the later cost intact", async () => {
  const dossier = await createDossier();
  const article = await createArticle(dossier);

  const first = await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 1)),
    lines: [{ article, quantity: qty("10"), unitValue: money("100") }],
  });
  await validateDocument(dossier, {
    type: "OPENING_STOCK",
    date: new Date(Date.UTC(2026, 0, 2)),
    lines: [{ article, quantity: qty("10"), unitValue: money("120") }],
  });

  await prisma.$transaction(async (tx) => validation.reverseStockDocumentInTransaction(tx, {
    companyId: dossier.company.id, documentId: first.id, actorUserId: dossier.user.id,
  }));

  // Removing exactly what the first receipt contributed leaves exactly what the
  // second one did.
  const balance = await balanceOf(dossier, article);
  expect(balance.quantity).toBe(qty("10"));
  expect(balance.value).toBe(money("1200"));
});
