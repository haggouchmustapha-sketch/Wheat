/**
 * Document-level understanding for Wheat's OCR pipeline.
 *
 * Recognition gives Wheat text per page. That is not the same as understanding
 * a document: a three-page invoice repeats its header on every page, continues
 * one table across the page break, and states its totals once at the end. Read
 * page by page, that becomes duplicated counterparties, three "invoice numbers"
 * and a line-item table cut in two.
 *
 * This module turns pages into one logical document and then checks the result
 * against the arithmetic an accounting document has to satisfy. It never
 * invents a value: it reconciles the values that were read, derives at most one
 * missing amount from two that were actually found — marked as derived — and
 * flags everything else for human review instead of guessing.
 */

export type UnderstandingPage = {
  page: number;
  text: string;
  confidence: number;
  tables?: string[][][];
};

export type AssembledDocument = {
  /** Page texts joined with repeated headers and footers removed. */
  text: string;
  /** Tables after continuation across page breaks has been resolved. */
  tables: string[][][];
  pageCount: number;
  /** Lines dropped because they repeat identically on most pages. */
  repeatedLines: string[];
  notes: string[];
};

export type AccountingCheck = {
  id: string;
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  detail: string;
};

export type ReconciliationOutcome = {
  checks: AccountingCheck[];
  /**
   * Fields a human must settle because the document contradicts itself.
   *
   * Only failed checks land here. A value that was simply not found is not a
   * contradiction — it is reported in `missingFields`, and whether its absence
   * matters is decided by the document type, not by this arithmetic.
   */
  fieldsNeedingReview: string[];
  /** Amounts the recogniser did not find at all. */
  missingFields: string[];
  /** Amounts Wheat computed from two read values, never from none. */
  derivedFields: string[];
};

type AmountFields = {
  ht?: number | null;
  tva?: number | null;
  ttc?: number | null;
  vatRateBps?: number | null;
};

/** Statutory Moroccan VAT rates, in basis points. */
export const MOROCCAN_VAT_RATES_BPS = [0, 700, 1000, 1400, 2000];

/** Combining diacritical marks (U+0300-U+036F). */
const DIACRITICS = new RegExp("[\u0300-\u036f]", "g");

const HEADER_SCAN_LINES = 6;
const FOOTER_SCAN_LINES = 4;

function normalizedLine(value: string) {
  return value
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(DIACRITICS, "")
    // Page numbers and dates change between otherwise identical headers.
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the header/footer lines a multi-page document repeats verbatim.
 *
 * Only lines present in the first `HEADER_SCAN_LINES` (or last
 * `FOOTER_SCAN_LINES`) of at least two thirds of the pages count, so a page
 * that happens to start with a line item is never mistaken for a header.
 */
export function repeatedBoilerplate(pages: UnderstandingPage[]): Set<string> {
  if (pages.length < 2) return new Set();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const zone = [...lines.slice(0, HEADER_SCAN_LINES), ...lines.slice(-FOOTER_SCAN_LINES)];
    for (const line of new Set(zone.map(normalizedLine))) {
      if (line.length < 4) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 2 / 3));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([line]) => line));
}

/**
 * True when `next` continues `first`: same column count, and `next` has no
 * header row of its own (its first row looks like data, not labels).
 */
function continuesTable(first: string[][], next: string[][]) {
  if (!first.length || !next.length) return false;
  const width = first[0].length;
  if (width < 2 || next[0].length !== width) return false;
  const firstHeader = first[0].map(normalizedLine).join("|");
  const nextHeader = next[0].map(normalizedLine).join("|");
  // A repeated header means the same table restarted on the next page.
  if (firstHeader === nextHeader) return true;
  const looksNumeric = next[0].filter((cell) => /\d/.test(cell)).length;
  return looksNumeric >= Math.ceil(width / 2);
}

/**
 * Joins one logical document out of its pages.
 *
 * Boilerplate that repeats on most pages is removed from every page but the
 * first, so the header is read once, and tables that continue across a page
 * break become a single table with one header row.
 */
