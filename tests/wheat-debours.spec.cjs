/**
 * Débours: money advanced for a client, re-invoiced unchanged.
 *
 * A débours à l'identique is not turnover and not a VAT base. It is a third
 * party's expense passing through the invoice, and the whole reason it needs
 * its own field is that every place it could be folded into instead is wrong:
 * counted in HT it inflates revenue and understates margin, counted in the
 * taxable base it invents VAT that was never due, counted only in the payable
 * total it disappears from the books entirely.
 *
 * The IFCOF invoice in the real batch is the canonical shape — 4 500 of fees,
 * 900 of VAT, 2 142,76 of disbursements, 7 542,76 payable — and it is exactly
 * the shape a pipeline that only knows HT + TVA = TTC reports as inconsistent
 * and refuses.
 *
 * These tests follow the amount along the whole path rather than asserting it
 * exists somewhere: recognised, normalised, planned, given its own line, given
 * a third-party account rather than a revenue one, kept out of the taxable
 * base, and correctable inline. A field that the recogniser reads and the plan
 * drops is a failure here, which is the only definition of "supported" worth
 * having.
 *
 * The false-positive cases matter as much as the positive ones. "Frais" is an
 * ordinary word on an ordinary invoice, and a rule that treats every line
 * containing it as a disbursement would remove real revenue from real turnover.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const draft = tsxRequire(path.join(root, "electron", "documentInvoiceDraft.ts"), __filename);

const DOSSIER = { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077", city: "Casablanca", baseCurrency: "MAD" };
const ISSUER = { name: "CABINET IFCOF", ice: "000187958000077", taxId: "1110375", rc: "193109" };

function extraction({ ht, tva, ttc, debours, vatRate = 2000, lineItems = [] }) {
  return {
    documentType: "INVOICE",
    confidence: 92,
    uncertainFields: [],
    parties: { issuer: ISSUER, recipient: { name: DOSSIER.name, ice: DOSSIER.ice } },
    fields: {
      invoiceNumber: "39/2026", date: "2026-08-12", currency: "MAD",
      ht, tva, ttc, vatRate,
      ...(debours === undefined ? {} : { debours }),
    },
    fieldConfidence: { invoiceNumber: 92, date: 92, currency: 92, ht: 92, tva: 92, ttc: 92, debours: 92 },
    invoiceSchema: { lineItems },
  };
}

const plan = (extracted) => draft.planInvoiceDraftFromDocument({
  extracted, documentTitle: "facture.pdf", company: DOSSIER, paymentTermsDays: null, forcedKind: null,
});

const refusal = (extracted) => {
  try {
    plan(extracted);
    return null;
  } catch (error) { return error; }
};

/** A line of a recognised invoice, in centimes as the schema stores them. */
const item = (description, cents) => ({ description, lineTotalCents: String(cents), quantity: null, unitPriceCents: null });

