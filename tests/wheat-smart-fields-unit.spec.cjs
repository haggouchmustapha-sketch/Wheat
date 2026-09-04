/**
 * What the correction screen shows, and what it sends back.
 *
 * The bug this suite pins is not an OCR bug. The recogniser read Débours, the
 * draft planner needed Débours, and the one screen between them — the screen
 * whose entire purpose is correcting an extraction — kept a hand-maintained
 * list of field names that did not include it. The field was read, stored,
 * and then invisible: an accountant looking at an IFCOF invoice that Wheat
 * refused as unbalanced had no box in which to fix the amount that unbalanced
 * it.
 *
 * So these tests assert the *form*, not the parser. `wheat-debours.spec.cjs`
 * already proves the amount survives recognition and planning; what follows
 * proves it survives the user interface, which is where it was being lost.
 *
 * The second thing pinned here is the basis-point round trip. `vatRate` travels
 * as 2000 for 20 % because that is what the planner reads back. Rendering the
 * stored number raw in a box labelled "Taux de TVA" would invite a correction
 * to "20" that the planner reads as 0,2 % — a plausible-looking edit that
 * silently changes the tax on the entry.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const {
  visibleSmartFields,
  stringifyFields,
  smartFieldToInput,
  smartFieldFromInput,
  smartFieldLabels,
  readSmartFields,
} = tsxRequire(path.join(root, "src", "lib", "smartFields.ts"), __filename);

/** The shape `smartOcr.ts` stores on Document.extracted for an invoice. */
function invoiceExtraction(overrides = {}) {
  return {
    documentType: "INVOICE",
    fields: {
      date: "2026-08-12",
      invoiceNumber: "39/2026",
      reference: "39/2026",
      counterparty: "CABINET IFCOF",
      supplier: "CABINET IFCOF",
      client: null,
      ice: "000187958000077",
      if: "1110375",
      supplierRc: "193109",
      supplierTp: null,
      supplierCnss: null,
      ht: 4500,
      tva: 900,
      ttc: 7542.76,
      debours: 2142.76,
      discount: null,
      netPaid: 7542.76,
      paymentTerms: "Virement",
      dueDate: null,
      currency: "MAD",
      vatRate: 2000,
      ...overrides,
    },
  };
}

test.describe("fields the correction screen offers", () => {
  test("shows Débours for an invoice that carries one", () => {
    const extraction = invoiceExtraction();
    const keys = visibleSmartFields(readSmartFields(extraction), "INVOICE");
    expect(keys).toContain("debours");
    // Next to the other totals, not appended after the payroll fields.
    expect(keys.indexOf("debours")).toBeGreaterThan(keys.indexOf("tva"));
    expect(keys.indexOf("debours")).toBeLessThan(keys.indexOf("ttc"));
  });

  test("offers Débours even when the recogniser read none", () => {
    // The accountant must be able to enter what Wheat missed; an absent box is
    // indistinguishable from an unsupported concept.
    const keys = visibleSmartFields({ ht: 4500, tva: 900, ttc: 5400 }, "INVOICE");
    expect(keys).toContain("debours");
    expect(keys).toContain("discount");
    expect(keys).toContain("vatRate");
  });

  test("carries every other field the pipeline reads but the old list omitted", () => {
    const keys = visibleSmartFields(readSmartFields(invoiceExtraction()), "INVOICE");
    for (const key of ["netPaid", "discount", "vatRate", "supplierRc"]) {
      expect(keys, `${key} must be correctable`).toContain(key);
    }
  });

  test("does not put payroll boxes on an invoice, nor invoice boxes on a payslip", () => {
    const invoice = visibleSmartFields(readSmartFields(invoiceExtraction()), "INVOICE");
    expect(invoice).not.toContain("amo");
    expect(invoice).not.toContain("gross");

    const payslip = visibleSmartFields({ employee: "A. Haggouch", gross: 12000, net: 9800 }, "PAYROLL");
    expect(payslip).toContain("gross");
    expect(payslip).not.toContain("ttc");
  });

  test("shows a field it has never heard of rather than dropping it", () => {
    const keys = visibleSmartFields({ ht: 1, someFutureField: "x" }, "INVOICE");
    expect(keys).toContain("someFutureField");
  });

  test("every offered field has a human label", () => {
    const keys = visibleSmartFields(readSmartFields(invoiceExtraction()), "INVOICE");
    for (const key of keys) {
      expect(smartFieldLabels[key], `${key} needs a label`).toBeTruthy();
    }
  });
});

test.describe("what the form holds and returns", () => {
  test("the editable snapshot keeps the disbursement, exactly", () => {
    const extraction = invoiceExtraction();
    const keys = visibleSmartFields(readSmartFields(extraction), "INVOICE");
    const form = stringifyFields(readSmartFields(extraction), keys);
    expect(form.debours).toBe("2142.76");
    expect(form.ht).toBe("4500");
    expect(form.ttc).toBe("7542.76");
  });

  test("keeps a stored field even when the screen has no box for it", () => {
    const extraction = invoiceExtraction({ unknownVendorField: "keep me" });
    const form = stringifyFields(readSmartFields(extraction), ["ht", "tva"]);
    expect(form.unknownVendorField).toBe("keep me");
  });

  test("an absent amount is an empty box, not a zero", () => {
    // "0,00" is an accounting claim. A field nobody read is not one.
    const form = stringifyFields(readSmartFields(invoiceExtraction()), ["discount"]);
    expect(form.discount).toBe("");
  });
});

test.describe("VAT rate basis points", () => {
  test("is shown as a percentage", () => {
    expect(smartFieldToInput("vatRate", 2000)).toBe("20");
    expect(smartFieldToInput("vatRate", 1000)).toBe("10");
    expect(smartFieldToInput("vatRate", 700)).toBe("7");
  });

  test("is stored back as basis points", () => {
    expect(smartFieldFromInput("vatRate", "20")).toBe(2000);
    expect(smartFieldFromInput("vatRate", "10")).toBe(1000);
    expect(smartFieldFromInput("vatRate", "7")).toBe(700);
  });

  test("accepts the comma a French keyboard produces", () => {
    expect(smartFieldFromInput("vatRate", "8,25")).toBe(825);
  });

  test("round-trips without drift", () => {
    for (const bps of [0, 700, 1000, 1400, 2000]) {
      expect(smartFieldFromInput("vatRate", smartFieldToInput("vatRate", bps))).toBe(bps);
    }
  });

  test("an emptied rate is absent, not zero percent", () => {
    // `documentInvoiceDraft.ts` distinguishes these: a null rate means the
    // document printed none, a 0 rate means a genuine exemption.
    expect(smartFieldFromInput("vatRate", "")).toBeNull();
    expect(smartFieldFromInput("vatRate", "0")).toBe(0);
  });

  test("leaves other fields as typed", () => {
    expect(smartFieldFromInput("ht", "4500.50")).toBe("4500.50");
    expect(smartFieldFromInput("counterparty", " CABINET IFCOF ")).toBe(" CABINET IFCOF ");
  });
});
