/**
 * Which side of the ledger a document belongs to, and what reaches the draft.
 *
 * The regression these tests exist for: a fiduciaire named IFCOF opened its own
 * dossier, imported an invoice *it had issued* to a client, and Wheat filed the
 * document as a purchase and proposed "Tiers : IFCOF" — the dossier as its own
 * supplier. The cause was a fallback that read "no identifier matched, so treat
 * it as a purchase", combined with identity matching that compared ICE and IF
 * and nothing else, so a dossier that had not recorded its ICE never matched
 * anything on its own letterhead.
 *
 * The fixture is the real recognised document (`scanned-invoice-debours-ifcof`,
 * invoice 39/2026, 4 500,00 HT + 900,00 TVA + 2 142,76 de débours = 7 542,76).
 * Feeding recorded recognition rather than re-running the recogniser keeps the
 * two failure modes apart: a red test here means Wheat mapped a correct reading
 * wrongly, not that the scanner misread the page.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const fixtureDir = path.join(__dirname, "fixtures", "ocr");

const { extractDocumentFields } = tsxRequire(path.join(cwd, "electron", "ocrFieldExtraction.ts"), __filename);
const identity = tsxRequire(path.join(cwd, "electron", "partyIdentity.ts"), __filename);
const draft = tsxRequire(path.join(cwd, "electron", "documentInvoiceDraft.ts"), __filename);

const IFCOF = { name: "IFCOF", ice: "000187958000077", taxId: "1110375", rc: "193109", baseCurrency: "MAD" };
const ANOUAL = { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077", baseCurrency: "MAD" };

function pages(name) {
  const recognised = JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));
  return [{ page: 1, text: recognised.text, confidence: recognised.confidence, words: recognised.words }];
}

function extractFor(company) {
  return extractDocumentFields(pages("scanned-invoice-debours-ifcof"), { fileName: "scanned-invoice-debours-ifcof.pdf", company });
}

/** The shape `smartOcr` persists, built from a live extraction. */
function storedExtraction(result) {
  const value = (field) => (field && field.value !== undefined ? field.value : null);
  return {
    documentType: result.classification.type,
    documentDirection: result.classification.direction,
    parties: {
      issuer: result.parties.issuer && { name: result.parties.issuer.name, ice: result.parties.issuer.ice, taxId: result.parties.issuer.taxId, rc: result.parties.issuer.rc, address: result.parties.issuer.address, email: result.parties.issuer.email, phone: result.parties.issuer.phone },
      recipient: result.parties.recipient && { name: result.parties.recipient.name, ice: result.parties.recipient.ice, taxId: result.parties.recipient.taxId, rc: result.parties.recipient.rc, address: result.parties.recipient.address, email: result.parties.recipient.email, phone: result.parties.recipient.phone },
    },
    fields: Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, value(field)])),
    fieldConfidence: Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.confidence])),
    invoiceSchema: { lineItems: [] },
  };
}

/* ------------------------------------------------------------------ */
/* Identity matching                                                   */
/* ------------------------------------------------------------------ */

