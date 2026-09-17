const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The stock module's renderer surface.
 *
 * What the interface chooses to show is a convenience. The rule that matters is
 * enforced here, in the main process: every channel checks the caller's role and
 * their membership of the dossier before it reads or writes anything, so a
 * renderer that invokes a channel directly — with another dossier's id, or
 * without the role the action needs — gets an error instead of data.
 */

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let prisma;
let temporaryRoot;
let stock;
let registry;

function sqliteFileUrl(filePath) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

test.beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-stock-ipc-"));
  const databasePath = path.join(temporaryRoot, "stock.db");
  const dir = path.join(cwd, "prisma", "migrations");
  const database = new DatabaseSync(databasePath);
  try {
    for (const name of fs.readdirSync(dir).filter((entry) => fs.existsSync(path.join(dir, entry, "migration.sql"))).sort()) {
      database.exec(fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }
  process.env.DATABASE_URL = sqliteFileUrl(databasePath);
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(databasePath) } } });
  stock = tsxRequire(path.join(cwd, "electron", "stock.ts"), __filename);
  registry = tsxRequire(path.join(cwd, "electron", "wheatWorkflowRegistry.ts"), __filename);
});

test.afterAll(async () => {
  await prisma?.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function createDossierWith(role) {
  const suffix = randomUUID().slice(0, 8);
  const company = await prisma.company.create({
    data: { name: `Stock ${suffix}`, legalForm: "SARL", ice: `ICE${suffix}`, taxId: `IF${suffix}`, city: "Rabat" },
  });
  const user = await prisma.user.create({
    data: { name: `User ${suffix}`, email: `ipc-${suffix}@example.test`, role },
  });
  await prisma.companyUser.create({ data: { companyId: company.id, userId: user.id, role } });
  const unit = await prisma.stockUnit.create({ data: { companyId: company.id, code: "UN", label: "Unité" } });
  return { company, user, unit };
}

function serviceFor(userId) {
  return stock.createStockService({
    getPrisma: async () => prisma,
    getActorUserId: async () => userId,
  });
}

test("registration exposes the complete stock surface, and the registry classifies all of it", () => {
  const channels = [];
  const ipcMain = { handle: (channel) => channels.push(channel) };
  stock.registerStockIpc({ ipcMain, getPrisma: async () => prisma, getActorUserId: async () => null });

  expect(channels).toEqual([
    "wheat:stock:workspace",
    "wheat:stock:state",
    "wheat:stock:card",
    "wheat:stock:movement",
    "wheat:stock:documents",
    "wheat:stock:document",
    "wheat:stock:document:save",
    "wheat:stock:document:delete",
    "wheat:stock:document:preview-validation",
    "wheat:stock:document:validate",
    "wheat:stock:document:reverse",
    "wheat:stock:article:save",
    "wheat:stock:family:save",
    "wheat:stock:unit:save",
    "wheat:stock:unit-conversion:save",
    "wheat:stock:unit-conversion:delete",
    "wheat:stock:warehouse:save",
    "wheat:stock:lot:save",
    "wheat:stock:lots",
    "wheat:stock:settings:save",
    "wheat:stock:mapping:save",
    "wheat:stock:mapping:delete",
    "wheat:stock:inventory:list",
    "wheat:stock:inventory:get",
    "wheat:stock:inventory:create",
    "wheat:stock:inventory:freeze",
    "wheat:stock:inventory:count",
    "wheat:stock:inventory:status",
    "wheat:stock:inventory:validate",
    "wheat:stock:impairment:list",
    "wheat:stock:impairment:preview",
    "wheat:stock:impairment:save",
    "wheat:stock:impairment:reverse",
    "wheat:stock:import:preview",
    "wheat:stock:import:confirm",
    "wheat:stock:report:valuation",
    "wheat:stock:report:movements",
    "wheat:stock:report:variance",
    "wheat:stock:report:anomalies",
    "wheat:stock:report:ageing",
  ]);

  // Every one carries a decision and a reason, and the two that move stock are
  // the two that carry the highest risk level.
  const classified = new Map(registry.WHEAT_WORKFLOW_REGISTRY.map((workflow) => [workflow.channel, workflow]));
  for (const channel of channels) {
    const workflow = classified.get(channel);
    expect(workflow, `${channel} is unclassified`).toBeTruthy();
    expect(workflow.reason.length).toBeGreaterThan(20);
  }
  expect(classified.get("wheat:stock:document:validate").riskLevel).toBe(3);
  expect(classified.get("wheat:stock:document:reverse").riskLevel).toBe(3);
  expect(classified.get("wheat:stock:card").mutating).toBe(false);
});

test("a viewer may read the stock and may not change the catalogue", async () => {
  const dossier = await createDossierWith("VIEWER");
  const service = serviceFor(dossier.user.id);

  const workspace = await service.getWorkspace({ companyId: dossier.company.id });
  expect(workspace.role).toBe("VIEWER");
  expect(workspace.articles).toEqual([]);

  await expect(service.saveArticle({
    companyId: dossier.company.id, sku: "ART-1", designation: "Test", unitId: dossier.unit.id,
  })).rejects.toThrow(/Le rôle VIEWER ne permet pas/);

  await expect(service.saveSettings({ companyId: dossier.company.id })).rejects.toThrow(/Le rôle VIEWER ne permet pas/);
});

test("configuring the stock accounts is reserved to an administrator", async () => {
  const dossier = await createDossierWith("ACCOUNTANT");
  const service = serviceFor(dossier.user.id);

  // An accountant runs the stock day to day...
  const article = await service.saveArticle({
    companyId: dossier.company.id, sku: "ART-1", designation: "Test", unitId: dossier.unit.id,
  });
  expect(article.sku).toBe("ART-1");

  // ...but which account inventory posts to is a configuration decision.
  await expect(service.saveSettings({ companyId: dossier.company.id }))
    .rejects.toThrow(/Le rôle ACCOUNTANT ne permet pas/);
});

test("a caller who is not a member of the dossier reaches nothing in it", async () => {
  const mine = await createDossierWith("ADMIN");
  const theirs = await createDossierWith("ADMIN");
  const intruder = serviceFor(theirs.user.id);

  await expect(intruder.getWorkspace({ companyId: mine.company.id })).rejects.toThrow(/n'avez pas accès à ce dossier/);
  await expect(intruder.getStockState({ companyId: mine.company.id })).rejects.toThrow(/n'avez pas accès à ce dossier/);
  await expect(intruder.saveArticle({
    companyId: mine.company.id, sku: "X", designation: "X", unitId: mine.unit.id,
  })).rejects.toThrow(/n'avez pas accès à ce dossier/);

  expect(await prisma.stockArticle.count({ where: { companyId: mine.company.id } })).toBe(0);
});

test("an unidentified session reaches nothing at all", async () => {
  const dossier = await createDossierWith("ADMIN");
  const anonymous = serviceFor(null);
  await expect(anonymous.getWorkspace({ companyId: dossier.company.id }))
    .rejects.toThrow(/session utilisateur identifiée est requise/);
});

test("a duplicate reference is refused in the user's words, not Prisma's", async () => {
  const dossier = await createDossierWith("ADMIN");
  const service = serviceFor(dossier.user.id);
  await service.saveArticle({ companyId: dossier.company.id, sku: "ART-001", designation: "Premier", unitId: dossier.unit.id });

  await expect(service.saveArticle({
    companyId: dossier.company.id, sku: "ART-001", designation: "Doublon", unitId: dossier.unit.id,
  })).rejects.toThrow(/Un article avec la référence ART-001 existe déjà\./);

  await service.saveArticle({
    companyId: dossier.company.id, sku: "ART-002", designation: "Avec code-barres", unitId: dossier.unit.id, barcode: "6111000000001",
  });
  await expect(service.saveArticle({
    companyId: dossier.company.id, sku: "ART-003", designation: "Même code-barres", unitId: dossier.unit.id, barcode: "6111000000001",
  })).rejects.toThrow(/code-barres « 6111000000001 » est déjà utilisé/);
});

test("quantities and values cross to the renderer as exact decimal text", async () => {
  const dossier = await createDossierWith("ADMIN");
  const service = serviceFor(dossier.user.id);
  const article = await service.saveArticle({
    companyId: dossier.company.id, sku: "ART-EXACT", designation: "Précision", unitId: dossier.unit.id, minQuantity: "0,333333",
  });

  const workspace = await service.getWorkspace({ companyId: dossier.company.id });
  const row = workspace.articles.find((candidate) => candidate.id === article.id);
  // Never a JavaScript number: the scaled integer travels as a string and the
  // decimal beside it is exact to the last place the module stores.
  expect(row.minQuantity).toEqual({ raw: "333333", display: "0.333333" });
  expect(typeof workspace.overview.totalValue.display).toBe("string");
});

test("the valuation method cannot change once an article has moved", async () => {
  const dossier = await createDossierWith("ADMIN");
  const service = serviceFor(dossier.user.id);
  const warehouse = await prisma.stockWarehouse.create({ data: { companyId: dossier.company.id, code: "P", name: "Principal" } });
  await prisma.fiscalYear.create({
    data: {
      companyId: dossier.company.id, label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)), endsOn: new Date(Date.UTC(2026, 11, 31)), status: "OPEN",
    },
  });
  const journal = await prisma.journal.create({ data: { companyId: dossier.company.id, code: "STK", label: "Stocks" } });
  const stockAccount = await prisma.account.create({ data: { companyId: dossier.company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" } });
  const variation = await prisma.account.create({ data: { companyId: dossier.company.id, code: "6114", label: "Variation", classNo: 6, type: "EXPENSE" } });
  await service.saveSettings({ companyId: dossier.company.id, stockJournalId: journal.id });
  await service.saveAccountMapping({
    companyId: dossier.company.id, scope: "COMPANY", stockAccountId: stockAccount.id, variationAccountId: variation.id,
  });

  const article = await service.saveArticle({
    companyId: dossier.company.id, sku: "ART-M", designation: "Méthode", unitId: dossier.unit.id, valuationMethod: "CMP",
  });
  const document = await service.saveDocument({
    companyId: dossier.company.id,
    type: "OPENING_STOCK",
    documentDate: "2026-01-01",
    warehouseId: warehouse.id,
    lines: [{ articleId: article.id, quantity: "10", unitValue: "100" }],
  });
  await service.validateDocument({ companyId: dossier.company.id, documentId: document.id });

  await expect(service.saveArticle({
    companyId: dossier.company.id, id: article.id, sku: "ART-M", designation: "Méthode",
    unitId: dossier.unit.id, valuationMethod: "FIFO",
  })).rejects.toThrow(/méthode de valorisation ne peut plus changer/);
});

test("a validated document is no longer editable or deletable through the service", async () => {
  const dossier = await createDossierWith("ADMIN");
  const service = serviceFor(dossier.user.id);
  const warehouse = await prisma.stockWarehouse.create({ data: { companyId: dossier.company.id, code: "P", name: "Principal" } });
  await prisma.fiscalYear.create({
    data: {
      companyId: dossier.company.id, label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)), endsOn: new Date(Date.UTC(2026, 11, 31)), status: "OPEN",
    },
  });
  const journal = await prisma.journal.create({ data: { companyId: dossier.company.id, code: "STK", label: "Stocks" } });
  const stockAccount = await prisma.account.create({ data: { companyId: dossier.company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" } });
  const variation = await prisma.account.create({ data: { companyId: dossier.company.id, code: "6114", label: "Variation", classNo: 6, type: "EXPENSE" } });
  await service.saveSettings({ companyId: dossier.company.id, stockJournalId: journal.id });
  await service.saveAccountMapping({
    companyId: dossier.company.id, scope: "COMPANY", stockAccountId: stockAccount.id, variationAccountId: variation.id,
  });
  const article = await service.saveArticle({ companyId: dossier.company.id, sku: "ART-V", designation: "Validé", unitId: dossier.unit.id });

  const document = await service.saveDocument({
    companyId: dossier.company.id, type: "OPENING_STOCK", documentDate: "2026-01-01",
    warehouseId: warehouse.id, lines: [{ articleId: article.id, quantity: "5", unitValue: "20" }],
  });

  // The preview states the consequences before anything happens.
  const preview = await service.previewValidation({ companyId: dossier.company.id, documentId: document.id });
  expect(preview.lines[0].quantity.display).toBe("5.000000");
  expect(preview.warning).toMatch(/mouvements immuables/);

  const validated = await service.validateDocument({ companyId: dossier.company.id, documentId: document.id });
  expect(validated.reference).toMatch(/^SI-2026-\d{6}$/);
  expect(validated.accountingEntryId).toBeTruthy();

  await expect(service.saveDocument({
    companyId: dossier.company.id, documentId: document.id, type: "OPENING_STOCK", documentDate: "2026-01-01",
    warehouseId: warehouse.id, lines: [{ articleId: article.id, quantity: "9", unitValue: "20" }],
  })).rejects.toThrow(/document validé ne peut plus être modifié/);

  await expect(service.deleteDocument({ companyId: dossier.company.id, documentId: document.id }))
    .rejects.toThrow(/Seul un brouillon peut être supprimé/);

  // And the card reads back what was validated, in the columns it belongs in.
  const card = await service.getStockCard({ companyId: dossier.company.id, articleId: article.id });
  expect(card.rows).toHaveLength(1);
  expect(card.rows[0].column).toBe("OPENING");
  expect(card.rows[0].runningQuantity.display).toBe("5.000000");
  expect(card.rows[0].runningValue.display).toBe("100.000000");
  expect(card.header.currentValue.display).toBe("100.000000");
});

test("each half of a transfer names the other dépôt on the card", async () => {
  const dossier = await createDossierWith("ADMIN");
  const service = serviceFor(dossier.user.id);
  const source = await prisma.stockWarehouse.create({ data: { companyId: dossier.company.id, code: "A", name: "Dépôt Casablanca" } });
  const target = await prisma.stockWarehouse.create({ data: { companyId: dossier.company.id, code: "B", name: "Magasin Settat" } });
  await prisma.fiscalYear.create({
    data: {
      companyId: dossier.company.id, label: "2026",
      startsOn: new Date(Date.UTC(2026, 0, 1)), endsOn: new Date(Date.UTC(2026, 11, 31)), status: "OPEN",
    },
  });
  const journal = await prisma.journal.create({ data: { companyId: dossier.company.id, code: "STK", label: "Stocks" } });
  const stockAccount = await prisma.account.create({ data: { companyId: dossier.company.id, code: "3111", label: "Marchandises", classNo: 3, type: "ASSET" } });
  const variation = await prisma.account.create({ data: { companyId: dossier.company.id, code: "6114", label: "Variation", classNo: 6, type: "EXPENSE" } });
  await service.saveSettings({ companyId: dossier.company.id, stockJournalId: journal.id });
  await service.saveAccountMapping({
    companyId: dossier.company.id, scope: "COMPANY", stockAccountId: stockAccount.id, variationAccountId: variation.id,
  });
  const article = await service.saveArticle({ companyId: dossier.company.id, sku: "ART-T", designation: "Transféré", unitId: dossier.unit.id });

  const opening = await service.saveDocument({
    companyId: dossier.company.id, type: "OPENING_STOCK", documentDate: "2026-01-01",
    warehouseId: source.id, lines: [{ articleId: article.id, quantity: "10", unitValue: "100" }],
  });
  await service.validateDocument({ companyId: dossier.company.id, documentId: opening.id });

  const transfer = await service.saveDocument({
    companyId: dossier.company.id, type: "TRANSFER", documentDate: "2026-01-02",
    warehouseId: source.id, targetWarehouseId: target.id,
    lines: [{ articleId: article.id, quantity: "4" }],
  });
  await service.validateDocument({ companyId: dossier.company.id, documentId: transfer.id });

  const card = await service.getStockCard({ companyId: dossier.company.id, articleId: article.id });
  const designations = card.rows.map((row) => row.designation);
  expect(designations).toContain("Transfert vers Magasin Settat");
  expect(designations).toContain("Transfert depuis Dépôt Casablanca");

  // Across both dépôts the company still holds the same goods at the same cost.
  expect(card.header.currentQuantity.display).toBe("10.000000");
  expect(card.header.currentValue.display).toBe("1000.000000");
  // A transfer between dépôts sharing a stock account posts nothing.
  const document = await service.getDocument({ companyId: dossier.company.id, documentId: transfer.id });
  expect(document.accountingEntryId).toBeNull();
});
