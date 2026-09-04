/**
 * Working out which spreadsheet column is which, so nobody has to say.
 *
 * A fiduciaire arriving with a year of entries in Excel had to map ten columns
 * by hand before Wheat would look at the file — every time, for every client,
 * even though the headers say "Date", "N° compte", "Débit" in almost every
 * export any Moroccan accounting package produces. The import screen said as
 * much: "chargé sans mapping automatique".
 *
 * This proposes the mapping instead. Two independent signals are combined:
 *
 *   *The header.* Normalised (accents, case, punctuation and spacing removed)
 *   and matched against the vocabulary the common exports actually use —
 *   Sage, Ciel, generic French, English. A header match is strong evidence.
 *
 *   *The column's own content.* What proportion of its values parse as ISO or
 *   French dates, as exact decimal amounts, as PCGE account codes, as a short
 *   journal code. Content is what settles a file whose headers are "Col1..Col10"
 *   or in a language nobody anticipated, and what stops a "Date de règlement"
 *   column being taken for the entry date when a better one exists.
 *
 * Nothing here is authoritative. The result is a *proposal*: each field carries
 * the confidence and the reason it was chosen, the screen shows them, and the
 * user changes any of them before staging. The staging service then re-validates
 * every row exactly as it did when the mapping was typed by hand — this module
 * never relaxes a check, it only saves the typing.
 */

export const LEDGER_IMPORT_FIELDS = [
  "entryKey", "date", "journalCode", "pieceNumber", "entryLabel",
  "accountCode", "lineLabel", "debit", "credit", "thirdParty",
] as const;

export type LedgerImportField = (typeof LEDGER_IMPORT_FIELDS)[number];

export type MappingSuggestion = {
  field: LedgerImportField;
  /** Index into the sheet's columns, or null when nothing was convincing. */
  columnIndex: number | null;
  /** 0-100. Above 70 the screen treats it as settled; below, it highlights it. */
  confidence: number;
  /** Why this column, in one sentence, for the person checking. */
  reason: string;
};

export type MappingProposal = {
  suggestions: MappingSuggestion[];
  /** Fields Wheat could not fill; the screen asks for exactly these. */
  unresolved: LedgerImportField[];
  /** Overall: are all the required fields settled with reasonable confidence? */
  complete: boolean;
};

type Sheet = { headers: string[]; rows: Array<{ values: string[] }> };

const REQUIRED: ReadonlySet<LedgerImportField> = new Set([
  "entryKey", "date", "journalCode", "pieceNumber", "entryLabel", "accountCode", "lineLabel", "debit", "credit",
]);

/**
 * Header vocabulary, per field.
 *
 * `exact` wins over `contains`: a column headed "Date" is the entry date, while
 * "Date d'échéance" merely contains it. Terms are stored normalised.
 */
const HEADERS: Record<LedgerImportField, { exact: string[]; contains: string[]; avoid?: string[] }> = {
  entryKey: {
    exact: ["cleecriture", "clecriture", "numeroecriture", "necriture", "noecriture", "entrykey", "ecriture", "numecriture", "idecriture", "mouvement"],
    contains: ["cleecriture", "numeroecriture", "entrykey", "identifiantecriture"],
  },
  date: {
    exact: ["date", "dateecriture", "datepiece", "datecompta", "datecomptable", "jour", "entrydate", "dateoperation"],
    contains: ["dateecriture", "datecomptable", "datepiece"],
    avoid: ["echeance", "reglement", "valeur", "paiement", "duedate", "creation", "saisie", "edition"],
  },
  journalCode: {
    exact: ["journal", "codejournal", "jrn", "jnl", "journalcode", "codejrn", "jo"],
    contains: ["journal"],
    avoid: ["libellejournal", "nomjournal"],
  },
  pieceNumber: {
    exact: ["piece", "npiece", "nopiece", "numeropiece", "numpiece", "reference", "ref", "piecenumber", "document", "facture", "numerofacture"],
    contains: ["piece", "reference", "numerofacture"],
    avoid: ["datepiece", "libellepiece"],
  },
  entryLabel: {
    exact: ["libelleecriture", "libelle", "libelleoperation", "intitule", "entrylabel", "description", "objet"],
    contains: ["libelleecriture", "libelleoperation"],
    avoid: ["libelleligne", "libellecompte", "libelletiers"],
  },
  accountCode: {
    exact: ["compte", "ncompte", "nocompte", "numerocompte", "numcompte", "comptegeneral", "cptegeneral", "account", "accountcode", "cpt", "compteclient"],
    contains: ["compte", "account"],
    avoid: ["libellecompte", "nomcompte", "intitulecompte", "comptetiers", "contrepartie"],
  },
  lineLabel: {
    exact: ["libelleligne", "libelledetail", "designation", "linelabel", "libelle2", "detail"],
    contains: ["libelleligne", "designation"],
    avoid: ["libelleecriture"],
  },
  debit: {
    exact: ["debit", "montantdebit", "debitmad", "debitdh", "dt", "d"],
    contains: ["debit"],
    avoid: ["soldedebiteur", "cumuldebit", "totaldebit"],
  },
  credit: {
    exact: ["credit", "montantcredit", "creditmad", "creditdh", "ct", "c"],
    contains: ["credit"],
    avoid: ["soldecrediteur", "cumulcredit", "totalcredit"],
  },
  thirdParty: {
    exact: ["tiers", "comptetiers", "auxiliaire", "compteauxiliaire", "client", "fournisseur", "thirdparty", "partenaire"],
    contains: ["tiers", "auxiliaire"],
  },
};