test.describe("party identity", () => {
  test("an ICE settles identity in both directions and outranks the name", () => {
    expect(identity.matchPartyIdentity(IFCOF, { name: "n'importe quoi", ice: "000187958000077" })).toMatchObject({ verdict: "SAME", basis: "ICE" });
    expect(identity.matchPartyIdentity(IFCOF, { name: "IFCOF", ice: "003983471000077" })).toMatchObject({ verdict: "DIFFERENT", basis: "ICE" });
  });

  test("a name that agrees with a contradicting ICE is refused and flagged, never accepted", () => {
    const conflicted = identity.matchPartyIdentity(IFCOF, { name: "IFCOF SARL", ice: "003983471000077" });
    expect(conflicted.verdict).toBe("DIFFERENT");
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.reasons.join(" ")).toMatch(/ICE fait foi/i);
  });

  test("the identifiant fiscal decides when neither party printed a comparable ICE", () => {
    expect(identity.matchPartyIdentity({ name: "A", taxId: "1110375" }, { name: "B", taxId: "1110375" })).toMatchObject({ verdict: "SAME", basis: "IF" });
    expect(identity.matchPartyIdentity({ name: "A", taxId: "1110375" }, { name: "B", taxId: "9999999" })).toMatchObject({ verdict: "DIFFERENT", basis: "IF" });
  });

  test("an RC alone is never enough, and confirms only alongside an agreeing name", () => {
    expect(identity.matchPartyIdentity({ name: "Alpha", rc: "193109" }, { name: "Beta", rc: "193109" }).verdict).not.toBe("SAME");
    expect(identity.matchPartyIdentity({ name: "Alpha", rc: "193109" }, { name: "ALPHA SARL", rc: "193109" })).toMatchObject({ verdict: "SAME", basis: "RC" });
  });

  test("normalisation removes case, accents, punctuation and legal forms, and stops there", () => {
    expect(identity.normalizeCompanyName("Sté  IFCOF S.A.R.L. AU")).toBe("IFCOF");
    expect(identity.normalizeCompanyName("société étoile sarl")).toBe("ETOILE");
    expect(identity.matchPartyIdentity({ name: "IFCOF SARL AU" }, { name: "ifcof" })).toMatchObject({ verdict: "SAME", basis: "NAME" });
    // Narrowing the name is a different entity, not the same one abbreviated.
    expect(identity.matchPartyIdentity({ name: "IFCOF" }, { name: "IFCOF CONSEIL" }).verdict).toBe("DIFFERENT");
  });

  test("two parties with nothing in common are UNKNOWN, which is not a weak DIFFERENT", () => {
    expect(identity.matchPartyIdentity({ ice: "000187958000077" }, { name: "Sans identifiant" })).toMatchObject({ verdict: "UNKNOWN", basis: null });
  });
});

/* ------------------------------------------------------------------ */
/* Direction, on the real document                                     */
/* ------------------------------------------------------------------ */

test.describe("invoice 39/2026 — sale or purchase relative to the open dossier", () => {
  test("the dossier that issued it reads the document as a SALE, whatever it matched on", () => {
    for (const company of [
      IFCOF,
      { name: "IFCOF", ice: null, taxId: "1110375" },
      // The reported failure: a dossier holding only its name.
      { name: "IFCOF SARL", ice: null, taxId: null },
    ]) {
      const result = extractFor(company);
      expect(result.classification.direction, `company ${JSON.stringify(company)}`).toBe("SALE");
      expect(result.classification.directionStatus).toBe("RESOLVED");
      expect(result.parties.issuer.isCurrentCompany).toBe(true);
      expect(result.parties.recipient.isCurrentCompany).toBe(false);
    }
  });

  test("the same document is a PURCHASE for the dossier that received it", () => {
    const result = extractFor(ANOUAL);
    expect(result.classification.direction).toBe("PURCHASE");
    expect(result.classification.directionStatus).toBe("RESOLVED");
    expect(result.classification.directionBasis).toBe("ICE");
    expect(result.fields.counterparty.value).toBe("IFCOF");
  });

  test("a dossier that is neither party leaves the direction unresolved instead of defaulting to purchase", () => {
    const result = extractFor({ name: "TIERS SANS RAPPORT", ice: "000000000000001" });
    expect(result.classification.direction).toBeNull();
    expect(result.classification.directionStatus).toBe("UNMATCHED");
    expect(result.classification.reasons.join(" ")).toMatch(/reste a confirmer/i);
  });

  test("no dossier context at all is also unresolved, never a purchase", () => {
    expect(extractFor(null).classification.direction).toBeNull();
  });

  test("a name that matches the dossier while the ICE contradicts it does not attribute the document", () => {
    const result = extractFor({ name: "IFCOF", ice: "000000000000009" });
    expect(result.classification.direction).toBeNull();
    expect(result.classification.reasons.join(" ")).toMatch(/contradictoires|correspond/i);
  });

  test("the third party is the other side, and is never the dossier itself", () => {
    expect(extractFor(IFCOF).fields.counterparty.value).toBe("ANOUAL HEALTH SOLUTIONS");
    expect(extractFor(ANOUAL).fields.counterparty.value).toBe("IFCOF");
    // Unresolved direction must still never hand back the dossier's own name.
    const unresolved = extractFor({ name: "IFCOF SARL", ice: "000000000000009" });
    expect(unresolved.fields.counterparty.value).not.toBe("IFCOF");
  });
});

/* ------------------------------------------------------------------ */
/* What actually reaches the draft                                     */
/* ------------------------------------------------------------------ */

