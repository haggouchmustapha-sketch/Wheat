import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { App } from "electron";
import type { StatementColumnMapping } from "./reconciliation";
import { isPaddleOcrVl16Installed, recognizeWithPaddle, type PaddleOcrResult } from "./paddleOcr";
import { normalizeFlexibleDate } from "./dateNormalization21";
import { classifyStatementRow, inferStatementYear, looksLikeStatementAmount } from "./reconciliation";
import { completeBankTableWithAi, incompleteMovementRows } from "./bankStatementAiFallback";
import {
  extractBankStatementWithCloud,
  MAX_CLOUD_STATEMENT_PAGES,
  type CloudBankExtraction,
} from "./bankStatementCloudExtraction";
import { CloudOcrUnavailableError, type RecognitionPlan } from "./cloudOcr";
import type { AiReviewChat } from "./ocrAiReview";
import { buildCloudImage, renderPdfPages, resolvePdfWorkerUrl } from "./pageImages";
import { readWheatEnv } from "./runtimeEnvironment";

/** The one-way channel a cloud reading reports its page progress on. */
export const BANK_STATEMENT_PROGRESS_CHANNEL = "wheat:bank:statement:progress";

const MAX_SOURCE_BYTES = 25_000_000;
const MAX_ROWS = 2_000;
const nodeRequire = createRequire(import.meta.url);

export type BankStatementFormat =
  | "CSV"
  | "TXT"
  | "XLSX"
  | "XLS"
  | "OFX"
  | "QIF"
  | "MT940"
  | "CAMT053"
  | "PDF_TEXT"
  | "PDF_OCR"
  | "IMAGE_OCR";

export type BankStatementRowClass = "TRANSACTION" | "OPENING_BALANCE" | "CLOSING_BALANCE" | "TOTAL" | "SUBTOTAL" | "HEADER" | "FOOTER" | "CARRY_FORWARD" | "PAGE_NUMBER" | "NOISE" | "UNKNOWN";

export interface CanonicalBankTransaction {
  operationDate: string | null;
  operationDateRaw: string;
  operationDateInferred: boolean;
  valueDate: string | null;
  valueDateRaw: string;
  description: string;
  reference: string;
  bankIdentifier: string;
  debit: string | null;
  credit: string | null;
  signedAmount: string | null;
  currency: string | null;
  balance: string | null;
  sourcePage: number | null;
  sourceRow: number;
  rowClass: BankStatementRowClass;
  confidence: {
    textRecognition: number | null;
    layout: number | null;
    rowReconstruction: number | null;
    fieldMapping: number | null;
    accountingConsistency: number | null;
    finalDocument: number | null;
  };
  raw: Record<string, string>;
}

/**
 * The balances a statement states about itself.
 *
 * Wheat already knows how to check that an opening balance plus the movements
 * it read equals the stated closing balance, and refuses an import where they
 * disagree. Until now nothing supplied the two figures, so that check recorded
 * `equationChecked: false` on every statement ever imported and never once ran.
 *
 * These are read only from formats that state them as machine-readable fields.
 * A number that merely looks like a balance on a scanned page is not evidence:
 * guessing one would turn a real guard into a source of false refusals, so a
 * format that does not declare its balances reports none and the statement-level
 * check stays honestly unavailable.
 */
export interface StatementDeclaredBalances {
  /** Exact integer centimes, signed. Absent when the format does not state it. */
  openingBalanceCents?: string;
  closingBalanceCents?: string;
}

export interface ParsedBankStatement {
  format: BankStatementFormat;
  formatLabel: string;
  parser: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  suggestedMapping: Partial<StatementColumnMapping>;
  warnings: string[];
  currency: string | null;
  rowCount: number;
  previewRows: Array<Record<string, string>>;
  canonicalRows: CanonicalBankTransaction[];
  /** Present only when the source declares them; see StatementDeclaredBalances. */
  declaredBalances?: StatementDeclaredBalances;
  ocr?: {
    engine: string;
    engineVersion: string;
    confidence: number;
    pageCount: number;
    /** False when the pages were read by the provider the user authorised. */
    local: boolean;
    confidenceDimensions: CanonicalBankTransaction["confidence"];
    fallbackRecommended: boolean;
    /**
     * Rows whose empty cells the assisted pass filled from the recognised text.
     * Always shown for review: nothing here was read directly off the page.
     */
    assistedRows?: number[];
    /** Present when the pages themselves were read by the cloud provider. */
    cloud?: CloudBankReading;
    /**
     * Offered when the local engine could not finish and a cloud reading is
     * configured on this machine. Acting on it is an explicit choice: nothing
     * is uploaded until the accountant asks for it.
     */
    cloudOffer?: BankCloudOffer;
  };
}

/**
 * What a cloud reading of a scanned statement carries into the review.
 *
 * Everything an accountant needs to judge the proposal without opening the
 * provider's account: who read it, how much of it was read, what it refused,
 * and what it could not settle. `blockingIssues` is not advisory — the review
 * screen refuses confirmation while any remain.
 */
export type CloudBankReading = {
  provider: string;
  modelId: string;
  pagesRead: number;
  /** Row-level provenance, 1-based against the produced table. */
  evidence: CloudBankExtraction["evidence"];
  blockingIssues: string[];
  /** Balances printed on the pages, for the accountant to confirm and apply. */
  readBalances: CloudBankExtraction["readBalances"];
};

export type BankCloudOffer = {
  /** Why the offer exists: nothing was read, or what was read is unusable. */
  reason: "LOCAL_FAILED" | "LOCAL_INCOMPLETE";
  detail: string;
  /** True when the privacy consent has not been given on this machine yet. */
  consentRequired: boolean;
}

export interface ParseBankStatementInput {
  sourceName: string;
  bytesBase64: string;
  mimeType?: string;
  app?: App;
  /**
   * The document reviewer's channel, reused rather than duplicated. Supplied
   * only when the user has enabled assisted reading and chosen a model; absent,
   * a scanned statement is read entirely by the local path, exactly as before.
   */
  aiFallback?: AiReviewChat;
  /**
   * Who reads a scanned statement, for this build and these settings.
   *
   * The same plan the document pipeline uses, resolved once by the main process
   * so one import cannot read half its pages locally and half in the cloud.
   * Absent means the local engine only, which is exactly how Wheat behaved
   * before cloud recognition existed.
   */
  recognition?: RecognitionPlan;
  /**
   * An accountant explicitly asking for this statement to be read in the cloud.
   *
   * Only ever set by the review screen's own "read this with Wheat Cloud AI"
   * action. A build that can read locally never uploads a bank statement
   * without it — enabling cloud reading in settings is permission, not an
   * instruction, and a bank statement is not an invoice.
   */
  cloudRequested?: boolean;
  /** Reports page-by-page progress of a cloud reading. */
  onCloudProgress?: (event: { page: number; completed: number; total: number }) => void;
  /** Cancels a reading in flight. A cancelled import writes nothing. */
  signal?: AbortSignal;
}

type ParsedTable = { headers: string[]; rows: Array<Record<string, string>>; warnings: string[] };
type ParsedPdfTable = ParsedTable & {
  ocr?: ParsedBankStatement["ocr"];
  currency?: string | null;
  /**
   * Movement rows the reading left unusable — no date, or no amount on either
   * side. What decides whether a cloud re-reading is worth offering.
   */
  incompleteRows?: number[];
};

/** Everything the scanned paths need that is not the file itself. */
type ScannedStatementOptions = {
  aiFallback?: AiReviewChat;
  recognition?: RecognitionPlan;
  cloudRequested?: boolean;
  onCloudProgress?: ParseBankStatementInput["onCloudProgress"];
  signal?: AbortSignal;
};

const STANDARD_HEADERS = ["Date", "Value Date", "Description", "Reference", "External ID", "Amount", "Currency"];

function userError(message: string): Error {
  const error = new Error(message);
  error.name = "BankStatementImportError";
  return error;
}