/** Accents, case, punctuation and spacing all differ between exports. */
export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/* ------------------------------------------------------------------ */
/* What a column's values look like                                    */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOOSE_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
/**
 * Thousands separators as exports actually write them: a plain space, a
 * non-breaking space, or a narrow no-break space — all of which JavaScript's
 * `\s` already matches. They are stripped before a value is tested.
 */
const THOUSANDS_SEPARATORS = /\s/g;
/** An exact decimal, in either separator convention, once spacing is gone. */
const AMOUNT = /^-?\d+(?:[.,]\d{1,4})?$/;
const ACCOUNT_CODE = /^\d{3,10}$/;
const JOURNAL_CODE = /^[A-Za-z][A-Za-z0-9]{0,5}$/;

type ColumnShape = {
  values: string[];
  filled: number;
  dateRatio: number;
  amountRatio: number;
  zeroOrBlankRatio: number;
  accountRatio: number;
  journalRatio: number;
  distinctRatio: number;
  distinctCount: number;
  averageLength: number;
};

function shapeOf(values: string[]): ColumnShape {
  const filled = values.filter((value) => value.trim().length > 0);
  const ratio = (count: number) => (filled.length ? count / filled.length : 0);
  const isDate = (value: string) => ISO_DATE.test(value) || LOOSE_DATE.test(value);
  const isAmount = (value: string) => AMOUNT.test(value.replace(THOUSANDS_SEPARATORS, ""));
  const numericValue = (value: string) => Number(value.replace(THOUSANDS_SEPARATORS, "").replace(",", "."));
  return {
    values,
    filled: filled.length,
    dateRatio: ratio(filled.filter(isDate).length),
    amountRatio: ratio(filled.filter(isAmount).length),
    // A debit column in a journal export is mostly empty or zero, because each
    // line carries one side only. That asymmetry is what separates the two.
    zeroOrBlankRatio: values.length
      ? values.filter((value) => !value.trim() || (isAmount(value) && numericValue(value) === 0)).length / values.length
      : 0,
    accountRatio: ratio(filled.filter((value) => ACCOUNT_CODE.test(value.trim())).length),
    journalRatio: ratio(filled.filter((value) => JOURNAL_CODE.test(value.trim())).length),
    distinctRatio: filled.length ? new Set(filled).size / filled.length : 0,
    distinctCount: new Set(filled).size,
    averageLength: filled.length ? filled.reduce((sum, value) => sum + value.length, 0) / filled.length : 0,
  };
}

/** 0-100: how well a column's *content* fits a field, ignoring its header. */
function contentScore(field: LedgerImportField, shape: ColumnShape): number {
  if (!shape.filled) return 0;
  switch (field) {
    case "date":
      return shape.dateRatio >= 0.9 ? 70 : shape.dateRatio >= 0.6 ? 40 : 0;
    case "debit":
    case "credit":
      // Amounts, and a column that is mostly empty or zero: one side of a
      // double entry. A column of amounts that is always filled is a total.
      return shape.amountRatio >= 0.85 && shape.zeroOrBlankRatio >= 0.25 ? 45 : shape.amountRatio >= 0.85 ? 20 : 0;
    case "accountCode":
      return shape.accountRatio >= 0.9 ? 55 : shape.accountRatio >= 0.6 ? 25 : 0;
    case "journalCode":
      // A dossier keeps a handful of journals whatever the size of the file, so
      // the test is the *number* of distinct codes, not their proportion: a
      // ratio rejects a correct column in a short extract and accepts a wrong
      // one in a long file.
      return shape.journalRatio >= 0.9 && shape.distinctCount <= 12 && shape.averageLength <= 6 ? 50 : 0;
    case "entryKey":
      // Repeats across the lines of one entry: several lines, one key.
      return shape.distinctRatio > 0 && shape.distinctRatio <= 0.75 && shape.averageLength <= 40 ? 25 : 0;
    case "pieceNumber":
      return shape.averageLength <= 30 && shape.distinctRatio <= 0.9 ? 15 : 0;
    case "entryLabel":
    case "lineLabel":
      return shape.averageLength >= 8 && shape.dateRatio < 0.2 && shape.amountRatio < 0.2 ? 25 : 0;
    case "thirdParty":
      return shape.averageLength >= 3 && shape.amountRatio < 0.2 && shape.dateRatio < 0.2 ? 12 : 0;
    default:
      return 0;
  }
}