test.describe("the draft built from invoice 39/2026", () => {
  function planFor(company, options = {}) {
    return draft.planInvoiceDraftFromDocument({
      extracted: storedExtraction(extractFor(company)),
      documentTitle: "scanned-invoice-debours-ifcof.pdf",
      company,
      paymentTermsDays: options.paymentTermsDays ?? null,
      forcedKind: options.forcedKind ?? null,
    });
  }

  test("carries every field the document actually prints", () => {
    const plan = planFor(IFCOF);
    expect(plan.kind).toBe("SALE");
    expect(plan.invoiceNo).toBe("39/2026");
    expect(plan.invoiceDate).toBe("2026-08-12");
    expect(plan.currency).toBe("MAD");
    expect(plan.vatRateBps).toBe(2000);
    expect(plan.counterparty).toMatchObject({ kind: "CUSTOMER", displayName: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077" });
  });

  test("keeps exact centimes and refuses to repair a document to make it balance", () => {
    const plan = planFor(IFCOF);
    // 4 500,00 + 900,00 + 2 142,76 = 7 542,76, the total the invoice prints.
    expect(plan.htCents).toBe("664276");
    expect(plan.vatCents).toBe("90000");
    expect(plan.ttcCents).toBe("754276");
    expect(plan.deboursCents).toBe("214276");
    expect(BigInt(plan.htCents) + BigInt(plan.vatCents)).toBe(BigInt(plan.ttcCents));
  });

  test("isolates the disbursements on their own untaxed line, off the revenue accounts", () => {
    const plan = planFor(IFCOF);
    const disbursement = plan.lines.find((line) => line.disbursement);
    expect(disbursement).toBeTruthy();
    expect(disbursement.htCents).toBe("214276");
    expect(disbursement.vatCents).toBe("0");
    expect(disbursement.accountRole).toBe("DISBURSEMENT");
    const service = plan.lines.find((line) => !line.disbursement);
    expect(service.accountRole).toBe("REVENUE_SERVICE");
    expect(service.htCents).toBe("450000");
    expect(service.vatCents).toBe("90000");
    expect(plan.warnings.join(" ")).toMatch(/ni du chiffre d'affaires ni une base de TVA/i);
  });

  test("routes the ledger accounts by direction rather than assuming a purchase", () => {
    expect(planFor(IFCOF)).toMatchObject({ controlRole: "RECEIVABLE", vatRole: "VAT_COLLECTED" });
    expect(planFor(ANOUAL)).toMatchObject({ controlRole: "PAYABLE", vatRole: "VAT_DEDUCTIBLE", kind: "PURCHASE" });
    expect(planFor(ANOUAL).lines.find((line) => !line.disbursement).accountRole).toBe("EXPENSE_SERVICE");
  });

  test("leaves a field the document does not carry blank instead of inventing one", () => {
    const plan = planFor(IFCOF);
    // This invoice prints no échéance and no payment term.
    expect(plan.dueDate).toBeNull();
    expect(plan.absentFields).toContain("dueDate");
    expect(plan.paymentMethod).toBeNull();
  });

  test("derives a due date only from the third party's recorded terms, and says so", () => {
    const plan = planFor(IFCOF, { paymentTermsDays: 30 });
    expect(plan.dueDate).toBe("2026-09-11");
    expect(plan.warnings.join(" ")).toMatch(/n'imprime pas d'échéance/i);
  });

  test("refuses to build a draft it cannot attribute, and names what is missing", () => {
    let error;
    try { planFor({ name: "TIERS SANS RAPPORT", ice: "000000000000001" }); } catch (caught) { error = caught; }
    expect(error).toBeTruthy();
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
    expect(error.missingFields).toContain("kind");
    expect(error.message).toMatch(/vente ou un achat/i);
  });

  test("a person may settle the direction the document could not, and the choice is recorded", () => {
    const plan = planFor({ name: "TIERS SANS RAPPORT", ice: "000000000000001" }, { forcedKind: "PURCHASE" });
    expect(plan.kind).toBe("PURCHASE");
    expect(plan.directionStatus).toBe("UNMATCHED");
    expect(plan.warnings.join(" ")).toMatch(/indiqué manuellement/i);
  });

  test("never lets the dossier become its own third party, even when told the wrong direction", () => {
    let error;
    // Forcing "purchase" on a document the dossier issued would make the
    // dossier its own supplier. That is the exact bug, and it is refused.
    try { planFor(IFCOF, { forcedKind: "PURCHASE" }); } catch (caught) { error = caught; }
    expect(error).toBeTruthy();
    expect(error.code).toBe("COUNTERPARTY_IS_DOSSIER");
    expect(error.message).toMatch(/son propre fournisseur/i);
  });

  test("reads the document's own lines when they reconstruct its taxable base", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    extraction.invoiceSchema.lineItems = [
      { description: "Honoraires relatives à la phase de creation", quantity: "1", unitPriceCents: "400000", lineTotalCents: "400000", vatRateBps: 2000 },
      { description: "PVAG constitutive", quantity: "1", unitPriceCents: "50000", lineTotalCents: "50000", vatRateBps: 2000 },
      { description: "Debours à l'identique", quantity: "1", unitPriceCents: null, lineTotalCents: "214276", vatRateBps: null },
    ];
    const plan = draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "x.pdf", company: IFCOF, paymentTermsDays: null });
    expect(plan.lines).toHaveLength(3);
    expect(plan.lines.map((line) => line.description)).toContain("PVAG constitutive");
    // VAT is apportioned across the taxable lines only, and to the centime.
    expect(plan.lines.filter((line) => !line.disbursement).reduce((total, line) => total + BigInt(line.vatCents), 0n)).toBe(90000n);
    expect(plan.lines.find((line) => line.disbursement).vatCents).toBe("0");
    expect(BigInt(plan.htCents) + BigInt(plan.vatCents)).toBe(BigInt(plan.ttcCents));
  });

  test("falls back to one summary line, with a warning, when the printed lines do not add up", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    extraction.invoiceSchema.lineItems = [{ description: "Ligne mal lue", quantity: "1", lineTotalCents: "12345", vatRateBps: 2000 }];
    const plan = draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "x.pdf", company: IFCOF, paymentTermsDays: null });
    expect(plan.warnings.join(" ")).toMatch(/ne totalisent pas|pas le total HT/i);
    expect(plan.lines.filter((line) => !line.disbursement)).toHaveLength(1);
  });

  test("rejects totals that contradict each other rather than adjusting one to fit", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    extraction.fields.ttc = 9999;
    let error;
    try { draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "x.pdf", company: IFCOF, paymentTermsDays: null }); } catch (caught) { error = caught; }
    expect(error.code).toBe("TOTALS_INCONSISTENT");
    expect(error.message).toMatch(/ne corrige pas une pièce/i);
  });

  test("still reads a document extracted by an earlier Wheat, which stored no party blocks", () => {
    // The shape a dossier's existing library is full of after an upgrade: flat
    // fields, a supplier, no `parties`, no direction.
    const legacy = { supplier: "Techno Bureau Maroc", ice: "000894112000089", date: "2026-05-29", invoiceNumber: "FR-9876", ht: 13000, vat: 2600, ttc: 15600 };
    const plan = draft.planInvoiceDraftFromDocument({ extracted: legacy, documentTitle: "Facture Techno Bureau FR-9876.pdf", company: { name: "MAGHREB TRADING", ice: "002741963000017", baseCurrency: "MAD" }, paymentTermsDays: null });
    expect(plan.kind).toBe("PURCHASE");
    expect(plan.directionStatus).toBe("IMPLIED");
    expect(plan.counterparty).toMatchObject({ kind: "SUPPLIER", displayName: "Techno Bureau Maroc", ice: "000894112000089" });
    expect(plan.ttcCents).toBe("1560000");
    expect(plan.warnings.join(" ")).toMatch(/ne nomme qu'une partie/i);
  });

  test("the implied-purchase shortcut never fires once the document names a recipient", () => {
    // This is what separates it from the old "anything unattributable is an
    // achat" fallback: invoice 39/2026 names ANOUAL, so nothing is inferred.
    let error;
    try { planFor({ name: "TIERS SANS RAPPORT", ice: "000000000000001" }); } catch (caught) { error = caught; }
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
  });

  test("a legacy extraction whose only party is the dossier itself is refused, not inverted", () => {
    // Read as a sale, correctly — the dossier issued it. What it cannot do is
    // invent the customer, so it asks for the one thing that is missing rather
    // than falling back to naming the dossier as its own third party.
    const legacy = { supplier: "IFCOF", ice: "000187958000077", date: "2026-08-12", invoiceNumber: "39/2026", ht: 4500, vat: 900, ttc: 5400 };
    let error;
    try { draft.planInvoiceDraftFromDocument({ extracted: legacy, documentTitle: "x.pdf", company: IFCOF, paymentTermsDays: null }); } catch (caught) { error = caught; }
    expect(error).toBeTruthy();
    expect(error.code).toBe("COUNTERPARTY_UNRESOLVED");
    expect(error.missingFields).toContain("client");
    expect(error.message).not.toMatch(/IFCOF/);
  });

  test("completes a single missing total from the two the document states", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    delete extraction.fields.ttc;
    const plan = draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "x.pdf", company: IFCOF, paymentTermsDays: null });
    expect(plan.ttcCents).toBe("754276");
  });

  test("persists a printed discount separately while keeping net invoice totals exact", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    Object.assign(extraction.fields, { ht: 100, tva: 20, discount: 5, debours: null, ttc: 115 });
    extraction.invoiceSchema.lineItems = [];
    const plan = draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "remise.pdf", company: IFCOF, paymentTermsDays: null });
    expect(plan).toMatchObject({ htCents: "9500", vatCents: "2000", ttcCents: "11500", discountCents: "500" });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ discountCents: "500", htCents: "9500", vatCents: "2000", ttcCents: "11500" });
    expect(BigInt(plan.htCents) + BigInt(plan.vatCents)).toBe(BigInt(plan.ttcCents));
  });

  test("uses the dossier base currency with explicit provenance when the piece prints none", () => {
    const extraction = storedExtraction(extractFor(IFCOF));
    extraction.fields.currency = null;
    extraction.fieldConfidence.currency = 0;
    const plan = draft.planInvoiceDraftFromDocument({ extracted: extraction, documentTitle: "sans-devise.pdf", company: IFCOF, paymentTermsDays: null });
    expect(plan.currency).toBe("MAD");
    expect(plan.absentFields).toContain("currency");
    expect(plan.warnings.join(" ")).toMatch(/devise de base MAD du dossier/i);
  });
});

