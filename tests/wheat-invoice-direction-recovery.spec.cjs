/**
 * The four blocked invoices, and the two reasons they were blocked.
 *
 * A real batch of seven documents produced one invoice draft and four refusals.
 * Every refusal was the same sentence — Wheat could not tell a sale from a
 * purchase — and the cost of it was not one field: the number, the date, the
 * third party, the identifiers, the lines and the totals had all been read
 * correctly and were thrown away with it. The fifth document was refused for a
 * different reason, a total that did not add up, and there too a complete
 * reading was discarded over an arithmetic the document itself could settle.
 *
 * The tests below fix the behaviour, not the batch. Nothing keys off a supplier
 * name, an ICE or a file from that batch; each case states a rule about
 * Moroccan accounting documents in general, and the real batch is exercised
 * separately by `scripts/ocr-accuracy.cjs` against ground truth read off the
 * paper.
 *
 * Two invariants are load-bearing here and are asserted as often as the
 * improvements are:
 *
 *   Wheat still never decides the ledger side on its own. A document it cannot
 *   attribute is *prepared* with its side left open and marked as an
 *   assumption; it is not silently filed as a purchase, and the draft-creation
 *   path — the one that writes — still refuses it outright.
 *
 *   Wheat still never repairs a total to make it balance. A recovered reading
 *   is offered as a proposal with its reasoning, and only when the document's
 *   own redundancy makes it unique.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const draft = tsxRequire(path.join(root, "electron", "documentInvoiceDraft.ts"), __filename);
const amounts = tsxRequire(path.join(root, "electron", "ocrAmounts.ts"), __filename);

const DOSSIER = { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077", taxId: null, city: "Casablanca", baseCurrency: "MAD" };

/** A recognised invoice in the shape the pipeline actually stores. */
function extraction({ issuer, recipient, number = "39/2026", date = "2026-08-12", ht, tva, ttc, debours, vatRate = 2000, lineItems = [] }) {
  return {
    documentType: "INVOICE",
    confidence: 92,
    uncertainFields: [],
    parties: { issuer, recipient },
    fields: {
      invoiceNumber: number, date, currency: "MAD",
      ht, tva, ttc, vatRate,
      ...(debours === undefined ? {} : { debours }),
    },
    fieldConfidence: { invoiceNumber: 92, date: 92, currency: 92, ht: 92, tva: 92, ttc: 92 },
    invoiceSchema: { lineItems },
  };
}

const plan = (extracted, options = {}) => draft.planInvoiceDraftFromDocument({
  extracted, documentTitle: "piece.pdf", company: DOSSIER, paymentTermsDays: null, forcedKind: null, ...options,
});

const refusal = (extracted, options = {}) => {
  try {
    plan(extracted, options);
    return null;
  } catch (error) {
    return error;
  }
};

const SUPPLIER = { name: "CABINET IFCOF", ice: "000187958000077", taxId: "1110375", rc: "193109" };
const STRANGER_A = { name: "LUNA STEEL", ice: "003358098000067", taxId: "53977847", rc: "597773" };
const STRANGER_B = { name: "CHANI MAROC", ice: "003206387000051" };

