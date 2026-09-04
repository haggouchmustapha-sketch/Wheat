/**
 * The assisted pass on a scanned statement, and the limits placed on it.
 *
 * The fallback exists because a scan can defeat the local reader outright — a
 * fold across the amount column, a page photographed at an angle. What it must
 * never do is turn "Wheat could not read this" into a number an accountant
 * trusts. So the tests here are mostly about refusal: a value that is not on
 * the page, a cell the local path already read, a row proposed with both a
 * debit and a credit, a row nobody asked about.
 *
 * The chat channel is a stub. There is no network here and no model: the point
 * is the gate around the answer, not the answer.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const fallback = tsxRequire(path.join(root, "electron", "bankStatementAiFallback.ts"), __filename);

const MAPPING = { date: "DATE", valueDate: "VALEUR", label: "LIBELLE", debit: "DEBIT", credit: "CREDIT" };

const RECOGNISED_TEXT = [
  "RELEVE DE COMPTE",
  "0016CP 25 06 VIREMENT RECU DE BRIGADE 25 06 2026 18 334,42",
  "0016MI 26 06 PAIEMENT CB CMH BENGUERIR 26 06 2026 600,00",
  "0016M1 29 06 PAIEMENT CB ELECTROPLANET 29 06 2026 8 998,00",
  "TOTAL MOUVEMENTS 9 598,00 18 334,42",
].join("\n");

function table() {
  return {
    headers: ["DATE", "LIBELLE", "VALEUR", "DEBIT", "CREDIT"],
    rows: [
      { DATE: "25 06", LIBELLE: "VIREMENT RECU DE BRIGADE", VALEUR: "25 06 2026", DEBIT: "", CREDIT: "18 334,42" },
      { DATE: "26 06", LIBELLE: "PAIEMENT CB CMH BENGUERIR", VALEUR: "", DEBIT: "", CREDIT: "" },
      { DATE: "", LIBELLE: "PAIEMENT CB ELECTROPLANET", VALEUR: "29 06 2026", DEBIT: "", CREDIT: "" },
    ],
    warnings: [],
  };
}

const isMovement = () => true;

function stubChat(payload) {
  return async () => ({ text: JSON.stringify(payload), provider: "STUB", modelId: "stub-model" });
}

test("only the rows the local reader could not finish are asked about", () => {
  const incomplete = fallback.incompleteMovementRows(table(), MAPPING, isMovement);
  // Row 1 is complete: it has a date and a credit. Rows 2 and 3 are not.
  expect(incomplete).toEqual([2, 3]);

  // A statement Wheat read completely asks nothing at all.
  const complete = {
    headers: ["DATE", "LIBELLE", "DEBIT", "CREDIT"],
    rows: [{ DATE: "25 06", LIBELLE: "X", DEBIT: "", CREDIT: "10,00" }],
    warnings: [],
  };
  expect(fallback.incompleteMovementRows(complete, MAPPING, isMovement)).toEqual([]);
});

test("nothing is asked, and nothing changes, when there is nothing to complete", async () => {
  let called = false;
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [],
    chat: async () => { called = true; return { text: "{}", provider: "STUB", modelId: "stub" }; },
  });
  expect(called).toBe(false);
  expect(result.applied).toBe(false);
  expect(result.filledRows).toEqual([]);
});

test("values found on the page fill the empty cells and are flagged for review", async () => {
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2, 3],
    chat: stubChat({
      rows: [
        { index: 2, debit: "600,00", valueDate: "26 06 2026" },
        { index: 3, date: "29 06", debit: "8 998,00" },
      ],
    }),
  });

  expect(result.applied).toBe(true);
  expect(result.filledRows).toEqual([2, 3]);
  expect(result.table.rows[1].DEBIT).toBe("600,00");
  expect(result.table.rows[1].VALEUR).toBe("26 06 2026");
  expect(result.table.rows[2].DATE).toBe("29 06");
  expect(result.table.rows[2].DEBIT).toBe("8 998,00");
  // The row that was already readable is untouched.
  expect(result.table.rows[0]).toEqual(table().rows[0]);
  // And the reader is told, by row number, what was not read off the page.
  expect(result.table.warnings.join(" ")).toMatch(/Relecture assistée par Wheat AI.*2, 3/);
});

test("a value that is not on the page is refused", async () => {
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2, 3],
    chat: stubChat({ rows: [{ index: 2, debit: "4 250,00" }, { index: 3, debit: "77 777,00" }] }),
  });
  expect(result.applied).toBe(false);
  expect(result.table.rows[1].DEBIT).toBe("");
  expect(result.table.rows[2].DEBIT).toBe("");
  expect(result.notes.join(" ")).toMatch(/absente du texte reconnu/i);
});

test("a cell the local reader already read is never replaced", async () => {
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    // Row 1 is deliberately included to prove the rule holds even when asked.
    rowNumbers: [1, 2],
    chat: stubChat({ rows: [{ index: 1, credit: "600,00" }, { index: 2, debit: "600,00" }] }),
  });
  expect(result.table.rows[0].CREDIT).toBe("18 334,42");
  expect(result.table.rows[1].DEBIT).toBe("600,00");
});

test("a row proposed with both a debit and a credit is left as the local reader left it", async () => {
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2],
    chat: stubChat({ rows: [{ index: 2, debit: "600,00", credit: "18 334,42" }] }),
  });
  expect(result.applied).toBe(false);
  expect(result.table.rows[1].DEBIT).toBe("");
  expect(result.table.rows[1].CREDIT).toBe("");
  expect(result.notes.join(" ")).toMatch(/débit et un crédit sur la même ligne/i);
});

test("rows outside the request, and replies that are not JSON, change nothing", async () => {
  const outside = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2],
    chat: stubChat({ rows: [{ index: 3, date: "29 06" }] }),
  });
  expect(outside.applied).toBe(false);
  expect(outside.table.rows[2].DATE).toBe("");

  const prose = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2],
    chat: async () => ({ text: "Je ne peux pas lire ce relevé.", provider: "STUB", modelId: "stub" }),
  });
  expect(prose.applied).toBe(false);
  expect(prose.notes.join(" ")).toMatch(/n'a pas renvoyé de lignes exploitables/i);
});

test("a provider failure leaves the local reading intact and says so", async () => {
  const result = await fallback.completeBankTableWithAi({
    table: table(),
    mapping: MAPPING,
    recognisedText: RECOGNISED_TEXT,
    rowNumbers: [2],
    chat: async () => { throw new Error("réseau indisponible"); },
  });
  expect(result.applied).toBe(false);
  expect(result.table.rows[1].DEBIT).toBe("");
  expect(result.notes.join(" ")).toMatch(/Relecture assistée indisponible/i);
});
