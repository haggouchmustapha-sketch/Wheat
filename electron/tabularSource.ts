/**
 * Reading a spreadsheet or a delimited file into headers and rows.
 *
 * This is the part of importing that is the same whatever is being imported: an
 * encoding to detect, a separator to guess, quoted fields to honour, an XLSX
 * sheet to flatten. None of it knows what a bank statement is, and none of it
 * knows what an article is.
 *
 * It was extracted from `bankStatementImporter.ts`, which had all of it and was
 * the only caller until the stock catalogue needed to be importable too. A
 * second copy would have been a second place for "which separator is this" and
 * "is this Windows-1252" to be answered differently, and an accented
 * désignation reads as mojibake in exactly the same way whether it arrived in a
 * statement or in a catalogue.
 *
 * Callers supply the noun their messages use — "Le relevé", "Le fichier" — so
 * the refusal a person reads is about the thing they actually dropped.
 */

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

export type TabularTable = {
  headers: string[];
  rows: Array<Record<string, string>>;
  warnings: string[];
};

export type TabularFormat = "CSV" | "TXT" | "XLSX";

export type TabularOptions = {
  /** How the messages name the file: "Le relevé", "Le fichier importé". */
  noun: string;
  /** Rows beyond this are refused outright rather than truncated silently. */
  maxRows: number;
  /** Turns a message into the error type the calling domain already throws. */
  fail: (message: string) => Error;
};

/**
 * UTF-8 where it decodes, Windows-1252 otherwise.
 *
 * Strict UTF-8 first (`fatal: true`) so a Windows-1252 file is detected by
 * failing rather than by silently producing replacement characters — the
 * mojibake would otherwise survive all the way into a désignation.
 */
export function decodeText(bytes: Buffer): { text: string; encoding: "UTF-8" | "Windows-1252" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

/**
 * Names every column, and never twice.
 *
 * A blank header becomes "Column n" and a repeated one gains a suffix, because
 * the rows below are keyed by header: two columns called "Montant" would
 * otherwise collapse into one and lose a value without saying so.
 */
export function uniqueHeaders(values: unknown[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value ?? "").replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/** The separator that appears most often outside quotes, or none. */
export function detectSeparator(line: string): string | null {
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

/** RFC-4180-shaped delimited text: quoted fields, doubled quotes, CRLF or LF. */
export function parseDelimitedMatrix(text: string, separator: string, options: TabularOptions): string[][] {
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
  if (quoted) throw options.fail(`${options.noun} contient un champ entre guillemets non fermé.`);
  return matrix;
}

/**
 * First row as headers, the rest as rows keyed by them.
 *
 * A row with the wrong number of cells is kept and reported rather than
 * dropped: it is usually a stray separator inside a label, and the person
 * importing needs to see which line to look at.
 */
export function tableFromMatrix(matrix: string[][], options: TabularOptions): TabularTable {
  if (matrix.length < 2) throw options.fail(`${options.noun} ne contient pas d'en-tête et de ligne de données exploitables.`);
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
  if (rows.length > options.maxRows) {
    throw options.fail(`${options.noun} contient plus de ${options.maxRows} lignes, limite sûre d'un import Wheat.`);
  }
  return { headers, rows, warnings };
}

export function parseDelimited(text: string, options: TabularOptions): TabularTable & { separator: string } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = detectSeparator(firstLine);
  if (!separator) {
    throw options.fail(
      `Aucun séparateur de colonnes fiable n'a été détecté dans ${options.noun.toLowerCase()}. `
      + "Utilisez une virgule, un point-virgule, une tabulation ou une barre verticale.",
    );
  }
  return { ...tableFromMatrix(parseDelimitedMatrix(text, separator, options), options), separator };
}

/** The first worksheet of an XLSX workbook, as text cells. */
export async function readXlsxMatrix(bytes: Buffer, options: TabularOptions): Promise<string[][]> {
  const ExcelJS = nodeRequire("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw options.fail(`${options.noun} ressemble à un XLSX mais le classeur est corrompu ou non pris en charge.`);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw options.fail(`${options.noun} ne contient aucune feuille.`);
  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row: any) => {
    const width = Math.max(worksheet.columnCount, row.cellCount);
    matrix.push(Array.from({ length: width }, (_value, index) => row.getCell(index + 1).text.trim()));
  });
  return matrix;
}

export function looksLikeXlsx(bytes: Buffer): boolean {
  // A XLSX is a ZIP; "PK" is its local file header signature.
  return bytes.subarray(0, 2).toString("ascii") === "PK";
}

export type TabularSource = TabularTable & {
  format: TabularFormat;
  separator?: string;
  encoding?: "UTF-8" | "Windows-1252";
};

/**
 * Reads whichever of the three shapes the bytes turn out to be.
 *
 * XLSX is recognised by its ZIP signature rather than by its extension,
 * because a spreadsheet saved as `.csv` and a CSV named `.xlsx` are both things
 * people actually send.
 */
export async function readTabularSource(bytes: Buffer, fileName: string, options: TabularOptions): Promise<TabularSource> {
  if (!bytes.length) throw options.fail(`${options.noun} est vide.`);
  if (looksLikeXlsx(bytes)) {
    return { format: "XLSX", ...tableFromMatrix(await readXlsxMatrix(bytes, options), options) };
  }
  const { text, encoding } = decodeText(bytes);
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const parsed = parseDelimited(trimmed, options);
  const format: TabularFormat = /\.txt$/i.test(fileName) ? "TXT" : "CSV";
  return { format, encoding, ...parsed };
}