export function assembleDocument(pages: UnderstandingPage[]): AssembledDocument {
  const notes: string[] = [];
  if (!pages.length) return { text: "", tables: [], pageCount: 0, repeatedLines: [], notes };

  const boilerplate = repeatedBoilerplate(pages);
  const parts: string[] = [];
  for (const [index, page] of pages.entries()) {
    const lines = page.text.split("\n");
    const kept = index === 0
      ? lines
      : lines.filter((line) => !boilerplate.has(normalizedLine(line.trim())));
    parts.push(kept.join("\n").trim());
  }
  if (boilerplate.size && pages.length > 1) {
    notes.push(`${boilerplate.size} ligne(s) d'en-tête ou de pied répétées ont été lues une seule fois.`);
  }

  const tables: string[][][] = [];
  for (const page of pages) {
    for (const table of page.tables ?? []) {
      const previous = tables.at(-1);
      if (previous && continuesTable(previous, table)) {
        const sameHeader = previous[0].map(normalizedLine).join("|") === table[0].map(normalizedLine).join("|");
        previous.push(...(sameHeader ? table.slice(1) : table));
        notes.push("Un tableau se poursuivant sur plusieurs pages a été reconstitué.");
        continue;
      }
      tables.push(table.map((row) => [...row]));
    }
  }

  return {
    text: parts.filter(Boolean).join("\n"),
    tables,
    pageCount: pages.length,
    repeatedLines: [...boilerplate],
    notes: [...new Set(notes)],
  };
}

const TOLERANCE_ABSOLUTE = 0.02;

function closeEnough(left: number, right: number) {
  // Two centimes of rounding, or 0.5% on large documents where each line was
  // rounded independently before being summed.
  return Math.abs(left - right) <= Math.max(TOLERANCE_ABSOLUTE, Math.abs(right) * 0.005);
}

/**
 * A finite number, or null when the value is absent.
 *
 * `Number(null)` and `Number("")` are both `0`, which would turn "this amount
 * was never read" into "this amount is zero" — and a zero VAT rate contradicts
 * every invoice that actually carries VAT. Absence has to be checked before
 * conversion, never after.
 */
function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Checks the arithmetic an invoice must satisfy and reports what failed.
 *
 * `derive` is deliberately narrow: exactly one of HT / TVA / TTC may be
 * computed, and only when the other two were genuinely read from the document.
 * A document that yields one amount, or none, produces review flags — never a
 * fabricated total.
 */
