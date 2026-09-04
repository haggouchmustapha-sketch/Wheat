const { test, expect } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migrationName = "20260827000000_fiscal_workpapers_ai_context";
const migrationPath = path.join(root, "prisma", "migrations", migrationName, "migration.sql");
const expectedDigest = "a0875302bf013216860aedb873393f55ea57fe22560a13f3e66744dcd0df3de2";
const catalog = tsxRequire(path.join(root, "electron", "fiscalCatalog.ts"), __filename);
const fiscal = tsxRequire(path.join(root, "electron", "fiscal21.ts"), __filename);
const product = tsxRequire(path.join(root, "electron", "wheatProductKnowledge.ts"), __filename);
const localAi = tsxRequire(path.join(root, "electron", "wheatAi.ts"), __filename);

function sqliteUrl(databasePath) { return `file:${databasePath.replace(/\\/g, "/")}`; }
function day(value) { return new Date(`${value}T00:00:00.000Z`); }
function scalar(database, sql) { return Object.values(database.prepare(sql).get())[0]; }
function migrationFolders(filter = () => true) {
  return fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
    .filter((item) => item.isDirectory() && filter(item.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}
function applyMigrations(database, folders) {
  database.exec("PRAGMA foreign_keys=OFF");
  for (const folder of folders) database.exec(fs.readFileSync(path.join(root, "prisma", "migrations", folder.name, "migration.sql"), "utf8"));
  database.exec("PRAGMA foreign_keys=ON");
}
function createLatestDatabase(prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(temporaryRoot, "atlas.sqlite");
  const database = new DatabaseSync(databasePath);
  applyMigrations(database, migrationFolders());
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  database.close();
  return { temporaryRoot, databasePath };
}

test("normal fiscal catalog is a single versioned authority with 25 workpapers and 27 numbered views", () => {
  const labels = [
    "Bilan", "CPC", "Passage du résultat net comptable au résultat net fiscal", "Tableau des immobilisations non financières",
    "État des soldes de gestion (E.S.G.)", "Détail des rubriques du CPC", "Tableau des immobilisations en crédit-bail",
    "Tableau des amortissements", "Tableau des provisions", "Plus ou moins-values sur cessions ou retraits d'immobilisations",
    "Tableau des titres de participation", "Détail de la TVA", "État de répartition du capital social", "État d'affectation des résultats",
    "Détermination de l'IS pour les entreprises bénéficiant de mesures d'incitation à l'investissement",
    "Dotations aux amortissements relatives aux immobilisations", "Plus-values constatées en cas de fusion d'entreprises",
    "État des intérêts sur emprunts auprès des associés et des tiers", "Tableau des locations et loyers (hors crédit-bail)",
    "État détaillé des stocks", "Opérations en devises enregistrées au cours de l'exercice", "État des changements de méthodes",
    "État des dérogations", "Tableau de financement de l'exercice", "Principales méthodes d'évaluation spécifiques à l'entreprise",
  ];
  expect(catalog.FISCAL_TABLE_CATALOG).toHaveLength(25);
  expect(catalog.FISCAL_TABLE_CATALOG.map((item) => item.id)).toEqual(Array.from({ length: 25 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`));
  expect(catalog.FISCAL_TABLE_CATALOG.map((item) => item.label)).toEqual(labels);
  expect(catalog.FISCAL_TABLE_VIEWS).toHaveLength(27);
  expect(catalog.FISCAL_TABLE_CATALOG[0].views.map((view) => view.label)).toEqual(["1 - Bilan Actif", "1 - Bilan Passif"]);
  expect(catalog.FISCAL_TABLE_CATALOG[1].views.map((view) => view.label)).toEqual(["2 - CPC", "2 - CPC (Suite)"]);
  expect(catalog.fiscalCatalogForRenderer()).toMatchObject({ regime: "NORMAL", version: catalog.FISCAL_CATALOG_VERSION });
  expect(catalog.FISCAL_TABLE_CATALOG.filter((item) => item.mode === "AUTOMATIC").map((item) => item.number)).toEqual([1, 2, 3, 5, 6, 12]);
  expect(catalog.FISCAL_TABLE_CATALOG.filter((item) => item.mode === "HYBRID").map((item) => item.number)).toEqual([4, 8, 9, 10, 11, 14, 16, 18, 19, 20, 24]);
  expect(fiscal.CPC_MAPPING_VERSION).toBe("PCGE-CPC-ESG-1");
  const profile = product.wheatProductKnowledge("9.8.7-test");
  expect(product.WHEAT_PRODUCT_KNOWLEDGE_VERSION).toBe("WHEAT-PRODUCT-KNOWLEDGE-4");
  expect(profile).toContain("Wheat 9.8.7-test");
  for (const label of labels) expect(profile).toContain(label);
  expect(profile).toMatch(/confirmation explicite/i);
  expect(profile).toMatch(/export statutaire reste indisponible/i);
});

test("fiscal workpaper migration is checksummed, additive and preserves legacy packages", () => {
  expect(crypto.createHash("sha256").update(fs.readFileSync(migrationPath)).digest("hex")).toBe(expectedDigest);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fiscal-migration-"));
  const database = new DatabaseSync(path.join(temporaryRoot, "legacy.sqlite"));
  try {
    applyMigrations(database, migrationFolders((name) => name < migrationName));
    const now = "2026-08-27T12:00:00.000Z";
    database.exec(`
      INSERT INTO "Company" ("id","name","legalForm","ice","taxId","city","updatedAt") VALUES ('c','Atlas Legacy','SARL','001','IF1','Casa','${now}');
      INSERT INTO "FiscalYear" ("id","companyId","label","startsOn","endsOn") VALUES ('fy','c','2026','2026-01-01','2026-12-31');
      INSERT INTO "FiscalPackage" ("id","companyId","fiscalYearId","regime","templateVersion","schemaVersion","accountingProfitCents","taxableProfitCents") VALUES ('fp','c','fy','NORMAL','FOUNDATION-2.1.0','ATLAS_FISCAL_1',12345,12345);
      INSERT INTO "FiscalAdjustment" ("id","fiscalPackageId","kind","label","amountCents","legalReference") VALUES ('fa','fp','REINTEGRATION','Legacy adjustment',300,'REF');
    `);
    const before = database.prepare('SELECT "accountingProfitCents","taxableProfitCents" FROM "FiscalPackage" WHERE "id" = \'fp\'').get();
    database.exec(fs.readFileSync(migrationPath, "utf8"));
    expect(database.prepare('SELECT "accountingProfitCents","taxableProfitCents" FROM "FiscalPackage" WHERE "id" = \'fp\'').get()).toEqual(before);
    expect(scalar(database, 'SELECT count(*) FROM "FiscalAdjustment" WHERE "fiscalPackageId" = \'fp\'')).toBe(1);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare('PRAGMA table_info("FiscalTableWorkpaper")').all().map((row) => row.name)).toEqual(expect.arrayContaining(["fiscalPackageId", "tableId", "computedJson", "manualJson", "sourceHash", "status", "revision"]));
    const databaseSource = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
    expect(databaseSource).toContain(`name: "${migrationName}"`);
    expect(databaseSource).toContain(`checksum: "${expectedDigest}"`);
  } finally {
    database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test.describe.serial("fiscal workpaper workflow", () => {
  let temporaryRoot;
  let prisma;
  let company;
  let otherCompany;
  let currentYear;
  let normalPackage;

  test.beforeAll(async () => {
    const latest = createLatestDatabase("atlas-fiscal-workflow-");
    temporaryRoot = latest.temporaryRoot;
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(latest.databasePath) });
    company = await prisma.company.create({ data: { name: "Atlas Workpapers", legalForm: "SARL", ice: "001", taxId: "IF-1", city: "Casablanca" } });
    otherCompany = await prisma.company.create({ data: { name: "Other", legalForm: "SARL", ice: "002", taxId: "IF-2", city: "Rabat" } });
    const priorYear = await prisma.fiscalYear.create({ data: { companyId: company.id, label: "2025", startsOn: day("2025-01-01"), endsOn: day("2025-12-31"), status: "CLOSED" } });
    currentYear = await prisma.fiscalYear.create({ data: { companyId: company.id, label: "2026", startsOn: day("2026-01-01"), endsOn: day("2026-12-31"), status: "OPEN" } });
    const journal = await prisma.journal.create({ data: { companyId: company.id, code: "OD", label: "Opérations diverses" } });
    const accounts = {};
    for (const input of [
      { code: "234", label: "Actif", classNo: 2, type: "ASSET", reportNature: "BALANCE_SHEET" },
      { code: "441", label: "Passif", classNo: 4, type: "LIABILITY", reportNature: "BALANCE_SHEET" },
      { code: "611", label: "Charges", classNo: 6, type: "EXPENSE", reportNature: "PROFIT_AND_LOSS" },
      { code: "711", label: "Produits", classNo: 7, type: "REVENUE", reportNature: "PROFIT_AND_LOSS" },
    ]) accounts[input.code] = await prisma.account.create({ data: { companyId: company.id, ...input } });
    async function post(year, suffix, revenue, expense) {
      return prisma.entry.create({ data: {
        companyId: company.id, journalId: journal.id, number: `OD-${suffix}`, date: day(`${year.label}-06-30`), pieceNumber: `P-${suffix}`,
        label: `Exercice ${year.label}`, status: "POSTED", journalCodeSnapshot: "OD", postedAt: day(`${year.label}-06-30`), lines: { create: [
          { accountId: accounts["234"].id, label: "Actif", debitCents: BigInt(revenue), position: 1, accountCodeSnapshot: "234", accountLabelSnapshot: "Actif" },
          { accountId: accounts["611"].id, label: "Charge", debitCents: BigInt(expense), position: 2, accountCodeSnapshot: "611", accountLabelSnapshot: "Charges" },
          { accountId: accounts["711"].id, label: "Produit", creditCents: BigInt(revenue), position: 3, accountCodeSnapshot: "711", accountLabelSnapshot: "Produits" },
          { accountId: accounts["441"].id, label: "Passif", creditCents: BigInt(expense), position: 4, accountCodeSnapshot: "441", accountLabelSnapshot: "Passif" },
        ] },
      } });
    }
    await post(priorYear, "2025", 8000, 3000);
    await post(currentYear, "2026", 10001, 4001);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("generation computes exact N/N-1 values and keeps the simplified regime separate", async () => {
    normalPackage = await fiscal.generateFiscalPackage(prisma, { companyId: company.id, fiscalYearId: currentYear.id, regime: "NORMAL" });
    expect(normalPackage.tables).toHaveLength(25);
    const cpc = await fiscal.getFiscalTable(prisma, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T02" });
    const rows = cpc.computed.sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.code === "611")).toMatchObject({ amountCents: "4001", priorAmountCents: "3000" });
    expect(rows.find((row) => row.code === "711")).toMatchObject({ amountCents: "10001", priorAmountCents: "8000" });
    expect(rows.find((row) => row.code === "611").entryLineIds).toHaveLength(1);
    expect(cpc.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const simplified = await fiscal.generateFiscalPackage(prisma, { companyId: company.id, fiscalYearId: currentYear.id, regime: "SIMPLIFIED" });
    expect(simplified.tables).toEqual([]);
    await expect(fiscal.listFiscalTables(prisma, { companyId: company.id, fiscalPackageId: simplified.id })).resolves.toMatchObject({ regime: "SIMPLIFIED", catalogAvailable: false, tables: [] });
  });

  test("save, optimistic conflicts, evidence scoping, review locks, stale detection, reopen and N/A are audited", async () => {
    let table = await fiscal.getFiscalTable(prisma, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25" });
    expect(JSON.parse((await prisma.fiscalTableWorkpaper.findUniqueOrThrow({ where: { id: table.id } })).validationJson).map((issue) => issue.code)).toContain("MISSING_MANUAL_ROWS");
    table = await fiscal.saveFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true, manualRows: [{ rowId: "policy-1", section: "Stocks", method: "Coût documenté", sourceRef: "PV inventaire", note: "Revue annuelle" }] });
    expect(JSON.parse((await prisma.fiscalTableWorkpaper.findUniqueOrThrow({ where: { id: table.id } })).validationJson).map((issue) => issue.code)).toContain("READY_FOR_REVIEW");
    await expect(fiscal.saveFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision - 1, confirmed: true, manualRows: [] })).rejects.toThrow(/modifié ailleurs/i);

    const ownDocument = await prisma.document.create({ data: { companyId: company.id, title: "PV inventaire", type: "PDF", fiscalYear: "2026", tags: "fiscal", contentSha256: "a".repeat(64), ocrText: "", extracted: "{}" } });
    const foreignDocument = await prisma.document.create({ data: { companyId: otherCompany.id, title: "Foreign", type: "PDF", fiscalYear: "2026", tags: "", contentSha256: "b".repeat(64), ocrText: "", extracted: "{}" } });
    await expect(fiscal.attachFiscalTableEvidence({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, documentId: foreignDocument.id, confirmed: true })).rejects.toThrow(/appartenir au dossier/i);
    table = await fiscal.attachFiscalTableEvidence({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, documentId: ownDocument.id, confirmed: true });
    expect(table.evidence[0]).toMatchObject({ documentTitleSnapshot: "PV inventaire", contentSha256Snapshot: "a".repeat(64) });
    table = await fiscal.reviewFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true });
    expect(table.status).toBe("REVIEWED");
    await expect(fiscal.saveFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true, manualRows: [] })).rejects.toThrow(/brouillon/i);

    const journal = await prisma.journal.findFirstOrThrow({ where: { companyId: company.id, code: "OD" } });
    const expense = await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: "611" } });
    const liability = await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: "441" } });
    await prisma.entry.create({ data: { companyId: company.id, journalId: journal.id, number: "OD-STALE", date: day("2026-08-27"), pieceNumber: "P-STALE", label: "Source changed", status: "POSTED", postedAt: day("2026-08-27"), journalCodeSnapshot: "OD", lines: { create: [
      { accountId: expense.id, label: "Charge", debitCents: 100n, position: 1, accountCodeSnapshot: "611", accountLabelSnapshot: "Charges" },
      { accountId: liability.id, label: "Passif", creditCents: 100n, position: 2, accountCodeSnapshot: "441", accountLabelSnapshot: "Passif" },
    ] } } });
    table = await fiscal.getFiscalTable(prisma, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25" });
    expect(table.stale).toBe(true);
    await expect(fiscal.refreshFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true })).rejects.toThrow(/Rouvrez/i);
    table = await fiscal.reopenFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true, reason: "Nouvelle écriture comptable" });
    table = await fiscal.refreshFiscalTable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true });
    expect(table).toMatchObject({ status: "DRAFT", stale: false });
    table = await fiscal.markFiscalTableNotApplicable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true, reason: "Aucune méthode spécifique applicable" });
    expect(table).toMatchObject({ status: "NOT_APPLICABLE", notApplicableReason: "Aucune méthode spécifique applicable" });
    table = await fiscal.clearFiscalTableNotApplicable({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, tableId: "T25", expectedRevision: table.revision, confirmed: true, reason: "Méthode désormais applicable" });
    expect(table).toMatchObject({ status: "DRAFT", notApplicableReason: null });
    expect(await prisma.activityLog.count({ where: { companyId: company.id, entity: "FiscalTableWorkpaper" } })).toBeGreaterThanOrEqual(7);
  });

  test("control and validation expose preparation completeness without enabling statutory export", async () => {
    const adjustment = await fiscal.addFiscalAdjustment({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, kind: "REINTEGRATION", label: "Charge documentée", amountCents: "1250", legalReference: "Référence à valider", confirmed: true });
    await expect(fiscal.verifyFiscalAdjustment({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, adjustmentId: adjustment.id })).rejects.toThrow(/confirmation explicite/i);
    const verified = await fiscal.verifyFiscalAdjustment({ prisma }, { companyId: company.id, fiscalPackageId: normalPackage.id, adjustmentId: adjustment.id, confirmed: true });
    expect(verified.verified).toBe(true);
    const control = await fiscal.buildFiscalControl(prisma, { companyId: company.id, fiscalPackageId: normalPackage.id });
    expect(control).toMatchObject({ total: 25, preparationComplete: false, statutoryExportAvailable: false });
    expect(control.checks.map((check) => check.code)).toEqual(expect.arrayContaining(["BALANCE_EQUAL", "RESULT_RECONCILIATION", "TAXABLE_BRIDGE", "VAT_REVIEWED", "SOURCES_CURRENT", "EVIDENCE_COMPLETE"]));
    const validation = await fiscal.validateFiscalPackage(prisma, { companyId: company.id, id: normalPackage.id });
    expect(validation).toMatchObject({ preparationComplete: false, canFinalize: false, statutoryExportAvailable: false });
    expect(validation.tableSummaries).toHaveLength(25);
  });
});

test("Electron surfaces every fiscal workpaper API and Wheat AI confirmation endpoint", () => {
  const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  const fiscalSource = fs.readFileSync(path.join(root, "electron", "fiscal21.ts"), "utf8");
  const aiSource = fs.readFileSync(path.join(root, "electron", "wheatAi.ts"), "utf8");
  for (const channel of ["catalog", "list", "get", "refresh", "save", "review", "reopen", "not-applicable", "evidence:attach", "evidence:remove", "control"]) expect(fiscalSource).toContain(`fiscal-table:${channel}`);
  for (const method of ["getFiscalTableCatalog", "listFiscalTables", "getFiscalTable", "refreshFiscalTable", "saveFiscalTable", "reviewFiscalTable", "reopenFiscalTable", "markFiscalTableNotApplicable", "clearFiscalTableNotApplicable", "attachFiscalTableEvidence", "removeFiscalTableEvidence", "getFiscalControl", "verifyFiscalAdjustment"]) expect(preload).toContain(method);
  expect(aiSource).toContain('confirmAction: "wheat:ai:confirm-action"');
  expect(aiSource).toContain('cancelAction: "wheat:ai:cancel-action"');
  // The confirmation gate moved into `capabilityRequiresConfirmation` when the
  // capability registry replaced the flat risk strings; the invariant it pins is
  // the same one, so the assertion follows the code rather than the old wording.
  expect(aiSource).toContain("function capabilityRequiresConfirmation");
  expect(aiSource).toContain('if (definition.confirmation === "ALWAYS" || definition.riskLevel === 3) return true;');
  expect(aiSource).toContain("capabilityRequiresConfirmation(definition, permissionMode)");
  expect(aiSource).toContain('name: "mark_fiscal_table_not_applicable"');
  expect(aiSource).toContain('name: "add_fiscal_adjustment"');
  expect(preload).toContain("confirmWheatAiAction");
  expect(preload).toContain("cancelWheatAiAction");
});

test("Wheat AI has a dedicated top-level workspace and no longer appears inside the accounting tabs", () => {
  const appSource = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const workspaceSource = fs.readFileSync(path.join(root, "src", "components", "FiscalWorkspace.tsx"), "utf8");
  expect(appSource).toContain('| "wheat-ai"');
  expect(appSource).toContain('{ page: "wheat-ai", label: "Wheat AI"');
  expect(appSource).toContain('page === "wheat-ai"');
  expect(workspaceSource).toContain("export function WheatAiWorkspace");
  expect(workspaceSource).not.toContain('{ id: "ai", label: "Wheat AI"');
});

test("Wheat AI preflights mutations with normalized arguments, before/after previews and optimistic versions", async () => {
  const company = { id: "company", name: "Avant SARL", legalForm: "SARL", ice: "001122334455667", taxId: "IF1", city: "Rabat", vatFrequency: "MONTHLY", version: 7 };
  const customAccount = { id: "account-custom", companyId: "company", code: "23499", label: "Ancien libellé", isStandard: false, active: true, version: 4 };
  const standardAccount = { ...customAccount, id: "account-standard", code: "234", isStandard: true };
  const fiscalPackage = { id: "package", companyId: "company", regime: "NORMAL", status: "DRAFT", templateVersion: "FOUNDATION-2.1.0" };
  const workpaper = { id: "workpaper", fiscalPackageId: "package", tableId: "T25", status: "DRAFT", revision: 3 };
  const prisma = {
    company: { findUnique: async () => company },
    account: { findFirst: async ({ where }) => where.code === "234" ? standardAccount : where.code === "23499" ? customAccount : null },
    fiscalPackage: { findFirst: async () => fiscalPackage },
    fiscalTableWorkpaper: { findFirst: async () => workpaper },
  };
  const profile = await localAi.prepareWheatAiMutation(prisma, "company", "update_company_profile", { name: "Après SARL", city: "Casablanca" });
  expect(profile.arguments).toMatchObject({ name: "Après SARL", city: "Casablanca" });
  expect(profile.preconditions).toEqual({ companyVersion: 7 });
  expect(profile.preview.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "name", before: "Avant SARL", after: "Après SARL" }),
    expect.objectContaining({ field: "city", before: "Rabat", after: "Casablanca" }),
  ]));
  const rename = await localAi.prepareWheatAiMutation(prisma, "company", "rename_custom_account", { accountCode: "23499", label: "Nouveau libellé" });
  expect(rename.preconditions).toMatchObject({ accountId: "account-custom", accountVersion: 4 });
  expect(rename.preview.changes[0]).toMatchObject({ before: "Ancien libellé", after: "Nouveau libellé" });
  await expect(localAi.prepareWheatAiMutation(prisma, "company", "rename_custom_account", { accountCode: "234", label: "Interdit" })).rejects.toThrow(/officiel PCGE/i);
  const notApplicable = await localAi.prepareWheatAiMutation(prisma, "company", "mark_fiscal_table_not_applicable", { tableId: "t25", reason: "Aucune méthode spécifique applicable" });
  expect(notApplicable.arguments).toMatchObject({ tableId: "T25", _fiscalPackageId: "package", _expectedRevision: 3 });
  expect(notApplicable.preconditions).toMatchObject({ workpaperId: "workpaper", workpaperRevision: 3 });
  expect(notApplicable.preview.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: "status", before: "Brouillon", after: "Non applicable" })]));
});

test("Wheat AI builds bounded dossier context with deterministic routing and rejects caller-supplied file context", async () => {
  let entryQuery;
  const company = {
    id: "company", name: "Atlas Context", legalForm: "SARL", ice: "001", taxId: "IF1", city: "Casa", baseCurrency: "MAD", vatFrequency: "MONTHLY", version: 3,
    fiscalYears: [{ id: "fy-open", label: "2026", startsOn: day("2026-01-01"), endsOn: day("2026-12-31"), status: "OPEN", lockedTo: null }],
    _count: { accounts: 10, entries: 2, invoices: 1, documents: 3, bankAccounts: 1, employees: 0, fiscalPackages: 0 },
  };
  const prisma = {
    company: { findUnique: async () => company },
    entry: { findMany: async (query) => { entryQuery = query; return [{ id: "entry", number: "OD-1", pieceNumber: "P-1", date: day("2026-03-01"), label: "Journal", status: "POSTED", source: "MANUAL" }]; } },
    fiscalPackage: { findFirst: async () => null },
  };
  const journal = await localAi.buildWheatAiChatContext(prisma, "company", { messages: [{ role: "user", content: "Montre les écritures du journal" }], toolContext: { databasePath: "C:\\secret\\atlas.db", sql: "SELECT *" } }, "9.8.7");
  expect(journal.toolsUsed).toEqual(["get_entries"]);
  expect(journal.contextSources).toEqual(["Guide produit Wheat 9.8.7", "Dossier Atlas Context", "get_entries"]);
  expect(entryQuery.where).toMatchObject({ companyId: "company", date: { gte: day("2026-01-01"), lte: day("2026-12-31") } });
  expect(entryQuery.take).toBe(40);
  expect(JSON.stringify(journal)).not.toContain("atlas.db");
  expect(JSON.stringify(journal)).not.toContain("SELECT *");
  const liasse = await localAi.buildWheatAiChatContext(prisma, "company", { messages: [{ role: "user", content: "Où en est la liasse fiscale ?" }] }, "9.8.7");
  expect(liasse.toolsUsed).toEqual(["get_fiscal_package"]);
  expect(liasse.routedResults.get_fiscal_package).toMatchObject({ prepared: false });
});

test("Wheat AI routes invoice, document, TVA and payroll questions to bounded metadata tools", async () => {
  const company = {
    id: "company", name: "Atlas Modules", legalForm: "SARL", ice: "001", taxId: "IF1", city: "Casa", baseCurrency: "MAD", vatFrequency: "MONTHLY", version: 1,
    fiscalYears: [{ id: "fy-open", label: "2026", startsOn: day("2026-01-01"), endsOn: day("2026-12-31"), status: "OPEN", lockedTo: null }],
    _count: { accounts: 1, journals: 1, entries: 1, invoices: 1, documents: 1, bankAccounts: 0, payments: 0, counterparties: 1, taxPeriods: 1, employees: 0, payrollRuns: 1, fiscalPackages: 0, wheatKnowledgePatterns: 0 },
  };
  const prisma = {
    company: { findUnique: async () => company },
    invoice: { findMany: async () => [{ id: "invoice", invoiceNo: "FA-1", ttcCents: 10000n }] },
    document: { findMany: async () => [{ id: "document", title: "Facture FA-1", status: "INDEXED", contentSha256: "abc" }] },
    taxPeriod: { findMany: async () => [{ id: "tax", label: "2026-01", dueVatCents: 2000n }] },
    payrollRun: { findMany: async () => [{ id: "payroll", period: "2026-01", status: "DRAFT", _count: { lines: 2 } }] },
  };
  const context = await localAi.buildWheatAiChatContext(prisma, "company", { messages: [{ role: "user", content: "Montre mes factures, documents, TVA et paie" }] }, "9.8.7");
  expect(context.toolsUsed).toEqual(["get_invoices", "get_documents", "get_vat_status", "get_payroll_summary"]);
  expect(context.dossier.availableModules).toMatchObject({ invoicing: true, vat: true, payroll: true, statutoryFiscalExport: false });
  expect(context.routedResults.get_invoices[0]).toMatchObject({ invoiceNo: "FA-1", ttcCents: 10000n });
  expect(JSON.stringify(context, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/storedPath|ocrText|databasePath|SELECT\s/i);
});

test("mocked Ollama prompt contains versioned product/dossier context, strips reasoning and disables mutation tools in read-only mode", async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: { content: "<think>private chain</think>Réponse finale Atlas" }, total_duration: 10, eval_count: 3 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await localAi.runOllamaChat({ id: "ollama:test", provider: "OLLAMA", displayName: "test", installed: true, chatReady: true, removable: true, integrity: "LOCAL", bytes: 1, source: "test" }, {
      messages: [{ role: "user", content: "Que peut faire Wheat ?" }],
      productKnowledge: product.wheatProductKnowledge("9.8.7"),
      toolContext: { dossier: { id: "company", name: "Atlas Context" }, routedResults: {} },
      mutationToolsAllowed: false,
    });
    expect(result.text).toBe("Réponse finale Atlas");
    expect(requestBody.messages[0].content).toContain("Wheat 9.8.7");
    expect(requestBody.messages[0].content).toContain("Atlas Context");
    expect(requestBody.messages[0].content).not.toMatch(/databasePath|SELECT\s/i);
    // No mutation tool is offered in read-only mode. With no capability left to
    // send, Wheat now omits the field entirely rather than sending an empty
    // array: Ollama rejects a `tools` key outright for a model that does not
    // declare the capability, and this test model declares none.
    expect(requestBody.tools).toBeUndefined();
    expect(requestBody.stream).toBe(false);
    // Likewise `think`, which Ollama refuses for a model without the capability.
    expect("think" in requestBody).toBe(false);
  } finally {
    global.fetch = originalFetch;
  }
});
