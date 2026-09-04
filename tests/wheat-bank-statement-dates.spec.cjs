/**
 * A Moroccan bank statement that states its year once.
 *
 * The Attijariwafa "RELEVE DE COMPTE BANCAIRE" prints the operation date as a
 * bare day and month — "25 06" — and writes the year elsewhere on the same
 * page: in full in the value-date column, and again in the closing-balance
 * line, "SOLDE FINAL AU 30 06 2026". Wheat looked for the year only in the
 * operation-date column, which is the one place that statement never writes it,
 * so every date failed, every row was rejected, and a perfectly ordinary
 * statement could not be imported at all.
 *
 * These tests pin the reading of that shape end to end, and — more importantly
 * — pin the limits of it. Inferring a year is inventing data unless the
 * document establishes it, so the cases that must *fail* carry as much weight
 * here as the ones that must succeed: a statement that names no year, a
 * statement that names two, four digits that are not a day and a month.
 *
 * The second failure this covers is the block of registration text every bank
 * prints at the foot of the page. It says nothing any keyword rule was looking
 * for, so it was read as a transaction, rejected for having no date, and
 * reported as an error that blocked the import. The rule that catches it is
 * structural rather than lexical — a line that moves no money is not a movement
 * — because the next statement will be from a different bank.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const reconciliation = tsxRequire(path.join(root, "electron", "reconciliation.ts"), __filename);
const dates = tsxRequire(path.join(root, "electron", "dateNormalization21.ts"), __filename);

const MAPPING = {
  date: "DATE",
  valueDate: "VALEUR",
  label: "LIBELLE",
  reference: "CODE",
  debit: "DEBIT",
  credit: "CREDIT",
};

/** The statement from the report, including everything printed under it. */
function attijariwafaStatement() {
  return [
    { CODE: "101", DATE: "25 06", LIBELLE: "VIREMENT RECU IFCOF", VALEUR: "25 06 2026", DEBIT: "", CREDIT: "12 500,00" },
    { CODE: "204", DATE: "29 06", LIBELLE: "CHEQUE 4412207", VALEUR: "29 06 2026", DEBIT: "3 200,00", CREDIT: "" },
    { CODE: "310", DATE: "3006", LIBELLE: "COMMISSION TENUE DE COMPTE", VALEUR: "06 2026", DEBIT: "120,00", CREDIT: "" },
    { CODE: "", DATE: "$30 06", LIBELLE: "FRAIS DE VIREMENT", VALEUR: "30 06 2026", DEBIT: "15,00", CREDIT: "" },
    { CODE: "", DATE: "", LIBELLE: "TOTAL MOUVEMENTS", VALEUR: "", DEBIT: "3 335,00", CREDIT: "12 500,00" },
    { CODE: "", DATE: "", LIBELLE: "SOLDE FINAL AU 30 06 2026", VALEUR: "", DEBIT: "", CREDIT: "9 165,00" },
    { CODE: "", DATE: "", LIBELLE: "Attijariwafa bank societe anonyme a directoire et a conseil de surveillance au capital de 2 098 596 790 DH - RC 333 - IF 01084160 - ICE 001542903000027", VALEUR: "", DEBIT: "", CREDIT: "" },
    { CODE: "", DATE: "", LIBELLE: "2, boulevard Moulay Youssef - 20000 Casablanca - Maroc", VALEUR: "", DEBIT: "", CREDIT: "" },
  ];
}

function normalize(rows, mapping = MAPPING) {
  return reconciliation.normalizeStatementRows({ bankAccountId: "bank_attijari", rows, mapping });
}

test.describe("the statement that could not be imported", () => {
  test("imports every movement instead of refusing the file", () => {
    const movements = normalize(attijariwafaStatement());
    expect(movements).toHaveLength(4);
    expect(movements.map((movement) => movement.date.toISOString().slice(0, 10))).toEqual([
      "2026-06-25", "2026-06-29", "2026-06-30", "2026-06-30",
    ]);
  });

  test("takes the year from the statement, not from today", () => {
    const [first] = normalize(attijariwafaStatement());
    expect(first.date.getUTCFullYear()).toBe(2026);
    // Flagged, because 2026 was not printed on that cell.
    expect(first.dateInferred).toBe(true);
  });

  test("keeps what the page actually said", () => {
    const movements = normalize(attijariwafaStatement());
    expect(movements[0].operationDateRaw).toBe("25 06");
    // Including the recognition artefact: the repair is recorded, not hidden.
    expect(movements[3].operationDateRaw).toBe("$30 06");
  });

  test("reads the amounts as exact centimes on both sides", () => {
    const movements = normalize(attijariwafaStatement());
    expect(movements.map((movement) => movement.amountCents)).toEqual([1250000n, -320000n, -12000n, -1500n]);
  });
});

test.describe("lines that are not movements", () => {
  test("leaves the totals and balances out of the movements", () => {
    const labels = normalize(attijariwafaStatement()).map((movement) => movement.label);
    expect(labels).not.toContain("TOTAL MOUVEMENTS");
    expect(labels.some((label) => label.startsWith("SOLDE FINAL"))).toBe(false);
  });

  test("does not read the bank's registration footer as a transaction", () => {
    const rows = attijariwafaStatement();
    expect(reconciliation.classifyStatementRow(rows[6], { mapping: MAPPING })).toBe("FOOTER");
    expect(reconciliation.classifyStatementRow(rows[7], { mapping: MAPPING })).toBe("FOOTER");
  });

  test("a footer does not become a blocking 'date is empty' error", () => {
    // The whole failure: metadata rejected as a transaction, and the rejection
    // reported as a fault in the statement.
    expect(() => normalize(attijariwafaStatement())).not.toThrow();
  });

  test("a movement with an unreadable date stays a movement", () => {
    // It must reach the review as a problem to settle, never be filed away as
    // metadata because Wheat could not read it.
    const row = { CODE: "99", DATE: "3O O6", LIBELLE: "PRELEVEMENT", VALEUR: "", DEBIT: "500,00", CREDIT: "" };
    expect(reconciliation.classifyStatementRow(row, { mapping: MAPPING })).toBe("TRANSACTION");
  });
});