export function reconcileAccountingAmounts(
  amounts: AmountFields,
  options: { derive?: boolean } = {},
): ReconciliationOutcome & { ht: number | null; tva: number | null; ttc: number | null } {
  const checks: AccountingCheck[] = [];
  const fieldsNeedingReview: string[] = [];
  const missingFields: string[] = [];
  const derivedFields: string[] = [];

  let ht = finite(amounts.ht);
  let tva = finite(amounts.tva);
  let ttc = finite(amounts.ttc);
  const rateBps = finite(amounts.vatRateBps);

  const present = [ht, tva, ttc].filter((value) => value !== null).length;

  if (options.derive !== false && present === 2) {
    if (ttc === null && ht !== null && tva !== null) {
      ttc = Number((ht + tva).toFixed(2));
      derivedFields.push("ttc");
    } else if (tva === null && ht !== null && ttc !== null && ttc >= ht) {
      tva = Number((ttc - ht).toFixed(2));
      derivedFields.push("tva");
    } else if (ht === null && tva !== null && ttc !== null && ttc >= tva) {
      ht = Number((ttc - tva).toFixed(2));
      derivedFields.push("ht");
    }
  }

  if (ht !== null && tva !== null && ttc !== null) {
    const expected = Number((ht + tva).toFixed(2));
    const passed = closeEnough(ttc, expected);
    checks.push({
      id: "ht-plus-tva-equals-ttc",
      label: "HT + TVA = TTC",
      status: passed ? "PASSED" : "FAILED",
      detail: passed
        ? `${ht.toFixed(2)} + ${tva.toFixed(2)} = ${ttc.toFixed(2)}`
        : `${ht.toFixed(2)} + ${tva.toFixed(2)} donne ${expected.toFixed(2)}, mais le document indique ${ttc.toFixed(2)}.`,
    });
    if (!passed) fieldsNeedingReview.push("ht", "tva", "ttc");
  } else {
    checks.push({
      id: "ht-plus-tva-equals-ttc",
      label: "HT + TVA = TTC",
      status: "SKIPPED",
      detail: "Deux des trois montants n'ont pas été lus avec certitude ; aucun montant n'a été inventé.",
    });
    for (const [name, value] of [["ht", ht], ["tva", tva], ["ttc", ttc]] as const) {
      if (value === null) missingFields.push(name);
    }
  }

  if (rateBps !== null && ht !== null && tva !== null && ht > 0) {
    const expectedTva = Number((ht * rateBps / 10_000).toFixed(2));
    const passed = closeEnough(tva, expectedTva);
    checks.push({
      id: "vat-rate-consistent",
      label: "TVA cohérente avec le taux annoncé",
      status: passed ? "PASSED" : "FAILED",
      detail: passed
        ? `${(rateBps / 100).toFixed(2)} % de ${ht.toFixed(2)} = ${tva.toFixed(2)}`
        : `${(rateBps / 100).toFixed(2)} % de ${ht.toFixed(2)} donne ${expectedTva.toFixed(2)}, mais le document indique ${tva.toFixed(2)}.`,
    });
    if (!passed) fieldsNeedingReview.push("tva", "vatRate");
  }

  if (rateBps !== null) {
    const known = MOROCCAN_VAT_RATES_BPS.includes(Math.round(rateBps));
    checks.push({
      id: "vat-rate-statutory",
      label: "Taux de TVA marocain reconnu",
      status: known ? "PASSED" : "FAILED",
      detail: known
        ? `${(rateBps / 100).toFixed(2)} % fait partie des taux en vigueur.`
        : `${(rateBps / 100).toFixed(2)} % ne correspond a aucun taux marocain usuel (0, 7, 10, 14, 20 %).`,
    });
    if (!known) fieldsNeedingReview.push("vatRate");
  }

  if (ttc !== null && ttc < 0) {
    checks.push({ id: "ttc-sign", label: "Total TTC positif", status: "FAILED", detail: "Le total TTC lu est negatif ; s'agit-il d'un avoir ?" });
    fieldsNeedingReview.push("ttc");
  }

  return { checks, fieldsNeedingReview: [...new Set(fieldsNeedingReview)], missingFields, derivedFields, ht, tva, ttc };
}

/**
 * Checks that the line items add up to the stated HT total.
 *
 * A mismatch is reported, never corrected: a wrong quantity and a missed line
 * look identical from here, and only a person can tell them apart.
 */
export function reconcileLineItems(
  lines: Array<{ totalHt?: number | null; quantity?: number | null; unitPrice?: number | null }>,
  statedHt: number | null,
): AccountingCheck {
  const usable = lines
    .map((line) => {
      const total = finite(line.totalHt);
      if (total !== null) return total;
      const quantity = finite(line.quantity);
      const unitPrice = finite(line.unitPrice);
      return quantity !== null && unitPrice !== null ? Number((quantity * unitPrice).toFixed(2)) : null;
    })
    .filter((value): value is number => value !== null);

  if (!usable.length || statedHt === null) {
    return {
      id: "line-items-sum-to-ht",
      label: "Somme des lignes = total HT",
      status: "SKIPPED",
      detail: "Les lignes ou le total HT n'ont pas été lus de maniere exploitable.",
    };
  }
  const sum = Number(usable.reduce((total, value) => total + value, 0).toFixed(2));
  const passed = closeEnough(sum, statedHt);
  return {
    id: "line-items-sum-to-ht",
    label: "Somme des lignes = total HT",
    status: passed ? "PASSED" : "FAILED",
    detail: passed
      ? `${usable.length} ligne(s) totalisent ${sum.toFixed(2)}.`
      : `${usable.length} ligne(s) totalisent ${sum.toFixed(2)}, contre ${statedHt.toFixed(2)} annonces.`,
  };
}
