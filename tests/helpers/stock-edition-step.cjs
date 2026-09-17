/**
 * One step of the cross-build stock scenario, run as its own process.
 *
 * The point of running it this way is the environment: each invocation starts a
 * fresh Node process with `WHEAT_EDITION` set to one build or the other, loads
 * the stock module under that identity, and works on the database file it is
 * given. The spec alternates the two against a single file, so "the same dossier
 * opens in either build, unchanged" is tested rather than assumed.
 *
 * Usage: node stock-edition-step.cjs <databasePath> <step>
 * Prints one JSON object on stdout.
 */

const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const [databasePath, step] = process.argv.slice(2);
const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..", "..");
const url = `file:${databasePath.replace(/\\/g, "/")}`;
process.env.DATABASE_URL = url;

const prisma = new PrismaClient({ datasources: { db: { url } } });
const stock = tsxRequire(path.join(root, "electron", "stock.ts"), __filename);
const edition = tsxRequire(path.join(root, "src", "wheatEdition.ts"), __filename);

async function main() {
  const company = await prisma.company.findFirstOrThrow();
  const user = await prisma.user.findFirstOrThrow();
  const warehouse = await prisma.stockWarehouse.findFirstOrThrow({ where: { companyId: company.id } });
  const service = stock.createStockService({
    getPrisma: async () => prisma,
    getActorUserId: async () => user.id,
  });

  const validate = async (payload) => {
    const document = await service.saveDocument({
      companyId: company.id, warehouseId: warehouse.id, ...payload,
    });
    return service.validateDocument({ companyId: company.id, documentId: document.id });
  };

  const article = await prisma.stockArticle.findFirstOrThrow({ where: { companyId: company.id } });

  if (step === "opening") {
    await validate({
      type: "OPENING_STOCK", documentDate: "2026-01-01",
      lines: [{ articleId: article.id, quantity: "10", unitValue: "100" }],
    });
  } else if (step === "receipt") {
    await validate({
      type: "PRODUCTION_RECEIPT", documentDate: "2026-01-05",
      lines: [{ articleId: article.id, quantity: "10", unitValue: "120" }],
    });
  } else if (step === "issue") {
    await validate({
      type: "INTERNAL_CONSUMPTION", documentDate: "2026-01-10",
      lines: [{ articleId: article.id, quantity: "5" }],
    });
  } else if (step === "inventory") {
    // A physical inventory, end to end, in whichever build is running: the
    // campaign, the frozen theoretical position, the count and the adjustment.
    const campaign = await service.createCampaign({
      companyId: company.id, countDate: "2026-02-01", warehouseId: warehouse.id,
    });
    await service.freezeCampaign({ companyId: company.id, campaignId: campaign.id });
    await service.saveCampaignCounts({
      companyId: company.id,
      campaignId: campaign.id,
      entries: [{ articleId: article.id, warehouseId: warehouse.id, countedQuantity: "14" }],
    });
    await service.validateCampaign({ companyId: company.id, campaignId: campaign.id });
  } else if (step === "impairment") {
    await service.saveImpairment({
      companyId: company.id,
      articleId: article.id,
      impairmentDate: "2026-03-01",
      recoverableValue: "1000",
      reason: "Rotation lente",
    });
  } else if (step !== "read") {
    throw new Error(`unknown step ${step}`);
  }

  // What the other build must see, byte for byte.
  const card = await service.getStockCard({ companyId: company.id, articleId: article.id });
  const state = await service.getStockState({ companyId: company.id });
  const documents = await service.listDocuments({ companyId: company.id });
  const campaigns = await service.listCampaigns({ companyId: company.id });
  const impairments = await service.listImpairments({ companyId: company.id });
  const valuation = await service.getValuationReport({
    companyId: company.id, asOf: "2026-12-31", groupBy: "ARTICLE",
  });

  process.stdout.write(JSON.stringify({
    edition: edition.resolveWheatEdition(),
    quantity: card.header.currentQuantity.display,
    value: card.header.currentValue.display,
    unitCost: card.header.unitCost ? card.header.unitCost.display : null,
    rows: card.rows.map((row) => ({
      designation: row.designation,
      column: row.column,
      quantity: row.quantity.display,
      value: row.value.display,
      runningQuantity: row.runningQuantity.display,
      runningValue: row.runningValue.display,
    })),
    totalValue: state.totals.value.display,
    references: documents.map((document) => document.reference).sort(),
    entries: documents.filter((document) => document.accountingEntry).map((document) => ({
      reference: document.reference,
      status: document.accountingEntry.status,
    })),
    campaigns: campaigns.map((campaign) => ({
      reference: campaign.reference,
      status: campaign.status,
      documents: campaign.documents.map((document) => document.reference).sort(),
    })),
    impairments: impairments.map((impairment) => ({
      reference: impairment.reference,
      status: impairment.status,
      quantity: impairment.quantity.display,
      valueBefore: impairment.valueBefore.display,
      amount: impairment.amount.display,
    })),
    valuation: {
      quantity: valuation.totals.quantity.display,
      value: valuation.totals.value.display,
      impairment: valuation.totals.impairment.display,
      netValue: valuation.totals.netValue.display,
    },
  }));
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (error) => {
    await prisma.$disconnect();
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