function safeSourceName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw userError("Le nom du relevé est manquant.");
  return path.basename(value.trim()).slice(0, 250);
}

function decodeText(bytes: Buffer): { text: string; encoding: "UTF-8" | "Windows-1252" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function uniqueHeaders(values: unknown[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value ?? "").replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function suggestStatementMapping(headers: string[]): Partial<StatementColumnMapping> {
  const entries = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
  const pick = (patterns: string[], excluded: string[] = []) => entries.find(({ normalized }) => (
    patterns.some((pattern) => normalized === pattern || normalized.startsWith(pattern) || normalized.endsWith(pattern))
      && !excluded.some((pattern) => normalized.includes(pattern))
  ))?.header;
  const balanceWords = ["solde", "balance", "encours", "disponible", "available"];
  const date = pick(["dateoperation", "datecomptable", "bookingdate", "transactiondate", "date"], ["valeur", "value"]);
  const valueDate = pick(["datevaleur", "valuedate"]);
  const label = pick(["libelle", "description", "designation", "details", "motif", "narrative", "payee", "memo"]);
  const reference = pick(["reference", "ref", "numeropiece", "piece", "checknum", "accountservicerreference"]);
  const externalId = pick(["transactionid", "identifiant", "externalid", "idoperation", "fitid"]);
  const currency = pick(["devise", "currency", "ccy"]);
  const amount = pick(["montantoperation", "montantmouvement", "transactionamount", "signedamount", "montant", "amount"], [...balanceWords, "debit", "credit"]);
  const debit = amount ? undefined : pick(["debit", "retrait", "withdrawal", "sortie"], balanceWords);
  const credit = amount ? undefined : pick(["credit", "versement", "deposit", "entree"], balanceWords);
  return { date, valueDate, label, reference, externalId, amount, debit, credit, currency };
}

function detectSeparator(line: string): string | null {
  const candidates = [";", "\t", "|", ","];
  let quoted = false;
  const counts = new Map(candidates.map((candidate) => [candidate, 0]));
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  const [separator, count] = [...counts].sort((left, right) => right[1] - left[1])[0] ?? ["", 0];
  return count > 0 ? separator : null;
}

function parseDelimitedMatrix(text: string, separator: string): string[][] {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const finishCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) matrix.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && char === separator) finishCell();
    else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else cell += char;
  }
  if (cell || row.length) finishRow();
  if (quoted) throw userError("Le fichier délimité contient un champ entre guillemets non fermé.");
  return matrix;
}

function tableFromMatrix(matrix: string[][]): ParsedTable {
  if (matrix.length < 2) throw userError("Le relevé ne contient pas d'en-tête et de ligne de données exploitables.");
  const headers = uniqueHeaders(matrix[0]);
  const warnings: string[] = [];
  const rows: Array<Record<string, string>> = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index];
    if (values.length !== headers.length) {
      warnings.push(`Ligne source ${index + 1}: ${values.length} colonne(s) trouvée(s), ${headers.length} attendue(s).`);
    }
    rows.push(Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])));
  }
  if (rows.length > MAX_ROWS) throw userError(`Le relevé contient plus de ${MAX_ROWS} lignes, limite sûre d'un import Wheat.`);
  return { headers, rows, warnings };
}

function parseDelimited(text: string): ParsedTable & { separator: string } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = detectSeparator(firstLine);
  if (!separator) throw userError("Aucun séparateur de colonnes fiable n'a été détecté. Utilisez CSV, point-virgule, tabulation ou barre verticale.");
  return { ...tableFromMatrix(parseDelimitedMatrix(text, separator)), separator };
}

function xmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]): string {
  for (const name of names) {
    const xml = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block)?.[1];
    if (xml !== undefined) return xmlText(xml);
    const sgml = new RegExp(`<${name}(?:\\s[^>]*)?>([^<\\r\\n]*)`, "i").exec(block)?.[1];
    if (sgml !== undefined) return xmlText(sgml);
  }
  return "";
}

function structuredRow(values: Partial<Record<(typeof STANDARD_HEADERS)[number], string>>): Record<string, string> {
  return Object.fromEntries(STANDARD_HEADERS.map((header) => [header, values[header] ?? ""]));
}

function isoFromCompactDate(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 8) return value.trim();
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function qifDate(value: string): string {
  const clean = value.trim().replace(/[.'-]/g, "/");
  const match = /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/.exec(clean);
  if (!match) return clean;
  if (match[1].length === 4) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year.padStart(4, "0")}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function parseOfx(text: string): { rows: Array<Record<string, string>>; currency: string | null; warnings: string[] } {
  const blocks = [...text.matchAll(/<STMTTRN(?:\s[^>]*)?>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN|<\/BANKTRANLIST>))/gi)].map((match) => match[1]);
  if (!blocks.length) throw userError("Le fichier OFX ne contient aucun bloc STMTTRN exploitable.");
  const currency = tag(text, ["CURDEF"]) || null;
  const rows = blocks.map((block) => {
    const name = tag(block, ["NAME"]);
    const memo = tag(block, ["MEMO"]);
    const fitId = tag(block, ["FITID"]);
    const reference = tag(block, ["CHECKNUM", "REFNUM"]) || fitId;
    return structuredRow({
      Date: isoFromCompactDate(tag(block, ["DTPOSTED"])),
      "Value Date": isoFromCompactDate(tag(block, ["DTUSER", "DTAVAIL"])),
      Description: [name, memo].filter(Boolean).join(" — ") || "Mouvement OFX",
      Reference: reference,
      "External ID": fitId,
      Amount: tag(block, ["TRNAMT"]),
      Currency: currency ?? "",
    });
  });
  return { rows, currency, warnings: [] };
}

function parseQif(text: string): { rows: Array<Record<string, string>>; warnings: string[] } {
  const withoutHeaders = text.split(/\r?\n/).filter((line) => !line.startsWith("!Type:")).join("\n");
  const records = withoutHeaders.split(/^\^\s*$/m).map((record) => record.trim()).filter(Boolean);
  const rows = records.map((record) => {
    const fields = new Map<string, string>();
    for (const line of record.split(/\r?\n/)) {
      const code = line.slice(0, 1);
      const value = line.slice(1).trim();
      if (code && value && !fields.has(code)) fields.set(code, value);
    }
    const payee = fields.get("P") ?? "";
    const memo = fields.get("M") ?? "";
    return structuredRow({
      Date: qifDate(fields.get("D") ?? ""),
      Description: [payee, memo].filter(Boolean).join(" — ") || "Mouvement QIF",
      Reference: fields.get("N") ?? "",
      Amount: fields.get("T") ?? "",
    });
  });
  if (!rows.length) throw userError("Le fichier QIF ne contient aucune transaction terminée par ^.");
  return { rows, warnings: ["Les dates QIF ambiguës sont interprétées au format jour/mois/année; contrôlez la prévisualisation."] };
}