test.describe("invoice direction recovery", () => {
  /* ------------------------------------------------- the original refusal */

  test("a document naming neither party of the dossier is still refused by the writing path", () => {
    // The regression guard. `planInvoiceDraftFromDocument` without the
    // preparation opt-in is what the "Créer le brouillon" button calls, and it
    // must go on refusing: a dossier filed as its own supplier is the fault
    // this whole module was built to prevent.
    const error = refusal(extraction({ issuer: STRANGER_A, recipient: STRANGER_B, ht: 75000, tva: 15000, ttc: 90000 }));
    expect(error).not.toBeNull();
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
    expect(error.missingFields).toContain("kind");
  });

  /* ------------------------------------- resolved from the dossier's own books */

  test("a supplier the dossier already deals with settles the direction of its next invoice", () => {
    // The generic rule behind the second refused IFCOF invoice: its recipient
    // block carried an ICE and no legible name, so the page could not be tied
    // to the dossier — but the issuer was already this dossier's supplier.
    const result = plan(
      extraction({ issuer: SUPPLIER, recipient: { name: null, ice: "001864713000017" }, ht: 5300, tva: 1060, ttc: 8915, debours: 2555 }),
      { knownCounterparties: [{ kind: "SUPPLIER", displayName: "CABINET IFCOF", ice: SUPPLIER.ice, taxId: SUPPLIER.taxId }] },
    );
    expect(result.kind).toBe("PURCHASE");
    // Deduced, never claimed as read: the row stays a review row.
    expect(result.directionStatus).toBe("IMPLIED");
    expect(result.directionProvisional).toBe(false);
    expect(result.counterparty.displayName).toBe("CABINET IFCOF");
    expect(result.warnings.join(" ")).toContain("déjà enregistré comme fournisseur");
  });

  test("a customer named as the recipient settles a sale the same way", () => {
    const result = plan(
      extraction({ issuer: { name: null, ice: null }, recipient: { name: "RESTOPRO BOUSKORA", ice: "000034157000037" }, ht: 5200, tva: 1040, ttc: 6240 }),
      { knownCounterparties: [{ kind: "CUSTOMER", displayName: "RESTOPRO BOUSKORA", ice: "000034157000037" }] },
    );
    expect(result.kind).toBe("SALE");
    expect(result.directionStatus).toBe("IMPLIED");
  });

  test("a third party known on both sides of the page settles nothing", () => {
    // Two of the dossier's own contacts invoicing each other says nothing about
    // where the dossier stands, and guessing from it would be worse than asking.
    const error = refusal(
      extraction({ issuer: STRANGER_A, recipient: STRANGER_B, ht: 75000, tva: 15000, ttc: 90000 }),
      {
        knownCounterparties: [
          { kind: "SUPPLIER", displayName: "LUNA STEEL", ice: STRANGER_A.ice },
          { kind: "CUSTOMER", displayName: "CHANI MAROC", ice: STRANGER_B.ice },
        ],
      },
    );
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
  });

  test("a supplier appearing as the recipient settles nothing either", () => {
    // A company the dossier both buys from and sells to is exactly the case
    // where the role carries no information about this particular page.
    const error = refusal(
      extraction({ issuer: STRANGER_A, recipient: SUPPLIER, ht: 75000, tva: 15000, ttc: 90000 }),
      { knownCounterparties: [{ kind: "SUPPLIER", displayName: "CABINET IFCOF", ice: SUPPLIER.ice }] },
    );
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
  });

  test("a matching name never overrules a contradicting identifier", () => {
    // The counterparty roster is a weaker signal than an ICE and must not be
    // able to smuggle a name match past one.
    const error = refusal(
      extraction({ issuer: { name: "CABINET IFCOF", ice: "999999999999999" }, recipient: STRANGER_B, ht: 100, tva: 20, ttc: 120 }),
      { knownCounterparties: [{ kind: "SUPPLIER", displayName: "CABINET IFCOF", ice: SUPPLIER.ice }] },
    );
    expect(error.code).toBe("DIRECTION_UNRESOLVED");
  });

  /* --------------------------------------- prepared instead of discarded */

  test("preparation keeps the whole reading and puts only the direction to the reviewer", () => {
    const result = plan(
      extraction({ issuer: STRANGER_A, recipient: STRANGER_B, number: "25072026", date: "2026-07-25", ht: 75000, tva: 15000, ttc: 90000 }),
      { allowProvisionalDirection: true },
    );
    // Everything the page carried survives.
    expect(result.invoiceNo).toBe("25072026");
    expect(result.invoiceDate).toBe("2026-07-25");
    expect(result.htCents).toBe("7500000");
    expect(result.vatCents).toBe("1500000");
    expect(result.currency).toBe("MAD");
    // And the one thing Wheat could not settle is marked as unsettled.
    expect(result.directionProvisional).toBe(true);
    expect(result.directionStatus).toBe("UNMATCHED");
    expect(result.directionBasis).toBeNull();
    expect(result.warnings.join(" ")).toContain("à confirmer avant toute écriture");
    // The other reading is offered, so flipping it is one action.
    expect(result.directionAlternative).toEqual({ kind: "SALE", counterpartyName: "CHANI MAROC" });
  });

  test("a confirmed direction stops being provisional and is honoured as given", () => {
    const result = plan(
      extraction({ issuer: STRANGER_A, recipient: STRANGER_B, ht: 75000, tva: 15000, ttc: 90000 }),
      { allowProvisionalDirection: true, forcedKind: "SALE" },
    );
    expect(result.kind).toBe("SALE");
    expect(result.directionProvisional).toBe(false);
    // A sale posts against the recipient, which is the whole point of asking.
    expect(result.counterparty.displayName).toBe("CHANI MAROC");
    expect(result.counterparty.kind).toBe("CUSTOMER");
  });

  test("a document the page does attribute is never marked provisional", () => {
    const result = plan(
      extraction({ issuer: SUPPLIER, recipient: { name: DOSSIER.name, ice: DOSSIER.ice }, ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }),
      { allowProvisionalDirection: true },
    );
    expect(result.directionStatus).toBe("RESOLVED");
    expect(result.directionProvisional).toBe(false);
    expect(result.directionBasis).toBe("ICE");
  });

  /* ---------------------------------- a total the recogniser misread */

  test("a misread total is recovered from the document's own arithmetic and offered, not applied", () => {
    // The scan states 5 060,00 TTC at 20 %; the base and the VAT are therefore
    // determined, and the two values read differ from them by one glyph each.
    const error = refusal(extraction({
      issuer: STRANGER_A, recipient: { name: DOSSIER.name, ice: DOSSIER.ice }, ht: 4216.07, tva: 643.33, ttc: 5060, vatRate: null,
    }));
    expect(error.code).toBe("TOTALS_INCONSISTENT");
    expect(error.suggestion).not.toBeNull();
    expect(error.suggestion.fields).toEqual({ ht: 4216.67, tva: 843.33, ttc: 5060, vatRate: 2000 });
    // Offered with its reasoning, and explicitly not applied.
    expect(error.suggestion.explanation).toContain("erreur de reconnaissance");
    expect(error.suggestion.explanation).toContain("que si vous l'acceptez");
  });

  test("accepting the recovered reading produces the invoice the paper states", () => {
    const result = plan(
      extraction({ issuer: STRANGER_A, recipient: { name: DOSSIER.name, ice: DOSSIER.ice }, ht: 4216.67, tva: 843.33, ttc: 5060, vatRate: 2000 }),
    );
    expect(result.htCents).toBe("421667");
    expect(result.vatCents).toBe("84333");
    expect(result.ttcCents).toBe("506000");
  });

  test("totals that are genuinely different amounts get no proposal", () => {
    // 4 500 + 900 is not 9 000 by any single misread digit, and inventing a
    // reading that makes it balance is precisely what must not happen.
    const error = refusal(extraction({ issuer: STRANGER_A, recipient: { name: DOSSIER.name, ice: DOSSIER.ice }, ht: 4500, tva: 900, ttc: 9000 }));
    expect(error.code).toBe("TOTALS_INCONSISTENT");
    expect(error.suggestion).toBeNull();
  });

  test("a document that already balances is never told it does not", () => {
    expect(amounts.reconstructTotals({ ht: 5200, tva: 1040, ttc: 6240, statedRateBps: 2000 })).toBeNull();
    expect(amounts.reconstructTotals({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76, statedRateBps: 2000 })).toBeNull();
  });

  test("a dropped or added digit is not a misread and is never recovered", () => {
    // Equal length is as much of the rule as the single difference: a magnitude
    // change is a different amount, and Wheat has no business proposing one.
    expect(amounts.isSingleDigitMisread(421.67, 4216.67)).toBe(false);
    expect(amounts.isSingleDigitMisread(4216.07, 4216.67)).toBe(true);
    expect(amounts.isSingleDigitMisread(4216.67, 4216.67)).toBe(false);
  });

  test("an absent VAT rate is absent, not zero per cent", () => {
    // `Number(null)` is 0, so reading the rate with a bare cast turned a
    // document that printed no rate into one that printed an exemption.
    const result = plan(
      extraction({ issuer: SUPPLIER, recipient: { name: DOSSIER.name, ice: DOSSIER.ice }, ht: 1000, tva: 200, ttc: 1200, vatRate: null }),
    );
    expect(result.vatRateBps).toBeNull();
    expect(result.absentFields).toContain("vatRate");
  });
});
