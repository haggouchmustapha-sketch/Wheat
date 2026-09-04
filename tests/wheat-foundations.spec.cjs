const { test, expect } = require("@playwright/test");
const { require: tsxRequire } = require("tsx/cjs/api");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const pcge = tsxRequire(path.join(root, "electron", "pcgeData.ts"), __filename);
const chart = tsxRequire(path.join(root, "electron", "chartOfAccounts21.ts"), __filename);
const dates = tsxRequire(path.join(root, "electron", "dateNormalization21.ts"), __filename);
const pieces = tsxRequire(path.join(root, "electron", "pieceNumbering21.ts"), __filename);
const importer = tsxRequire(path.join(root, "electron", "bankStatementImporter.ts"), __filename);
const reports = tsxRequire(path.join(root, "electron", "reporting21.ts"), __filename);
const fiscal = tsxRequire(path.join(root, "electron", "fiscal21.ts"), __filename);
const localAi = tsxRequire(path.join(root, "electron", "wheatAi.ts"), __filename);
const smartOcr = tsxRequire(path.join(root, "electron", "smartOcr.ts"), __filename);

test("PCGE 2.1 contains the pinned 0-9 hierarchy and accent-insensitive search data", () => {
  expect(pcge.PCGE_ACCOUNTS).toHaveLength(1134);
  expect(pcge.PCGE_CLASS_COUNTS).toEqual({ 0: 119, 1: 76, 2: 147, 3: 125, 4: 68, 5: 33, 6: 252, 7: 152, 8: 26, 9: 136 });
  for (let classNo = 0; classNo <= 9; classNo += 1) {
    const rootAccount = pcge.PCGE_ACCOUNTS.find((account) => account.code === String(classNo));
    expect(rootAccount, `missing root ${classNo}`).toBeTruthy();
    expect(rootAccount.parentCode).toBeNull();
  }
  const depreciation = pcge.PCGE_ACCOUNTS.find((account) => /amort/i.test(account.label));
  expect(depreciation.searchText).not.toMatch(/[\u0300-\u036f]/);
  expect(chart.PCGE_STANDARD_ACCOUNT_COUNT).toBe(1134);
  expect(pcge.PCGE_SOURCE.officialUrl).toContain("finances.gov.ma");
  expect(pcge.PCGE_SOURCE.officialSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("flexible Moroccan dates preserve raw input and infer a year only from reliable context", () => {
  const examples = [
    ["290526", "2026-05-29"], ["29/05/26", "2026-05-29"], ["29/05/2026", "2026-05-29"],
    ["29-05-2026", "2026-05-29"], ["29.05.2026", "2026-05-29"], ["2026-05-29", "2026-05-29"],
    ["20260529", "2026-05-29"], ["29052026", "2026-05-29"],
  ];
  for (const [raw, expected] of examples) {
    const normalized = dates.normalizeFlexibleDate(raw);
    expect(normalized.iso).toBe(expected);
    expect(normalized.raw).toBe(raw);
    expect(normalized.inferred).toBe(false);
  }
  expect(dates.normalizeFlexibleDate("29/05", { periodStart: "2026-01-01", periodEnd: "2026-12-31" })).toMatchObject({ iso: "2026-05-29", inferred: true, raw: "29/05" });
  expect(() => dates.normalizeFlexibleDate("29/05")).toThrow(/aucun contexte/i);
  expect(() => dates.normalizeFlexibleDate("31/02/2026")).toThrow(/calendrier/i);
  expect(dates.inferUniqueYear(["01/01/26", "311226", "05/06"])).toBe(2026);
  expect(dates.inferUniqueYear(["01/01/25", "01/01/26"])).toBeNull();
});

test("piece patterns render and recover fiscal-year sequences without numeric drift", () => {
  const journal = { code: "AC", piecePrefix: "ACH", piecePattern: "{prefix}-{year}-{sequence}", pieceYearFormat: "YY", piecePadding: 5, pieceSeparator: "/" };
  const value = pieces.renderPieceNumber(journal, new Date("2026-05-29T00:00:00Z"), 42);
  expect(value).toBe("ACH/26/00042");
  expect(pieces.extractConfiguredSequence(journal, new Date("2026-05-29T00:00:00Z"), value)).toBe(42);
  expect(pieces.extractConfiguredSequence(journal, new Date("2027-05-29T00:00:00Z"), value)).toBeNull();
  expect(() => pieces.validatePiecePattern("{journal}-{year}")).toThrow(/sequence/i);
  expect(() => pieces.validatePiecePattern("{journal}-{sql}-{sequence}")).toThrow(/pas pris en charge/i);
});

function word(text, x, y, page = 1) {
  return { text, confidence: 95, page, bbox: { x0: x, y0: y, x1: x + 70, y1: y + 18 } };
}

test("adaptive spatial bank parser handles shifted rows, repeated page headers and source pages", () => {
  const xs = [20, 150, 360, 530, 670, 810];
  const header = ["Date", "Date valeur", "Libellé", "Débit", "Crédit", "Solde"];
  const row1 = ["29/05/2026", "30/05/2026", "VIR FOURNISSEUR", "1 250,00", "", "8 750,00"];
  const row2 = ["30/05/2026", "30/05/2026", "CLIENT ATLAS", "", "2 000,00", "10 750,00"];
  const words = [
    ...header.map((text, i) => word(text, xs[i], 40)),
    ...row1.map((text, i) => word(text || " ", xs[i] + (i % 2 ? 9 : -3), 82)),
    ...header.map((text, i) => word(text, xs[i] + 4, 35, 2)),
    ...row2.map((text, i) => word(text || " ", xs[i] + (i % 2 ? -7 : 12), 79, 2)),
  ];
  const table = importer.tableFromSpatialWords(words);
  expect(table.headers).toHaveLength(6);
  expect(table.rows).toHaveLength(2);
  expect(table.rows[0].Libellé).toContain("VIR");
  expect(table.rows[0].__wheatSourcePage).toBe("1");
  expect(table.rows[1].__wheatSourcePage).toBe("2");
  expect(table.rows.some((row) => row.Libellé === "Libellé")).toBe(false);
});

function reportLine({ id, date, debit = 0n, credit = 0n, code, label, classNo, type, reportNature, journal = "OD" }) {
  return { id, debitCents: debit, creditCents: credit, entry: { id: `e-${id}`, date: new Date(`${date}T00:00:00Z`), status: "POSTED", source: "MANUAL", journalId: journal, journal: { code: journal, label: journal } }, account: { id: `a-${code}`, code, label, classNo, type, category: "TEST", parentCode: null, reportNature }, counterparty: null, thirdParty: null };
}

test("balance, Bilan and bank totals use the shared exact-cent engine", async () => {
  const lines = [
    reportLine({ id: "1", date: "2026-01-01", debit: 10000n, code: "234", label: "Actif", classNo: 2, type: "ASSET", reportNature: "BALANCE_SHEET" }),
    reportLine({ id: "2", date: "2026-01-01", credit: 10000n, code: "111", label: "Capital", classNo: 1, type: "EQUITY", reportNature: "BALANCE_SHEET" }),
    reportLine({ id: "3", date: "2026-05-01", debit: 2500n, code: "612", label: "Charge", classNo: 6, type: "EXPENSE", reportNature: "PROFIT_AND_LOSS" }),
    reportLine({ id: "4", date: "2026-05-01", credit: 2500n, code: "712", label: "Produit", classNo: 7, type: "REVENUE", reportNature: "PROFIT_AND_LOSS" }),
  ];
  const prisma = {
    fiscalYear: { findFirst: async () => ({ id: "fy", label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z") }) },
    entryLine: {
      findMany: async () => lines,
      aggregate: async () => ({ _sum: { debitCents: 10000n, creditCents: 0n } }),
    },
    bankAccount: { findMany: async () => [{ id: "bank", bankName: "Atlas Bank", currency: "MAD", ledgerAccountId: "a-234", ledgerAccount: { code: "234" }, statements: [{ closingBalanceCents: 10000n, endsOn: new Date("2026-05-31T00:00:00Z") }], balanceAsOf: null, balanceSource: "LEDGER" }] },
  };
  const balance = await reports.buildBalanceFamily(prisma, { companyId: "company", view: "GENERAL", from: "2026-01-01", to: "2026-12-31" });
  expect(balance.balanced).toBe(true);
  expect(balance.totals.periodDebitCents).toBe(12500n);
  expect(balance.totals.periodCreditCents).toBe(12500n);
  expect(balance.rows.every((row) => typeof row.cumulativeBalanceCents === "bigint")).toBe(true);
  const bilan = await reports.buildBilan(prisma, { companyId: "company", variant: "NORMAL", asOf: "2026-12-31" });
  expect(bilan.balanced).toBe(true);
  expect(bilan.statutoryFinalizationAvailable).toBe(false);
  expect(bilan.totals.totalActifCents).toBe(10000n);
  const bank = await reports.buildBankTotal(prisma, { companyId: "company", asOf: "2026-12-31" });
  expect(bank.rows[0]).toMatchObject({ accountingCents: 10000n, bankCents: 10000n, differenceCents: 0n });
});

test("opening preview carries only balance-sheet accounts and blocks unassigned profit", async () => {
  const target = { id: "fy-2026", companyId: "company", label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" };
  const source = { id: "fy-2025", companyId: "company", label: "2025", startsOn: new Date("2025-01-01T00:00:00Z"), endsOn: new Date("2025-12-31T00:00:00Z"), status: "CLOSED" };
  const tx = {
    fiscalYear: { findFirst: async ({ where }) => where.id ? target : source },
    entryLine: { findMany: async () => [
      { accountId: "asset", debitCents: 10000n, creditCents: 0n, account: { id: "asset", code: "234", label: "Actif", reportNature: "BALANCE_SHEET" } },
      { accountId: "capital", debitCents: 0n, creditCents: 8000n, account: { id: "capital", code: "111", label: "Capital", reportNature: "BALANCE_SHEET" } },
      { accountId: "revenue", debitCents: 0n, creditCents: 2000n, account: { id: "revenue", code: "712", label: "Produit", reportNature: "PROFIT_AND_LOSS" } },
    ] },
    account: { findFirst: async () => null },
  };
  const preview = await fiscal.previewOpeningBalance(tx, { companyId: "company", fiscalYearId: target.id });
  expect(preview.rows.map((row) => row.accountCode)).toEqual(["234", "111"]);
  expect(preview.profitLossCents).toBe(2000n);
  expect(preview.canPost).toBe(false);
  expect(preview.warnings.join(" ")).toMatch(/affectation vérifié/i);
});

test("local model manifest is immutable, hashed and recommends only eligible tiers", async () => {
  const manifest = await localAi.readModelManifest(path.join(root, "resources", "models", "wheat-model-manifest.json"));
  expect(manifest.models.map((model) => model.tier)).toEqual(["LITE", "STANDARD", "ADVANCED"]);
  expect([manifest.runtime, ...manifest.models].every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
  expect(manifest.models.every((model) => /\/resolve\/[a-f0-9]{40}\//.test(model.url))).toBe(true);
  const recommendation = localAi.recommendModel({ totalRamBytes: 20 * 1024 ** 3, freeRamBytes: 10 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3, platform: "win32", arch: "x64", cpu: "test", logicalCores: 8, gpus: [] }, manifest);
  expect(recommendation.tier).toBe("STANDARD");
  expect(recommendation.eligibleModelIds).toHaveLength(2);
});

test("local AI exposes only the final response and never model reasoning", () => {
  expect(localAi.stripModelReasoning("<think>secret calculation</think>\nRéponse visible")).toBe("Réponse visible");
  expect(localAi.stripModelReasoning("<analysis>private analysis</analysis>\nFinal result")).toBe("Final result");
  expect(localAi.stripModelReasoning("hidden tokens</think>\nOnly this answer")).toBe("Only this answer");
  expect(localAi.stripModelReasoning("Thinking: private steps\nFinal Answer: Public answer")).toBe("Public answer");
  expect(localAi.stripModelReasoning("<|channel|>analysis<|message|>private<|end|><|start|>assistant<|channel|>final<|message|>Visible channel answer")).toBe("Visible channel answer");
  expect(localAi.stripModelReasoning("<think>unterminated private reasoning")).toMatch(/pas fourni de réponse finale/i);
  expect(localAi.stripModelReasoning("[THINK]unterminated private reasoning")).toMatch(/pas fourni de réponse finale/i);
  expect(localAi.stripModelReasoning("Thinking:\nprivate reasoning without a final answer")).toMatch(/pas fourni de réponse finale/i);
  expect(localAi.stripModelReasoning("Réponse directe sans raisonnement")).toBe("Réponse directe sans raisonnement");
});

test("invoice OCR contract exposes exact cents, line items, confidence and bbox evidence", () => {
  const fields = {
    supplier: { value: "Atlas Fournitures SARL", confidence: 91, raw: "Fournisseur: Atlas Fournitures SARL", source: "supplier" },
    ice: { value: "001589742000063", confidence: 94, raw: "ICE 001589742000063", source: "ICE" },
    if: { value: "48291073", confidence: 88, raw: "IF 48291073", source: "IF" },
    client: { value: "Client Maroc", confidence: 84, raw: "Client: Client Maroc", source: "client" },
    invoiceNumber: { value: "FA-2026-42", confidence: 90, raw: "Facture FA-2026-42", source: "invoice" },
    date: { value: "2026-05-29", confidence: 89, raw: "29/05/2026", source: "date" },
    dueDate: { value: "2026-06-29", confidence: 80, raw: "29/06/2026", source: "due" },
    currency: { value: "MAD", confidence: 92, raw: "MAD", source: "currency" },
    paymentTerms: { value: "Virement", confidence: 78, raw: "Paiement: Virement", source: "payment" },
    ht: { value: 12000, confidence: 90, raw: "HT 12 000,00", source: "ht" },
    tva: { value: 2400, confidence: 90, raw: "TVA 2 400,00", source: "tva" },
    ttc: { value: 14400, confidence: 92, raw: "TTC 14 400,00", source: "ttc" },
  };
  const pages = [{ page: 1, text: "", confidence: 90, engine: "test", preprocessing: [], words: [
    { text: "Atlas", confidence: 96, bbox: { x0: 20, y0: 20, x1: 55, y1: 35 } },
    { text: "Fournitures", confidence: 96, bbox: { x0: 60, y0: 20, x1: 130, y1: 35 } },
    { text: "SARL", confidence: 96, bbox: { x0: 135, y0: 20, x1: 170, y1: 35 } },
    { text: "FA-2026-42", confidence: 94, bbox: { x0: 20, y0: 50, x1: 100, y1: 65 } },
  ] }];
  const table = [["Désignation", "Qté", "Prix unitaire", "TVA", "Total"], ["Service comptable", "2", "6 000,00", "20%", "12 000,00"]];
  const schema = smartOcr.buildInvoiceSchema(fields, table, pages);
  expect(schema.schemaVersion).toBe("WHEAT_INVOICE_1");
  expect(schema.fields.htCents.value).toBe("1200000");
  expect(schema.fields.ttcCents.value).toBe("1440000");
  expect(schema.confidence.accountingConsistency).toBe(100);
  expect(schema.lineItems[0]).toMatchObject({ description: "Service comptable", quantity: "2", unitPriceCents: "600000", vatRateBps: 2000, lineTotalCents: "1200000" });
  expect(schema.fields.supplierName.evidence[0].bbox).toEqual({ x0: 20, y0: 20, x1: 170, y1: 35 });
});