test.describe("débours", () => {
  /* ------------------------------------------------------ 1 & 2. reading it */

  test("an explicit disbursement label is read as an amount of its own", () => {
    // "Débours" is a kind of total the recogniser knows, distinct from HT, TVA
    // and TTC, and it survives into the plan as its own figure rather than
    // being folded into one of the three.
    const result = plan(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }));
    expect(result.deboursCents).toBe("214276");
    expect(result.deboursCents).not.toBe(result.htCents);
    expect(result.deboursCents).not.toBe(result.vatCents);
  });

  test("HT + TVA + débours = payable is a shape Wheat accepts rather than refuses", () => {
    // The exact IFCOF arithmetic. Without the disbursement in the equation this
    // invoice reads as 4 500 + 900 ≠ 7 542,76 and is thrown out.
    const result = plan(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }));
    expect(result.deboursCents).toBe("214276");
    // The plan's own HT carries the disbursement line, so the *taxable* base is
    // the difference — and the VAT is on the fees alone, not on the pass-through.
    expect(BigInt(result.htCents) - BigInt(result.deboursCents)).toBe(450000n);
    expect(result.vatCents).toBe("90000");
    expect(result.ttcCents).toBe("754276");
  });

  test("the disbursement gets its own line, at no VAT, on a third-party account", () => {
    const result = plan(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }));
    const disbursement = result.lines.filter((line) => line.disbursement);
    expect(disbursement).toHaveLength(1);
    expect(disbursement[0].htCents).toBe("214276");
    expect(disbursement[0].vatCents).toBe("0");
    expect(disbursement[0].vatRateBps).toBe(0);
    // Never a revenue or expense account: this is somebody else's money.
    expect(disbursement[0].accountRole).toBe("DISBURSEMENT");
    expect(draft.requiredRolesForPlan(result)).toContain("DISBURSEMENT");
    // And the reviewer is told, because the tax treatment is theirs to settle.
    expect(result.warnings.join(" ")).toContain("ni du chiffre d'affaires ni une base de TVA");
  });

  test("printed lines that name a disbursement keep it out of the taxable base", () => {
    const result = plan(extraction({
      ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76,
      lineItems: [
        item("Honoraires relatives à la phase de creation", 400000),
        item("PVAG constitutive", 50000),
        item("Débours à l'identique", 214276),
      ],
    }));
    const [fees, pvag, disbursement] = result.lines;
    expect(fees.disbursement).toBe(false);
    expect(pvag.disbursement).toBe(false);
    expect(disbursement.disbursement).toBe(true);
    // The VAT is apportioned across the taxable lines only, and totals the
    // amount the document states.
    expect(BigInt(fees.vatCents) + BigInt(pvag.vatCents)).toBe(90000n);
    expect(disbursement.vatCents).toBe("0");
  });

  /* ------------------------------------------ 3, 4 & 5. not inventing one */

  test("an invoice with no disbursement is never given one", () => {
    const result = plan(extraction({ ht: 5200, tva: 1040, ttc: 6240 }));
    expect(result.deboursCents).toBe("0");
    expect(result.lines.some((line) => line.disbursement)).toBe(false);
    expect(result.warnings.join(" ")).not.toContain("débours");
  });

  test("an ordinary line containing « frais » is not a disbursement", () => {
    // "Frais de dossier" is the cabinet's own fee and is taxable revenue. A
    // rule keyed on the word alone would take it out of turnover.
    const result = plan(extraction({
      ht: 1000, tva: 200, ttc: 1200,
      lineItems: [item("Frais de dossier", 100000)],
    }));
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].disbursement).toBe(false);
    expect(result.lines[0].accountRole).toBe("EXPENSE_SERVICE");
    expect(result.deboursCents).toBe("0");
  });

  test("« frais de port » and « frais bancaires » stay taxable lines", () => {
    for (const label of ["Frais de port", "Frais bancaires", "Frais de gestion"]) {
      const result = plan(extraction({ ht: 1000, tva: 200, ttc: 1200, lineItems: [item(label, 100000)] }));
      expect(result.lines[0].disbursement, `${label} must not be read as a disbursement`).toBe(false);
    }
  });

  test("the wordings that do mean a disbursement are recognised", () => {
    // These name money advanced on the client's behalf, which "frais" alone
    // does not. Each is tested through the plan, not through the regexp.
    for (const label of ["Débours à l'identique", "Debours", "Frais avancés pour le compte du client", "Avances pour compte"]) {
      const result = plan(extraction({
        ht: 1500, tva: 200, ttc: 1700,
        lineItems: [item("Honoraires", 100000), item(label, 50000)],
      }));
      const line = result.lines.find((candidate) => candidate.description.startsWith(label.slice(0, 8)));
      expect(line?.disbursement, `${label} should be read as a disbursement`).toBe(true);
    }
  });

  /* --------------------------------- 6. the field has to reach the plan */

  test("a disbursement read by the recogniser and dropped by the plan is a failure", () => {
    // The test that would have caught a cosmetic implementation: the value is
    // present in the extraction, so the assertion is about the *plan's* field.
    const extracted = extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 });
    expect(extracted.fields.debours).toBe(2142.76);
    const result = plan(extracted);
    expect(result.deboursCents).not.toBe("0");
    expect(result.deboursCents).toBe("214276");
  });

  /* ------------------------------- 8. telling the totals apart */

  test("the payable total is not mistaken for the taxable total", () => {
    // 7 542,76 is what the client pays; 5 400,00 is what carries VAT. An
    // implementation that took the largest printed number as the taxable TTC
    // would post 2 142,76 of turnover that does not exist.
    const result = plan(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }));
    const taxableTtc = BigInt(result.htCents) - BigInt(result.deboursCents) + BigInt(result.vatCents);
    expect(taxableTtc).toBe(540000n);
    expect(BigInt(result.ttcCents)).toBe(754276n);
  });

  test("a disbursement that does not reconcile with the totals is refused, not absorbed", () => {
    // 4 500 + 900 + 2 000 is not 7 542,76. Wheat does not quietly adjust the
    // disbursement to close the gap.
    const error = refusal(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2000 }));
    expect(error.code).toBe("TOTALS_INCONSISTENT");
    expect(error.message).toContain("débours");
  });

  test("a negative disbursement is refused", () => {
    expect(refusal(extraction({ ht: 4500, tva: 900, ttc: 3400, debours: -2000 })).code).toBe("TOTALS_INVALID");
  });

  /* ------------------------------- 9. the amount survives an open question */

  test("an uncertain tax treatment never costs the amount that was read", () => {
    // The rule the brief asks for: preserve the extracted disbursement, put the
    // treatment to a person, and do not discard the invoice over it. The amount
    // reaches the plan and its own line; what the plan does *not* do is decide
    // the VAT consequence, which is why the line carries a third-party account
    // and a warning rather than a tax position.
    const result = plan(extraction({ ht: 4500, tva: 900, ttc: 7542.76, debours: 2142.76 }));
    expect(result.deboursCents).toBe("214276");
    expect(result.warnings.some((warning) => warning.includes("débours"))).toBe(true);
    expect(result.lines.find((line) => line.disbursement).accountRole).toBe("DISBURSEMENT");
  });
});
