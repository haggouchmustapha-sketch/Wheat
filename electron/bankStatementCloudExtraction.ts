import { CloudOcrFailureError, CloudOcrUnavailableError, describeCloudOcrFailure, type CloudOcrRuntime } from "./cloudOcr";
import { looksLikeStatementAmount } from "./reconciliation";

/**
 * Reading a scanned bank statement with the provider the user authorised.
 *
 * Wheat Lightweight does not carry the local recognition runtime, so a scanned
 * statement had nothing at all to read it and the import stopped with an error
 * about a component that edition deliberately does not ship. This is the path
 * that reads it instead — and, in Standard, the alternative an accountant may
 * explicitly ask for when the local engine could not finish the table.
 *
 * ## What this produces, and what it does not
 *
 * It produces **a table**, in exactly the shape every other bank parser in
 * `bankStatementImporter.ts` produces: headers, and rows of text as printed.
 * From there the statement travels the one road Wheat has — the same column
 * mapping, the same `normalizeStatementRows`, the same duplicate detection, the
 * same balance equation, the same preview, the same explicit confirmation, the
 * same import history. There is no AI-specific import, no AI-specific
 * persistence, and nothing here can write an accounting record.
 *
 * ## Why the model is never trusted with the dangerous decisions
 *
 * A misread invoice costs somebody five minutes. A misread bank statement
 * silently changes what a business believes it has. So the prompt asks for a
 * transcription of rows, and every judgement that could turn a transcription
 * into a wrong ledger is made *here*, deterministically, on the way out:
 *
 *   1. **Money is never re-derived.** Amounts are carried as the characters
 *      printed on the page and parsed downstream by the exact-decimal reader
 *      Wheat already uses. No arithmetic happens in this module, and no
 *      floating-point value ever represents a posted amount.
 *   2. **A side is never guessed.** A movement carries a debit or a credit. A
 *      row offered with both, or with neither, is kept and reported as a
 *      blocking issue — never quietly assigned to the likelier column.
 *   3. **Balances are not movements.** Opening and closing balances, subtotals
 *      and page carry-forwards are recognised and kept *out* of the movement
 *      table. They are reported as read text so a person can use them, and they
 *      are never fed into Wheat's balance check as if a format had declared
 *      them — a number read off a scan is not a declaration.
 *   4. **Nothing is dropped in silence.** A row the model could not classify, a
 *      value that is not a number, a page that failed: each one becomes a named
 *      issue, and issues that matter block confirmation. An import is never
 *      presented as complete when part of it was discarded.
 *   5. **Everything is bounded.** Pages, rows per page, and the size of every
 *      cell. The reply is hostile input and is parsed as such.
 */

/** Hard ceilings on anything a provider can return, per page. */
const MAX_ROWS_PER_PAGE = 300;
const MAX_CELL_CHARS = 300;
/** Bounded work: an accountant's statement, not an archive. */
export const MAX_CLOUD_STATEMENT_PAGES = 12;

/**
 * The columns the extraction produces.
 *
 * Chosen so `suggestStatementMapping` identifies every one of them without a
 * person having to intervene, and so a "Solde" column can never be mistaken for
 * a movement amount. They are the statement's own vocabulary, in French,
 * because that is what the review screen shows.
 */
export const CLOUD_BANK_HEADERS = ["Date", "Date valeur", "Libellé", "Référence", "Débit", "Crédit", "Solde"] as const;

const FIELD_BY_HEADER = {
  "Date": "date",
  "Date valeur": "valueDate",
  "Libellé": "label",
  "Référence": "reference",
  "Débit": "debit",
  "Crédit": "credit",
  "Solde": "balance",
} as const;

type CloudBankField = (typeof FIELD_BY_HEADER)[keyof typeof FIELD_BY_HEADER];

/** What a line on the page is. Anything else is `UNCERTAIN`, which blocks. */
export type CloudBankRowKind =
  | "TRANSACTION"
  | "OPENING_BALANCE"
  | "CLOSING_BALANCE"
  | "SUBTOTAL"
  | "CARRY_FORWARD"
  | "HEADER"
  | "UNCERTAIN";

const KNOWN_KINDS = new Set<string>(["TRANSACTION", "OPENING_BALANCE", "CLOSING_BALANCE", "SUBTOTAL", "CARRY_FORWARD", "HEADER"]);

/**
 * Where a proposed movement came from, and how sure the reading was.
 *
 * Kept per row and shown beside it during review: the page it was read on, the
 * line on that page where the model could say, the values exactly as they came
 * back before Wheat touched them, anything Wheat corrected or refused, and the
 * fields the model itself flagged as hard to read.
 */