function mt940Date(value: string): string {
  const year = Number(value.slice(0, 2));
  const fullYear = year >= 70 ? 1900 + year : 2000 + year;
  return `${fullYear}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
}

/**
 * An MT940 balance field: `:60F:C260825MAD1000,00`.
 *
 * The mark is the bank's own sign — `C` for a credit balance, `D` for a debit
 * one — so no convention is assumed here beyond the one the format defines.
 * Returns exact integer centimes as a string, or null when the field is absent
 * or malformed; a balance that cannot be read is reported as no balance rather
 * than as a zero, because a zero would be checked and would be wrong.
 */
function mt940BalanceCents(text: string, tag: "60" | "62"): string | null {
  const match = new RegExp(`:${tag}[FM]:([CD])[0-9]{6}[A-Z]{3}([0-9][0-9.,]*)`, "i").exec(text);
  if (!match) return null;
  const digits = match[2].replace(/\./g, "").replace(",", ".");
  const [whole, fraction = ""] = digits.split(".");
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]*$/.test(fraction) || fraction.length > 2) return null;
  const magnitude = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return (match[1].toUpperCase() === "D" ? -magnitude : magnitude).toString();
}

function parseMt940(text: string): { rows: Array<Record<string, string>>; currency: string | null; warnings: string[]; declaredBalances?: StatementDeclaredBalances } {
  const currency = /:6[02][FM]:[CD][0-9]{6}([A-Z]{3})/i.exec(text)?.[1]?.toUpperCase() ?? null;
  const matches = [...text.matchAll(/^:61:(\d{6})(\d{4})?[^\r\n]*?([CD])(?:R)?([0-9][0-9.,]*)([A-Z][A-Z0-9]{3})([^\r\n]*)(?:\r?\n:86:([^\r\n]*(?:\r?\n(?!:)[^\r\n]*)*))?/gim)];
  if (!matches.length) throw userError("Le fichier MT940 ne contient aucune ligne :61: reconnue.");
  const rows = matches.map((match) => {
    const amount = `${match[3].toUpperCase() === "D" ? "-" : ""}${match[4].replace(",", ".")}`;
    const rawReference = match[6].trim();
    const narrative = (match[7] ?? "").replace(/\r?\n/g, " ").trim();
    return structuredRow({
      Date: mt940Date(match[1]),
      "Value Date": match[2] ? `${mt940Date(match[1]).slice(0, 5)}${match[2].slice(0, 2)}-${match[2].slice(2, 4)}` : "",
      Description: narrative || rawReference || `Mouvement ${match[5]}`,
      Reference: rawReference,
      Amount: amount,
      Currency: currency ?? "",
    });
  });
  const openingBalanceCents = mt940BalanceCents(text, "60");
  const closingBalanceCents = mt940BalanceCents(text, "62");
  const declaredBalances: StatementDeclaredBalances = {
    ...(openingBalanceCents === null ? {} : { openingBalanceCents }),
    ...(closingBalanceCents === null ? {} : { closingBalanceCents }),
  };
  return { rows, currency, warnings: [], ...(Object.keys(declaredBalances).length ? { declaredBalances } : {}) };
}

function parseCamt053(text: string): { rows: Array<Record<string, string>>; currency: string | null; warnings: string[] } {
  const blocks = [...text.matchAll(/<(?:\w+:)?Ntry(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Ntry>/gi)].map((match) => match[1]);
  if (!blocks.length) throw userError("Le fichier CAMT.053 ne contient aucune entrée Ntry exploitable.");
  const localElement = (block: string, name: string) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i").exec(block)?.[1] ?? "";
  const localText = (block: string, names: string[]) => {
    for (const name of names) {
      const value = localElement(block, name);
      if (value) return xmlText(value);
    }
    return "";
  };
  const nestedDate = (block: string, parent: string) => {
    const parentBlock = localElement(block, parent);
    const value = localText(parentBlock, ["Dt", "DtTm"]);
    return value.slice(0, 10);
  };
  let detectedCurrency: string | null = null;
  const rows = blocks.map((block) => {
    const amountMatch = /<(?:\w+:)?Amt\b[^>]*\bCcy=["']([A-Z]{3})["'][^>]*>([^<]+)<\/(?:\w+:)?Amt>/i.exec(block);
    const currency = amountMatch?.[1]?.toUpperCase() ?? "";
    if (!detectedCurrency && currency) detectedCurrency = currency;
    const direction = localText(block, ["CdtDbtInd"]);
    const amount = `${direction.toUpperCase() === "DBIT" ? "-" : ""}${xmlText(amountMatch?.[2] ?? "")}`;
    const description = localText(block, ["Ustrd", "AddtlNtryInf", "Nm"]);
    const reference = localText(block, ["AcctSvcrRef", "EndToEndId", "InstrId"]);
    return structuredRow({
      Date: nestedDate(block, "BookgDt"),
      "Value Date": nestedDate(block, "ValDt"),
      Description: description || "Mouvement CAMT.053",
      Reference: reference,
      "External ID": localText(block, ["NtryRef"]),
      Amount: amount,
      Currency: currency,
    });
  });
  return { rows, currency: detectedCurrency, warnings: [] };
}

async function parsePdf(bytes: Buffer, app: App | undefined, options: ScannedStatementOptions): Promise<ParsedPdfTable> {
  const { PDFParse } = await import("pdf-parse");
  const workerUrl = resolvePdfWorkerUrl(app);
  if (workerUrl && typeof PDFParse.setWorker === "function") PDFParse.setWorker(workerUrl);
  const parser = new PDFParse({ data: bytes });
  try {
    let extractedTables: string[][][] = [];
    try {
      const result = await parser.getTable({ first: 1, last: 20 });
      extractedTables = (result.pages ?? []).flatMap((page) => page.tables ?? []).map((table) => table.map((row) => row.map((cell) => String(cell ?? "").trim())));
    } catch {
      // Text fallback below reports a clear layout error if no table is usable.
    }
    const usableTable = extractedTables.find((table) => table.length >= 2 && table[0].length >= 3);
    if (usableTable) return { ...tableFromMatrix(usableTable), warnings: ["PDF texte: contrôlez chaque colonne; les mises en page PDF ne sont pas standardisées."] };
    const textResult = await parser.getText({ first: 1, last: 20 });
    const text = String(textResult.text ?? "").split("\u0000").join("").trim();
    if (text.replace(/\s/g, "").length < 40) {
      if (!app) {
        throw userError("Ce PDF ne contient pas de couche texte fiable. Un relevé scanné doit être lu par reconnaissance, ce qui n'est pas disponible ici.");
      }
      return parseScannedStatement(bytes, app, ".pdf", options);
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const headerIndex = lines.findIndex((line) => Boolean(detectSeparator(line)) && /date/i.test(line));
    if (headerIndex < 0) {
      throw userError("La couche texte du PDF est lisible, mais sa mise en page n'est pas un tableau délimité fiable. Exportez le relevé en CSV/OFX/CAMT ou fournissez un PDF texte avec colonnes reconnaissables.");
    }
    const headerSeparator = detectSeparator(lines[headerIndex])!;
    const tableLines = lines.slice(headerIndex).filter((line, index) => index === 0 || detectSeparator(line) === headerSeparator);
    const table = parseDelimited(tableLines.join("\n"));
    return { ...table, warnings: [...table.warnings, "PDF texte générique: contrôlez le mapping et chaque ligne avant confirmation."] };
  } finally {
    await parser.destroy();
  }
}

async function parseScannedStatementLocally(bytes: Buffer, app: App, extension: string, aiFallback?: AiReviewChat): Promise<ParsedPdfTable> {
  let result: PaddleOcrResult;
  try {
    result = await recognizeWithPaddle(app, bytes, { mode: "structure", extension });
  } catch (error) {
    throw userError(`PaddleOCR local est requis pour ce relevé scanné: ${error instanceof Error ? error.message : "moteur indisponible"}`);
  }
  let table: ParsedTable;
  let parserKind = "adaptive spatial reconstruction";
  try {
    table = tableFromSpatialWords(result.words);
  } catch (spatialError) {
    parserKind = "PP-Structure table fallback";
    table = tableFromOcrMatrices(result.tables);
    table.warnings.unshift(`Reconstruction spatiale indisponible (${spatialError instanceof Error ? spatialError.message : "géométrie insuffisante"}); tableau PP-Structure utilisé.`);
  }
  const preliminaryFallback = result.confidence < 75 || table.warnings.length > Math.max(3, table.rows.length / 4);
  if (preliminaryFallback && isPaddleOcrVl16Installed(app)) {
    try {
      const vlResult = await recognizeWithPaddle(app, bytes, { mode: "vl", extension });
      const vlTable = vlResult.tables.length ? tableFromOcrMatrices(vlResult.tables) : tableFromSpatialWords(vlResult.words);
      if (vlTable.rows.length) {
        result = vlResult;
        table = vlTable;
        parserKind = "PaddleOCR-VL-1.6 local fallback";
      }
    } catch (error) {
      table.warnings.push(`PaddleOCR-VL-1.6 installé mais fallback impossible : ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  table = repairOcrMoneyColumns(table);

  /*
   * The assisted pass, and only where the local one came up short.
   *
   * "Short" is measured on the page, not on a confidence score: a movement row
   * with no date, or with no amount on either side, is a row an accountant
   * cannot use. If none exists, no model is asked anything and the statement is
   * read entirely on this machine, which is the ordinary case.
   */
  const aiRowNumbers = aiFallback ? unusableMovementRows(table) : [];
  let aiAssist: { applied: boolean; filledRows: number[] } = { applied: false, filledRows: [] };
  if (aiFallback && aiRowNumbers.length) {
    const completion = await completeBankTableWithAi({
      table,
      mapping: suggestStatementMapping(table.headers),
      recognisedText: result.text,
      rowNumbers: aiRowNumbers,
      chat: aiFallback,
    });
    table = completion.table;
    aiAssist = { applied: completion.applied, filledRows: completion.filledRows };
    if (!completion.applied && completion.notes.length) table.warnings.push(...completion.notes);
  } else if (aiRowNumbers.length) {
    table.warnings.push(`${aiRowNumbers.length} ligne(s) de mouvement restent incomplètes après la lecture locale (ligne(s) ${aiRowNumbers.join(", ")}). Complétez-les à la main, ou activez la relecture assistée dans Réglages > Wheat AI.`);
  }

  const confidence = result.confidence;
  const engine = result.engine;
  const engineVersion = result.engineVersion;
  const warnings = [
    ...table.warnings,
    `PDF scanné analysé localement par ${engine} ${engineVersion} (${parserKind}); vérifiez chaque cellule avant confirmation.`,
    ...(confidence < 75 ? [`Confiance OCR moyenne faible (${confidence}%): corrigez les cellules ambiguës ou utilisez CSV/OFX/CAMT.053.`] : []),
    ...result.warnings,
  ];
  const currency = /\b(MAD|EUR|USD|GBP|CAD|CHF|AED|SAR)\b/i.exec(result.text)?.[1]?.toUpperCase() ?? null;
  // Measured again on the finished table: the assisted pass may have completed
  // some of the rows counted above, and what matters here is what is still
  // unusable — that, and only that, is what a cloud re-reading would be for.
  const incompleteRows = unusableMovementRows(table);
  return {
    ...table,
    warnings,
    currency,
    incompleteRows,
    ocr: {
      engine,
      engineVersion,
      confidence,
      pageCount: result.pageCount,
      local: true,
      confidenceDimensions: ocrConfidenceDimensions(result, table),
      fallbackRecommended: confidence < 75 || table.warnings.length > Math.max(3, table.rows.length / 4),
      assistedRows: aiAssist.filledRows,
    },
  };
}

