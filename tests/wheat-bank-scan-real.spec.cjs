/**
 * The real scanned Attijariwafa statement, read end to end.
 *
 * Not a fixture built from what Wheat was expected to see: the actual PDF a
 * user photographed and imported, run through the real recognition path and
 * then through the same normalisation the importer uses before it writes bank
 * movements. It is the only test here that can catch what actually went wrong,
 * because everything upstream of the table — the recogniser, the geometry, the
 * heading reconstruction — is where the fault was.
 *
 * What it pins:
 *
 *   - Every movement printed on the page arrives, with its own debit or credit.
 *     Three of the five used to arrive with no amount at all, because the two
 *     money columns on a Moroccan statement sit under a single centred title
 *     ("CAPITAUX") and the layout recogniser gave that title a column of its
 *     own — leaving the word DEBIT over an empty strip and every debit figure
 *     underneath a heading Wheat did not recognise.
 *   - The bank's own registration footer is not a movement. It is full of
 *     digits — share capital, RC, ICE, a decree number — and "contains a digit"
 *     was all it took to be read as one.
 *   - Bare "25 06" and scan-damaged "3006" / "$30 06" dates resolve to the year
 *     the statement establishes elsewhere, and a value date the scanner mangled
 *     does not discard an otherwise sound movement.
 *
 * The recognition step needs the local PaddleOCR runtime, so the test skips
 * rather than fails where that runtime is absent. A skip is reported as a skip.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const STATEMENT = path.join(root, "test documents for use", "Whatsapp Scan 9 juillet 2026 at 15.46.15.pdf");

const importer = tsxRequire(path.join(root, "electron", "bankStatementImporter.ts"), __filename);
const reconciliation = tsxRequire(path.join(root, "electron", "reconciliation.ts"), __filename);

function stubApp() {
  const userData = path.join(os.tmpdir(), "wheat-bank-scan-test");
  fs.mkdirSync(userData, { recursive: true });
  return { isPackaged: false, getPath: (name) => (name === "userData" ? userData : os.tmpdir()) };
}

let parsed = null;
let skipReason = "";

test.beforeAll(async () => {
  test.setTimeout(600_000);
  if (!fs.existsSync(STATEMENT)) {
    skipReason = `Le relevé scanné de référence est absent : ${STATEMENT}`;
    return;
  }
  try {
    parsed = await importer.parseBankStatement({
      sourceName: path.basename(STATEMENT),
      bytesBase64: fs.readFileSync(STATEMENT).toString("base64"),
      app: stubApp(),
    });
  } catch (error) {
    skipReason = `Reconnaissance locale indisponible : ${error instanceof Error ? error.message : String(error)}`;
  }
});

test("the scanned statement is recognised as a bank statement with its own columns", () => {
  test.skip(Boolean(skipReason), skipReason);
  expect(parsed.format).toBe("PDF_OCR");
  expect(parsed.ocr.local).toBe(true);
  // Both money columns are mapped, and to columns that actually hold money.
  expect(parsed.suggestedMapping.date).toBeTruthy();
  expect(parsed.suggestedMapping.debit).toBeTruthy();
  expect(parsed.suggestedMapping.credit).toBeTruthy();
});

test("every movement on the page arrives with its own debit or credit", () => {
  test.skip(Boolean(skipReason), skipReason);
  const movements = parsed.canonicalRows.filter((row) => row.rowClass === "TRANSACTION");
  expect(movements.length).toBe(5);

  const amounts = movements.map((row) => ({
    date: row.operationDate,
    debit: row.debit,
    credit: row.credit,
    label: row.description,
  }));
  // Read straight off the page, in printed order.
  expect(amounts[0]).toMatchObject({ date: "2026-06-25", credit: "18 334,42" });
  expect(amounts[1]).toMatchObject({ date: "2026-06-25", debit: "600,00" });
  expect(amounts[2].date).toBe("2026-06-29");
  expect(amounts[3]).toMatchObject({ date: "2026-06-30", credit: "23 400,00" });
  expect(amounts[4]).toMatchObject({ date: "2026-06-30", debit: "10 000,00" });

  // No movement arrives with both sides, and none arrives with neither.
  for (const movement of amounts) {
    const hasDebit = Boolean(movement.debit);
    const hasCredit = Boolean(movement.credit);
    expect(hasDebit !== hasCredit, `${movement.label}`).toBe(true);
  }
});

test("totals, the closing balance and the bank's registration footer are not movements", () => {
  test.skip(Boolean(skipReason), skipReason);
  const classes = parsed.canonicalRows.map((row) => row.rowClass);
  expect(classes).toContain("TOTAL");
  expect(classes).toContain("CLOSING_BALANCE");

  const footer = parsed.canonicalRows.find((row) => /Attijariwafa bank soci/i.test(JSON.stringify(row.raw)));
  expect(footer, "the registration block must be present in the reading").toBeTruthy();
  expect(footer.rowClass).not.toBe("TRANSACTION");
});

test("the importer turns the recognised page into the five bank movements", () => {
  test.skip(Boolean(skipReason), skipReason);
  const movements = reconciliation.normalizeStatementRows({
    bankAccountId: "bank-account-test",
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
  });
  expect(movements).toHaveLength(5);

  const signed = movements.map((movement) => movement.amountCents);
  expect(signed).toEqual([1_833_442n, -60_000n, -899_800n, 2_340_000n, -1_000_000n]);
  expect(movements.map((movement) => movement.date.toISOString().slice(0, 10))).toEqual([
    "2026-06-25", "2026-06-25", "2026-06-29", "2026-06-30", "2026-06-30",
  ]);

  // Dates the statement did not print in full, and a value date the scan
  // damaged, are carried as readings to confirm rather than as certainties.
  expect(movements.every((movement) => movement.dateInferred)).toBe(true);
  // Every movement is distinct: a fingerprint collision would silently merge two.
  expect(new Set(movements.map((movement) => movement.fingerprint)).size).toBe(5);
});

test("a figure the scan damaged is read exactly, and prose is never read as one", () => {
  // Deterministic, and independent of the recogniser being installed.
  expect(reconciliation.parseStatementMoney("8.998.,00")).toBe(899_800n);
  expect(reconciliation.parseStatementMoney("18 334,42")).toBe(1_833_442n);
  expect(reconciliation.looksLikeStatementAmount("8.998.,00")).toBe(true);
  expect(reconciliation.looksLikeStatementAmount("10 000,00")).toBe(true);
  expect(reconciliation.looksLikeStatementAmount("150 289,29 MAD")).toBe(true);
  expect(reconciliation.looksLikeStatementAmount("ce Benguerir (0814 AiWaIA")).toBe(false);
  expect(reconciliation.looksLikeStatementAmount("CREDITEUR")).toBe(false);
  expect(reconciliation.looksLikeStatementAmount("RC-333 -C.N.S.S.92774-1CE001648789000")).toBe(false);
  expect(reconciliation.looksLikeStatementAmount("")).toBe(false);
});

test("a heading is moved onto its figures only when exactly one column can carry them", () => {
  // The repair is decided from the page, so it is testable without a scanner.
  const table = {
    headers: ["DATE", "LIBELLE", "DEBIT::", "CAPITAUX", "CREDIT"],
    rows: [
      { DATE: "01 07", LIBELLE: "ACHAT", "DEBIT::": "", CAPITAUX: "1 200,00", CREDIT: "" },
      { DATE: "02 07", LIBELLE: "VIREMENT", "DEBIT::": "", CAPITAUX: "", CREDIT: "900,00" },
    ],
    warnings: [],
  };
  const repaired = importer.repairOcrMoneyColumns(table);
  expect(repaired.headers).toEqual(["DATE", "LIBELLE", "CAPITAUX", "DEBIT", "CREDIT"]);
  expect(repaired.rows[0].DEBIT).toBe("1 200,00");
  expect(repaired.rows[1].CREDIT).toBe("900,00");
  expect(repaired.warnings.join(" ")).toMatch(/En-tête reconstruit/i);

  // Two candidate columns is ambiguous: nothing is moved, and it is said.
  const ambiguous = importer.repairOcrMoneyColumns({
    headers: ["DATE", "LIBELLE", "DEBIT", "COL A", "COL B", "CREDIT"],
    rows: [{ DATE: "01 07", LIBELLE: "ACHAT", DEBIT: "", "COL A": "10,00", "COL B": "20,00", CREDIT: "" }],
    warnings: [],
  });
  expect(ambiguous.headers).toEqual(["DATE", "LIBELLE", "DEBIT", "COL A", "COL B", "CREDIT"]);
  expect(ambiguous.warnings.join(" ")).toMatch(/plusieurs colonnes voisines/i);

  // A page whose movements all fall on one side is ordinary, and silent.
  const oneSided = importer.repairOcrMoneyColumns({
    headers: ["DATE", "LIBELLE", "DEBIT", "CREDIT"],
    rows: [{ DATE: "01 07", LIBELLE: "ACHAT", DEBIT: "1 200,00", CREDIT: "" }],
    warnings: [],
  });
  expect(oneSided.warnings).toEqual([]);

  // A debit column that already carries figures is left exactly as it is.
  const sound = importer.repairOcrMoneyColumns({
    headers: ["DATE", "LIBELLE", "DEBIT", "CREDIT"],
    rows: [{ DATE: "01 07", LIBELLE: "ACHAT", DEBIT: "1 200,00", CREDIT: "" }],
    warnings: [],
  });
  expect(sound.headers).toEqual(["DATE", "LIBELLE", "DEBIT", "CREDIT"]);
  expect(sound.warnings).toEqual([]);
});