test.describe("what the year may be inferred from", () => {
  test("a full date in the value column establishes it", () => {
    const rows = [{ CODE: "1", DATE: "25 06", LIBELLE: "X", VALEUR: "25 06 2026", DEBIT: "", CREDIT: "10,00" }];
    expect(reconciliation.inferStatementYear(rows, MAPPING)).toBe(2026);
  });

  test("the closing-balance line establishes it", () => {
    const rows = [
      { CODE: "1", DATE: "25 06", LIBELLE: "X", VALEUR: "", DEBIT: "", CREDIT: "10,00" },
      { CODE: "", DATE: "", LIBELLE: "SOLDE FINAL AU 30 06 2026", VALEUR: "", DEBIT: "", CREDIT: "9 165,00" },
    ];
    expect(reconciliation.inferStatementYear(rows, MAPPING)).toBe(2026);
  });

  test("a statement that states no year anywhere infers none", () => {
    const rows = [{ CODE: "1", DATE: "25 06", LIBELLE: "X", VALEUR: "", DEBIT: "", CREDIT: "10,00" }];
    expect(reconciliation.inferStatementYear(rows, MAPPING)).toBeNull();
    expect(() => normalize(rows)).toThrow(/aucun contexte/i);
  });

  test("a statement spanning two years infers none rather than guessing", () => {
    const rows = [
      { CODE: "1", DATE: "28 12 2025", LIBELLE: "X", VALEUR: "", DEBIT: "", CREDIT: "10,00" },
      { CODE: "2", DATE: "03 01 2026", LIBELLE: "Y", VALEUR: "", DEBIT: "", CREDIT: "10,00" },
    ];
    expect(reconciliation.inferStatementYear(rows, MAPPING)).toBeNull();
  });

  test("does not mine a year out of a transaction description", () => {
    // "REF 2019" is a reference, not a period. Reading a year from prose is how
    // a statement acquires a date nobody printed.
    const rows = [{ CODE: "1", DATE: "25 06", LIBELLE: "VIREMENT MARCHE 12 05 2019", VALEUR: "", DEBIT: "", CREDIT: "10,00" }];
    expect(reconciliation.inferStatementYear(rows, MAPPING)).toBeNull();
  });
});

test.describe("recognition artefacts in a date cell", () => {
  const context = { year: 2026 };

  test("a lost separator is restored when the year is known", () => {
    expect(dates.normalizeFlexibleDate("3006", context)).toMatchObject({ iso: "2026-06-30", raw: "3006", repaired: true });
  });

  test("a stray symbol in front of the digits is removed", () => {
    expect(dates.normalizeFlexibleDate("$30 06", context)).toMatchObject({ iso: "2026-06-30", raw: "$30 06", repaired: true });
  });

  test("four digits that are not a day and a month are refused", () => {
    // "2026" is day 20 of month 26. It must not become a date.
    expect(() => dates.normalizeFlexibleDate("2026", context)).toThrow();
    expect(() => dates.normalizeFlexibleDate("9999", context)).toThrow();
  });

  test("a lost separator is not guessed at without a year", () => {
    expect(() => dates.normalizeFlexibleDate("3006")).toThrow(/aucun contexte/i);
  });

  test("a letter read where a digit belongs stays an error", () => {
    // Trimming the ends cannot fix a misread character inside the value, and
    // pretending otherwise would put a wrong date in the books.
    expect(() => dates.normalizeFlexibleDate("3O 06", context)).toThrow();
  });

  test("a month and a year with no day is not completed", () => {
    // "06 2026" names a period, not a day. Wheat has no basis for choosing one.
    expect(() => dates.normalizeFlexibleDate("06 2026", context)).toThrow();
  });

  test("a clean date is not marked as repaired", () => {
    expect(dates.normalizeFlexibleDate("30/06/2026")).toMatchObject({ repaired: false, inferred: false });
  });
});

test.describe("an unreadable value date", () => {
  test("does not reject a movement whose own date is sound", () => {
    // The value date decides interest, never the posting. Losing the column to
    // a bad scan must not cost the movement.
    const rows = [{ CODE: "1", DATE: "25 06 2026", LIBELLE: "X", VALEUR: "06 2026", DEBIT: "", CREDIT: "10,00" }];
    const [movement] = normalize(rows);
    expect(movement.date.toISOString().slice(0, 10)).toBe("2026-06-25");
    expect(movement.valueDate).toBeNull();
  });

  test("is kept verbatim and flagged for review", () => {
    const rows = [{ CODE: "1", DATE: "25 06 2026", LIBELLE: "X", VALEUR: "06 2026", DEBIT: "", CREDIT: "10,00" }];
    const [movement] = normalize(rows);
    expect(movement.valueDateRaw).toBe("06 2026");
    expect(movement.dateInferred).toBe(true);
  });

  test("a readable value date is still read", () => {
    const rows = [{ CODE: "1", DATE: "25 06 2026", LIBELLE: "X", VALEUR: "26 06 2026", DEBIT: "", CREDIT: "10,00" }];
    const [movement] = normalize(rows);
    expect(movement.valueDate.toISOString().slice(0, 10)).toBe("2026-06-26");
    expect(movement.dateInferred).toBe(false);
  });
});