/* ------------------------------------------------------------------ */
/* Account roles resolved against a dossier's own chart                */
/* ------------------------------------------------------------------ */

test.describe("account roles", () => {
  const chart = [
    { id: "a1", code: "342100", label: "Clients", active: true, postable: true },
    { id: "a2", code: "445500", label: "Etat - TVA facturée", active: true, postable: true },
    { id: "a3", code: "712400", label: "Prestations de services", active: true, postable: true },
    { id: "a4", code: "3488", label: "Divers débiteurs", active: true, postable: true },
    { id: "a5", code: "441100", label: "Fournisseurs", active: true, postable: true },
  ];

  test("prefers the dossier's own code over a label match, and never returns a parent it cannot post to", () => {
    expect(draft.resolveAccountRole("REVENUE_SERVICE", chart)).toMatchObject({ basis: "CODE", account: { code: "712400" } });
    expect(draft.resolveAccountRole("RECEIVABLE", chart)).toMatchObject({ account: { code: "342100" } });
    expect(draft.resolveAccountRole("DISBURSEMENT", chart)).toMatchObject({ account: { code: "3488" } });
  });

  test("accepts a dossier's own subdivision of the expected account", () => {
    const custom = [{ id: "c1", code: "7124001", label: "Honoraires cabinet", active: true, postable: true }];
    expect(draft.resolveAccountRole("REVENUE_SERVICE", custom)).toMatchObject({ basis: "CODE", account: { code: "7124001" } });
  });

  test("reports a role it cannot fill rather than inventing an account", () => {
    const resolved = draft.resolveAccountRole("VAT_DEDUCTIBLE", chart);
    expect(resolved.account).toBeNull();
    expect(draft.missingAccountMessage([resolved])).toMatch(/TVA récupérable.*345520/s);
  });

  test("skips an archived or unpostable account", () => {
    const archived = [
      { id: "x", code: "712400", label: "Prestations de services", active: false, postable: true },
      { id: "y", code: "71243", label: "Prestations de services", active: true, postable: true },
    ];
    expect(draft.resolveAccountRole("REVENUE_SERVICE", archived)).toMatchObject({ account: { code: "71243" } });
  });
});
