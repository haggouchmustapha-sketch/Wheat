/**
 * Reading and reconciling the money on a recognised accounting document.
 *
 * Two separate problems live here, and they are separate on purpose.
 *
 * The first is turning a run of characters into a number. Moroccan documents
 * mix "4 500,00", "4.500,00", "4,500.00" and "4500" on the same page, and a
 * scanner regularly duplicates a decimal group ("6 240.00.00"). Guessing the
 * separator from the locale is wrong; it has to be read off the token.
 *
 * The second is deciding which number belongs to which label. Geometry offers
 * candidates, it does not settle them: on one invoice the totals column is
 * aligned with its labels, on the next it is printed one row lower, and both
 * look equally plausible to a proximity rule. What separates them is that only
 * one assignment satisfies the arithmetic the document must obey — VAT is the
 * rate applied to the taxable base, and the grand total is the sum of its
 * parts. So candidate assignments are scored against that arithmetic and the
 * consistent one wins. A document whose best assignment still fails is
 * reported as failing; nothing is ever silently repaired.
 */

/** Statutory Moroccan VAT rates, in basis points. */
export const MOROCCAN_VAT_RATES_BPS = [0, 700, 1000, 1400, 2000];

export type TotalKind = "HT" | "TVA" | "TTC" | "DEBOURS" | "DISCOUNT" | "NET_PAID" | "STAMP";

export type ParsedAmount = { value: number; raw: string; repairedDuplicateDecimals: boolean };

const CURRENCY = /\b(mad|dhs|dh|dirhams?|eur|euros?|usd)\b|[€$]/gi;

/** Non-breaking, narrow no-break and thin spaces, which typeset totals use. */
const FIXED_SPACES = new RegExp("[\\u00a0\\u202f\\u2009]", "g");

/**
 * Reads one amount token.
 *
 * Returns `null` rather than a wrong number whenever the token cannot be an
 * amount: an identifier, a date, a percentage. Callers rely on that — an ICE
 * silently becoming a fourteen-digit total is exactly the failure this
 * pipeline exists to prevent.
 */
