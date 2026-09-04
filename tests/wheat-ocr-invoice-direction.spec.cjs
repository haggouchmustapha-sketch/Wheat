/**
 * The reported regression, driven end to end through the real application.
 *
 * A fiduciaire named IFCOF opened its own dossier and imported invoice 39/2026,
 * which it had issued to ANOUAL HEALTH SOLUTIONS. Wheat filed it as an ACHAT and
 * proposed "Tiers : IFCOF" — the dossier recorded as its own supplier. The
 * cause was a classifier that fell back to "purchase" whenever it could not
 * attribute a document, and a draft builder hard-wired to the purchase side.
 *
 * Everything below goes through `window.wheat`, the same bridge the interface
 * uses: recognition, extraction, draft creation and reclassification. The unit
 * suite (`wheat-invoice-classification-unit`) pins the decisions; this pins
 * that they survive the whole pipeline and reach the database.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");

/** The document, written as the scanner reads it: both parties, both ICEs. */
const INVOICE_39_2026 = [
  "IFCOF",
  "Cabinet Comptable Agree",
  "INGENIERIE FINANCIERE CONSEIL JURIDIQUE & FISCALE",
  "",
  "Client: ANOUAL HEALTH SOLUTIONS",
  "252 ROUTE L OASIS Casablanca",
  "ICE :003983471000077",
  "",
  "FACTURE N 39/2026",
  "Date: 12/08/2026",
  "",
  "Designation                                        Total HT",
  "Honoraires relatives a la phase de creation        4 000,00",
  "PVAG constitutive                                    500,00",
  "Debours a l'identique comme suit:                  2 142,76",
  "",
  // The real document restates the disbursements in its totals block, which is
  // where the totals engine reads them from.
  "debours                                            2 142,76",
  "Total HT                                           4 500,00",
  "T.V.A 20%                                            900,00",
  "Total TTC                                          7 542,76",
  "",
  "29 Bd Mohammed VI, Casablanca 20250",
  "Tel.: +212 5 22 44 94 56 - Site Internet: www.ifcof.com",
  "ICE: 000187958000077 - RC: 193109 - TP: 32690363 - IF: 1110375 - CNSS: 7976361",
].join("\n");

async function openWheat(userDataDir) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20_000 });
  return { app, page };
}

/**
 * Imports invoice 39/2026 into a dossier and returns what Wheat made of it.
 * `dossier` decides which side of the document the open company is on.
 */
async function importInto(page, sourcePath, dossier) {
  return page.evaluate(async ({ sourcePath: filePath, dossier: identity }) => {
    const api = window.wheat;
    await api.resetWorkspace({ mode: "blank" });
    const company = await api.createCompany({
      ...identity,
      legalForm: "SARL",
      city: "Casablanca",
      fiscalYearStart: "2026-01-01",
      fiscalYearEnd: "2026-12-31",
      vatFrequency: "MONTHLY",
    });
    const documents = (await api.smartOcrProcess({ companyId: company.id, filePaths: [filePath] })).documents;
    const extracted = JSON.parse(documents[0].extracted);
    return {
      companyId: company.id,
      documentId: documents[0].id,
      documentType: extracted.documentType,
      direction: extracted.documentDirection,
      parties: extracted.parties,
      fields: extracted.fields,
    };
  }, { sourcePath, dossier });
}