/**
 * Reads a scanned statement with the provider the user authorised.
 *
 * The AI looks at the **pages**, not at somebody else's failed transcription of
 * them. That is the whole point: the previous assisted pass could only fill
 * gaps in a table PaddleOCR had already built, so on a machine with no
 * PaddleOCR there was no table to fill and no reading at all.
 *
 * Pages are prepared exactly as the document pipeline prepares them - the same
 * rotation, the same ceiling, the same encoding - and the reply is turned into
 * the ordinary bank table every other parser here produces.
 */
async function parseScannedStatementWithCloud(
  bytes: Buffer,
  app: App,
  extension: string,
  plan: RecognitionPlan,
  options: ScannedStatementOptions,
): Promise<ParsedPdfTable> {
  const cloud = plan.cloud;
  if (!cloud) throw new CloudOcrUnavailableError("NOT_CONNECTED");
  // Asked before a single page is rendered, exactly as the document pipeline
  // asks it. Rasterising eight pages and only then discovering there is nobody
  // to send them to wastes the machine's time and the accountant's, and the
  // interface needs the question early enough to resume this same import.
  if (!cloud.consentGiven) throw new CloudOcrUnavailableError("CONSENT_REQUIRED");
  if (!cloud.runtime.isConnected()) throw new CloudOcrUnavailableError("NOT_CONNECTED");

  const prepared: Array<{ page: number; mimeType: string; base64: string }> = [];
  let pageCount = 1;
  let truncated = false;
  if (extension === ".pdf") {
    const rendered = await renderPdfPages(bytes, { app, limit: MAX_CLOUD_STATEMENT_PAGES });
    if (!rendered.pages.length) {
      throw userError("Les pages de ce PDF n'ont pas pu être rendues pour la lecture. Fournissez le relevé en CSV, XLSX, OFX, MT940 ou CAMT.053.");
    }
    pageCount = rendered.pageCount;
    truncated = rendered.truncated;
    for (const page of rendered.pages) {
      const image = await buildCloudImage(page.buffer);
      prepared.push({ page: page.page, mimeType: "image/jpeg", base64: image.buffer.toString("base64") });
    }
  } else {
    const image = await buildCloudImage(bytes);
    prepared.push({ page: 1, mimeType: "image/jpeg", base64: image.buffer.toString("base64") });
  }

  const extraction = await extractBankStatementWithCloud({
    runtime: cloud.runtime,
    pages: prepared,
    consentGiven: cloud.consentGiven,
    signal: options.signal,
    onPage: options.onCloudProgress,
  });

  const table: ParsedTable = {
    headers: extraction.headers,
    rows: extraction.rows,
    warnings: [
      ...extraction.warnings,
      `Relevé scanné lu par ${extraction.provider} (${extraction.modelId}) sur ${extraction.pagesRead} page(s) : chaque ligne est une proposition à vérifier avant confirmation.`,
      ...(truncated
        ? [`Ce relevé compte ${pageCount} pages ; seules les ${MAX_CLOUD_STATEMENT_PAGES} premières ont été lues. Importez les pages suivantes séparément, ou fournissez un export CSV/OFX/CAMT.053.`]
        : []),
    ],
  };
  const repaired = repairOcrMoneyColumns(table);
  const confidence = extraction.confidence;
  return {
    ...repaired,
    currency: extraction.currency,
    incompleteRows: unusableMovementRows(repaired),
    ocr: {
      engine: `Wheat Cloud AI · ${extraction.provider}`,
      engineVersion: extraction.modelId,
      confidence,
      pageCount,
      local: false,
      confidenceDimensions: cloudConfidenceDimensions(extraction, repaired),
      fallbackRecommended: confidence < 75 || extraction.blockingIssues.length > 0,
      cloud: {
        provider: extraction.provider,
        modelId: extraction.modelId,
        pagesRead: extraction.pagesRead,
        evidence: extraction.evidence,
        blockingIssues: [
          ...extraction.blockingIssues,
          ...(truncated
            ? [`Seules ${MAX_CLOUD_STATEMENT_PAGES} des ${pageCount} pages ont été lues : ce relevé serait importé de façon incomplète.`]
            : []),
        ],
        readBalances: extraction.readBalances,
      },
    },
  };
}

/**
 * How sure the cloud reading was, in the terms the review screen already shows.
 *
 * Layout is not measurable here - a transcription carries no page geometry - so
 * it is reported as unknown rather than as a flattering number. Row
 * reconstruction is scored on what Wheat had to refuse or could not settle,
 * which is the honest question for this path.
 */
function cloudConfidenceDimensions(extraction: CloudBankExtraction, table: ParsedTable): CanonicalBankTransaction["confidence"] {
  const mapping = suggestStatementMapping(table.headers);
  const mapped = [mapping.date, mapping.label, mapping.amount || mapping.debit, mapping.amount || mapping.credit].filter(Boolean).length;
  const fieldMapping = Math.round((mapped / 4) * 100);
  const rowReconstruction = Math.round(Math.max(0, 100 - (extraction.blockingIssues.length / Math.max(1, table.rows.length)) * 100));
  return {
    textRecognition: extraction.confidence,
    layout: null,
    rowReconstruction,
    fieldMapping,
    accountingConsistency: null,
    finalDocument: Math.round(extraction.confidence * 0.45 + rowReconstruction * 0.35 + fieldMapping * 0.2),
  };
}

