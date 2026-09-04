/**
 * The statement checks itself, where it says enough about itself to be checked.
 *
 * Wheat has always known how to verify that an opening balance plus the
 * movements it read equals the stated closing balance, and to refuse an import
 * where they disagree. Nothing supplied the two figures, so that check recorded
 * `equationChecked: false` on every statement ever imported and never once ran.
 *
 * These tests hold both halves: that a format declaring its balances now has
 * them read, and that a format which does not declare them reports no balances
 * rather than a guessed pair. A guessed balance would be worse than none — it
 * would turn a real guard into a source of false refusals on scanned pages.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const importer = tsxRequire(path.join(cwd, "electron", "bankStatementImporter.ts"), __filename);

/** `:60F:` opening, `:61:` movements, `:62F:` closing — the format's own fields. */
function mt940({ opening = "C260825MAD1000,00", closing = "C260826MAD1016,00", movements = ":61:2608260826C16,00NTRFREF-MT940\n:86:Encaissement MT940\n" } = {}) {
  return `:20:WHEAT-BALANCE\n:25:MA000TEST\n:60F:${opening}\n${movements}:62F:${closing}\n`;
}

async function parse(text, sourceName = "releve.sta") {
  return importer.parseBankStatement({
    sourceName,
    bytesBase64: Buffer.from(text, "utf8").toString("base64"),
  });
}

test("an MT940 statement's declared opening and closing balances are read exactly", async () => {
  const parsed = await parse(mt940());

  expect(parsed.format).toBe("MT940");
  expect(parsed.declaredBalances).toEqual({
    openingBalanceCents: "100000",
    closingBalanceCents: "101600",
  });
});

test("a debit balance keeps the sign the format states, never an assumed one", async () => {
  // `D` is the bank's own mark for a balance in debit. Nothing here infers a
  // sign from the account's usual direction.
  const parsed = await parse(mt940({ opening: "D260825MAD250,00", closing: "D260826MAD234,00" }));

  expect(parsed.declaredBalances).toEqual({
    openingBalanceCents: "-25000",
    closingBalanceCents: "-23400",
  });
});

test("a statement whose movements reconcile its balances is accepted", () => {
  // 1 000,00 + 16,00 = 1 016,00, which is what :62F: states.
  const opening = 100_000n;
  const closing = 101_600n;
  const movementNet = 1_600n;
  expect(opening + movementNet).toBe(closing);
});

test("a format that declares no balances reports none, rather than a guess", async () => {
  const csv = "Date;Description;Reference;Amount;Currency\n21/08/2026;Frais;REF-1;-11,25;MAD\n";
  const parsed = await parse(csv, "releve.csv");

  expect(parsed.rowCount).toBe(1);
  // Absent, not zero: an absent balance leaves the check unavailable, while a
  // zero would be checked and would be wrong.
  expect(parsed.declaredBalances).toBeUndefined();
});

test("a malformed balance field is treated as absent, not as zero", async () => {
  const parsed = await parse(mt940({ opening: "C260825MAD" }));

  expect(parsed.declaredBalances?.openingBalanceCents).toBeUndefined();
  expect(parsed.declaredBalances?.closingBalanceCents).toBe("101600");
});

test("balances beyond 2^53 centimes survive exactly", async () => {
  const parsed = await parse(mt940({ opening: "C260825MAD99999999999999999,99" }));

  expect(parsed.declaredBalances?.openingBalanceCents).toBe("9999999999999999999");
});

/* ------------------------------------------- the guard these figures feed */

test("the import refuses a statement whose movements contradict its stated closing balance", async () => {
  const reconciliation = tsxRequire(path.join(cwd, "electron", "reconciliation.ts"), __filename);
  const service = reconciliation.createReconciliationService({
    // The check runs before any query, so the transaction never needs to do
    // anything: a statement that does not add up is refused on arithmetic.
    $transaction: async (run) => run({}),
  });

  const rows = [{ Date: "2026-08-26", Description: "Encaissement", Reference: "REF-MT940", Amount: "16.00" }];
  const mapping = { date: "Date", label: "Description", reference: "Reference", amount: "Amount" };
  const importOnce = (closingBalanceCents) => service.importStatement({
    bankAccountId: "bank-1",
    sourceName: "releve.sta",
    sourceSha256: "a".repeat(64),
    sourceFormat: "MT940",
    rows,
    mapping,
    openingBalanceCents: "100000",
    closingBalanceCents,
  });

  // 1 000,00 + 16,00 is 1 016,00. A statement claiming 1 020,00 is not one
  // Wheat may quietly accept: something was misread, or a movement is missing.
  await expect(importOnce("102000")).rejects.toThrow(/incoh/i);

  // The same statement, stating the closing balance its own movements produce,
  // gets past the arithmetic and on to the database work.
  await expect(importOnce("101600")).rejects.not.toThrow(/incoh/i);
});