export function parseDocumentAmount(input: string): ParsedAmount | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  let working = raw.replace(CURRENCY, " ").replace(FIXED_SPACES, " ").trim();
  // A trailing percentage is a rate, never an amount.
  if (/%\s*$/.test(working)) return null;
  // Dates and references are not amounts, whatever their digits look like.
  if (/[/\\]/.test(working)) return null;

  const negative = /^-/.test(working) || /^\(.*\)$/.test(working);
  working = working.replace(/^[-+(]+/, "").replace(/\)+$/, "").trim();
  if (!/^\d[\d\s.,']*$/.test(working)) return null;

  const condensed = working.replace(/[\s']/g, "");
  if (!/^\d/.test(condensed)) return null;

  // "6 240.00.00": the recogniser repeated the decimal group. Keeping the
  // first one is the only reading that can be right; keeping the last would
  // silently move the decimal point.
  const duplicated = condensed.match(/^(\d[\d.,]*?[.,]\d{2})(?:[.,]\d{2})+$/);
  const body = duplicated ? duplicated[1] : condensed;

  const lastSeparator = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
  let whole = body;
  let fraction = "";
  if (lastSeparator > 0) {
    const tail = body.slice(lastSeparator + 1);
    // One or two trailing digits is a decimal part. Exactly three is a
    // thousands group unless the token carries no other separator and no
    // leading group of its own — "1.500" stays ambiguous, so it is read as a
    // whole number, which is what a quantity column usually means.
    if (/^\d{1,2}$/.test(tail)) {
      whole = body.slice(0, lastSeparator);
      fraction = tail;
    }
  }

  const digits = whole.replace(/\D/g, "");
  if (!digits) return null;
  // A very long run of digits with no decimal part is an identifier, not a
  // total: a Moroccan ICE is fifteen digits, and no invoice states an amount
  // that long. Twelve leaves room for a share capital in centimes.
  if (!fraction && digits.length > 12) return null;

  const value = Number(`${digits}.${fraction.padEnd(2, "0").slice(0, 2) || "00"}`);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, raw, repairedDuplicateDecimals: Boolean(duplicated) };
}

/** True when a token could plausibly be a monetary amount on this document. */
export function isAmountLike(text: string) {
  const parsed = parseDocumentAmount(text);
  if (!parsed) return false;
  // A bare run of digits with neither a decimal part nor thousands grouping is
  // accepted only when short enough to be a real total; "003983471000077" is an
  // ICE, not two hundred billion dirhams. Grouping — "2 151 408 390" — is
  // itself the evidence that the document meant a number.
  const grouped = /\d[\s'](?=\d{3}\b)/.test(text.trim());
  const condensed = text.replace(/[^\d.,]/g, "");
  if (!grouped && !/[.,]/.test(condensed) && condensed.replace(/\D/g, "").length > 7) return false;
  return true;
}

/**
 * The amount a line ends with, when the label and its value share one element.
 *
 * "Montant HT: 12 000,00 MAD" is a single line on a printed invoice and a
 * single element after recognition. The currency has to be allowed after the
 * digits, otherwise the line looks like a label with no value at all and the
 * total is silently missed.
 */
export function trailingAmount(text: string): { amount: ParsedAmount; label: string } | null {
  const match = String(text ?? "").match(/^(.*?)([0-9][0-9\s.,']*)\s*(?:mad|dhs|dh|dirhams?|eur|usd|€|\$)?\s*$/i);
  if (!match) return null;
  const amount = parseDocumentAmount(match[2]);
  return amount ? { amount, label: match[1].trim() } : null;
}

/** The same line with its trailing amount and currency removed. */
export function withoutTrailingAmount(text: string) {
  return trailingAmount(text)?.label ?? String(text ?? "");
}

/** Reads a percentage such as "20%", "TVA 20 %", "7.00%". */
export function parsePercentBps(text: string): number | null {
  const match = String(text ?? "").match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
  if (!match) return null;
  const percent = Number(match[1].replace(",", "."));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

export type TotalsAssignment = Partial<Record<TotalKind, number>>;

export type TotalsCheck = {
  id: string;
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  detail: string;
  /** Fields a human must settle when this check failed. */
  fields: TotalKind[];
};

export type TotalsEvaluation = {
  checks: TotalsCheck[];
  /** 0-1. How well the assignment satisfies the document's own arithmetic. */
  score: number;
  /** True when every applicable check passed. */
  consistent: boolean;
  /** Set when the grand total only balances once disbursements are added. */
  deboursAdditive: boolean;
  /** Rate implied by TVA / HT, in basis points, when both were read. */
  impliedVatRateBps: number | null;
  failedFields: TotalKind[];
};

/**
 * Five centimes, and no relative allowance.
 *
 * These are totals the document states, not values Wheat recomputed from
 * lines: a printed grand total that misses the sum of its printed parts is an
 * error — usually a misread digit — and widening the tolerance in proportion to
 * the amount only hides it on exactly the large invoices where it costs most.
 */
function balances(left: number, right: number) {
  return Math.abs(left - right) <= 0.05;
}

/**
 * Per-line VAT is rounded before it is summed, so the stated VAT can miss the
 * rate applied to the stated base by a few centimes on a long invoice. One
 * percent of the expected VAT absorbs that without absorbing a real error.
 */
function vatBalances(stated: number, expected: number) {
  return Math.abs(stated - expected) <= Math.max(0.05, Math.abs(expected) * 0.01);
}

const money = (value: number) => value.toFixed(2);

/**
 * Scores one candidate reading of a document's totals.
 *
 * Every rule is expressed as a check with its own outcome so the reason a
 * reading was preferred — or rejected — survives into the review screen.
 * Deliberately, no rule is mandatory: an invoice may state VAT without a rate,
 * a receipt may state only a total, and a disbursement line may or may not be
 * inside the taxable base. What the caller gets back is how much of the
 * arithmetic held, not a verdict on whether the document is well formed.
 */
export function evaluateTotals(assignment: TotalsAssignment, vatRateBps: number | null): TotalsEvaluation {
  const checks: TotalsCheck[] = [];
  const failedFields = new Set<TotalKind>();
  const ht = assignment.HT ?? null;
  const tva = assignment.TVA ?? null;
  const ttc = assignment.TTC ?? null;
  const debours = assignment.DEBOURS ?? null;
  const discount = assignment.DISCOUNT ?? null;
  const stamp = assignment.STAMP ?? null;

  let earned = 0;
  let possible = 0;
  const award = (weight: number, passed: boolean) => { possible += weight; if (passed) earned += weight; };

  const impliedVatRateBps = ht !== null && tva !== null && ht > 0 ? Math.round((tva / ht) * 10_000) : null;

  if (ht !== null && tva !== null && vatRateBps !== null && ht > 0) {
    const expected = Number((ht * vatRateBps / 10_000).toFixed(2));
    const passed = vatBalances(tva, expected);
    award(3, passed);
    checks.push({
      id: "vat-matches-rate",
      label: "TVA = base HT x taux",
      status: passed ? "PASSED" : "FAILED",
      detail: passed
        ? `${(vatRateBps / 100).toFixed(2)} % de ${money(ht)} = ${money(tva)}.`
        : `${(vatRateBps / 100).toFixed(2)} % de ${money(ht)} donne ${money(expected)}, le document indique ${money(tva)}.`,
      fields: ["HT", "TVA"],
    });
    if (!passed) { failedFields.add("HT"); failedFields.add("TVA"); }
  } else {
    checks.push({ id: "vat-matches-rate", label: "TVA = base HT x taux", status: "SKIPPED", detail: "Le taux ou l'un des montants n'a pas ete lu.", fields: [] });
  }

  let deboursAdditive = false;
  if (ht !== null && tva !== null && ttc !== null) {
    const base = ht + tva - (discount ?? 0) + (stamp ?? 0);
    const withoutDebours = Number(base.toFixed(2));
    const withDebours = Number((base + (debours ?? 0)).toFixed(2));
    const plain = balances(ttc, withoutDebours);
    const additive = debours !== null && balances(ttc, withDebours);
    deboursAdditive = additive && !plain;
    const passed = plain || additive;
    award(4, passed);
    checks.push({
      id: "total-is-sum-of-parts",
      label: "TTC = HT + TVA (+ debours - remise)",
      status: passed ? "PASSED" : "FAILED",
      detail: passed
        ? additive && !plain
          ? `${money(ht)} + ${money(tva)} + ${money(debours ?? 0)} de debours = ${money(ttc)}.`
          : `${money(ht)} + ${money(tva)} = ${money(ttc)}.`
        : `${money(ht)} + ${money(tva)}${debours !== null ? ` (+ ${money(debours)} de debours)` : ""} ne donne pas ${money(ttc)}.`,
      fields: debours !== null ? ["HT", "TVA", "TTC", "DEBOURS"] : ["HT", "TVA", "TTC"],
    });
    if (!passed) for (const field of ["HT", "TVA", "TTC"] as TotalKind[]) failedFields.add(field);
  } else {
    checks.push({ id: "total-is-sum-of-parts", label: "TTC = HT + TVA (+ debours - remise)", status: "SKIPPED", detail: "Les trois montants n'ont pas tous ete lus ; aucun total n'a ete invente.", fields: [] });
  }

  if (impliedVatRateBps !== null) {
    const statutory = MOROCCAN_VAT_RATES_BPS.some((rate) => Math.abs(impliedVatRateBps - rate) <= 15);
    award(2, statutory);
    checks.push({
      id: "implied-rate-statutory",
      label: "Taux implicite reconnu au Maroc",
      status: statutory ? "PASSED" : "FAILED",
      detail: statutory
        ? `TVA / HT donne ${(impliedVatRateBps / 100).toFixed(2)} %.`
        : `TVA / HT donne ${(impliedVatRateBps / 100).toFixed(2)} %, qui ne correspond a aucun taux marocain usuel (0, 7, 10, 14, 20 %).`,
      fields: ["HT", "TVA"],
    });
    if (!statutory) { failedFields.add("HT"); failedFields.add("TVA"); }
  }

  if (vatRateBps !== null) {
    const known = MOROCCAN_VAT_RATES_BPS.includes(Math.round(vatRateBps));
    checks.push({
      id: "stated-rate-statutory",
      label: "Taux annonce reconnu au Maroc",
      status: known ? "PASSED" : "FAILED",
      detail: known ? `${(vatRateBps / 100).toFixed(2)} % fait partie des taux en vigueur.` : `${(vatRateBps / 100).toFixed(2)} % ne correspond a aucun taux marocain usuel.`,
      fields: ["TVA"],
    });
    award(1, known);
  }

  if (ht !== null && ttc !== null) {
    const ordered = ttc >= ht - 0.02;
    award(1, ordered);
    checks.push({
      id: "total-not-below-base",
      label: "TTC superieur ou egal au HT",
      status: ordered ? "PASSED" : "FAILED",
      detail: ordered ? `${money(ttc)} >= ${money(ht)}.` : `Le total ${money(ttc)} est inferieur a la base ${money(ht)} : les deux montants sont probablement intervertis.`,
      fields: ["HT", "TTC"],
    });
    if (!ordered) { failedFields.add("HT"); failedFields.add("TTC"); }
  }

  if (tva !== null && ht !== null && tva > ht + 0.02) {
    checks.push({
      id: "vat-not-above-base",
      label: "TVA inferieure a la base HT",
      status: "FAILED",
      detail: `La TVA lue (${money(tva)}) depasse la base HT (${money(ht)}) : aucun taux marocain ne le permet.`,
      fields: ["HT", "TVA"],
    });
    possible += 2;
    failedFields.add("TVA");
  } else if (tva !== null && ht !== null) {
    award(2, true);
  }

  const applicable = checks.filter((check) => check.status !== "SKIPPED");
  return {
    checks,
    score: possible ? earned / possible : 0,
    consistent: applicable.length > 0 && applicable.every((check) => check.status === "PASSED"),
    deboursAdditive,
    impliedVatRateBps,
    failedFields: [...failedFields],
  };
}

/**
 * Recovers the VAT rate an invoice implies but never prints.
 *
 * Accepted only when TVA / HT lands on a statutory Moroccan rate: a ratio that
 * matches no legal rate is left unset so the document is reviewed rather than
 * mislabelled.
 */
export function impliedStatutoryRateBps(ht: number | null, tva: number | null): number | null {
  if (ht === null || tva === null || ht <= 0 || tva < 0) return null;
  const implied = (tva / ht) * 10_000;
  return MOROCCAN_VAT_RATES_BPS.find((rate) => Math.abs(implied - rate) <= 15) ?? null;
}

/** Exact centime string for an amount read in document units. */
export function amountToCents(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const negative = value < 0;
  const scaled = Math.round(Math.abs(value) * 100);
  return `${negative ? "-" : ""}${scaled}`;
}

/* ------------------------------------------------------------------ */
/* Recovering a total the recogniser misread                           */
/* ------------------------------------------------------------------ */

/**
 * True when two centime amounts differ by exactly one substituted digit.
 *
 * This is the signature of a recognition error rather than of a different
 * amount. "4 216,67" read as "4 216,07" and "843,33" read as "643,33" are one
 * glyph apart each; "4 500,00" against "5 400,00" is not, however close the two
 * look in a column. Requiring equal length matters as much as requiring one
 * difference: a dropped or added digit changes the magnitude, and a magnitude
 * change is never something Wheat should propose to correct on its own.
 */
export function isSingleDigitMisread(read: number, implied: number): boolean {
  if (!Number.isFinite(read) || !Number.isFinite(implied) || read < 0 || implied < 0) return false;
  if (read === implied) return false;
  const left = String(Math.round(read * 100));
  const right = String(Math.round(implied * 100));
  if (left.length !== right.length) return false;
  let differences = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index] && (differences += 1) > 1) return false;
  }
  return differences === 1;
}

export type TotalsReconstruction = {
  /** The statutory rate that makes the document's own arithmetic close. */
  vatRateBps: number;
  ht: number;
  tva: number;
  ttc: number;
  /** The fields whose read value the recogniser got wrong, in document terms. */
  corrected: Array<{ field: "HT" | "TVA"; read: number; implied: number }>;
};

/**
 * The reading a document's totals must have had, when exactly one exists.
 *
 * An invoice states more than it needs to: a grand total, a taxable base, a VAT
 * amount and — usually — a rate. That redundancy is what makes a misread digit
 * recoverable. When the total is trustworthy and a single statutory Moroccan
 * rate reproduces it, the base and the VAT are determined; if the values that
 * were read differ from the determined ones by one glyph each, the recogniser
 * misread them and the document is not in fact inconsistent.
 *
 * Three restrictions keep this from becoming a repair that invents figures.
 * The grand total is never adjusted — it is the anchor, and a document whose
 * total is itself misread has nothing to anchor to. Only a statutory rate is
 * tried, so no reading is manufactured by solving for an arbitrary percentage.
 * And a candidate is returned only when it is unique: if two rates both produce
 * single-glyph explanations, the document is genuinely ambiguous and the caller
 * must ask rather than choose.
 *
 * The result is a *candidate*, never an assignment. Callers surface it for
 * confirmation; nothing in Wheat writes it without a person accepting it.
 */
export function reconstructTotals(input: {
  ht: number | null;
  tva: number | null;
  ttc: number | null;
  debours?: number | null;
  discount?: number | null;
  statedRateBps?: number | null;
}): TotalsReconstruction | null {
  const { ht, tva, ttc } = input;
  if (ht === null || tva === null || ttc === null) return null;
  if (ttc <= 0 || ht < 0 || tva < 0) return null;
  const debours = input.debours ?? 0;
  const discount = input.discount ?? 0;
  // Already consistent: there is nothing to recover, and proposing a change to
  // a document that adds up would be the worst possible false positive.
  if (balances(ttc, Number((ht + tva + debours - discount).toFixed(2)))) return null;

  // Disbursements and discounts sit outside the taxable base, so the amount the
  // rate has to reproduce is the total stripped of them.
  const taxable = Number((ttc - debours + discount).toFixed(2));
  if (taxable <= 0) return null;

  const rates = input.statedRateBps !== null && input.statedRateBps !== undefined && MOROCCAN_VAT_RATES_BPS.includes(input.statedRateBps)
    ? [input.statedRateBps]
    : MOROCCAN_VAT_RATES_BPS.filter((rate) => rate > 0);

  const candidates: TotalsReconstruction[] = [];
  for (const rate of rates) {
    const impliedHt = Number((taxable / (1 + rate / 10_000)).toFixed(2));
    const impliedTva = Number((taxable - impliedHt).toFixed(2));
    const htWrong = !balances(ht, impliedHt);
    const tvaWrong = !balances(tva, impliedTva);
    // Every field that has to move must move by one glyph. A value that differs
    // by more than that is a different amount, not a misread one.
    if (htWrong && !isSingleDigitMisread(ht, impliedHt)) continue;
    if (tvaWrong && !isSingleDigitMisread(tva, impliedTva)) continue;
    if (!htWrong && !tvaWrong) continue;
    const corrected: TotalsReconstruction["corrected"] = [];
    if (htWrong) corrected.push({ field: "HT", read: ht, implied: impliedHt });
    if (tvaWrong) corrected.push({ field: "TVA", read: tva, implied: impliedTva });
    candidates.push({ vatRateBps: rate, ht: impliedHt, tva: impliedTva, ttc, corrected });
  }

  return candidates.length === 1 ? candidates[0] : null;
}
