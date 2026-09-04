const { test, expect } = require("@playwright/test");
const { require: tsxRequire } = require("tsx/cjs/api");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const entries = tsxRequire(path.join(root, "electron", "entryCommands21.ts"), __filename);

function payload(overrides = {}) {
  return {
    companyId: "company-1",
    journalId: "journal-1",
    date: "2026-08-29",
    label: "Écriture exacte",
    lines: [
      { accountId: "account-debit", label: "Débit", debitCents: "9007199254740993", creditCents: "0" },
      { accountId: "account-credit", label: "Crédit", debitCents: "0", creditCents: "9007199254740993" },
    ],
    ...overrides,
  };
}

test("entry commands preserve exact cent strings above JavaScript's safe integer limit", () => {
  const normalized = entries.normalizeEntryCommandPayload(payload());
  expect(normalized.lines.map((line) => [line.debitCents, line.creditCents])).toEqual([
    [9007199254740993n, 0n],
    [0n, 9007199254740993n],
  ]);
});

test("entry commands reject unsafe JavaScript cent numbers and signed 64-bit overflow", () => {
  expect(() => entries.normalizeEntryCommandPayload(payload({
    lines: [{ accountId: "account-1", label: "Montant", debitCents: Number.MAX_SAFE_INTEGER + 1, creditCents: "0" }],
  }))).toThrow(/texte entier exact/i);
  expect(() => entries.normalizeEntryCommandPayload(payload({
    lines: [{ accountId: "account-1", label: "Montant", debitCents: "9223372036854775808", creditCents: "0" }],
  }))).toThrow(/hors limites/i);
});
