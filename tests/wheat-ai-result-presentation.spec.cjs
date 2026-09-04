/*
 * Wheat AI runs a typed capability and then has to answer the person who asked.
 *
 * It used to stop one step short: the capability returned its rows, the window
 * showed a card reading `reports.aged_payables` and "Terminee", and the
 * accountant who asked which suppliers were unpaid never saw a supplier. These
 * tests hold the answer contract that closed that gap — the result is described
 * from its own shape, deterministically, with no model involved, and a
 * capability identifier is never the answer.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { describeCapabilityResult } = tsxRequire(
  path.join(cwd, "electron", "wheatAiResultPresentation.ts"),
  __filename,
);

const agedPayables = {
  id: "reports.aged_payables",
  description: "Calculer l'anciennete fournisseurs.",
};

/** The shape `deriveAgingReport` actually returns, trimmed to what is read. */
function agingResult(counterparties) {
  return {
    reportType: "AGED_PAYABLES",
    asOf: "2026-09-03",
    currency: "MAD",
    rows: [],
    counterparties,
    totals: {
      originalCents: "0",
      allocatedCents: "0",
      outstandingCents: counterparties
        .reduce((sum, item) => sum + BigInt(item.outstandingCents), 0n)
        .toString(),
      overpaidCents: "0",
    },
    exclusions: { legacyExcludedCount: 0 },
  };
}

test("an aged-payables result answers with the suppliers and their amounts", () => {
  const presentation = describeCapabilityResult(
    agedPayables,
    agingResult([
      { counterpartyId: "c1", displayName: "Maroc Telecom SARL", invoiceCount: 2, outstandingCents: "1440000" },
      { counterpartyId: "c2", displayName: "Papeterie Atlas", invoiceCount: 1, outstandingCents: "23550" },
    ]),
  );

  expect(presentation.kind).toBe("table");
  const table = presentation.tables.find((item) => item.rows.length === 2);
  expect(table, JSON.stringify(presentation)).toBeTruthy();

  const rendered = JSON.stringify(table.rows);
  expect(rendered).toContain("Maroc Telecom SARL");
  expect(rendered).toContain("Papeterie Atlas");
  // Exact centimes, formatted for a reader, never through a float.
  // The thousands separator is a narrow no-break space, so it is named
  // rather than typed: an ordinary space here would pass by accident.
  expect(rendered).toContain(`14${String.fromCharCode(0x202f)}400,00 MAD`);
  expect(rendered).toContain("235,50 MAD");

  // The heading names the work, not the capability.
  const headings = table.columns.map((column) => column.label);
  expect(headings).toContain("Tiers");
  expect(headings).toContain("Encours");
  expect(headings).not.toContain("counterpartyId");
});

test("nothing in the answer exposes a capability identifier or a raw key", () => {
  const presentation = describeCapabilityResult(
    agedPayables,
    agingResult([{ counterpartyId: "c1", displayName: "Maroc Telecom SARL", invoiceCount: 1, outstandingCents: "100" }]),
  );

  const everything = JSON.stringify(presentation);
  expect(everything).not.toContain("reports.aged_payables");
  expect(everything).not.toContain("aged_payables");
  // A cuid is not an answer: identifier columns are dropped when the row has
  // anything else to show.
  expect(everything).not.toContain("c1");
});

test("an empty result says plainly that nothing matched", () => {
  const presentation = describeCapabilityResult(agedPayables, agingResult([]));

  expect(presentation.kind).toBe("none");
  expect(presentation.summary.toLowerCase()).toContain("aucun");
  expect(presentation.tables).toEqual([]);
  // The question was still answered against real figures, so the totals stay.
  expect(presentation.facts.length).toBeGreaterThan(0);
});

test("a list capability answers with its rows", () => {
  const presentation = describeCapabilityResult(
    { id: "invoices.list", description: "Lister les factures." },
    [
      { number: "FA-2026/0001", date: "2026-05-20", ttccents: "14400", status: "POSTED" },
      { number: "FA-2026/0002", date: "2026-06-02", ttccents: "23550", status: "DRAFT" },
    ],
  );

  expect(presentation.kind).toBe("table");
  expect(presentation.tables[0].rows).toHaveLength(2);
  // An ISO date is shown the way an accountant writes one.
  expect(JSON.stringify(presentation.tables[0].rows)).toContain("20/05/2026");
});

test("centimes beyond 2^53 survive the description exactly", () => {
  const huge = "123456789012345678901";
  const presentation = describeCapabilityResult(
    { id: "reports.trial_balance", description: "Editer la balance." },
    { currency: "MAD", rows: [{ accountcode: "5141", amountCents: huge }] },
  );

  const cell = presentation.tables[0].rows[0].amountCents;
  // Grouping separators and the decimal comma aside, every digit is preserved.
  expect(cell.replace(/[^0-9]/g, "")).toBe(huge);
});

test("a navigation result is not reported as data", () => {
  const presentation = describeCapabilityResult(
    { id: "navigation.open", description: "Ouvrir un ecran." },
    { navigation: { target: "banking", entityId: null } },
  );

  expect(presentation.kind).toBe("navigation");
  expect(presentation.tables).toEqual([]);
});

test("a result that cannot be rendered says so rather than inventing one", () => {
  const presentation = describeCapabilityResult({ id: "x.y", description: "Faire quelque chose." }, null);

  expect(presentation.kind).toBe("none");
  expect(presentation.summary).toBeTruthy();
  expect(presentation.tables).toEqual([]);
});

test("a column whose values cannot be shown faithfully is dropped, not stringified", () => {
  const presentation = describeCapabilityResult(
    { id: "x.y", description: "Faire quelque chose." },
    { rows: [{ label: "Ligne", payload: { deeply: { nested: true } } }] },
  );

  const rendered = JSON.stringify(presentation);
  expect(rendered).not.toContain("[object Object]");
  expect(presentation.tables[0].columns.map((column) => column.key)).toEqual(["label"]);
});