export type CloudBankRowEvidence = {
  /** 1-based row number in the produced table, matching the review preview. */
  row: number;
  page: number;
  /** 1-based line on the page, where the reading could establish it. */
  lineOnPage: number | null;
  kind: CloudBankRowKind;
  /** The values as the provider returned them, before any Wheat rule ran. */
  original: Partial<Record<CloudBankField, string>>;
  /** Values Wheat refused, with the reason. Never silently discarded. */
  corrections: string[];
  /** Fields the reading itself reported as uncertain. */
  uncertainFields: CloudBankField[];
};

/** A balance line the page states, kept as text and never as a declaration. */
export type CloudBankReadBalance = { kind: "OPENING_BALANCE" | "CLOSING_BALANCE"; page: number; label: string; amount: string };

export type CloudBankExtraction = {
  headers: string[];
  rows: Array<Record<string, string>>;
  warnings: string[];
  /**
   * Problems that must stop a confirmation, stated so a person can act on them.
   * A statement that cannot be reconstructed reliably arrives with these rather
   * than as a plausible-looking table.
   */
  blockingIssues: string[];
  evidence: CloudBankRowEvidence[];
  /**
   * Opening and closing balances read off the pages. Offered to the accountant
   * to confirm and apply; never passed to the balance check on their own.
   */
  readBalances: CloudBankReadBalance[];
  currency: string | null;
  confidence: number;
  provider: string;
  modelId: string;
  pageCount: number;
  /** Pages actually read, which is `pageCount` unless the ceiling was hit. */
  pagesRead: number;
};

const SYSTEM_PROMPT = [
  "Tu transcris une page de releve bancaire marocain scannee ou photographiee.",
  "Tu ne calcules rien, tu ne resumes rien, tu n'inventes rien : tu recopies ce qui est imprime sur la page.",
  "Reponds uniquement par un objet JSON, sans texte autour et sans bloc de code.",
  "Format exact :",
  "{\"currency\":\"MAD\",\"rows\":[{\"line\":1,\"kind\":\"TRANSACTION\",\"date\":\"25 06\",\"valueDate\":\"25 06 2026\",\"label\":\"VIREMENT RECU\",\"reference\":\"123456\",\"debit\":\"\",\"credit\":\"18 334,42\",\"balance\":\"\",\"uncertain\":[\"reference\"]}]}",
  "\"kind\" vaut TRANSACTION pour un mouvement reel,",
  "OPENING_BALANCE pour un solde initial ou un ancien solde,",
  "CLOSING_BALANCE pour un solde final ou un nouveau solde,",
  "SUBTOTAL pour un total ou un sous-total,",
  "CARRY_FORWARD pour un report de page,",
  "HEADER pour un en-tete de colonnes, un pied de page ou une mention legale.",
  "Si tu ne peux pas determiner la nature d'une ligne, mets \"kind\":\"UNCERTAIN\" : ne devine pas.",
  "Recopie chaque montant exactement comme il est imprime, avec ses espaces, ses virgules et ses points. Ne convertis pas, n'arrondis pas, n'additionne pas.",
  "Un mouvement porte un debit OU un credit, jamais les deux. Si tu ne distingues pas de quelle colonne vient le montant, laisse \"debit\" et \"credit\" vides et ajoute \"debit\" et \"credit\" dans \"uncertain\".",
  "N'invente jamais une ligne, une date, une reference, un libelle, un montant ou un solde absent de la page.",
  "Si une valeur est illisible, laisse la chaine vide et nomme le champ dans \"uncertain\".",
  "Transcris toutes les lignes de la page, y compris celles qui ne sont pas des mouvements, dans l'ordre d'impression.",
].join(" ");

const USER_PROMPT = [
  "Transcris les lignes de cette page de releve bancaire.",
  "Numerote chaque ligne dans \"line\" en partant de 1, dans l'ordre d'impression.",
].join(" ");

export type CloudBankPage = { page: number; mimeType: string; base64: string };

/**
 * Reads the prepared pages of one statement.
 *
 * Page by page rather than all at once: a page is a bounded unit of work, a
 * bounded upload and a bounded reply, and it is what lets the import report
 * progress and stop when the accountant cancels.
 */
