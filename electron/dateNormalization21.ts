export type NormalizedFlexibleDate = {
  iso: string;
  date: Date;
  raw: string;
  /** The year was not printed on the value; statement context supplied it. */
  inferred: boolean;
  /**
   * The value carried recognition noise that was removed before parsing — a
   * stray symbol a scanner put in front of the digits, say. The removal is
   * deterministic (only characters that cannot occur in any accepted date are
   * dropped, and only from the ends), but the reading is still one a person
   * should be shown rather than told about afterwards.
   */
  repaired: boolean;
  precision: "DAY";
};

export type FlexibleDateContext = {
  year?: number | null;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
};

function fourDigitYear(value: string) {
  const year = Number(value);
  if (value.length === 4) return year;
  return year <= 69 ? 2000 + year : 1900 + year;
}

function contextYear(context: FlexibleDateContext) {
  if (Number.isInteger(context.year) && Number(context.year) >= 1900 && Number(context.year) <= 2200) return Number(context.year);
  const candidates = [context.periodStart, context.periodEnd]
    .filter(Boolean)
    .map((value) => value instanceof Date ? value : new Date(String(value)))
    .filter((date) => !Number.isNaN(date.getTime()))
    .map((date) => date.getUTCFullYear());
  return candidates.length && candidates.every((year) => year === candidates[0]) ? candidates[0] : null;
}

function validDate(year: number, month: number, day: number, raw: string, inferred: boolean, repaired = false): NormalizedFlexibleDate {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`La date « ${raw} » est invalide.`);
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error(`La date « ${raw} » n'existe pas dans le calendrier.`);
  return { iso, date, raw, inferred, repaired, precision: "DAY" };
}

/**
 * Recognition noise around a date, removed before parsing.
 *
 * Scanners put things in front of numbers: a currency glyph bleeding in from
 * the next column, a bullet, a table rule read as a character. Every date shape
 * Wheat accepts begins and ends with a digit, so trimming non-digits from the
 * two ends cannot change which date is meant — it can only turn an unreadable
 * value into a readable one. Nothing inside the value is touched, so a letter
 * standing where a digit belongs stays a misreading to show somebody rather
 * than a stray mark to sweep away.
 */
function stripEdgeNoise(raw: string): string {
  return raw.replace(/^[^0-9]+/, "").replace(/[^0-9]+$/, "");
}

/** Full dates written inside statement prose, e.g. "SOLDE FINAL AU 30 06 2026". */
export function findEmbeddedDates(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...text.matchAll(/\b(\d{1,2})[ /.-](\d{1,2})[ /.-](\d{4})\b/g)].map((match) => match[0]);
}

/** Normalizes common Moroccan accounting dates without discarding the source value. */
export function normalizeFlexibleDate(value: unknown, context: FlexibleDateContext = {}): NormalizedFlexibleDate {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("La date importée doit être du texte.");
  const raw = String(value).trim();
  if (!raw) throw new Error("La date importée est vide.");
  // `raw` is what the document said, and is what every caller records. `text`
  // is what gets parsed. The two differ only when the ends carried noise.
  const text = stripEdgeNoise(raw);
  const repaired = text !== raw;
  if (!text) throw new Error(`La date « ${raw} » ne contient aucun chiffre.`);
  const spaced = text.replace(/\s+/g, " ");
  let match: RegExpExecArray | null;

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), raw, false, repaired);

  match = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(spaced);
  if (match) return validDate(fourDigitYear(match[3]), Number(match[2]), Number(match[1]), raw, false, repaired);

  match = /^(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (match) return validDate(fourDigitYear(match[3]), Number(match[2]), Number(match[1]), raw, false, repaired);

  match = /^(\d{8})$/.exec(text);
  if (match) {
    const leadingYear = Number(text.slice(0, 4));
    const trailingYear = Number(text.slice(4, 8));
    if (leadingYear >= 1900 && leadingYear <= 2200) {
      return validDate(leadingYear, Number(text.slice(4, 6)), Number(text.slice(6, 8)), raw, false, repaired);
    }
    if (trailingYear >= 1900 && trailingYear <= 2200) {
      return validDate(trailingYear, Number(text.slice(2, 4)), Number(text.slice(0, 2)), raw, false, repaired);
    }
    throw new Error(`La date « ${raw} » ne contient pas une année plausible.`);
  }

  match = /^(\d{1,2})[/.\-\s](\d{1,2})$/.exec(spaced);
  if (match) {
    const year = contextYear(context);
    if (!year) throw new Error(`La date « ${raw} » ne contient pas d'année et aucun contexte de relevé fiable ne permet de l'inférer.`);
    return validDate(year, Number(match[2]), Number(match[1]), raw, true, repaired);
  }

  // A day and a month whose separator was lost to recognition — "3006" for
  // "30 06". Only read this way once the statement has established its year,
  // and only when the four digits are a real day and month: "2026" read as day
  // 20 of month 26 fails here rather than quietly becoming a date.
  match = /^(\d{2})(\d{2})$/.exec(text);
  if (match) {
    const year = contextYear(context);
    if (!year) throw new Error(`La date « ${raw} » ne contient pas d'année et aucun contexte de relevé fiable ne permet de l'inférer.`);
    return validDate(year, Number(match[2]), Number(match[1]), raw, true, true);
  }

  throw new Error(`Le format de date « ${raw} » n'est pas reconnu. Formats acceptés : 290526, 29/05/26, 29/05/2026, 29-05-2026, 29.05.2026 ou 2026-05-29.`);
}

export function inferUniqueYear(values: unknown[]) {
  const years = new Set<number>();
  for (const value of values) {
    try {
      const normalized = normalizeFlexibleDate(value);
      years.add(normalized.date.getUTCFullYear());
    } catch {
      // Missing-year and malformed values are deliberately ignored here.
    }
  }
  return years.size === 1 ? [...years][0] : null;
}