/**
 * Who reads this scanned statement, and what happens when they cannot.
 *
 * The one place the edition influences a bank import. It chooses the engine and
 * never what the reading means: whatever answers, the table it produces goes
 * through the same mapping, validation, duplicate detection, balance check,
 * preview and confirmation as a CSV from the same bank.
 *
 *   - **Standard** reads locally, exactly as it always has. A cloud reading is
 *     an alternative the accountant asks for by name; it never happens on its
 *     own, because uploading somebody's bank statement is not a fallback to
 *     apply quietly when a local engine has a bad page.
 *   - **Lightweight** reads in the cloud, because no local recognition runtime
 *     is packaged with it. Missing authorisation is raised before any page is
 *     prepared, so the interface can obtain it and resume this same import.
 *
 * Neither edition falls back to Tesseract here. Reading prose off a photograph
 * is one thing; reconstructing a debit column from it is another, and a table
 * nobody can trust is worse for an accountant than a clear refusal.
 */
async function parseScannedStatement(
  bytes: Buffer,
  app: App,
  extension: string,
  options: ScannedStatementOptions,
): Promise<ParsedPdfTable> {
  const plan = options.recognition;
  const cloudConfigured = Boolean(plan?.cloud);
  /*
   * Whether this build has a local recogniser at all.
   *
   * The capability question, not the order of the list. An edition that does
   * not package PaddleOCR must never reach for it — not when the cloud is
   * first, and not when the accountant has switched cloud reading off, which
   * is the case that would otherwise fall straight through to the error this
   * whole path exists to remove.
   *
   * No plan at all means the caller wants the local reader, which is what
   * Wheat did before recognition became a choice.
   */
  const localAvailable = plan ? plan.order.includes("paddle") : true;

  if (!localAvailable) {
    if (cloudConfigured) return parseScannedStatementWithCloud(bytes, app, extension, plan!, options);
    // Nothing on this machine can read a scanned statement, and saying which
    // component is missing would name one this edition never ships. What the
    // accountant can actually do is the only useful sentence here.
    throw userError(
      "Cette édition de Wheat lit les relevés scannés avec Wheat Cloud AI, et la lecture en ligne est désactivée sur ce poste. "
      + "Activez-la dans Réglages > Wheat Cloud AI, ou importez le relevé dans un format lisible directement : CSV, XLSX, OFX, MT940 ou CAMT.053.",
    );
  }

  let local: ParsedPdfTable;
  try {
    local = await parseScannedStatementLocally(bytes, app, extension, options.aiFallback);
  } catch (localError) {
    // Nothing was read. An explicit request is honoured; otherwise the refusal
    // says what happened and what the accountant can do about it, which now
    // includes a cloud reading they can ask for.
    if (cloudConfigured && options.cloudRequested) {
      return parseScannedStatementWithCloud(bytes, app, extension, plan!, options);
    }
    throw localError instanceof Error && localError.name === "BankStatementImportError"
      ? userError(`${localError.message}${cloudConfigured
        ? " Vous pouvez demander une lecture par Wheat Cloud AI, ou fournir le relevé en CSV, XLSX, OFX, MT940 ou CAMT.053."
        : " Fournissez le relevé en CSV, XLSX, OFX, MT940 ou CAMT.053, ou activez la lecture par Wheat Cloud AI dans Réglages."}`)
      : localError;
  }

  const incomplete = local.incompleteRows ?? [];
  if (!incomplete.length) return local;
  if (cloudConfigured && options.cloudRequested) {
    return parseScannedStatementWithCloud(bytes, app, extension, plan!, options);
  }
  // The local reading stands, and the offer travels with it. Nothing has been
  // uploaded and nothing will be until somebody asks for it in the review.
  return {
    ...local,
    ocr: local.ocr && {
      ...local.ocr,
      ...(cloudConfigured
        ? {
          cloudOffer: {
            reason: "LOCAL_INCOMPLETE" as const,
            detail: `${incomplete.length} ligne(s) de mouvement restent inexploitables après la lecture locale (ligne(s) ${incomplete.join(", ")}).`,
            consentRequired: !plan?.cloud?.consentGiven,
          },
        }
        : {}),
    },
  };
}