test.describe("invoice 39/2026 through the whole pipeline", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let tempDir;
  let sourcePath;
  let running = null;

  test.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-direction-"));
    sourcePath = path.join(tempDir, "FACTURE-39-2026.txt");
    fs.writeFileSync(sourcePath, INVOICE_39_2026, "utf8");
  });

  test.afterEach(async () => {
    await running?.close().catch(() => undefined);
    running = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("the dossier that issued it gets a SALE billed to its customer, never to itself", async () => {
    const session = await openWheat(path.join(tempDir, "issuer"));
    running = session.app;
    const imported = await importInto(session.page, sourcePath, { name: "IFCOF", ice: "000187958000077", taxId: "1110375" });

    expect(imported.documentType).toBe("INVOICE");
    expect(imported.direction).toBe("SALE");
    expect(imported.parties.issuer.isCurrentCompany).toBe(true);
    expect(imported.parties.recipient.name).toContain("ANOUAL");
    expect(imported.fields.currency).toBeNull();
    // The exact wrong answer that was reported.
    expect(imported.fields.counterparty).not.toBe("IFCOF");
    expect(imported.fields.counterparty).toContain("ANOUAL");

    const created = await session.page.evaluate(async (documentId) => {
      const result = await window.wheat.postDocumentEntry(documentId);
      return result;
    }, imported.documentId);

    expect(created.invoiceDraft.kind).toBe("SALE");
    expect(created.invoiceDraft.counterparty).toContain("ANOUAL");
    expect(created.invoiceDraft.invoiceNo).toBe("39/2026");
    expect(created.invoiceDraft.currency).toBe("MAD");
    expect(created.invoiceDraft.dueDate).toBeNull();
    expect(String(created.invoiceDraft.invoiceDate)).toContain("2026-08-12");

    // Every centime the document prints, on the right side of the ledger.
    expect(String(created.invoiceDraft.vatCents)).toBe("90000");
    expect(String(created.invoiceDraft.ttcCents)).toBe("754276");
    expect(Number(created.invoiceDraft.htCents) + Number(created.invoiceDraft.vatCents)).toBe(Number(created.invoiceDraft.ttcCents));

    // The disbursements are billed but are neither turnover nor a VAT base.
    const disbursement = created.invoiceDraft.lines.find((line) => /d[eé]bours/i.test(line.description));
    expect(disbursement).toBeTruthy();
    expect(String(disbursement.vatCents)).toBe("0");
    expect(String(disbursement.htCents)).toBe("214276");

    const parties = await session.page.evaluate(async (companyId) => {
      const list = await window.wheat.listCounterparties({ companyId });
      return (list.items ?? list.rows ?? list).map((row) => ({ displayName: row.displayName, kind: row.kind, ice: row.ice }));
    }, imported.companyId);
    // The dossier was never created as a third party of its own dossier.
    expect(parties.some((party) => /IFCOF/i.test(party.displayName))).toBe(false);
    expect(parties.some((party) => /ANOUAL/i.test(party.displayName) && party.kind === "CUSTOMER")).toBe(true);
  });

  test("a known name-only customer is reused for payment terms without losing OCR identity or address", async () => {
    const session = await openWheat(path.join(tempDir, "known-customer"));
    running = session.app;
    const imported = await importInto(session.page, sourcePath, { name: "IFCOF", ice: "000187958000077", taxId: "1110375" });
    const existing = await session.page.evaluate(async (companyId) => window.wheat.createCounterparty({
      companyId,
      kind: "CUSTOMER",
      displayName: "ANOUAL HEALTH SOLUTIONS",
      legalName: "ANOUAL HEALTH SOLUTIONS",
      address: "Adresse maître à ne pas écraser",
      paymentTermsDays: 45,
    }), imported.companyId);

    const created = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId), imported.documentId);
    expect(created.invoiceDraft.counterpartyId).toBe(existing.id);
    expect(String(created.invoiceDraft.dueDate)).toContain("2026-09-26");
    expect(created.invoiceDraft.iceSnapshot).toBe("003983471000077");
    expect(created.invoiceDraft.billingAddressSnapshot).toMatch(/252 ROUTE L OASIS/i);

    const parties = await session.page.evaluate(async (companyId) => {
      const list = await window.wheat.listCounterparties({ companyId });
      return list.items ?? list.rows ?? list;
    }, imported.companyId);
    expect(parties).toHaveLength(1);
    expect(parties[0].id).toBe(existing.id);
    expect(parties[0].ice).toBeNull();
    expect(parties[0].address).toBe("Adresse maître à ne pas écraser");
  });

  test("a printed discount reaches InvoiceLine.discountCents and the persisted net totals", async () => {
    const discountPath = path.join(tempDir, "FACTURE-REMISE-2026.txt");
    fs.writeFileSync(discountPath, [
      "IFCOF",
      "Client: ANOUAL HEALTH SOLUTIONS",
      "ICE : 003983471000077",
      "FACTURE N REM-2026-1",
      "Date: 12/08/2026",
      "Total HT 100,00",
      "Remise 5,00",
      "TVA 20% 20,00",
      "Total TTC 115,00",
      "ICE: 000187958000077 - IF: 1110375",
    ].join("\n"), "utf8");
    const session = await openWheat(path.join(tempDir, "discount"));
    running = session.app;
    const imported = await importInto(session.page, discountPath, { name: "IFCOF", ice: "000187958000077", taxId: "1110375" });
    expect(imported.direction).toBe("SALE");
    expect(imported.fields).toMatchObject({ ht: 100, discount: 5, tva: 20, ttc: 115 });

    const created = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId), imported.documentId);
    expect(String(created.invoiceDraft.htCents)).toBe("9500");
    expect(String(created.invoiceDraft.vatCents)).toBe("2000");
    expect(String(created.invoiceDraft.ttcCents)).toBe("11500");
    expect(created.invoiceDraft.lines.reduce((sum, line) => sum + BigInt(line.discountCents), 0n)).toBe(500n);
    expect(created.invoiceDraft.lines.reduce((sum, line) => sum + BigInt(line.htCents), 0n)).toBe(9500n);
  });

  test("the dossier that received it gets a PURCHASE from IFCOF", async () => {
    const session = await openWheat(path.join(tempDir, "recipient"));
    running = session.app;
    const imported = await importInto(session.page, sourcePath, { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077", taxId: "IF-ANOUAL" });

    expect(imported.direction).toBe("PURCHASE");
    expect(imported.parties.recipient.isCurrentCompany).toBe(true);
    expect(imported.fields.counterparty).toContain("IFCOF");

    const created = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId), imported.documentId);
    expect(created.invoiceDraft.kind).toBe("PURCHASE");
    expect(created.invoiceDraft.counterparty).toContain("IFCOF");

    const parties = await session.page.evaluate(async (companyId) => {
      const list = await window.wheat.listCounterparties({ companyId });
      return (list.items ?? list.rows ?? list).map((row) => ({ displayName: row.displayName, kind: row.kind }));
    }, imported.companyId);
    expect(parties.some((party) => /ANOUAL/i.test(party.displayName))).toBe(false);
    expect(parties.some((party) => /IFCOF/i.test(party.displayName) && party.kind === "SUPPLIER")).toBe(true);
  });

  test("a dossier that is neither party is asked, not guessed at", async () => {
    const session = await openWheat(path.join(tempDir, "stranger"));
    running = session.app;
    const imported = await importInto(session.page, sourcePath, { name: "TIERS SANS RAPPORT", ice: "001111111111111", taxId: "IF-X" });

    expect(imported.direction).toBeNull();
    const refusal = await session.page.evaluate(async (documentId) => {
      try {
        await window.wheat.postDocumentEntry(documentId);
        return { refused: false, message: "" };
      } catch (error) {
        return { refused: true, message: error instanceof Error ? error.message : String(error) };
      }
    }, imported.documentId);
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toMatch(/vente ou un achat/i);

    // And a person may settle it, after which the draft is built normally.
    const forced = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId, "PURCHASE"), imported.documentId);
    expect(forced.invoiceDraft.kind).toBe("PURCHASE");
    expect(forced.invoiceDraft.counterparty).toContain("IFCOF");
  });

  test("a draft filed on the wrong side is rebuilt from its document, keeping the document linked", async () => {
    const session = await openWheat(path.join(tempDir, "reclassify"));
    running = session.app;
    // A fiduciaire capturing a piece for a dossier whose identifiers it does
    // not carry has to settle the direction by hand — and can settle it wrongly.
    // That is the situation reclassification exists for.
    const imported = await importInto(session.page, sourcePath, { name: "CABINET TIERS", ice: "001111111111111", taxId: "IF-X" });
    const wrong = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId, "PURCHASE"), imported.documentId);
    expect(wrong.invoiceDraft.kind).toBe("PURCHASE");
    expect(wrong.invoiceDraft.counterparty).toContain("IFCOF");

    const reclassified = await session.page.evaluate(
      (payload) => window.wheat.reclassifyInvoiceDraft(payload),
      { invoiceId: wrong.invoiceDraft.id, kind: "SALE" },
    );
    expect(reclassified.invoiceDraft.kind).toBe("SALE");
    expect(reclassified.replaced.kind).toBe("PURCHASE");
    // The source document follows the new draft; the old one is gone.
    expect(reclassified.document.invoiceId).toBe(reclassified.invoiceDraft.id);
    expect(reclassified.invoiceDraft.id).not.toBe(wrong.invoiceDraft.id);

    const after = await session.page.evaluate(async ({ companyId, oldInvoiceId }) => {
      const invoices = await window.wheat.listInvoices({ companyId });
      const rows = invoices.items ?? invoices.rows ?? invoices;
      return { count: rows.length, kinds: rows.map((row) => row.kind), oldStillThere: rows.some((row) => row.id === oldInvoiceId) };
    }, { companyId: imported.companyId, oldInvoiceId: wrong.invoiceDraft.id });
    expect(after.count).toBe(1);
    expect(after.kinds).toEqual(["SALE"]);
    expect(after.oldStillThere).toBe(false);
    expect(reclassified.invoiceDraft.counterparty).toContain("ANOUAL");
  });

  test("reclassification is refused when it would make the dossier its own third party", async () => {
    const session = await openWheat(path.join(tempDir, "refuse"));
    running = session.app;
    const imported = await importInto(session.page, sourcePath, { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077", taxId: "IF-ANOUAL" });
    const correct = await session.page.evaluate((documentId) => window.wheat.postDocumentEntry(documentId), imported.documentId);
    expect(correct.invoiceDraft.kind).toBe("PURCHASE");

    const refusal = await session.page.evaluate(async (payload) => {
      try {
        await window.wheat.reclassifyInvoiceDraft(payload);
        return { refused: false, message: "" };
      } catch (error) {
        return { refused: true, message: error instanceof Error ? error.message : String(error) };
      }
    }, { invoiceId: correct.invoiceDraft.id, kind: "SALE" });
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toMatch(/son propre client/i);

    // Nothing was destroyed on the way to the refusal.
    const after = await session.page.evaluate(async ({ companyId, invoiceId }) => {
      const invoices = await window.wheat.listInvoices({ companyId });
      const rows = invoices.items ?? invoices.rows ?? invoices;
      return { count: rows.length, stillThere: rows.some((row) => row.id === invoiceId && row.kind === "PURCHASE") };
    }, { companyId: imported.companyId, invoiceId: correct.invoiceDraft.id });
    expect(after).toEqual({ count: 1, stillThere: true });
  });
});
