const { test, expect } = require("@playwright/test");
const { require: tsxRequire } = require("tsx/cjs/api");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { parseAccountingDate } = tsxRequire(path.join(root, "electron/accounting.ts"), __filename);
const { normalizeEntryCommandPayload } = tsxRequire(path.join(root, "electron/entryCommands21.ts"), __filename);
const { createSubledgerService } = tsxRequire(path.join(root, "electron/subledger.ts"), __filename);

test("accounting dates reject calendar rollover and ambiguous locale strings", () => {
  for (const value of ["2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "02/03/2026", "2026", "2026-02", "2026-02-31T12:00:00Z"]) {
    expect(() => parseAccountingDate(value, "La date comptable"), value).toThrow(/date comptable/i);
  }
});

test("accounting dates preserve valid days and UTC timestamp compatibility", () => {
  for (const value of ["2024-02-29", "2024-02-29T15:45:00.000Z", new Date("2024-02-29T23:59:59Z")]) {
    expect(parseAccountingDate(value).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  }
  expect(parseAccountingDate("2026-01-01T00:30:00+01:00").toISOString()).toBe("2025-12-31T00:00:00.000Z");
  expect(() => parseAccountingDate(new Date(NaN))).toThrow(/invalide/i);
});

test("entry, invoice and payment commands reject impossible dates before accessing storage", async () => {
  const date = "2026-02-31";
  expect(() => normalizeEntryCommandPayload({ companyId: "company", journalId: "journal", date, label: "Achat", lines: [
    { accountId: "charge", label: "Charge", debitCents: "100", creditCents: "0" },
    { accountId: "tiers", label: "Tiers", debitCents: "0", creditCents: "100" },
  ] })).toThrow(/date/i);
  let storageCalls = 0;
  const service = createSubledgerService({ getPrisma: () => { storageCalls += 1; throw new Error("Storage reached"); } });
  await expect(service.createInvoiceDraft({ kind: "PURCHASE", invoiceDate: date, dueDate: "2026-03-31" })).rejects.toThrow(/date de facture/i);
  await expect(service.createPaymentDraft({ companyId: "company", counterpartyId: "supplier", kind: "DISBURSEMENT", paymentDate: date })).rejects.toThrow(/date du paiement/i);
  expect(storageCalls).toBe(0);
});