async function parseLegacyXls(bytes: Buffer, app?: App): Promise<ParsedTable> {
  const resourceRoot = app?.isPackaged ? path.join(process.resourcesPath, "paddleocr") : path.join(process.cwd(), "resources", "paddleocr");
  const readerPath = path.join(resourceRoot, "xls_reader.py");
  const pythonCandidates = [
    readWheatEnv("WHEAT_PADDLEOCR_PYTHON"),
    path.join(resourceRoot, "runtime", "python.exe"),
    path.join(resourceRoot, "runtime", "Scripts", "python.exe"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && fs.existsSync(candidate));
  if (!fs.existsSync(readerPath) || !pythonCandidates[0]) {
    throw userError("Le lecteur XLS local n'est pas installé. Relancez l'installation des ressources PaddleOCR/XLS ou enregistrez le relevé en XLSX.");
  }
  const temporaryRoot = app ? path.join(app.getPath("userData"), "import-temp") : path.join(os.tmpdir(), "wheat-import-temp");
  await fs.promises.mkdir(temporaryRoot, { recursive: true });
  const inputPath = path.join(temporaryRoot, `legacy-${randomUUID()}.xls`);
  await fs.promises.writeFile(inputPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(pythonCandidates[0], [readerPath, inputPath], { windowsHide: true, timeout: 30_000, maxBuffer: 20_000_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve({ stdout, stderr });
      });
    });
    const parsed = JSON.parse(result.stdout) as { matrix?: unknown };
    if (!Array.isArray(parsed.matrix)) throw new Error("Le lecteur XLS n'a retourné aucune feuille exploitable.");
    const matrix = parsed.matrix.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []);
    return tableFromMatrix(matrix);
  } catch (error) {
    throw userError(`Le classeur XLS binaire hérité n'a pas pu être lu localement : ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.promises.rm(inputPath, { force: true }).catch(() => undefined);
  }
}

function ocrConfidenceDimensions(result: PaddleOcrResult, table: ParsedTable): CanonicalBankTransaction["confidence"] {
  const positioned = result.words.filter((word) => word.bbox).length;
  const positionRatio = result.words.length ? positioned / result.words.length : 0;
  const mapping = suggestStatementMapping(table.headers);
  const mapped = [mapping.date, mapping.label, mapping.amount || mapping.debit, mapping.amount || mapping.credit].filter(Boolean).length;
  const layout = Math.round(Math.min(100, positionRatio * 100));
  const rowReconstruction = Math.round(Math.max(0, Math.min(100, 100 - (table.warnings.length / Math.max(1, table.rows.length)) * 35)));
  const fieldMapping = Math.round((mapped / 4) * 100);
  const finalDocument = Math.round(result.confidence * 0.35 + layout * 0.2 + rowReconstruction * 0.25 + fieldMapping * 0.2);
  return { textRecognition: result.confidence, layout, rowReconstruction, fieldMapping, accountingConsistency: null, finalDocument };
}

/** Reconstructs a bank table from relative word geometry instead of fixed columns. */
export function tableFromSpatialWords(words: PaddleOcrResult["words"]): ParsedTable {
  type Positioned = PaddleOcrResult["words"][number] & { bbox: NonNullable<PaddleOcrResult["words"][number]["bbox"]> };
  const positioned = words.filter((word): word is Positioned => Boolean(word.bbox));
  if (positioned.length < 12) throw userError("coordonnées OCR insuffisantes");
  const heights = positioned.map((word) => word.bbox.y1 - word.bbox.y0).filter((height) => height > 0).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 14;
  const tolerance = Math.max(5, Math.min(28, medianHeight * 0.7));
  const pageRows: Array<{ page: number; y: number; words: Positioned[] }> = [];
  for (const page of [...new Set(positioned.map((word) => word.page ?? 1))].sort((a, b) => a - b)) {
    const pageWords = positioned.filter((word) => (word.page ?? 1) === page).sort((left, right) => ((left.bbox.y0 + left.bbox.y1) / 2) - ((right.bbox.y0 + right.bbox.y1) / 2));
    for (const word of pageWords) {
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      const current = pageRows.at(-1);
      if (!current || current.page !== page || Math.abs(centerY - current.y) > tolerance) pageRows.push({ page, y: centerY, words: [word] });
      else {
        current.words.push(word);
        current.y = current.words.reduce((sum, item) => sum + (item.bbox.y0 + item.bbox.y1) / 2, 0) / current.words.length;
      }
    }
  }
  for (const row of pageRows) row.words.sort((left, right) => left.bbox.x0 - right.bbox.x0);
  const headerCandidates = pageRows.map((row, index) => {
    const headers = uniqueHeaders(repairOcrBankHeaders(row.words.map((word) => word.text)));
    const mapping = suggestStatementMapping(headers);
    const score = Number(Boolean(mapping.date)) * 4 + Number(Boolean(mapping.label)) * 3 + Number(Boolean(mapping.amount)) * 3 + Number(Boolean(mapping.debit)) * 2 + Number(Boolean(mapping.credit)) * 2 + Number(Boolean(mapping.valueDate)) + Number(Boolean(mapping.reference));
    return { row, index, headers, mapping, score };
  }).filter((candidate) => candidate.row.words.length >= 3).sort((left, right) => right.score - left.score);
  const best = headerCandidates[0];
  if (!best || best.score < 7 || !best.mapping.date || !(best.mapping.amount || best.mapping.debit || best.mapping.credit)) {
    throw userError("aucun en-tête date/montant fiable dans les coordonnées OCR");
  }
  const anchors = best.row.words.map((word) => (word.bbox.x0 + word.bbox.x1) / 2);
  const rows: Array<Record<string, string>> = [];
  const warnings: string[] = [];
  for (const [rowIndex, candidate] of pageRows.entries()) {
    if (rowIndex <= best.index && candidate.page === best.row.page) continue;
    const candidateHeaders = repairOcrBankHeaders(candidate.words.map((word) => word.text)).map(normalizeHeader);
    const repeatedMatches = candidateHeaders.filter((cell) => best.headers.map(normalizeHeader).includes(cell)).length;
    if (repeatedMatches >= Math.max(2, Math.ceil(best.headers.length * 0.5))) continue;
    const cells = Array.from({ length: best.headers.length }, () => [] as string[]);
    for (const word of candidate.words) {
      const x = (word.bbox.x0 + word.bbox.x1) / 2;
      let column = 0;
      for (let index = 1; index < anchors.length; index += 1) if (Math.abs(anchors[index] - x) < Math.abs(anchors[column] - x)) column = index;
      cells[column].push(word.text);
    }
    const cellRecord = Object.fromEntries(best.headers.map((header, index) => [header, cells[index].join(" ").trim()]));
    if (!Object.values(cellRecord).some(Boolean)) continue;
    const record = { ...cellRecord, __wheatSourcePage: String(candidate.page) };
    rows.push(record);
    const unusuallyDense = candidate.words.length > Math.max(20, best.headers.length * 6);
    if (unusuallyDense) warnings.push(`Page ${candidate.page}, ligne spatiale ${rows.length}: densité OCR anormale (${candidate.words.length} blocs).`);
    if (rows.length > MAX_ROWS) throw userError(`Le relevé OCR contient plus de ${MAX_ROWS} lignes.`);
  }
  if (!rows.length) throw userError("aucune ligne spatiale exploitable");
  return { headers: best.headers, rows, warnings };
}

function tableFromOcrMatrices(inputTables: string[][][]): ParsedTable {
  const tables = inputTables
    .map((table) => table.map((row) => row.map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim())).filter((row) => row.some(Boolean)))
    .filter((table) => table.length >= 2);
  type HeaderCandidate = { tableIndex: number; rowIndex: number; headers: string[]; mapping: Partial<StatementColumnMapping>; score: number };
  const candidates: HeaderCandidate[] = [];
  tables.forEach((table, tableIndex) => table.slice(0, 12).forEach((row, rowIndex) => {
    if (row.filter(Boolean).length < 3) return;
    const headers = uniqueHeaders(repairOcrBankHeaders(row));
    const mapping = suggestStatementMapping(headers);
    const score = Number(Boolean(mapping.date)) * 4
      + Number(Boolean(mapping.label)) * 3
      + Number(Boolean(mapping.amount)) * 3
      + Number(Boolean(mapping.debit)) * 2
      + Number(Boolean(mapping.credit)) * 2
      + Number(Boolean(mapping.valueDate))
      + Number(Boolean(mapping.reference));
    candidates.push({ tableIndex, rowIndex, headers, mapping, score });
  }));
  const best = candidates.sort((left, right) => right.score - left.score)[0];
  const hasMoneyColumns = Boolean(best?.mapping.amount || best?.mapping.debit || best?.mapping.credit);
  if (!best || best.score < 7 || !best.mapping.date || !hasMoneyColumns) {
    throw userError("PaddleOCR a lu le PDF, mais aucun tableau bancaire fiable (date et montant/débit/crédit) n'a été reconnu. Aucun mouvement n'a été créé.");
  }
  const normalizedHeaders = best.headers.map(normalizeHeader);
  const dateColumn = best.headers.indexOf(best.mapping.date as string);
  const moneyColumns = [best.mapping.amount, best.mapping.debit, best.mapping.credit]
    .filter((header): header is string => Boolean(header))
    .map((header) => best.headers.indexOf(header))
    .filter((index) => index >= 0);
  const resemblesTransaction = (row: string[]) => {
    const date = row[dateColumn] ?? "";
    const hasDate = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/.test(date);
    const hasAmount = moneyColumns.some((index) => /[-+]?\s*\d[\d\s.,'’]*\d|[-+]?\s*\d/.test(row[index] ?? ""));
    return hasDate && hasAmount;
  };
  const rows: Array<Record<string, string>> = [];
  const warnings: string[] = [];
  tables.forEach((table, tableIndex) => {
    const repeatedHeader = table.findIndex((row) => {
      if (row.length !== best.headers.length) return false;
      const normalized = repairOcrBankHeaders(row).map((cell) => normalizeHeader(cell));
      const matches = normalized.filter((cell, index) => cell && cell === normalizedHeaders[index]).length;
      return matches >= Math.max(2, Math.ceil(best.headers.length * 0.6));
    });
    if (tableIndex !== best.tableIndex && repeatedHeader < 0 && table.filter(resemblesTransaction).length < 2) {
      warnings.push(`Tableau OCR ${tableIndex + 1} ignoré: aucun en-tête bancaire répété ni série de transactions fiable.`);
      return;
    }
    let start = tableIndex === best.tableIndex ? best.rowIndex + 1 : repeatedHeader >= 0 ? repeatedHeader + 1 : 0;
    for (; start < table.length; start += 1) {
      const values = table[start];
      if (!values.some(Boolean)) continue;
      if (values.length !== best.headers.length) {
        warnings.push(`Tableau OCR ${tableIndex + 1}, ligne ${start + 1}: ${values.length} cellule(s), ${best.headers.length} attendue(s).`);
      }
      rows.push(Object.fromEntries(best.headers.map((header, column) => [header, values[column] ?? ""])));
      if (rows.length > MAX_ROWS) throw userError(`Le relevé OCR contient plus de ${MAX_ROWS} lignes, limite sûre d'un import Wheat.`);
    }
  });
  if (!rows.length) throw userError("Le tableau PaddleOCR contient un en-tête mais aucune ligne de transaction exploitable.");
  return { headers: best.headers, rows, warnings };
}