export async function extractBankStatementWithCloud(input: {
  runtime: CloudOcrRuntime;
  pages: CloudBankPage[];
  consentGiven: boolean;
  signal?: AbortSignal;
  onPage?: (event: { page: number; completed: number; total: number }) => void;
}): Promise<CloudBankExtraction> {
  if (!input.consentGiven) throw new CloudOcrUnavailableError("CONSENT_REQUIRED");
  if (!input.runtime.isConnected()) throw new CloudOcrUnavailableError("NOT_CONNECTED");
  const pages = input.pages.slice(0, MAX_CLOUD_STATEMENT_PAGES);
  if (!pages.length) throw new CloudOcrFailureError("Aucune page n'a pu être préparée pour la lecture en ligne.", "RETRY");

  const rows: Array<Record<string, string>> = [];
  const evidence: CloudBankRowEvidence[] = [];
  const readBalances: CloudBankReadBalance[] = [];
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const confidences: number[] = [];
  const currencies = new Set<string>();
  let provider = "";
  let modelId = "";
  let pagesRead = 0;

  for (const page of pages) {
    throwIfAborted(input.signal);
    let reply: Awaited<ReturnType<CloudOcrRuntime["runVision"]>>;
    try {
      reply = await input.runtime.runVision({
        system: SYSTEM_PROMPT,
        user: USER_PROMPT,
        images: [{ mimeType: page.mimeType, base64: page.base64 }],
      });
    } catch (error) {
      throwIfAborted(input.signal);
      // The first page failing is a failed reading; a later page failing would
      // leave a statement with a hole in it, which must never look complete.
      const described = describeCloudOcrFailure(error);
      throw new CloudOcrFailureError(
        pagesRead === 0
          ? described.message
          : `${described.message} La page ${page.page} n'a pas pu être lue : le relevé serait incomplet, aucun mouvement n'est proposé.`,
        described.remedy,
        { cause: error },
      );
    }
    provider ||= reply.provider;
    modelId ||= reply.modelId;

    const parsed = parseCloudBankReply(reply.text);
    if (!parsed) {
      throw new CloudOcrFailureError(
        `La lecture en ligne n'a pas renvoyé de tableau exploitable pour la page ${page.page}. Aucun mouvement n'est proposé.`,
        "RETRY",
      );
    }
    pagesRead += 1;
    if (parsed.currency) currencies.add(parsed.currency);

    for (const candidate of parsed.rows) {
      const corrections: string[] = [];
      const cells = sanitizeCells(candidate, corrections);
      const kind = candidate.kind;
      const where = `Page ${page.page}${candidate.line ? `, ligne ${candidate.line}` : ""}`;

      if (kind === "OPENING_BALANCE" || kind === "CLOSING_BALANCE") {
        const amount = cells.balance || cells.credit || cells.debit || "";
        readBalances.push({ kind, page: page.page, label: cells.label || where, amount });
        warnings.push(`${where} : ${kind === "OPENING_BALANCE" ? "solde initial" : "solde final"} lu sur la page${amount ? ` (${amount})` : ""}. Un solde n'est pas un mouvement : il n'est pas importé.`);
        continue;
      }
      if (kind === "SUBTOTAL" || kind === "CARRY_FORWARD" || kind === "HEADER") {
        warnings.push(`${where} : ligne « ${kind === "SUBTOTAL" ? "total" : kind === "CARRY_FORWARD" ? "report de page" : "en-tête ou mention"} » reconnue et exclue des mouvements.`);
        continue;
      }

      // Everything below becomes a row an accountant will see and confirm.
      // The total is already bounded twice over: each page's reply is capped at
      // MAX_ROWS_PER_PAGE, and the importer refuses any statement over its own
      // row limit with a sentence that names it.
      const rowNumber = rows.length + 1;

      if (kind === "UNCERTAIN") {
        blockingIssues.push(`${where} : la lecture n'a pas pu établir s'il s'agit d'un mouvement. Vérifiez cette ligne sur le relevé, corrigez-la ou retirez-la avant de confirmer.`);
      } else {
        const hasDebit = Boolean(cells.debit);
        const hasCredit = Boolean(cells.credit);
        if (hasDebit && hasCredit) {
          blockingIssues.push(`${where} : un débit et un crédit ont été lus sur la même ligne. Wheat ne choisit pas à votre place : corrigez la ligne avant de confirmer.`);
        } else if (!hasDebit && !hasCredit) {
          blockingIssues.push(`${where} : aucun montant lisible en débit ni en crédit. Saisissez le montant dans la bonne colonne, ou retirez la ligne.`);
        }
        if (!cells.date) {
          blockingIssues.push(`${where} : aucune date d'opération lisible. Complétez-la avant de confirmer.`);
        }
      }
      for (const field of candidate.uncertain) {
        corrections.push(`Champ « ${field} » signalé comme difficile à lire par la reconnaissance.`);
      }

      rows.push({
        ...Object.fromEntries(CLOUD_BANK_HEADERS.map((header) => [header, cells[FIELD_BY_HEADER[header]] ?? ""])),
        __wheatSourcePage: String(page.page),
      });
      evidence.push({
        row: rowNumber,
        page: page.page,
        lineOnPage: candidate.line,
        kind,
        original: candidate.original,
        corrections,
        uncertainFields: candidate.uncertain,
      });
    }

    confidences.push(parsed.confidence);
    input.onPage?.({ page: page.page, completed: pagesRead, total: pages.length });
  }

  if (!rows.length) {
    throw new CloudOcrFailureError(
      "Aucun mouvement n'a été reconnu sur ce relevé. Vérifiez qu'il s'agit bien d'un relevé bancaire, ou fournissez un export CSV, XLSX, OFX, MT940 ou CAMT.053.",
      "RETRY",
    );
  }
  if (currencies.size > 1) {
    blockingIssues.push(`Plusieurs devises ont été lues sur ce relevé (${[...currencies].join(", ")}). Wheat n'en choisit aucune : contrôlez le relevé avant de confirmer.`);
  }

  return {
    headers: [...CLOUD_BANK_HEADERS],
    rows,
    warnings,
    blockingIssues,
    evidence,
    readBalances,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    confidence: confidences.length ? Math.round(confidences.reduce((total, value) => total + value, 0) / confidences.length) : 0,
    provider,
    modelId,
    pageCount: input.pages.length,
    pagesRead,
  };
}