/** 0-100: how well a column's *header* names a field. */
function headerScore(field: LedgerImportField, header: string): { score: number; exact: boolean } {
  const vocabulary = HEADERS[field];
  const normalized = normalizeHeader(header);
  if (!normalized) return { score: 0, exact: false };
  if (vocabulary.avoid?.some((term) => normalized.includes(term))) return { score: 0, exact: false };
  if (vocabulary.exact.includes(normalized)) return { score: 100, exact: true };
  if (vocabulary.contains.some((term) => normalized.includes(term))) return { score: 65, exact: false };
  // A header that merely starts with the word — "debitmad2026".
  if (vocabulary.exact.some((term) => term.length >= 4 && normalized.startsWith(term))) return { score: 55, exact: false };
  return { score: 0, exact: false };
}

/* ------------------------------------------------------------------ */
/* The proposal                                                        */
/* ------------------------------------------------------------------ */

/**
 * Proposes one column per field, never the same column twice.
 *
 * Candidates are scored per (field, column) pair, then assigned greedily from
 * the strongest pair down. Greedy assignment is what prevents the classic
 * failure of independent per-field choice: "Débit" and "Crédit" both scoring
 * highest on the same amount column, and one of them silently winning.
 */
export function proposeLedgerImportMapping(sheet: Sheet): MappingProposal {
  const columnCount = sheet.headers.length;
  const sample = sheet.rows.slice(0, 400);
  const shapes = Array.from({ length: columnCount }, (_, index) => shapeOf(sample.map((row) => String(row.values[index] ?? ""))));

  type Candidate = { field: LedgerImportField; columnIndex: number; score: number; reason: string };
  const candidates: Candidate[] = [];

  for (const field of LEDGER_IMPORT_FIELDS) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const header = sheet.headers[columnIndex] ?? "";
      const byHeader = headerScore(field, header);
      const byContent = contentScore(field, shapes[columnIndex]);
      if (!byHeader.score && !byContent) continue;

      // The header names the intent; the content confirms it. A header match
      // that the content contradicts is heavily discounted rather than trusted,
      // which is what stops "Date" over a column of amounts.
      const contradicts = byHeader.score > 0 && byContent === 0 && requiresContent(field);
      const score = contradicts
        ? Math.round(byHeader.score * 0.35)
        : Math.min(100, Math.round(byHeader.score * 0.7 + byContent * 0.6));

      const reason = byHeader.exact
        ? `L'en-tête « ${header} » nomme ce champ.`
        : byHeader.score > 0 && byContent > 0
          ? `L'en-tête « ${header} » et le contenu de la colonne concordent.`
          : byHeader.score > 0
            ? `L'en-tête « ${header} » ressemble à ce champ${contradicts ? ", mais son contenu ne le confirme pas" : ""}.`
            : `Le contenu de la colonne « ${header || `n° ${columnIndex + 1}`} » correspond à ce champ.`;
      candidates.push({ field, columnIndex, score, reason });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.columnIndex - right.columnIndex);
  const takenColumns = new Set<number>();
  const chosen = new Map<LedgerImportField, Candidate>();
  for (const candidate of candidates) {
    if (chosen.has(candidate.field) || takenColumns.has(candidate.columnIndex)) continue;
    if (candidate.score < 25) continue;
    chosen.set(candidate.field, candidate);
    takenColumns.add(candidate.columnIndex);
  }

  // A file that carries one signed amount column instead of debit and credit is
  // common enough to name explicitly rather than leave as two blank fields.
  const suggestions: MappingSuggestion[] = LEDGER_IMPORT_FIELDS.map((field) => {
    const candidate = chosen.get(field);
    if (!candidate) {
      return {
        field,
        columnIndex: null,
        confidence: 0,
        reason: REQUIRED.has(field)
          ? "Aucune colonne ne correspond : indiquez-la vous-même."
          : "Aucune colonne correspondante ; ce champ est facultatif.",
      };
    }
    return { field, columnIndex: candidate.columnIndex, confidence: Math.min(99, candidate.score), reason: candidate.reason };
  });

  const unresolved = suggestions
    .filter((suggestion) => REQUIRED.has(suggestion.field) && suggestion.columnIndex === null)
    .map((suggestion) => suggestion.field);

  return { suggestions, unresolved, complete: unresolved.length === 0 };
}

/** Fields whose content is distinctive enough that a header alone is not proof. */
function requiresContent(field: LedgerImportField) {
  return field === "date" || field === "debit" || field === "credit" || field === "accountCode";
}

/**
 * Fills in an entry key when the file has no column for one.
 *
 * Many exports identify an entry only by the repetition of its journal, date
 * and piece number across consecutive lines. Wheat needs a key to group the
 * lines and check that each entry balances; deriving it from the three columns
 * that *are* present is exact, and far better than refusing the file.
 */
export function deriveEntryKey(row: { journalCode: string; date: string; pieceNumber: string }): string {
  return [row.journalCode, row.date, row.pieceNumber].map((part) => String(part ?? "").trim()).join("|");
}