function repairOcrBankHeaders(row: string[]): string[] {
  const repaired = row.map((cell) => cell.trim());
  repaired.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if (normalized.includes("debit") && normalized.includes("credit")) {
      const debitFirst = normalized.indexOf("debit") <= normalized.indexOf("credit");
      const emptyNeighbor = !repaired[index + 1]?.trim() ? index + 1 : !repaired[index - 1]?.trim() ? index - 1 : -1;
      if (emptyNeighbor >= 0 && emptyNeighbor < repaired.length) {
        repaired[index] = debitFirst ? "Débit" : "Crédit";
        repaired[emptyNeighbor] = debitFirst ? "Crédit" : "Débit";
      }
    }
  });
  const hasOperationDate = repaired.some((cell) => ["date", "dateoperation", "datecomptable"].includes(normalizeHeader(cell)));
  return repaired.map((cell) => {
    const normalized = normalizeHeader(cell);
    if (hasOperationDate && ["valeur", "value"].includes(normalized)) return "Date valeur";
    if (["code", "codeoperation", "operationcode"].includes(normalized)) return "Référence / code";
    return cell;
  });
}

/**
 * Puts the DEBIT and CREDIT labels back on the columns that hold the money.
 *
 * On a Moroccan bank statement the two money columns sit under a single
 * section title — "CAPITAUX" — printed centred above both of them. A layout
 * recogniser reading geometry gives that centred title a column of its own, and
 * the debit figures land underneath it while the word "DEBIT" ends up over an
 * empty strip. Every debit on the page then reads as absent: on the real
 * Attijariwafa statement, three of five movements arrived with no amount at all
 * and were classified as page furniture.
 *
 * The repair is decided from evidence on the page, never from the bank's name.
 * A labelled money column that carries no amount on any movement row, next to
 * exactly one unclaimed column that does, is a label sitting one column away
 * from its data — and the region between the DEBIT and CREDIT headings is the
 * only place the correction is allowed to look. Anything less clear-cut is left
 * alone and reported, because a debit read as a credit is worse than a debit
 * a person has to place by hand.
 */
export function repairOcrMoneyColumns(table: ParsedTable): ParsedTable {
  // Recognition noise on a heading is punctuation, never meaning: "DEBIT::".
  const headers = uniqueHeaders(table.headers.map((header) => header.replace(/[\s:.;_|-]+$/u, "").replace(/^[\s:.;_|-]+/u, "").trim()));
  const renamed = headers.some((header, index) => header !== table.headers[index]);
  let rows = renamed
    ? table.rows.map((row) => {
      const next: Record<string, string> = {};
      table.headers.forEach((header, index) => { next[headers[index]] = row[header] ?? ""; });
      if (row.__wheatSourcePage !== undefined) next.__wheatSourcePage = row.__wheatSourcePage;
      return next;
    })
    : table.rows;

  const warnings = [...table.warnings];
  const mapping = suggestStatementMapping(headers);
  const claimed = new Set(Object.values(mapping).filter((value): value is string => Boolean(value)));
  // Movement rows only. A total or a closing balance carries figures in columns
  // no movement uses, and counting those is how the empty column looks used.
  const movementRows = rows.filter((row) => classifyStatementRow(row, {}) === "TRANSACTION");
  const amountCount = (header: string) => movementRows.filter((row) => looksLikeStatementAmount(row[header])).length;

  const relabel = (side: "debit" | "credit") => {
    const current = mapping[side];
    if (!current || amountCount(current) > 0) return;
    const currentIndex = headers.indexOf(current);
    const otherIndex = headers.indexOf((side === "debit" ? mapping.credit : mapping.debit) ?? "");
    const lower = otherIndex >= 0 ? Math.min(currentIndex, otherIndex) : currentIndex;
    const upper = otherIndex >= 0 ? Math.max(currentIndex, otherIndex) : headers.length - 1;
    const candidates = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header, index }) => index > lower && index < upper && !claimed.has(header) && amountCount(header) > 0);
    // No candidate at all is the ordinary case of a page whose movements all
    // fall on the other side, and says nothing. Several candidates is genuine
    // ambiguity, and Wheat says so rather than choosing a side for a figure.
    if (!candidates.length) return;
    if (candidates.length > 1) {
      warnings.push(`La colonne « ${current} » ne contient aucun montant, et plusieurs colonnes voisines en contiennent. Vérifiez le mapping des colonnes avant de confirmer l'import.`);
      return;
    }
    // A straight swap: the heading moves onto its data, and the heading that
    // was over the data takes the empty strip. Naming the empty column anything
    // that still reads as "debit" would leave the mapping pointing at it.
    const [candidate] = candidates;
    const previousLabel = headers[candidate.index];
    headers[candidate.index] = current;
    headers[currentIndex] = previousLabel;
    claimed.add(current);
    rows = rows.map((row) => {
      const next = { ...row };
      next[current] = row[previousLabel] ?? "";
      next[previousLabel] = row[current] ?? "";
      return next;
    });
    warnings.push(`En-tête reconstruit : les montants situés sous « ${previousLabel} » ont été rattachés à la colonne ${side === "debit" ? "Débit" : "Crédit"}, car la colonne ainsi intitulée ne portait aucun montant. Contrôlez ces montants avant de confirmer.`);
  };

  relabel("debit");
  relabel("credit");
  return { headers, rows, warnings };
}

/**
 * What the accountant is told this file is.
 *
 * A scanned statement names the engine that actually read it rather than a
 * fixed one: the same `PDF_OCR` now covers a page read on this machine and a
 * page read by the provider the user authorised, and which of the two happened
 * is exactly the thing somebody reviewing the result wants to know.
 */
function formatLabel(format: BankStatementFormat, ocr?: ParsedBankStatement["ocr"]): string {
  const reader = ocr?.local === false ? "Wheat Cloud AI" : "PaddleOCR local";
  return {
    CSV: "CSV / texte délimité",
    TXT: "TXT délimité",
    XLSX: "Classeur XLSX",
    XLS: "Classeur XLS hérité",
    OFX: "OFX",
    QIF: "QIF",
    MT940: "SWIFT MT940",
    CAMT053: "ISO 20022 CAMT.053",
    PDF_TEXT: "PDF avec couche texte",
    PDF_OCR: `PDF scanné — ${reader}`,
    IMAGE_OCR: `Image de relevé — ${reader}`,
  }[format];
}