type CandidateRow = {
  line: number | null;
  kind: CloudBankRowKind;
  original: Partial<Record<CloudBankField, string>>;
  uncertain: CloudBankField[];
};

/**
 * Turns one provider reply into bounded, fully typed candidate rows — or null.
 *
 * Exported because this is the boundary worth testing exhaustively: it is the
 * only place where text an external service composed becomes something Wheat
 * carries towards a ledger. Every branch either produces a value of the
 * declared type or returns null; it never returns a half-trusted object.
 */
export function parseCloudBankReply(reply: string): { currency: string | null; confidence: number; rows: CandidateRow[] } | null {
  const object = firstJsonObject(reply);
  if (!object) return null;
  if (!Array.isArray(object.rows)) return null;

  const rows: CandidateRow[] = [];
  for (const raw of object.rows.slice(0, MAX_ROWS_PER_PAGE)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const line = Number(record.line);
    const kindText = String(record.kind ?? "").trim().toUpperCase();
    const original: Partial<Record<CloudBankField, string>> = {};
    for (const field of Object.values(FIELD_BY_HEADER)) {
      const value = record[field];
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).replace(/\s+/g, " ").trim().slice(0, MAX_CELL_CHARS);
        if (text) original[field] = text;
      }
    }
    const uncertain = Array.isArray(record.uncertain)
      ? record.uncertain
        .map((entry) => String(entry ?? "").trim())
        .filter((entry): entry is CloudBankField => (Object.values(FIELD_BY_HEADER) as string[]).includes(entry))
      : [];
    // A row with nothing on it is not a row; a row Wheat cannot name the kind
    // of is UNCERTAIN, which is a reported problem rather than a silent guess.
    if (!Object.keys(original).length && !uncertain.length) continue;
    rows.push({
      line: Number.isInteger(line) && line > 0 && line <= MAX_ROWS_PER_PAGE ? line : null,
      kind: KNOWN_KINDS.has(kindText) ? (kindText as CloudBankRowKind) : "UNCERTAIN",
      original,
      uncertain: [...new Set(uncertain)],
    });
  }

  const currency = typeof object.currency === "string" && /^[A-Za-z]{3}$/.test(object.currency.trim())
    ? object.currency.trim().toUpperCase()
    : null;
  return { currency, confidence: boundedConfidence(object.confidence), rows };
}

/**
 * Applies Wheat's own rules to one candidate row's cells.
 *
 * A money cell that is not a number is not money, whatever it was labelled: it
 * is removed and the removal is recorded, so an accountant sees that Wheat
 * refused a value rather than that the page had none.
 */
function sanitizeCells(candidate: CandidateRow, corrections: string[]): Partial<Record<CloudBankField, string>> {
  const cells: Partial<Record<CloudBankField, string>> = { ...candidate.original };
  for (const field of ["debit", "credit", "balance"] as const) {
    const value = cells[field];
    if (value && !looksLikeStatementAmount(value)) {
      corrections.push(`« ${value} » n'a pas été retenu comme montant (${field}) : ce n'est pas un nombre.`);
      delete cells[field];
    }
  }
  return cells;
}

function firstJsonObject(reply: string): Record<string, unknown> | null {
  const trimmed = String(reply ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A reading nobody scored is "check this", not "certain". */
function boundedConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 70;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export class BankStatementReadCancelledError extends Error {
  constructor() {
    super("La lecture du relevé a été annulée. Aucun mouvement n'a été créé.");
    this.name = "BankStatementReadCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new BankStatementReadCancelledError();
}
