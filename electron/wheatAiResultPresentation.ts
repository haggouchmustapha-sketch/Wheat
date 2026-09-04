/**
 * How a capability's result is shown to the person who asked for it.
 *
 * Wheat AI answers a business question by running a typed capability. Until
 * now the conversation ended there: the capability returned its data, the
 * window showed a card reading `reports.aged_payables` and "Terminée", and the
 * accountant who asked which suppliers were unpaid never saw a supplier. The
 * work had been done and the answer thrown away.
 *
 * This module turns a capability result into what the window renders. Three
 * properties are deliberate:
 *
 *  - It is derived, not generated. Nothing here asks a model. The capability
 *    already computed the figures; describing them is arithmetic and wording,
 *    and a second inference call would only add latency and a chance to lie.
 *
 *  - It is generic. It reads the shape of a result — collections, totals,
 *    scalars — rather than naming capabilities. A capability added tomorrow
 *    presents itself without being registered here, which is the only way this
 *    stays true as the registry grows.
 *
 *  - It never invents. A value that cannot be rendered faithfully is omitted,
 *    an empty result says plainly that nothing matched, and a truncated table
 *    reports how many rows it holds.
 *
 * Capability identifiers, arguments and durations are not part of this: they
 * belong to the execution-details disclosure, not to the answer.
 */

export type WheatAiPresentationColumn = {
  key: string;
  label: string;
  numeric: boolean;
};

export type WheatAiPresentationTable = {
  title: string;
  columns: WheatAiPresentationColumn[];
  rows: Array<Record<string, string>>;
  /** Rows the capability returned, including any beyond those listed. */
  totalRows: number;
};

export type WheatAiUserPresentation = {
  kind: "table" | "summary" | "record" | "navigation" | "none";
  /** A human title. Never a capability identifier. */
  title: string;
  /** The sentence that answers the question, including the empty answer. */
  summary: string;
  tables: WheatAiPresentationTable[];
  facts: Array<{ label: string; value: string }>;
};

const MAX_TABLE_ROWS = 50;
const MAX_COLUMNS = 8;
const MAX_TABLES = 3;
const MAX_FACTS = 12;
const MAX_CELL = 120;