function canonicalRows(table: ParsedTable, currency: string | null, ocr?: ParsedBankStatement["ocr"]): CanonicalBankTransaction[] {
  const mapping = suggestStatementMapping(table.headers);
  // The same statement-wide reading the import uses, so the preview a person
  // approves and the movements Wheat then writes cannot disagree about which
  // year a bare "25 06" belongs to.
  const inferredYear = inferStatementYear(table.rows, mapping);
  const balanceHeader = table.headers.find((header) => ["solde", "balance", "encours", "availableamount"].some((word) => normalizeHeader(header).includes(word)));
  const baseConfidence = ocr?.confidenceDimensions ?? { textRecognition: 100, layout: 100, rowReconstruction: 100, fieldMapping: 100, accountingConsistency: null, finalDocument: 100 };
  return table.rows.map((row, index) => {
    const operationRaw = mapping.date ? row[mapping.date] ?? "" : "";
    const valueRaw = mapping.valueDate ? row[mapping.valueDate] ?? "" : "";
    let operationDate: ReturnType<typeof normalizeFlexibleDate> | null = null;
    let valueDate: ReturnType<typeof normalizeFlexibleDate> | null = null;
    try { if (operationRaw) operationDate = normalizeFlexibleDate(operationRaw, { year: inferredYear }); } catch { /* review records the field error */ }
    try { if (valueRaw) valueDate = normalizeFlexibleDate(valueRaw, { year: inferredYear }); } catch { /* review records the field error */ }
    const rowClass = classifyStatementRow(row, { mapping }) as BankStatementRowClass;
    return {
      operationDate: operationDate?.iso ?? null,
      operationDateRaw: operationRaw,
      operationDateInferred: Boolean(operationDate?.inferred),
      valueDate: valueDate?.iso ?? null,
      valueDateRaw: valueRaw,
      description: mapping.label ? row[mapping.label] ?? "" : "",
      reference: mapping.reference ? row[mapping.reference] ?? "" : "",
      bankIdentifier: mapping.externalId ? row[mapping.externalId] ?? "" : "",
      debit: mapping.debit && row[mapping.debit]?.trim() ? row[mapping.debit] : null,
      credit: mapping.credit && row[mapping.credit]?.trim() ? row[mapping.credit] : null,
      signedAmount: mapping.amount && row[mapping.amount]?.trim() ? row[mapping.amount] : null,
      currency: mapping.currency && row[mapping.currency]?.trim() ? row[mapping.currency].trim().toUpperCase() : currency,
      balance: balanceHeader && row[balanceHeader]?.trim() ? row[balanceHeader] : null,
      sourcePage: Number.isInteger(Number(row.__wheatSourcePage)) ? Number(row.__wheatSourcePage) : null,
      sourceRow: index + 1,
      rowClass,
      confidence: { ...baseConfidence },
      raw: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "__wheatSourcePage")),
    };
  });
}

function finalize(format: BankStatementFormat, parser: string, table: ParsedTable, warnings: string[], currency: string | null, ocr?: ParsedBankStatement["ocr"], declaredBalances?: StatementDeclaredBalances): ParsedBankStatement {
  if (!table.rows.length) throw userError("Le relevé ne contient aucune transaction exploitable.");
  if (table.rows.length > MAX_ROWS) throw userError(`Le relevé dépasse la limite sûre de ${MAX_ROWS} transactions.`);
  return {
    format,
    formatLabel: formatLabel(format, ocr),
    parser,
    headers: table.headers,
    rows: table.rows,
    suggestedMapping: suggestStatementMapping(table.headers),
    warnings: [...table.warnings, ...warnings],
    currency,
    rowCount: table.rows.length,
    previewRows: table.rows.slice(0, 20),
    canonicalRows: canonicalRows(table, currency, ocr),
    ...(declaredBalances && Object.keys(declaredBalances).length ? { declaredBalances } : {}),
    ...(ocr ? { ocr } : {}),
  };
}

/**
 * Movement rows a person cannot use, as the rest of the import sees them.
 *
 * The classification has to be the mapping-aware one, because that is what
 * `canonicalRows`, the review service and the import itself all use. Asked
 * without a mapping, a statement's registration footer and its totals line look
 * like movements with no amount — so a page Wheat had read perfectly reported
 * three "unusable movements" that were never movements at all, which is a model
 * asked for nothing and, worse, a reading described as incomplete when it was
 * complete.
 */
function unusableMovementRows(table: ParsedTable): number[] {
  const mapping = suggestStatementMapping(table.headers);
  return incompleteMovementRows(table, mapping, (row) => classifyStatementRow(row, { mapping }) === "TRANSACTION");
}

/** Names the engine that actually read the pages, for the import history. */
function scannedParserName(table: ParsedPdfTable): string {
  return table.ocr?.local === false ? "WheatCloudBankTableParser" : "PaddleOcrBankTableParser";
}

export async function parseBankStatement(input: ParseBankStatementInput): Promise<ParsedBankStatement> {
  const sourceName = safeSourceName(input?.sourceName);
  if (typeof input?.bytesBase64 !== "string" || !input.bytesBase64) throw userError("Le relevé est vide.");
  const bytes = Buffer.from(input.bytesBase64, "base64");
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw userError("Le relevé est vide ou dépasse 25 Mo.");
  const extension = path.extname(sourceName).toLowerCase();
  const headAscii = bytes.subarray(0, Math.min(bytes.length, 64_000)).toString("latin1");
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".heic", ".heif"]);
  const scanned: ScannedStatementOptions = {
    aiFallback: input.aiFallback,
    recognition: input.recognition,
    cloudRequested: input.cloudRequested,
    onCloudProgress: input.onCloudProgress,
    signal: input.signal,
  };
  if (imageExtensions.has(extension)) {
    if (!input.app) throw userError("Une image de relevé doit être lue par reconnaissance, ce qui n'est pas disponible ici.");
    const table = await parseScannedStatement(bytes, input.app, extension, scanned);
    return finalize("IMAGE_OCR", scannedParserName(table), table, [], table.currency ?? null, table.ocr);
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    const table = await parsePdf(bytes, input.app, scanned);
    return table.ocr
      ? finalize("PDF_OCR", scannedParserName(table), table, [], table.currency ?? null, table.ocr)
      : finalize("PDF_TEXT", "PdfTextBankParser", table, [], null);
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0]))) {
    return finalize("XLS", "XlrdLegacyBankParser", await parseLegacyXls(bytes, input.app), ["Classeur XLS binaire lu par le convertisseur local épinglé xlrd 2.0.2."], null);
  }
  if (bytes.subarray(0, 2).toString("ascii") === "PK") {
    const ExcelJS = nodeRequire("exceljs");
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw userError("Le fichier ressemble à un XLSX mais le classeur est corrompu ou non pris en charge.");
    }
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw userError("Le classeur XLSX ne contient aucune feuille.");
    const matrix: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      const width = Math.max(worksheet.columnCount, row.cellCount);
      matrix.push(Array.from({ length: width }, (_, index) => row.getCell(index + 1).text.trim()));
    });
    return finalize("XLSX", "ExcelBankParser", tableFromMatrix(matrix), [], null);
  }
  const { text, encoding } = decodeText(bytes);
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (/OFXHEADER\s*:|<OFX\b/i.test(trimmed) || /<STMTTRN\b/i.test(headAscii)) {
    const parsed = parseOfx(trimmed);
    return finalize("OFX", "OfxBankParser", { headers: STANDARD_HEADERS, rows: parsed.rows, warnings: [] }, parsed.warnings, parsed.currency);
  }
  if (/^!Type:/im.test(trimmed) && /^\^\s*$/m.test(trimmed)) {
    const parsed = parseQif(trimmed);
    return finalize("QIF", "QifBankParser", { headers: STANDARD_HEADERS, rows: parsed.rows, warnings: [] }, parsed.warnings, null);
  }
  if (/^:20:/m.test(trimmed) && /^:61:/m.test(trimmed)) {
    const parsed = parseMt940(trimmed);
    return finalize("MT940", "Mt940BankParser", { headers: STANDARD_HEADERS, rows: parsed.rows, warnings: [] }, parsed.warnings, parsed.currency, undefined, parsed.declaredBalances);
  }
  if (/<(?:\w+:)?BkToCstmrStmt\b/i.test(trimmed) || /camt\.053/i.test(trimmed)) {
    const parsed = parseCamt053(trimmed);
    return finalize("CAMT053", "Camt053BankParser", { headers: STANDARD_HEADERS, rows: parsed.rows, warnings: [] }, parsed.warnings, parsed.currency);
  }
  if (extension === ".xls") {
    throw userError("Ce fichier porte l'extension XLS mais sa signature BIFF est invalide.");
  }
  const table = parseDelimited(trimmed);
  const format: BankStatementFormat = extension === ".txt" ? "TXT" : "CSV";
  const separatorLabel = table.separator === "\t" ? "tabulation" : table.separator;
  const encodingWarning = encoding === "Windows-1252" ? ["Encodage Windows-1252 détecté et décodé."] : [];
  return finalize(format, format === "TXT" ? "DelimitedTextBankParser" : "CsvBankParser", table, [`Séparateur détecté: ${separatorLabel}.`, ...encodingWarning], null);
}
