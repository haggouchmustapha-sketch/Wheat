/**
 * Working out a spreadsheet's columns without asking.
 *
 * Every case below is a file shape a fiduciaire actually arrives with: a Sage
 * export, a French export with accents and a signed-space thousands separator,
 * an English one, a headerless dump, and the two traps that make naive header
 * matching dangerous — a settlement-date column beside the entry date, and a
 * "libellé compte" column beside the account number.
 *
 * The rule the suite pins is not "always guess right". It is: when Wheat is
 * confident it says so and is correct, and when it is not confident it leaves
 * the field for the user rather than filling it with something plausible.
 */

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { proposeLedgerImportMapping } = tsxRequire(path.join(root, "src", "lib", "ledgerImportMapping.ts"), __filename);

/** Builds a sheet from a header row plus data rows. */
function sheet(headers, rows) {
  return { headers, rows: rows.map((values, index) => ({ sourceRow: index + 2, values: values.map(String) })) };
}

/** The chosen column index for a field, or null. */
const columnFor = (proposal, field) => proposal.suggestions.find((item) => item.field === field)?.columnIndex ?? null;
const confidenceFor = (proposal, field) => proposal.suggestions.find((item) => item.field === field)?.confidence ?? 0;

test.describe("ledger import column mapping", () => {
  test("a French export is mapped from its headers alone", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Clé écriture", "Date", "Journal", "N° pièce", "Libellé écriture", "N° compte", "Libellé ligne", "Débit", "Crédit", "Tiers"],
      [
        ["E1", "2026-01-05", "AC", "FA-1", "Achat fournitures", "613600", "Papeterie", "1000,00", "0", "LAKHOUILI"],
        ["E1", "2026-01-05", "AC", "FA-1", "Achat fournitures", "441100", "Fournisseur", "0", "1000,00", "LAKHOUILI"],
        ["E2", "2026-01-08", "VE", "FV-1", "Vente prestation", "342100", "Client", "2400,00", "0", "ANOUAL"],
        ["E2", "2026-01-08", "VE", "FV-1", "Vente prestation", "712400", "Prestation", "0", "2400,00", "ANOUAL"],
      ],
    ));
    expect(proposal.complete).toBe(true);
    expect(proposal.unresolved).toEqual([]);
    expect(columnFor(proposal, "date")).toBe(1);
    expect(columnFor(proposal, "journalCode")).toBe(2);
    expect(columnFor(proposal, "accountCode")).toBe(5);
    expect(columnFor(proposal, "debit")).toBe(7);
    expect(columnFor(proposal, "credit")).toBe(8);
    expect(confidenceFor(proposal, "date")).toBeGreaterThanOrEqual(70);
  });

  test("no column is ever assigned to two fields", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Date", "Journal", "Compte", "Libellé", "Débit", "Crédit"],
      [
        ["2026-01-05", "AC", "613600", "Achat", "1000,00", "0"],
        ["2026-01-05", "AC", "441100", "Achat", "0", "1000,00"],
      ],
    ));
    const used = proposal.suggestions.map((item) => item.columnIndex).filter((index) => index !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  test("a settlement-date column does not steal the entry date", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Date de règlement", "Date", "Journal", "N° pièce", "Libellé", "Compte", "Désignation", "Débit", "Crédit"],
      [
        ["2026-02-28", "2026-01-05", "AC", "FA-1", "Achat", "613600", "Papeterie", "1000,00", "0"],
        ["2026-02-28", "2026-01-05", "AC", "FA-1", "Achat", "441100", "Fournisseur", "0", "1000,00"],
      ],
    ));
    expect(columnFor(proposal, "date")).toBe(1);
  });

  test("an account *label* column does not stand in for the account number", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Date", "Journal", "Pièce", "Libellé écriture", "Libellé compte", "N° compte", "Libellé ligne", "Débit", "Crédit"],
      [
        ["2026-01-05", "AC", "FA-1", "Achat", "Achats de fournitures", "613600", "Papeterie", "1000,00", "0"],
        ["2026-01-05", "AC", "FA-1", "Achat", "Fournisseurs", "441100", "Fournisseur", "0", "1000,00"],
      ],
    ));
    expect(columnFor(proposal, "accountCode")).toBe(5);
  });

  test("an English export is recognised too", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Entry key", "Date", "Journal", "Reference", "Description", "Account", "Line label", "Debit", "Credit"],
      [
        ["E1", "2026-01-05", "AC", "FA-1", "Office supplies", "613600", "Paper", "1000.00", "0"],
        ["E1", "2026-01-05", "AC", "FA-1", "Office supplies", "441100", "Supplier", "0", "1000.00"],
      ],
    ));
    expect(proposal.complete).toBe(true);
    expect(columnFor(proposal, "debit")).toBe(7);
    expect(columnFor(proposal, "credit")).toBe(8);
  });

  test("amounts written with a thousands separator still read as amounts", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Clé", "Date", "Journal", "Pièce", "Libellé", "Compte", "Ligne", "Débit", "Crédit"],
      [
        ["E1", "05/01/2026", "AC", "FA-1", "Achat", "613600", "Papeterie", "1 250 000,00", "0"],
        ["E1", "05/01/2026", "AC", "FA-1", "Achat", "441100", "Fournisseur", "0", "1 250 000,00"],
      ],
    ));
    expect(columnFor(proposal, "debit")).toBe(7);
    expect(columnFor(proposal, "credit")).toBe(8);
    // A French day-first date is still a date.
    expect(columnFor(proposal, "date")).toBe(1);
  });

  test("a headerless file is mapped from the shape of its columns", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Colonne 1", "Colonne 2", "Colonne 3", "Colonne 4", "Colonne 5", "Colonne 6"],
      [
        ["2026-01-05", "AC", "613600", "Achat de fournitures de bureau", "1000,00", "0"],
        ["2026-01-05", "AC", "441100", "Achat de fournitures de bureau", "0", "1000,00"],
        ["2026-01-08", "VE", "342100", "Vente de prestation de service", "2400,00", "0"],
        ["2026-01-08", "VE", "712400", "Vente de prestation de service", "0", "2400,00"],
      ],
    ));
    // Content alone settles the unambiguous ones.
    expect(columnFor(proposal, "date")).toBe(0);
    expect(columnFor(proposal, "journalCode")).toBe(1);
    expect(columnFor(proposal, "accountCode")).toBe(2);
    // And it does not pretend to know the rest.
    expect(proposal.complete).toBe(false);
    expect(proposal.unresolved.length).toBeGreaterThan(0);
  });

  test("every suggestion explains itself and carries a confidence", () => {
    const proposal = proposeLedgerImportMapping(sheet(
      ["Clé", "Date", "Journal", "Pièce", "Libellé", "Compte", "Ligne", "Débit", "Crédit", "Tiers"],
      [["E1", "2026-01-05", "AC", "FA-1", "Achat", "613600", "Papeterie", "1000,00", "0", "LAKHOUILI"]],
    ));
    for (const suggestion of proposal.suggestions) {
      expect(String(suggestion.reason).length, suggestion.field).toBeGreaterThan(20);
      expect(suggestion.confidence, suggestion.field).toBeGreaterThanOrEqual(0);
      expect(suggestion.confidence, suggestion.field).toBeLessThanOrEqual(99);
      if (suggestion.columnIndex === null) expect(suggestion.confidence, suggestion.field).toBe(0);
    }
  });

  test("an empty sheet proposes nothing rather than guessing", () => {
    const proposal = proposeLedgerImportMapping(sheet([], []));
    expect(proposal.suggestions.every((item) => item.columnIndex === null)).toBe(true);
    expect(proposal.complete).toBe(false);
  });
});