/** Exact integer centimes to a readable figure. Never converts through Number. */
function formatCents(cents: bigint, currency: string): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const grouped = String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "−" : ""}${grouped},${String(absolute % 100n).padStart(2, "0")} ${currency}`;
}

function asCents(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d{1,30}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?$/;

/**
 * Field names an accountant reads, for the keys Wheat's domain services
 * actually return. An unlisted key is humanised from its own name rather than
 * hidden: a column with an awkward heading is still an answer, a missing
 * column is not.
 */
const FIELD_LABELS: Record<string, string> = {
  accountcode: "Compte",
  accountname: "Libellé du compte",
  allocatedcents: "Imputé",
  amountcents: "Montant",
  asof: "Au",
  bucket: "Tranche",
  closingbalancecents: "Solde de clôture",
  code: "Code",
  creditcents: "Crédit",
  currency: "Devise",
  date: "Date",
  dayspastdue: "Jours de retard",
  debitcents: "Débit",
  displayname: "Tiers",
  duedate: "Échéance",
  htcents: "HT",
  invoicecount: "Factures",
  invoicenumber: "Facture",
  journalcode: "Journal",
  kind: "Type",
  label: "Libellé",
  name: "Nom",
  number: "Numéro",
  openingbalancecents: "Solde d'ouverture",
  originalcents: "Montant initial",
  outstandingcents: "Encours",
  overpaidcents: "Trop-perçu",
  paymentdate: "Date de règlement",
  piecenumber: "Pièce",
  reference: "Référence",
  status: "Statut",
  ttccents: "TTC",
  vatcents: "TVA",
};

/** Ageing buckets carry their own meaning; the key alone reads as jargon. */
const BUCKET_LABELS: Record<string, string> = {
  current: "Non échu",
  d1to30: "1 à 30 j",
  d31to60: "31 à 60 j",
  d61to90: "61 à 90 j",
  d90plus: "Plus de 90 j",
};

function humanLabel(key: string): string {
  const normalized = key.toLowerCase();
  const known = FIELD_LABELS[normalized] ?? BUCKET_LABELS[normalized];
  if (known) return known;
  const spaced = key
    .replace(/Cents$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function isMoneyKey(key: string): boolean {
  return /cents$/i.test(key);
}

/**
 * One cell. Returns `null` for anything that cannot be shown faithfully — a
 * nested structure, a value the reader would have to guess at — so the column
 * is dropped rather than filled with `[object Object]`.
 */
function formatCell(key: string, value: unknown, currency: string): string | null {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (isMoneyKey(key)) {
    const cents = asCents(value);
    return cents === null ? null : formatCents(cents, currency);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const iso = ISO_DATE.exec(trimmed);
    if (iso) {
      const [year, month, day] = iso[1].split("-");
      return `${day}/${month}/${year}`;
    }
    return trimmed.length > MAX_CELL ? `${trimmed.slice(0, MAX_CELL - 1)}…` : trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = value as Record<string, unknown>;
    for (const preferred of ["name", "displayName", "label", "code", "number"]) {
      const candidate = nested[preferred];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, MAX_CELL);
    }
  }
  return null;
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

/** The columns worth showing: first-seen order, dropping any that renders nothing. */
function buildTable(title: string, rows: Array<Record<string, unknown>>, currency: string): WheatAiPresentationTable | null {
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const keys: string[] = [];
  for (const row of shown) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  const hasNonIdentifier = keys.some((key) => !/Id$/.test(key) && key !== "id");
  const columns: WheatAiPresentationColumn[] = [];
  const rendered: Array<Record<string, string>> = shown.map(() => ({}));
  for (const key of keys) {
    if (columns.length >= MAX_COLUMNS) break;
    // A raw identifier is not an answer. It stays only when the row has
    // nothing else to show, so the reader is never handed a table of cuids.
    if (hasNonIdentifier && (key === "id" || /Id$/.test(key))) continue;
    const cells = shown.map((row) => formatCell(key, row[key], currency));
    if (cells.some((cell) => cell === null)) continue;
    if (cells.every((cell) => cell === "—")) continue;
    columns.push({
      key,
      label: humanLabel(key),
      // Whether a column is right-aligned is decided on the values the
      // capability returned, not on how they happen to be punctuated once
      // formatted: a thousands separator is not evidence of a number.
      numeric: isMoneyKey(key) || shown.every((row) => typeof row[key] === "number" || typeof row[key] === "bigint"),
    });
    cells.forEach((cell, index) => { rendered[index][key] = cell as string; });
  }
  if (!columns.length) return null;
  return { title, columns, rows: rendered, totalRows: rows.length };
}

/** Scalar and money leaves of an object, as labelled facts. */
function buildFacts(source: Record<string, unknown>, currency: string): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(source)) {
    if (facts.length >= MAX_FACTS) break;
    if (value === null || value === undefined || typeof value === "object") continue;
    if (key === "id" || /Id$/.test(key)) continue;
    const cell = formatCell(key, value, currency);
    if (cell === null || cell === "—") continue;
    facts.push({ label: humanLabel(key), value: cell });
  }
  return facts;
}

function currencyOf(result: Record<string, unknown>): string {
  const direct = result.currency;
  if (typeof direct === "string" && /^[A-Z]{3}$/.test(direct)) return direct;
  const company = result.company;
  if (company && typeof company === "object") {
    const nested = (company as Record<string, unknown>).currency;
    if (typeof nested === "string" && /^[A-Z]{3}$/.test(nested)) return nested;
  }
  return "MAD";
}

function countSentence(tables: WheatAiPresentationTable[]): string {
  return tables.map((table) => `${table.totalRows} ${table.title}`).join(", ");
}

/**
 * The answer for one executed capability.
 *
 * `title` comes from the capability's own description, so the heading names the
 * work in the language the registry already uses rather than exposing its
 * identifier.
 */
export function describeCapabilityResult(
  capability: { id: string; description: string } | null,
  value: unknown,
): WheatAiUserPresentation {
  const title = (capability?.description ?? "Résultat").replace(/\s*\.\s*$/, "");
  const empty = (summary: string, facts: Array<{ label: string; value: string }> = []): WheatAiUserPresentation =>
    ({ kind: "none", title, summary, tables: [], facts });

  if (value === null || value === undefined) {
    return empty("L'opération n'a produit aucun résultat à afficher.");
  }

  if (isRecordArray(value)) {
    const table = buildTable("élément(s)", value, "MAD");
    return table
      ? { kind: "table", title, summary: `${value.length} élément(s).`, tables: [table], facts: [] }
      : { kind: "summary", title, summary: `${value.length} élément(s).`, tables: [], facts: [] };
  }

  if (Array.isArray(value)) {
    return value.length
      ? { kind: "summary", title, summary: `${value.length} valeur(s) : ${value.slice(0, 10).map((item) => String(item)).join(", ")}.`, tables: [], facts: [] }
      : empty("Aucun élément ne correspond.");
  }

  if (typeof value !== "object") {
    return { kind: "summary", title, summary: String(value), tables: [], facts: [] };
  }

  const result = value as Record<string, unknown>;

  if (result.navigation && typeof result.navigation === "object") {
    return { kind: "navigation", title, summary: "Wheat a ouvert l'écran demandé.", tables: [], facts: [] };
  }

  const currency = currencyOf(result);
  const tables: WheatAiPresentationTable[] = [];
  let emptyCollections = 0;
  for (const [key, nested] of Object.entries(result)) {
    if (tables.length >= MAX_TABLES) break;
    if (!Array.isArray(nested)) continue;
    if (!nested.length) { emptyCollections += 1; continue; }
    if (!isRecordArray(nested)) continue;
    const table = buildTable(humanLabel(key).toLowerCase(), nested, currency);
    if (table) tables.push(table);
  }

  const totals = result.totals;
  const facts = [
    ...buildFacts(result, currency),
    ...(totals && typeof totals === "object" && !Array.isArray(totals) ? buildFacts(totals as Record<string, unknown>, currency) : []),
  ].slice(0, MAX_FACTS);

  if (tables.length) {
    return { kind: "table", title, summary: `${countSentence(tables)}.`, tables, facts };
  }
  if (emptyCollections) {
    return empty("Aucun élément ne correspond à cette demande.", facts);
  }
  if (facts.length) {
    return { kind: "record", title, summary: "", tables: [], facts };
  }
  return empty("L'opération s'est déroulée sans résultat à afficher.");
}
