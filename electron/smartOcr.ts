import crypto from "node:crypto";
import { STORED_SCHEMA_VERSIONS, WHEAT_OCR_TAG } from "./legacyDomainValues";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";
import { portableArchiveSegment } from "./archive";
import { closePaddleOcrWorker, paddleOcrPoolSize, recognizeWithPaddle } from "./paddleOcr";
import {
  assembleDocument,
  reconcileLineItems,
  type AccountingCheck,
} from "./ocrDocumentUnderstanding";
import { evaluateTotals } from "./ocrAmounts";
import { extractDocumentFields, type DetectedParty, type ExtractionContext, type ExtractionResult } from "./ocrFieldExtraction";
import { reviewDocumentWithAi, type AiReviewChat, type AiReviewOutcome } from "./ocrAiReview";
import { readWheatEnv } from "./runtimeEnvironment";

type ExistingDocument = {
  id: string;
  title: string;
  type: string;
  extracted: string;
};

type FieldResult = {
  value: string | number | null;
  confidence: number;
  raw?: string;
  source?: string;
};

type WheatOcrPage = {
  page: number;
  text: string;
  confidence: number;
  engine: string;
  preprocessing: string[];
  words: WheatWord[];
  tables?: string[][][];
  candidates?: Array<{ engine: string; confidence: number }>;
  /** Pixel size of the image the coordinates refer to, when it is known. */
  source?: RecognitionDetail;
};

type WheatWord = {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
};

/**
 * Recognition detail kept for the document-understanding layer.
 *
 * The pipeline used to flatten every page to a string before looking for a
 * single field. That is what made "TVA" pick up the HT total printed on the
 * line above it: in reading order the two are adjacent, on the page they are
 * not. Coordinates, per-element confidence and the source image size are
 * carried through so the semantic layer can tell those apart.
 */
type RecognitionDetail = { width?: number; height?: number };

type WheatOcrOutput = {
  /** Set when this recognition came back from the local cache. */
  reusedRecognition?: boolean;
  text: string;
  confidence: number;
  engine: string;
  pages: WheatOcrPage[];
  tables: string[][][];
  warnings: string[];
  preprocessing: string[];
  note: string;
};

type BankTransaction = {
  Date: string;
  Description: string;
  Debit: number | null;
  Credit: number | null;
  Balance: number | null;
};

/**
 * What a batch import reports while it runs.
 *
 * A thirty-document import is a minute of work whatever the pipeline does with
 * it; the difference between a usable feature and a frozen window is whether
 * the person can see it advancing. The recogniser emits these as each stage of
 * each document completes, and the caller forwards them to the renderer.
 */
export type SmartOcrProgress = {
  phase: "BATCH_START" | "DOCUMENT_START" | "DOCUMENT_DONE" | "BATCH_DONE";
  fileName: string;
  index: number;
  total: number;
  completed: number;
  elapsedMs: number;
  /** Set on `DOCUMENT_DONE`: whether recognition was reused from the cache. */
  cached?: boolean;
  status?: string;
  documentType?: string;
  error?: string;
};

export type SmartOcrProgressListener = (event: SmartOcrProgress) => void;

/** The one-way channel batch progress is pushed to the renderer on. */
export const SMART_OCR_PROGRESS_CHANNEL = "wheat:smart-ocr:progress";

type SmartOcrResult = {
  /** True when the recognition was read back from the local cache. */
  reusedRecognition?: boolean;
  originalPath: string;
  originalName: string;
  storedPath: string;
  title: string;
  type: string;
  fiscalYear: string;
  tags: string;
  ocrText: string;
  extracted: Record<string, unknown>;
  status: string;
};

const nodeRequire = createRequire(import.meta.url);
let worker: any = null;
let sharpModule: any = null;

const engineName = "Wheat Vision OCR";
const engineVersion = "2.1.0";

const imageExtensions = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);
const spreadsheetExtensions = new Set([".xlsx"]);
const acceptedExtensions = new Set([".pdf", ".csv", ".txt", ...spreadsheetExtensions, ...imageExtensions]);

const documentTypeLabels: Record<string, string> = {
  INVOICE: "Facture",
  CREDIT_NOTE: "Avoir",
  BANK_STATEMENT: "Releve bancaire",
  RECEIPT: "Recu",
  CONTRACT: "Contrat",
  PAYROLL: "Paie",
  IDENTITY: "Identite",
  TAX: "Fiscal",
  LETTER: "Courrier",
  TABLE: "Tableau",
  UNKNOWN: "Inconnu",
};

const folderNames: Record<string, string> = {
  INVOICE: "Invoices",
  CREDIT_NOTE: "Credit notes",
  BANK_STATEMENT: "Bank statements",
  RECEIPT: "Receipts",
  CONTRACT: "Contracts",
  PAYROLL: "Payroll",
  IDENTITY: "Identity docs",
  TAX: "Tax docs",
  LETTER: "Letters",
  TABLE: "Tables",
  UNKNOWN: "Unknown",
};

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const resolveUserDataDir = (app: App) => readWheatEnv("WHEAT_USER_DATA_DIR") || app.getPath("userData");

export async function closeSmartOcrWorker() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  await closePaddleOcrWorker();
}

export async function processSmartOcrFiles(app: App, params: {
  companyId: string;
  companyName: string;
  filePaths: string[];
  existingDocuments: ExistingDocument[];
  /**
   * Identity of the dossier the document is being filed into.
   *
   * A purchase invoice and a sales invoice look identical until you know which
   * of the two companies printed on it is the one you keep the books for. When
   * the dossier's ICE appears on the page, that question is settled; when it
   * does not, the pipeline says so instead of guessing silently.
   */
  company?: { name?: string | null; ice?: string | null; taxId?: string | null } | null;
  /**
   * Optional AI re-reading of the recognised document. Supplied by the main
   * process only when the user has explicitly enabled it; absent means the
   * pipeline stays fully local, which is the default.
   */
  aiReview?: AiReviewChat;
  /** Called as each document starts and finishes, for a progressive UI. */
  onProgress?: SmartOcrProgressListener;
  /** Overrides how many documents are recognised at once. Tests pin it to 1. */
  concurrency?: number;
}) {
  const filePaths = params.filePaths.filter(Boolean).filter((filePath) => fs.existsSync(filePath));
  const startedAt = Date.now();
  const report = (event: Omit<SmartOcrProgress, "elapsedMs" | "total">) => {
    try {
      params.onProgress?.({ ...event, total: filePaths.length, elapsedMs: Date.now() - startedAt });
    } catch {
      // A listener that throws must not abort an import that is otherwise fine.
    }
  };
  report({ phase: "BATCH_START", fileName: "", index: 0, completed: 0 });

  // Documents are independent up to the duplicate check, and the recognition
  // pool can serve several at once. Running them one after another left most of
  // the machine idle for the whole of a batch import; the duplicate pass below
  // is what keeps the *result* identical to the sequential order.
  let completed = 0;
  const results = await mapWithConcurrency(filePaths, resolveOcrConcurrency(params.concurrency), async (filePath, index) => {
    report({ phase: "DOCUMENT_START", fileName: path.basename(filePath), index, completed });
    try {
      const result = await analyzeSmartOcrFile(app, params, filePath);
      completed += 1;
      report({ phase: "DOCUMENT_DONE", fileName: path.basename(filePath), index, completed, status: result.status, documentType: result.type, cached: result.reusedRecognition });
      return result;
    } catch (error) {
      // One unreadable document must never take the other twenty-nine with it.
      completed += 1;
      const message = errorMessage(error);
      report({ phase: "DOCUMENT_DONE", fileName: path.basename(filePath), index, completed, status: "TO_REVIEW", error: message });
      return buildUnsupportedResult(app, params.companyName, filePath, `La lecture de ce document a échoué : ${message}`);
    }
  });

  // Duplicate detection is order-dependent — the first occurrence keeps the
  // page, the later ones are marked — so it runs once, in input order, after
  // recognition rather than inside it.
  const seenFingerprints = new Map<string, string>();
  for (const result of results) {
    const fingerprint = String((result.extracted as Record<string, unknown>).duplicateFingerprint ?? "");
    if (!fingerprint) continue;
    const extracted = result.extracted as Record<string, unknown>;
    const duplicateIds = [
      ...findExistingDuplicates(params.existingDocuments, fingerprint),
      ...(seenFingerprints.has(fingerprint) ? [seenFingerprints.get(fingerprint) as string] : []),
    ].filter(Boolean);
    seenFingerprints.set(fingerprint, result.originalPath);
    extracted.duplicateIds = duplicateIds;
    if (duplicateIds.length && !result.tags.split(",").includes("duplicate")) {
      result.tags = [...result.tags.split(",").filter(Boolean), "duplicate"].join(",");
    }
  }

  report({ phase: "BATCH_DONE", fileName: "", index: filePaths.length, completed });
  return results;
}

/** How many documents to recognise at once, matched to the sidecar pool. */
function resolveOcrConcurrency(requested?: number) {
  if (Number.isInteger(requested) && (requested as number) >= 1) return requested as number;
  return Math.max(1, paddleOcrPoolSize());
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * `Promise.all` over the whole batch would start thirty recognitions at once
 * and thrash a machine that can usefully run three.
 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Everything one document needs, with no reference to the rest of the batch.
 *
 * Keeping this free of shared state is what makes the concurrency above safe:
 * the only cross-document decision, duplicate detection, is made by the caller
 * in input order.
 */
async function analyzeSmartOcrFile(app: App, params: {
  companyName: string;
  company?: { name?: string | null; ice?: string | null; taxId?: string | null } | null;
  aiReview?: AiReviewChat;
}, filePath: string): Promise<SmartOcrResult> {
  {
    const extension = path.extname(filePath).toLowerCase();
    if (!acceptedExtensions.has(extension)) {
      return buildUnsupportedResult(app, params.companyName, filePath, `Format ${extension || "sans extension"} non pris en charge.`);
    }

    const extraction = await runWheatVisionOcr(app, filePath, extension);
    // One logical document, not a pile of pages: repeated headers are read
    // once and a table split by a page break is put back together before any
    // field is looked for.
    const assembled = assembleDocument(extraction.pages.length > 1
      ? extraction.pages.map((page) => ({ page: page.page, text: page.text, confidence: page.confidence, tables: page.tables }))
      : [{ page: 1, text: extraction.text, confidence: extraction.confidence, tables: extraction.tables }]);
    const text = normalizeText(assembled.text || extraction.text);
    const documentTables = assembled.tables.length ? assembled.tables : extraction.tables;
    // Understanding runs on the recognised elements, coordinates included —
    // never on the flattened string, which is where the field mapping used to
    // go wrong even when recognition was perfect.
    const understanding = extractDocumentFields(
      extraction.pages.length
        ? extraction.pages.map((page) => ({
          page: page.page,
          text: page.text,
          confidence: page.confidence,
          words: page.words,
          width: page.source?.width,
          height: page.source?.height,
        }))
        : [{ page: 1, text, confidence: extraction.confidence }],
      { fileName: path.basename(filePath), company: params.company ?? null } satisfies ExtractionContext,
    );
    const classification = understanding.classification;
    const structured = extractStructuredData(text, classification.type, documentTables, extraction.pages, understanding);
    const fingerprint = buildFingerprint(classification.type, structured.fields);
    // Filled in by the caller, once, in input order.
    const duplicateIds: string[] = [];

    const confidence = calculateConfidence(extraction.confidence, classification.confidence, structured.fields, structured.tableRows.length);
    const required = requiredFieldsForType(classification.type);
    // Accounting-aware validation. A document whose own arithmetic does not
    // hold is flagged, never silently "fixed": the totals engine has already
    // scored every candidate reading against it, and its verdict is what the
    // review screen shows.
    const accountingChecks: AccountingCheck[] = understanding.totals.evaluation.checks.map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      detail: check.detail,
    }));
    if (classification.type === "INVOICE" || classification.type === "CREDIT_NOTE") {
      accountingChecks.push(reconcileLineItems(
        // Line items carry exact centime strings; the reconciliation works in
        // document units, so each is converted back once here.
        invoiceLineItems(structured.tableRows).map((item: any) => ({
          totalHt: centsToUnits(item.lineTotalCents),
          quantity: parseAmount(String(item.quantity ?? "")),
          unitPrice: centsToUnits(item.unitPriceCents),
        })),
        numericValue(structured.fields.ht),
      ));
    }
    // Optional whole-document re-reading. It runs after the rule-based pass so
    // it can see what was read weakly, and it can only add or contest a field —
    // never silently replace a confident one.
    let aiReview: AiReviewOutcome | null = null;
    if (params.aiReview) {
      aiReview = await reviewDocumentWithAi({
        text,
        documentType: classification.type,
        fields: Object.fromEntries(Object.entries(structured.fields).map(([key, item]) => [key, { value: item.value, confidence: item.confidence }])),
      }, params.aiReview);
      for (const [key, field] of Object.entries(aiReview.fields)) {
        structured.fields[key] = { value: field.value, confidence: field.confidence, raw: field.evidence, source: "ai-review" };
      }
    }

    const uncertainFields = [...new Set([
      ...Object.entries(structured.fields)
        .filter(([key, fieldItem]) => required.includes(key) && fieldItem.confidence < 72)
        .map(([key]) => key),
      // A failed arithmetic check is a stronger signal than a confident OCR
      // read: the numbers were legible and still do not agree.
      ...understanding.totals.evaluation.failedFields
        .map((kind) => ({ HT: "ht", TVA: "tva", TTC: "ttc", DEBOURS: "debours", DISCOUNT: "discount", NET_PAID: "netPaid", STAMP: "stamp" }[kind] ?? ""))
        .filter((key) => key && key in structured.fields),
      ...(accountingChecks.some((check) => check.id === "line-items-sum-to-ht" && check.status === "FAILED") ? ["ht"] : []),
      // A field where the recogniser and the review disagree is exactly the
      // kind a person has to settle.
      ...(aiReview?.disagreements.map((entry) => entry.field) ?? []),
    ])];
    const documentDate = parseDateValue(asText(structured.fields.date?.value)) ?? new Date();
    const fiscalYear = String(documentDate.getFullYear());
    const counterparty =
      asText(structured.fields.counterparty?.value) ||
      asText(structured.fields.supplier?.value) ||
      asText(structured.fields.client?.value) ||
      "Unknown";
    const storedPath = copyToSmartFolder(app, params.companyName, filePath, documentDate, classification.type, counterparty);
    const status = confidence < 78 || uncertainFields.length > 0 ? "TO_REVIEW" : "EXTRACTED";

    return {
      reusedRecognition: extraction.reusedRecognition === true,
      originalPath: filePath,
      originalName: path.basename(filePath),
      storedPath,
      title: path.basename(filePath),
      type: documentTypeLabels[classification.type],
      fiscalYear,
      tags: [
        WHEAT_OCR_TAG,
        classification.type.toLowerCase().replaceAll("_", "-"),
        `${confidence}%`,
        duplicateIds.length ? "duplicate" : "",
        uncertainFields.length ? "needs-review" : "",
      ].filter(Boolean).join(","),
      ocrText: text || extraction.note,
      extracted: {
        engine: engineName,
        engineVersion,
        stack: {
          pdf: "pdf-parse text layer + scanned-page raster fallback",
          imagePreprocessing: "sharp auto-rotate/grayscale/normalize/sharpen/threshold variants",
          recognizer: "PaddleOCR 3.7 authoritative local engine (PP-OCR for documents, PP-StructureV3 for bank tables, optional locally installed PaddleOCR-VL-1.6 fallback); tesseract.js only when PaddleOCR is unavailable or returns no usable text",
          understanding: "Wheat layout engine (rows, columns, party blocks) + accounting validation of every candidate reading",
        },
        language: "fra+eng+ara",
        documentType: classification.type,
        documentTypeLabel: documentTypeLabels[classification.type],
        documentDirection: understanding.classification.direction,
        classificationReasons: understanding.classification.reasons,
        confidence,
        ocrConfidence: extraction.confidence,
        classificationConfidence: classification.confidence,
        classificationScores: classification.scores,
        uncertainFields,
        duplicateIds,
        duplicateFingerprint: fingerprint,
        organizedPath: storedPath,
        preprocessing: extraction.preprocessing,
        warnings: extraction.warnings,
        pages: extraction.pages.map((page) => ({
          page: page.page,
          confidence: page.confidence,
          engine: page.engine,
          preprocessing: page.preprocessing,
          textLength: page.text.length,
          wordCount: page.words.length,
          tableCount: page.tables?.length ?? 0,
          candidates: page.candidates ?? [{ engine: page.engine, confidence: page.confidence }],
        })),
        layout: buildLayoutSummary(text, extraction.pages, structured.tableRows),
        document: {
          pageCount: assembled.pageCount,
          repeatedLinesRemoved: assembled.repeatedLines.length,
          notes: [...assembled.notes, ...understanding.trace.notes],
        },
        parties: {
          issuer: publicParty(understanding.parties.issuer),
          recipient: publicParty(understanding.parties.recipient),
        },
        // Diagnosis material. When a field comes out wrong, this is what says
        // whether the recogniser misread the page or Wheat mapped a correct
        // reading to the wrong field — the two need opposite fixes, and telling
        // them apart used to require re-running the document by hand.
        diagnostics: {
          totalsStrategy: understanding.totals.strategy,
          totalsAlternatives: understanding.totals.alternatives.slice(0, 12),
          accountingScore: Math.round(understanding.totals.evaluation.score * 100),
          deboursAdditive: understanding.totals.evaluation.deboursAdditive,
          vatRateSource: understanding.totals.vatRateSource,
          candidates: understanding.trace.candidates.slice(0, 120),
          fieldEvidence: Object.fromEntries(Object.entries(understanding.fields)
            .filter(([, item]) => item.evidence.length)
            .map(([key, item]) => [key, item.evidence])),
          recognizedElements: extraction.pages.flatMap((page) => page.words.slice(0, 400).map((word) => ({
            page: page.page,
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox ?? null,
          }))).slice(0, 800),
        },
        aiReview: aiReview
          ? {
            applied: aiReview.applied,
            provider: aiReview.provider,
            modelId: aiReview.modelId,
            suppliedFields: Object.keys(aiReview.fields),
            disagreements: aiReview.disagreements,
            notes: aiReview.notes,
          }
          : null,
        accountingChecks,
        amountsNotFound: (["ht", "tva", "ttc"] as const).filter((key) => structured.fields[key]?.value === null),
        accountingCheckSummary: {
          passed: accountingChecks.filter((check) => check.status === "PASSED").length,
          failed: accountingChecks.filter((check) => check.status === "FAILED").length,
          skipped: accountingChecks.filter((check) => check.status === "SKIPPED").length,
        },
        fields: mapFieldValues(structured.fields),
        fieldConfidence: mapFieldConfidence(structured.fields),
        fieldRaw: mapFieldRaw(structured.fields),
        fieldSources: mapFieldSources(structured.fields),
        invoiceSchema: classification.type === "INVOICE" ? buildInvoiceSchema(structured.fields, structured.tableRows, extraction.pages) : null,
        bankTransactions: structured.bankTransactions,
        tableRows: structured.tableRows,
        freeText: text.slice(0, 32000),
      },
      status,
    };
  }
}

async function buildUnsupportedResult(app: App, companyName: string, filePath: string, note: string): Promise<SmartOcrResult> {
  const storedPath = copyToSmartFolder(app, companyName, filePath, new Date(), "UNKNOWN", "Unsupported");
  return {
    originalPath: filePath,
    originalName: path.basename(filePath),
    storedPath,
    title: path.basename(filePath),
    type: documentTypeLabels.UNKNOWN,
    fiscalYear: String(new Date().getFullYear()),
    tags: `${WHEAT_OCR_TAG},unsupported,needs-review`,
    ocrText: note,
    extracted: {
      engine: engineName,
      engineVersion,
      documentType: "UNKNOWN",
      documentTypeLabel: documentTypeLabels.UNKNOWN,
      confidence: 5,
      uncertainFields: ["freeText"],
      duplicateIds: [],
      organizedPath: storedPath,
      preprocessing: ["stored-original"],
      warnings: [note],
      fields: {},
      fieldConfidence: {},
      bankTransactions: [],
      tableRows: [],
      freeText: note,
    },
    status: "TO_REVIEW",
  };
}

/**
 * Unique enough for two copies of the same file, filed in the same millisecond.
 *
 * The timestamp prefix alone was unique while documents were recognised one
 * after another. They no longer are.
 */
function uniqueStoredName(sourcePath: string) {
  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeSegment(path.basename(sourcePath))}`;
}

/**
 * Recognition, cached by what the file actually contains.
 *
 * Recognising a page costs several seconds and is a pure function of the bytes
 * and the pipeline that read them. Re-importing a document, re-running the
 * recogniser after correcting a field, or dropping a folder that already holds
 * files Wheat has seen all repeated that work in full. The key is the file's
 * SHA-256 plus the engine version, so upgrading the recogniser invalidates
 * every entry rather than serving yesterday's reading from a better engine.
 *
 * The cache holds recognised text, never a decision: what Wheat *concludes*
 * from a document is recomputed every time, so a change in the understanding
 * layer or in the dossier's own identity takes effect immediately.
 */
const RECOGNITION_CACHE_VERSION = `${engineVersion}-1`;
const RECOGNITION_CACHE_LIMIT = 400;

function recognitionCacheDir(app: App) {
  return path.join(resolveUserDataDir(app), "ocr-cache", "recognition");
}

function readRecognitionCache(app: App, key: string): WheatOcrOutput | null {
  try {
    const file = path.join(recognitionCacheDir(app), `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string; output?: WheatOcrOutput };
    if (parsed?.version !== RECOGNITION_CACHE_VERSION || !parsed.output) return null;
    return { ...parsed.output, reusedRecognition: true };
  } catch {
    return null;
  }
}

function writeRecognitionCache(app: App, key: string, output: WheatOcrOutput) {
  try {
    const directory = recognitionCacheDir(app);
    fs.mkdirSync(directory, { recursive: true });
    const entries = fs.readdirSync(directory);
    if (entries.length >= RECOGNITION_CACHE_LIMIT) {
      // Oldest first, so a long-running install keeps a bounded folder without
      // ever discarding what it just recognised.
      const aged = entries
        .map((name) => ({ name, at: fs.statSync(path.join(directory, name)).mtimeMs }))
        .sort((left, right) => left.at - right.at)
        .slice(0, Math.max(1, entries.length - RECOGNITION_CACHE_LIMIT + 1));
      for (const entry of aged) fs.rmSync(path.join(directory, entry.name), { force: true });
    }
    fs.writeFileSync(path.join(directory, `${key}.json`), JSON.stringify({ version: RECOGNITION_CACHE_VERSION, output }), "utf8");
  } catch {
    // A cache that cannot be written is a slower import, not a failed one.
  }
}

async function runWheatVisionOcr(app: App, filePath: string, extension: string): Promise<WheatOcrOutput> {
  const key = crypto.createHash("sha256").update(fs.readFileSync(filePath)).update(extension).digest("hex");
  const cached = readRecognitionCache(app, key);
  if (cached) return cached;
  const output = await recognizeWheatVision(app, filePath, extension);
  if (output.text.trim().length >= 8) writeRecognitionCache(app, key, output);
  return output;
}

async function recognizeWheatVision(app: App, filePath: string, extension: string): Promise<WheatOcrOutput> {
  if (extension === ".txt" || extension === ".csv") {
    const text = fs.readFileSync(filePath, "utf8");
    return {
      text,
      confidence: 96,
      engine: "wheat-text-reader",
      pages: [{ page: 1, text, confidence: 96, engine: "text-reader", preprocessing: ["direct-text"], words: wordsFromText(text) }],
      tables: extension === ".csv" ? [readDelimitedTable(text)] : [],
      warnings: [],
      preprocessing: ["direct-text", "amount/date-normalized"],
      note: "",
    };
  }

  if (spreadsheetExtensions.has(extension)) return extractSpreadsheet(filePath);
  if (extension === ".pdf") return extractPdf(app, filePath);
  return extractImage(app, filePath);
}

async function extractSpreadsheet(filePath: string): Promise<WheatOcrOutput> {
  const ExcelJS = nodeRequire("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const tables: string[][][] = [];
  const textSections: string[] = [];
  for (const worksheet of workbook.worksheets) {
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      const cells: string[] = [];
      for (let index = 1; index <= Math.max(row.cellCount, worksheet.columnCount); index += 1) {
        cells.push(spreadsheetCellText(row.getCell(index).value));
      }
      if (cells.some(Boolean)) rows.push(cells);
    });

    if (rows.length) {
      tables.push(rows);
      textSections.push(`Feuille: ${worksheet.name}\n${rows.map((row) => row.filter(Boolean).join("; ")).join("\n")}`);
    }
  }

  const text = normalizeText(textSections.join("\n\n"));
  return {
    text,
    confidence: text.length ? 96 : 20,
    engine: "wheat-spreadsheet-reader",
    pages: [{ page: 1, text, confidence: text.length ? 96 : 20, engine: "spreadsheet-reader", preprocessing: ["xlsx-structured-reader"], words: wordsFromText(text) }],
    tables,
    warnings: [],
    preprocessing: ["xlsx-structured-reader", "table-preserved"],
    note: text ? "" : "No exploitable rows were extracted from the spreadsheet.",
  };
}

/**
 * Whether a PDF page's embedded text can be used instead of recognising it.
 *
 * A scanned page still returns a few characters — a stamp, a page number, the
 * artefacts of a partial OCR layer left by the scanner — so length alone is not
 * enough. A usable layer also has to be mostly letters and digits: a run of
 * substitution glyphs is exactly the case where trusting the layer produces
 * confident nonsense and recognising the page would have worked.
 */
function hasUsableTextLayer(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 80) return false;
  const readable = trimmed.replace(/[^\p{L}\p{N}]/gu, "").length;
  return readable >= 60 && readable / trimmed.length >= 0.45;
}

async function extractPdf(app: App, filePath: string): Promise<WheatOcrOutput> {
  const warnings: string[] = [];
  const pages: WheatOcrPage[] = [];
  const tables: string[][][] = [];
  const preprocessing = ["stored-original", "pdf-inspection"];
  const { PDFParse } = await import("pdf-parse");
  const workerUrl = resolvePdfWorkerUrl(app);
  if (workerUrl && typeof PDFParse.setWorker === "function") {
    PDFParse.setWorker(workerUrl);
    preprocessing.push("pdf-worker-local");
  } else {
    warnings.push("PDF worker was not found locally; PDF parsing may be limited.");
  }
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });

  try {
    const textResult = await parser.getText({ first: 1, last: 20 });
    const digitalText = normalizeText(textResult.text ?? "");

    try {
      const tableResult = await parser.getTable({ first: 1, last: 10 });
      for (const page of tableResult.pages ?? []) {
        for (const table of page.tables ?? []) tables.push(table.map((row: unknown[]) => row.map((cell) => String(cell ?? "").trim())));
      }
    } catch (error) {
      warnings.push(`Table extraction from PDF text layer was limited: ${errorMessage(error)}`);
    }

    // Page by page, not document by document. A PDF is regularly part digital
    // and part scanned — an invoice generated as text with a signed annex
    // photographed and appended — and judging the whole file by its combined
    // character count either rasterises pages that did not need it, wasting a
    // minute of CPU and inviting recognition errors on text that was already
    // perfect, or skips recognition on the pages that did need it.
    const perPage = new Map<number, string>();
    for (const page of textResult.pages ?? []) {
      perPage.set(Number(page.num) || 1, normalizeText(page.text ?? ""));
    }
    if (!perPage.size && digitalText) perPage.set(1, digitalText);

    const scannedPages = [...perPage.entries()].filter(([, text]) => !hasUsableTextLayer(text)).map(([page]) => page);
    const digitalPages = [...perPage.entries()].filter(([, text]) => hasUsableTextLayer(text));

    for (const [pageNo, text] of digitalPages) {
      pages.push({ page: pageNo, text, confidence: 93, engine: "pdf-text-layer", preprocessing: ["digital-pdf-text-layer"], words: wordsFromText(text) });
    }
    if (digitalPages.length) preprocessing.push("digital-pdf-text-layer");

    if (scannedPages.length) {
      warnings.push(digitalPages.length
        ? `Page(s) ${scannedPages.join(", ")} sans couche texte exploitable : rendu local et reconnaissance.`
        : "Ce PDF n'a pas de couche texte exploitable ; les pages sont rendues localement et reconnues.");
      try {
        // Only the pages that need it are rendered.
        const first = Math.min(...scannedPages);
        const last = Math.min(Math.max(...scannedPages), first + 7);
        const screenshot = await parser.getScreenshot({ scale: 2.2, first, last, imageDataUrl: false, imageBuffer: true });
        // A multi-page scan is several independent recognitions. Reading them
        // one after another made an eight-page statement eight times the cost
        // of a one-page invoice even though the pool was idle for seven of them.
        const rasterized = (screenshot.pages ?? [])
          .map((page: any, index: number) => ({ pageNo: Number(page.pageNumber) || first + index, data: page.data }))
          .filter((page: { pageNo: number; data: unknown }) => page.data && scannedPages.includes(page.pageNo));
        const recognized = await mapWithConcurrency(rasterized, resolveOcrConcurrency(), async (page: { pageNo: number; data: any }) =>
          recognizeImageWithPreprocessing(app, Buffer.from(page.data), page.pageNo));
        for (const pageResult of recognized) {
          pages.push(pageResult);
          if (pageResult.tables?.length) tables.push(...pageResult.tables);
        }
        preprocessing.push("pdf-rasterized-selected-pages");
      } catch (screenshotError) {
        warnings.push(`PDF page rendering failed: ${errorMessage(screenshotError)}`);
      }
    }

    pages.sort((left, right) => left.page - right.page);
    if (pages.length) {
      const text = mergePageText(pages);
      return {
        text,
        confidence: Math.round(average(pages.map((page) => page.confidence))) || 12,
        engine: scannedPages.length ? (digitalPages.length ? "wheat-pdf-hybrid" : "wheat-pdf-raster-ocr") : "wheat-pdf-text-layer",
        pages,
        tables,
        warnings,
        preprocessing,
        note: "",
      };
    }
  } catch (error) {
    warnings.push(`PDF processing failed: ${errorMessage(error)}`);
  } finally {
    await parser.destroy();
  }

  const text = mergePageText(pages);
  return {
    text,
    confidence: average(pages.map((page) => page.confidence)) || 12,
    engine: "wheat-pdf-raster-ocr",
    pages,
    tables,
    warnings,
    preprocessing: [...preprocessing, "pdf-rasterized", "image-normalized"],
    note: text ? "" : "No exploitable text was extracted from the PDF.",
  };
}

async function extractImage(app: App, filePath: string): Promise<WheatOcrOutput> {
  const warnings: string[] = [];
  try {
    const page = await recognizeImageWithPreprocessing(app, filePath, 1);
    return {
      text: page.text,
      confidence: page.confidence,
      engine: "wheat-image-ocr",
      pages: [page],
      tables: page.tables ?? [],
      warnings,
      preprocessing: page.preprocessing,
      note: "",
    };
  } catch (error) {
    warnings.push(`Image OCR failed: ${errorMessage(error)}`);
    return {
      text: "",
      confidence: 8,
      engine: "wheat-image-ocr",
      pages: [],
      tables: [],
      warnings,
      preprocessing: ["stored-original", "preprocessing-failed"],
      note: "Image was stored, but OCR failed. The document is marked for manual review.",
    };
  }
}

async function recognizeImageWithPreprocessing(app: App, input: string | Buffer, pageNo: number): Promise<WheatOcrPage> {
  const candidates: WheatOcrPage[] = [];
  const paddleWarnings: string[] = [];
  try {
    const paddleVariant = await buildPaddlePrimaryImage(input);
    const paddle = await recognizeWithPaddle(app, paddleVariant.buffer, { mode: "ocr", extension: ".png" });
    const paddleText = normalizeText(paddle.text);
    if (paddleText.length >= 8) {
      const paddleCandidate: WheatOcrPage = {
        page: pageNo,
        text: paddleText,
        confidence: paddle.confidence,
        engine: `${paddle.engine}:${paddle.engineVersion}`,
        preprocessing: [...paddleVariant.steps, "paddleocr-local-primary", ...paddle.warnings.map((warning) => `note:${warning}`)],
        words: paddle.words,
        tables: paddle.tables,
        source: { width: paddleVariant.width, height: paddleVariant.height },
      };
      return {
        ...paddleCandidate,
        candidates: [{ engine: paddleCandidate.engine, confidence: paddleCandidate.confidence }],
      };
    }
    paddleWarnings.push(...paddle.warnings);
    paddleWarnings.push("PaddleOCR n'a retourné aucun texte exploitable; repli Tesseract local.");
  } catch (error) {
    paddleWarnings.push(`PaddleOCR indisponible; repli Tesseract local: ${errorMessage(error)}`);
  }

  const variants = await buildImageVariants(input);
  const { PSM } = nodeRequire("tesseract.js");
  const passes = [
    { name: "auto-page", psm: PSM.AUTO },
    { name: "sparse-text", psm: PSM.SPARSE_TEXT },
  ];

  for (const variant of variants) {
    for (const pass of passes) {
      const recognized = await recognizePreparedImage(app, variant.buffer, pass.psm);
      candidates.push({
        page: pageNo,
        text: recognized.text,
        confidence: recognized.confidence,
        engine: `tesseract.js:${pass.name}`,
        preprocessing: variant.steps,
        words: recognized.words,
      });

      if (recognized.confidence >= 88 && hasAccountingAnchors(recognized.text)) break;
    }

    if (bestCandidate(candidates).confidence >= 84 && hasAccountingAnchors(bestCandidate(candidates).text)) break;
  }

  const best = bestCandidate(candidates);
  const mergedText = mergeCandidateText(candidates);
  const candidateSummary = candidates.map((candidate) => ({ engine: candidate.engine, confidence: candidate.confidence }));
  return {
    ...best,
    text: mergedText.length > best.text.length + 40 ? mergedText : best.text,
    confidence: Math.round(Math.max(best.confidence, average(candidates.map((candidate) => candidate.confidence)))),
    preprocessing: [...best.preprocessing, ...paddleWarnings.map((warning) => `note:${warning}`)],
    tables: best.tables,
    candidates: candidateSummary,
  };
}

async function buildPaddlePrimaryImage(input: string | Buffer): Promise<{ buffer: Buffer; steps: string[]; width: number; height: number }> {
  const sharp = await getSharp();
  const source = sharp(input, { limitInputPixels: false }).rotate();
  const metadata = await source.metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width > 1800 ? 1800 : width > 0 && width < 1200 ? 1600 : undefined;
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .png({ compressionLevel: 3 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    // The recogniser reports coordinates in the space of the image it was
    // given, so the size recorded here is the resized one, not the original.
    width: info.width,
    height: info.height,
    steps: ["sharp-auto-rotate", resizeWidth ? `paddle-resize-width-${resizeWidth}` : "paddle-native-size", "paddle-png"],
  };
}

async function buildImageVariants(input: string | Buffer): Promise<Array<{ name: string; buffer: Buffer; steps: string[] }>> {
  const sharp = await getSharp();
  const base = sharp(input, { limitInputPixels: false }).rotate();
  const metadata = await base.metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width && width < 1700 ? 2200 : width > 3200 ? 3200 : undefined;

  const clean = sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .grayscale()
    .normalize()
    .median(1)
    .sharpen()
    .png({ compressionLevel: 6 });

  const cleanBuffer = await clean.toBuffer();
  const variants = [{
    name: "normalized",
    buffer: cleanBuffer,
    steps: ["sharp-auto-rotate", resizeWidth ? `resize-width-${resizeWidth}` : "native-size", "grayscale", "normalize", "median-denoise", "sharpen", "png"],
  }];

  const thresholdBuffer = await sharp(cleanBuffer, { limitInputPixels: false })
    .linear(1.12, -8)
    .threshold(178)
    .png({ compressionLevel: 6 })
    .toBuffer();

  variants.push({
    name: "threshold",
    buffer: thresholdBuffer,
    steps: [...variants[0].steps, "linear-contrast", "threshold-178"],
  });

  return variants;
}

async function recognizePreparedImage(app: App, image: Buffer, psm: number) {
  const activeWorker = await withTimeout(getWorker(app), 45000, "OCR worker initialization took too long.");
  await activeWorker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const result: any = await withTimeout(activeWorker.recognize(image, {}, { text: true, blocks: true, words: true }), 120000, "OCR recognition took too long.");
  const words = Array.isArray(result.data.words)
    ? result.data.words.map((word: any) => ({
      text: String(word.text ?? "").trim(),
      confidence: Math.round(Number(word.confidence ?? word.conf ?? 0)),
      bbox: word.bbox,
    })).filter((word: WheatWord) => word.text)
    : [];
  return {
    text: normalizeText(result.data.text ?? ""),
    confidence: Math.round(Number(result.data.confidence ?? average(words.map((word: WheatWord) => word.confidence)) ?? 0)),
    words,
  };
}

async function getWorker(app: App) {
  if (!worker) {
    const { createWorker } = nodeRequire("tesseract.js");
    worker = await createWorker("fra+eng+ara", 1, {
      workerPath: resolveTesseractNodeWorkerPath(app),
      langPath: resolveTessdataPath(app),
      cachePath: path.join(resolveUserDataDir(app), "ocr-cache"),
      gzip: true,
      logger: () => undefined,
    });
  }

  return worker;
}

async function getSharp() {
  if (!sharpModule) {
    const module = await import("sharp");
    sharpModule = module.default ?? module;
  }
  return sharpModule;
}

/**
 * Maps the understanding layer's fields onto the shape the rest of Wheat reads.
 *
 * Payroll keeps its own label-based readers: a payslip has no totals column and
 * no counterparties, so the layout engine has nothing to add there yet.
 */
function extractStructuredData(
  text: string,
  type: string,
  pdfTables: string[][][],
  pages: WheatOcrPage[],
  understanding: ExtractionResult,
) {
  const fields: Record<string, FieldResult> = {};
  for (const [key, item] of Object.entries(understanding.fields)) {
    fields[key] = { value: item.value, confidence: item.confidence, raw: item.raw ?? undefined, source: item.source };
  }

  if (type === "PAYROLL") {
    fields.employee = findLabeledLine(text, ["salarie", "employee", "nom"], "employee");
    fields.gross = findAmount(text, ["salaire brut", "brut", "gross"], "gross");
    fields.cnss = findAmount(text, ["cnss"], "cnss");
    fields.amo = findAmount(text, ["amo"], "amo");
    fields.ir = findAmount(text, ["ir salarial", "impot sur le revenu", "ir"], "ir");
    fields.net = findAmount(text, ["net a payer", "net"], "net");
  }

  const tableRows = normalizeTables(pdfTables, text, pages);
  const bankTransactions = type === "BANK_STATEMENT" ? extractBankTransactions(text, tableRows) : [];
  return { fields, bankTransactions, tableRows };
}

/** The part of a detected party that is safe and useful to persist. */
function publicParty(party: DetectedParty | null) {
  if (!party) return null;
  return {
    role: party.role,
    name: party.name,
    nameConfidence: party.nameConfidence,
    nameSource: party.nameSource,
    ice: party.ice,
    taxId: party.taxId,
    rc: party.rc,
    tp: party.tp,
    cnss: party.cnss,
    address: party.address,
    email: party.email,
    website: party.website,
    phone: party.phone,
    isCurrentCompany: party.isCurrentCompany,
    reasons: party.reasons,
  };
}

function textLines(text: string) {
  return text.split(/\r?\n/).map((line) => cleanValue(line)).filter(Boolean);
}

function compactHeader(value: string) {
  return normalizeHeader(value).replace(/\s+/g, "");
}

function matchesAnyLabel(line: string, labels: string[]) {
  const normalized = normalizeHeader(line);
  const compact = compactHeader(line);
  return labels.some((label) => {
    const labelNormalized = normalizeHeader(label);
    const labelCompact = compactHeader(label);
    return normalized.startsWith(labelNormalized) || normalized.includes(` ${labelNormalized} `) || compact.includes(labelCompact);
  });
}

function valueAfterLabel(line: string) {
  const parts = line.split(/[:#=]/);
  if (parts.length < 2) return "";
  return cleanValue(parts.slice(1).join(":"));
}

function isBadCounterpartyCandidate(value: string) {
  const normalized = normalizeHeader(value);
  return !normalized
    || looksLikeAmount(value)
    || /^[0-9.,\s-]+$/.test(value)
    || /@/.test(value)
    || /\b(casablanca le|mandala|modele|model|id fiscal|id_fiscal|facture|bon de livraison|code article|designation|qte|montant|total|tva|ttc|ht|date|client|adresse|telephone|tel|email|web|www|ice|if|rc|rib|banque|bank|swift|patente|cnss)\b/.test(normalized)
    || /\b(rib|swift|iban|banque|bank)\b/.test(normalized);
}

function findAmountNearLabels(text: string, labels: string[], source: string): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matchesAnyLabel(line, labels)) continue;
    const normalizedLine = normalizeHeader(line);
    if (normalizedLine.includes("code article") || normalizedLine.includes("designation qte")) continue;
    const sameLine = extractAmounts(line).at(-1);
    if (sameLine !== undefined) return { value: sameLine, confidence: source === "ttc" ? 84 : 76, raw: line, source };
    const nextLine = extractAmounts(lines[index + 1] ?? "").at(-1);
    if (nextLine !== undefined) return { value: nextLine, confidence: 66, raw: `${line}\n${lines[index + 1]}`, source };
  }
  return emptyField();
}

function extractAmounts(value: string) {
  const amounts: number[] = [];
  const strictMatches = [...value.matchAll(/([0-9]{1,3}(?:\s+[0-9]{3})+(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2}))(?:\s*(MAD|DHS?|EUR|USD))?/gi)];
  const matches = strictMatches.length ? strictMatches : [...value.matchAll(/([0-9][0-9\s.,']{1,18})(?:\s*(MAD|DHS?|EUR|USD))?/gi)];
  for (const match of matches) {
    const after = value.slice((match.index ?? 0) + match[1].length, (match.index ?? 0) + match[1].length + 3);
    if (after.trimStart().startsWith("%")) continue;
    const parsed = parseAmount(match[1]);
    if (parsed !== null) amounts.push(parsed);
  }
  return amounts;
}

function findLabeledLine(text: string, labels: string[], source: string): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matchesAnyLabel(line, labels)) continue;
    const inline = valueAfterLabel(line);
    if (inline && !isBadCounterpartyCandidate(inline)) return { value: inline, confidence: 76, raw: line, source };
    if (normalizeHeader(line).includes("code client")) continue;

    for (let offset = 1; offset <= 4; offset += 1) {
      const next = cleanValue(lines[index + offset] ?? "");
      if (!next) continue;
      if (matchesAnyLabel(next, labels)) continue;
      if (isBadCounterpartyCandidate(next)) continue;
      return { value: next, confidence: 76, raw: `${line}\n${next}`, source };
    }
  }

  for (const label of labels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*[:#=\\-]?\\s*([^\\n\\r]{2,120})`, "i");
    const match = text.match(regex);
    if (match) return { value: cleanValue(match[1]), confidence: 68, raw: match[0], source };
  }
  return emptyField();
}

function findAmount(text: string, labels: string[], source: string): FieldResult {
  const normalizedText = normalizeAccountingAbbreviations(text);
  const amount = "([0-9][0-9\\s.,']{1,18})(?!\\s*%)";
  const priorityLabels = source === "ht"
    ? ["total ht", "montant ht"]
    : source === "tva"
      ? ["total tva", "montant tva"]
      : source === "ttc"
        ? ["total ttc", "net a payer", "montant ttc"]
        : [];
  if (priorityLabels.length) {
    const priorityMatch = findAmountNearLabels(normalizedText, priorityLabels, source);
    if (priorityMatch.value !== null) return priorityMatch;
  }
  const lineMatch = findAmountNearLabels(normalizedText, labels, source);
  if (lineMatch.value !== null) return lineMatch;
  for (const label of labels) {
    const after = new RegExp(`${escapeRegex(label)}\\s*(?:[0-9]{1,2}(?:[.,][0-9]+)?\\s*%)?\\s*[:=\\-]?\\s*${amount}\\s*(?:mad|dh|dhs|eur|usd)?`, "i");
    const before = new RegExp(`${amount}\\s*(?:mad|dh|dhs|eur|usd)?\\s*${escapeRegex(label)}`, "i");
    const match = normalizedText.match(after) ?? normalizedText.match(before);
    if (!match) continue;
    const parsed = parseAmount(match[1]);
    if (parsed !== null) return { value: parsed, confidence: source === "ttc" ? 84 : 76, raw: match[0], source };
  }
  return emptyField();
}

function extractBankTransactions(text: string, tableRows: string[][] = []) {
  const tableTransactions = extractBankTransactionsFromTable(tableRows);
  if (tableTransactions.length) return tableTransactions;

  const rows: BankTransaction[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+(.{4,90}?)\s+(-?[0-9][0-9\s.,']*)\s+(-?[0-9][0-9\s.,']*)?\s+(-?[0-9][0-9\s.,']*)?$/);
    if (!match) continue;
    const first = parseAmount(match[3]);
    const second = match[4] ? parseAmount(match[4]) : null;
    const third = match[5] ? parseAmount(match[5]) : null;
    rows.push({
      Date: normalizeDate(match[1]),
      Description: cleanValue(match[2]),
      Debit: second === null && first !== null && first < 0 ? Math.abs(first) : first,
      Credit: second,
      Balance: third,
    });
  }
  return rows.slice(0, 1000);
}

function extractBankTransactionsFromTable(tableRows: string[][]): BankTransaction[] {
  const headerIndex = tableRows.findIndex((row) => {
    const joined = normalizeHeader(row.join(" "));
    return joined.includes("date") && (joined.includes("debit") || joined.includes("credit")) && (joined.includes("solde") || joined.includes("balance") || joined.includes("description") || joined.includes("libelle"));
  });
  if (headerIndex < 0) return [];

  const header = tableRows[headerIndex].map(normalizeHeader);
  const contextYear = extractContextYear(tableRows.slice(0, headerIndex + 1));
  const findIndex = (patterns: RegExp[], fallback: number) => {
    const found = header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
    return found >= 0 ? found : fallback;
  };

  const dateIndex = findIndex([/date/], 0);
  const descriptionIndex = findIndex([/description/, /libelle/, /operation/, /details?/], 1);
  const debitIndex = findIndex([/debit/, /debit mad/, /sortie/], -1);
  const creditIndex = findIndex([/credit/, /credit mad/, /entree/], -1);
  const balanceIndex = findIndex([/solde/, /balance/], -1);

  return tableRows
    .slice(headerIndex + 1)
    .map((row) => {
      const date = row[dateIndex] ? normalizeBankDate(row[dateIndex], row.join(" "), contextYear) : "";
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const debit = debitIndex >= 0 ? parseAmount(row[debitIndex] ?? "") : null;
      const credit = creditIndex >= 0 ? parseAmount(row[creditIndex] ?? "") : null;
      const balance = balanceIndex >= 0 ? parseAmount(row[balanceIndex] ?? "") : null;
      return {
        Date: date,
        Description: cleanValue(row[descriptionIndex] ?? ""),
        Debit: debit,
        Credit: credit,
        Balance: balance,
      };
    })
    .filter((row): row is BankTransaction => Boolean(row && row.Description && (row.Debit !== null || row.Credit !== null || row.Balance !== null)))
    .slice(0, 1000);
}

function extractContextYear(rows: string[][]) {
  for (const row of rows) {
    const match = row.join(" ").match(/\b(20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return new Date().getFullYear();
}

function normalizeBankDate(value: string, rowText: string, fallbackYear: number) {
  const fullDate = rowText.match(/\b(\d{1,2})[ /.-](\d{1,2})[ /.-](20\d{2}|\d{2})\b/);
  if (fullDate && /[ /.-]/.test(value) && value.trim().split(/[ /.-]+/).length >= 3) return normalizeDate(fullDate[0]);
  const parts = value.trim().match(/^(\d{1,2})[ /.-](\d{1,2})(?:[ /.-](20\d{2}|\d{2}))?$/);
  if (parts) {
    const year = parts[3] ? (parts[3].length === 2 ? `20${parts[3]}` : parts[3]) : String(fallbackYear);
    return `${year}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  return normalizeDate(value);
}

function normalizeTables(pdfTables: string[][][], text: string, pages: WheatOcrPage[]) {
  const rows: string[][] = [];
  for (const table of pdfTables) {
    for (const row of table) rows.push(row.map((cell) => cleanValue(cell)));
  }
  const deductionRows = extractTaxDeductionRows(text);
  if (deductionRows.length) rows.push(...deductionRows);
  if (rows.length) return rows.slice(0, 1000);

  const lineRows = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(\s{2,}|\||;|\t)/.test(line))
    .map((line) => line.split(/\s{2,}|\||;|\t/).map((cell) => cleanValue(cell)).filter(Boolean))
    .filter((row) => row.length >= 3);
  if (lineRows.length) return lineRows.slice(0, 1000);

  const wordRows = rowsFromWordGeometry(pages);
  return wordRows.slice(0, 1000);
}

function extractTaxDeductionRows(text: string) {
  if (!/(fact_num|date_paie|date_fac|releve de deduction|relevededuction|article 112)/i.test(normalizeHeader(text))) return [];
  const rows: string[][] = [[
    "Ordre",
    "Facture",
    "Designation",
    "HT",
    "TVA",
    "TTC",
    "IF",
    "Fournisseur",
    "ICE",
    "Taux",
    "Paiement",
    "Date paiement",
    "Date facture",
  ]];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanValue(rawLine.replace(/[\u200e\u200f\u202a-\u202e]/g, " "));
    const withOrder = line.match(/^\D*(\d{1,4})\s+([A-Z0-9][A-Z0-9/-]{3,})\s+(.+?)\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9]{5,12})\s+(.+?)\s+([0-9]{10,18})\s+([0-9]{1,2}\.\d{2})\s+([0-9])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/i);
    const withoutOrder = line.match(/^\D*([A-Z0-9][A-Z0-9/-]{3,})\s+(.+?)\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9]{5,12})\s+(.+?)\s+([0-9]{10,18})\s+([0-9]{1,2}\.\d{2})\s+([0-9])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\D*(\d{1,4})?$/i);
    if (withOrder) {
      rows.push([
        withOrder[1],
        withOrder[2],
        cleanValue(withOrder[3]),
        String(parseAmount(withOrder[4]) ?? ""),
        String(parseAmount(withOrder[5]) ?? ""),
        String(parseAmount(withOrder[6]) ?? ""),
        withOrder[7],
        cleanValue(withOrder[8]),
        withOrder[9],
        withOrder[10],
        withOrder[11],
        normalizeDate(withOrder[12]),
        normalizeDate(withOrder[13]),
      ]);
    } else if (withoutOrder) {
      rows.push([
        withoutOrder[13] ?? "",
        withoutOrder[1],
        cleanValue(withoutOrder[2]),
        String(parseAmount(withoutOrder[3]) ?? ""),
        String(parseAmount(withoutOrder[4]) ?? ""),
        String(parseAmount(withoutOrder[5]) ?? ""),
        withoutOrder[6],
        cleanValue(withoutOrder[7]),
        withoutOrder[8],
        withoutOrder[9],
        withoutOrder[10],
        normalizeDate(withoutOrder[11]),
        normalizeDate(withoutOrder[12]),
      ]);
    }
  }

  return rows.length > 1 ? rows : [];
}

function rowsFromWordGeometry(pages: WheatOcrPage[]) {
  const rows: string[][] = [];
  for (const page of pages) {
    const words = page.words.filter((word) => word.bbox && word.confidence >= 35);
    const buckets = new Map<number, WheatWord[]>();
    for (const word of words) {
      const y = Math.round(((word.bbox!.y0 + word.bbox!.y1) / 2) / 14) * 14;
      buckets.set(y, [...(buckets.get(y) ?? []), word]);
    }
    for (const bucket of [...buckets.values()]) {
      const line = bucket.sort((a, b) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0)).map((word) => word.text).join(" ");
      if (!/\d/.test(line)) continue;
      const cells = line.split(/\s{2,}/).map((cell) => cleanValue(cell)).filter(Boolean);
      if (cells.length >= 3) rows.push(cells);
    }
  }
  return rows;
}

function buildLayoutSummary(text: string, pages: WheatOcrPage[], tableRows: string[][]) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const words = pages.reduce((sum, page) => sum + page.words.length, 0) || text.split(/\s+/).filter(Boolean).length;
  return {
    pages: pages.length || 1,
    lineCount: lines.length,
    wordCount: words,
    tableRowCount: tableRows.length,
    hasTables: tableRows.length > 0,
    readingOrder: "top-to-bottom",
  };
}

function decimalCents(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const source = String(value).trim().replace(/[\s']/g, "");
  const negative = /^-/.test(source) || /^\(.*\)$/.test(source);
  const unsigned = source.replace(/[()\-+]/g, "").replace(/[^0-9.,]/g, "");
  if (!unsigned) return null;
  const decimalSeparator = unsigned.includes(",") && unsigned.lastIndexOf(",") > unsigned.lastIndexOf(".") ? "," : ".";
  const parts = unsigned.split(decimalSeparator);
  const fractionCandidate = parts.length > 1 ? parts.at(-1)! : "";
  const hasDecimal = fractionCandidate.length > 0 && fractionCandidate.length <= 2;
  const whole = (hasDecimal ? parts.slice(0, -1).join("") : parts.join("")).replace(/\D/g, "") || "0";
  const fraction = (hasDecimal ? fractionCandidate : "").replace(/\D/g, "").padEnd(2, "0").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(fraction || "0");
  return (negative ? -cents : cents).toString();
}

function evidenceForField(field: FieldResult | undefined, pages: WheatOcrPage[]) {
  if (!field || field.value === null || field.value === "") return [];
  const targets = normalizeHeader(`${field.value} ${field.raw ?? ""}`).split(/\s+/).filter((item) => item.length >= 3);
  if (!targets.length) return [];
  for (const page of pages) {
    const matches = page.words.filter((word) => word.bbox && targets.some((target) => normalizeHeader(word.text).includes(target) || target.includes(normalizeHeader(word.text)))).slice(0, 12);
    if (!matches.length) continue;
    return [{
      page: page.page,
      text: matches.map((word) => word.text).join(" "),
      bbox: {
        x0: Math.min(...matches.map((word) => word.bbox!.x0)),
        y0: Math.min(...matches.map((word) => word.bbox!.y0)),
        x1: Math.max(...matches.map((word) => word.bbox!.x1)),
        y1: Math.max(...matches.map((word) => word.bbox!.y1)),
      },
    }];
  }
  return [];
}

function invoiceField(field: FieldResult | undefined, pages: WheatOcrPage[], transform?: (value: unknown) => unknown) {
  return {
    value: field?.value === null || field?.value === undefined || field.value === "" ? null : transform ? transform(field.value) : field.value,
    confidence: field?.confidence ?? 0,
    raw: field?.raw ?? null,
    source: field?.source ?? null,
    evidence: evidenceForField(field, pages),
  };
}

function invoiceLineItems(tableRows: string[][]) {
  const headerIndex = tableRows.findIndex((row) => {
    const joined = normalizeHeader(row.join(" "));
    return /(designation|description|article|produit|service)/.test(joined) && /(montant|total|prix|ht|ttc)/.test(joined);
  });
  if (headerIndex < 0) return [];
  const header = tableRows[headerIndex].map(normalizeHeader);
  const indexOf = (patterns: RegExp[]) => header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
  const descriptionIndex = indexOf([/designation/, /description/, /article/, /produit/, /service/]);
  const quantityIndex = indexOf([/qte/, /quantite/, /qty/]);
  const unitPriceIndex = indexOf([/prix unitaire/, /p\.?u/, /unit price/]);
  const vatIndex = indexOf([/tva/, /vat/, /tax/]);
  const totalIndex = indexOf([/total/, /montant/, /ttc/, /ht/]);
  return tableRows.slice(headerIndex + 1).map((row, index) => {
    const joined = normalizeHeader(row.join(" "));
    if (!row.some(Boolean) || /^(total|sous total|subtotal|net a payer)/.test(joined)) return null;
    const description = cleanValue(row[descriptionIndex] ?? "");
    if (!description) return null;
    const vatRaw = vatIndex >= 0 ? row[vatIndex] ?? "" : "";
    const vatRate = /([0-9]+(?:[.,][0-9]+)?)\s*%/.exec(vatRaw)?.[1];
    return {
      position: index + 1,
      description,
      quantity: quantityIndex >= 0 ? cleanValue(row[quantityIndex] ?? "") || null : null,
      unitPriceCents: unitPriceIndex >= 0 ? decimalCents(row[unitPriceIndex]) : null,
      vatRateBps: vatRate ? Math.round(Number(vatRate.replace(",", ".")) * 100) : null,
      lineTotalCents: totalIndex >= 0 ? decimalCents(row[totalIndex]) : null,
      confidence: Math.max(35, Math.min(88, 52 + Number(unitPriceIndex >= 0) * 8 + Number(totalIndex >= 0) * 12 + Number(vatIndex >= 0) * 6)),
      rawCells: row,
      evidence: { kind: "TABLE_ROW", row: headerIndex + index + 2, bbox: null },
    };
  }).filter(Boolean).slice(0, 500);
}

/** Stable, review-first invoice contract consumed by the posting workbench. */
export function buildInvoiceSchema(fields: Record<string, FieldResult>, tableRows: string[][], pages: WheatOcrPage[]) {
  const fieldValues = {
    supplierName: invoiceField(fields.supplier?.value ? fields.supplier : fields.counterparty, pages),
    supplierIce: invoiceField(fields.ice, pages),
    supplierTaxId: invoiceField(fields.if, pages),
    customerName: invoiceField(fields.client, pages),
    invoiceNumber: invoiceField(fields.invoiceNumber, pages),
    invoiceDate: invoiceField(fields.date, pages),
    dueDate: invoiceField(fields.dueDate, pages),
    currency: invoiceField(fields.currency, pages),
    paymentTerms: invoiceField(fields.paymentTerms, pages),
    htCents: invoiceField(fields.ht, pages, decimalCents),
    vatCents: invoiceField(fields.tva, pages, decimalCents),
    ttcCents: invoiceField(fields.ttc, pages, decimalCents),
  };
  const populated = Object.values(fieldValues).filter((field) => field.value !== null);
  const fieldConfidence = populated.length ? Math.round(populated.reduce((sum, field) => sum + field.confidence, 0) / populated.length) : 0;
  const lineItems = invoiceLineItems(tableRows);
  // The same accounting validator the extraction used, so the posting
  // workbench and the review screen never disagree about whether a document
  // adds up — including when it only adds up once disbursements are counted.
  const amount = (key: string) => typeof fields[key]?.value === "number" ? fields[key].value as number : undefined;
  const amountChecks = evaluateTotals({
    HT: amount("ht"), TVA: amount("tva"), TTC: amount("ttc"),
    DEBOURS: amount("debours"), DISCOUNT: amount("discount"),
  }, typeof fields.vatRate?.value === "number" ? fields.vatRate.value : null);
  const fieldsNeedingReview = amountChecks.failedFields
    .map((kind) => ({ HT: "ht", TVA: "tva", TTC: "ttc", DEBOURS: "debours", DISCOUNT: "discount", NET_PAID: "netPaid", STAMP: "stamp" }[kind] ?? ""))
    .filter(Boolean);
  return {
    schemaVersion: STORED_SCHEMA_VERSIONS.invoice.current,
    // Review is required when a key field is weakly read OR when the document
    // does not add up. Both are reasons a person has to look.
    reviewRequired: ["supplierName", "invoiceDate", "ttcCents"].some((key) => (fieldValues as Record<string, any>)[key].confidence < 72)
      || amountChecks.checks.some((check) => check.status === "FAILED"),
    accountingChecks: amountChecks.checks,
    fieldsNeedingReview,
    vatRateBps: typeof fields.vatRate?.value === "number" ? fields.vatRate.value : null,
    fields: fieldValues,
    lineItems,
    confidence: {
      fieldExtraction: fieldConfidence,
      lineItemReconstruction: lineItems.length ? Math.round(lineItems.reduce((sum, item: any) => sum + item.confidence, 0) / lineItems.length) : 0,
      accountingConsistency: amountChecks.checks.some((check) => check.status !== "SKIPPED")
        ? Math.round(amountChecks.score * 100)
        : null,
    },
    exactUnit: "CENTIME",
  };
}

/** Exact centime string back to document units, for arithmetic checks only. */
function centsToUnits(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return Number(value) / 100;
}

/** A field's value as a finite number, or null when it was not read. */
function numericValue(field: FieldResult | undefined): number | null {
  if (!field || field.value === null || field.value === "") return null;
  const parsed = typeof field.value === "number" ? field.value : Number(field.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredFieldsForType(type: string) {
  if (type === "INVOICE") return ["date", "counterparty", "ttc"];
  if (type === "BANK_STATEMENT") return ["date", "counterparty"];
  if (type === "PAYROLL") return ["employee", "gross", "net"];
  if (type === "TAX") return ["date", "reference"];
  return ["date", "counterparty"];
}

function calculateConfidence(ocrConfidence: number, classificationConfidence: number, fields: Record<string, FieldResult>, tableCount: number) {
  const knownFields = Object.values(fields).filter((fieldItem) => fieldItem.value !== null && fieldItem.value !== "");
  const fieldScore = knownFields.length ? average(knownFields.map((fieldItem) => fieldItem.confidence)) : 12;
  const tableBoost = Math.min(8, tableCount / 20);
  return Math.round(Math.max(1, Math.min(99, ocrConfidence * 0.42 + classificationConfidence * 0.25 + fieldScore * 0.30 + tableBoost)));
}

function buildFingerprint(type: string, fields: Record<string, FieldResult>) {
  const parts = [
    type,
    asText(fields.date?.value),
    asText(fields.invoiceNumber?.value || fields.reference?.value),
    asText(fields.counterparty?.value).toLowerCase(),
    asText(fields.ttc?.value),
  ].join("|");
  return crypto.createHash("sha1").update(parts).digest("hex");
}

function findExistingDuplicates(existingDocuments: ExistingDocument[], fingerprint: string) {
  if (!fingerprint) return [];
  return existingDocuments
    .filter((doc) => {
      const extracted = safeJson(doc.extracted);
      return extracted.duplicateFingerprint === fingerprint;
    })
    .map((doc) => doc.id);
}

function copyToSmartFolder(app: App, companyName: string, sourcePath: string, documentDate: Date, type: string, counterparty: string) {
  const year = String(documentDate.getFullYear());
  const month = `${String(documentDate.getMonth() + 1).padStart(2, "0")}-${monthNames[documentDate.getMonth()]}`;
  const targetDir = path.join(resolveUserDataDir(app), "documents", safeSegment(companyName), year, month, folderNames[type] ?? folderNames.UNKNOWN, safeSegment(counterparty || "Unknown"));
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, uniqueStoredName(sourcePath));
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function readDelimitedTable(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const delimiter = firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  return text.split(/\r?\n/)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

function spreadsheetCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const item = value as Record<string, any>;
    if (Array.isArray(item.richText)) return cleanValue(item.richText.map((part) => part.text ?? "").join(""));
    if (item.result !== undefined) return spreadsheetCellText(item.result);
    if (item.text !== undefined) return cleanValue(String(item.text));
    if (item.hyperlink !== undefined && item.text !== undefined) return cleanValue(String(item.text));
    if (item.formula !== undefined) return spreadsheetCellText(item.result ?? item.formula);
  }
  return cleanValue(String(value));
}

function mergePageText(pages: WheatOcrPage[]) {
  return pages.map((page) => page.text).filter(Boolean).join("\n\n");
}

function mergeCandidateText(candidates: WheatOcrPage[]) {
  const lines = new Map<string, string>();
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    for (const line of candidate.text.split(/\r?\n/)) {
      const clean = cleanValue(line);
      if (!clean) continue;
      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (key.length >= 3 && !lines.has(key)) lines.set(key, clean);
    }
  }
  return [...lines.values()].join("\n");
}

function bestCandidate(candidates: WheatOcrPage[]) {
  return [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a))[0] ?? {
    page: 1,
    text: "",
    confidence: 0,
    engine: "none",
    preprocessing: [],
    words: [],
  };
}

function candidateScore(candidate: WheatOcrPage) {
  return candidate.confidence + Math.min(20, candidate.text.length / 80) + (hasAccountingAnchors(candidate.text) ? 12 : 0);
}

function hasAccountingAnchors(text: string) {
  return /(facture|invoice|tva|ttc|ice|if|solde|debit|credit|cnss|amo|dgi)/i.test(text);
}

function wordsFromText(text: string): WheatWord[] {
  return text.split(/\s+/).filter(Boolean).map((word) => ({ text: word, confidence: 92 }));
}

function normalizeDate(value: string) {
  const parts = value.trim().replaceAll(".", "/").replaceAll("-", "/").replace(/\s+/g, "/").split("/").filter(Boolean);
  if (parts.length < 3) return "";
  if (parts[0]?.length === 4) return `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
}

function parseDateValue(value: string) {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseAmount(value: string) {
  const clean = value.replace(/\s/g, "").replace(/'/g, "");
  const normalized = clean.includes(",") && clean.lastIndexOf(",") > clean.lastIndexOf(".")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function looksLikeAmount(value: string) {
  return /^[0-9\s.,']+\s*(mad|dh|dhs|eur|usd)?$/i.test(value);
}

function emptyField(): FieldResult {
  return { value: null, confidence: 10 };
}

function mapFieldValues(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.value]));
}

function mapFieldConfidence(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.confidence]));
}

function mapFieldRaw(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.raw).map(([key, value]) => [key, value.raw]));
}

function mapFieldSources(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.source).map(([key, value]) => [key, value.source]));
}

/**
 * The folder and file name a managed document is stored under.
 *
 * It delegates to the archive's own portability rule rather than approximating
 * it. The approximation is what broke backups: it stripped accents but left a
 * trailing space after truncation, left Windows device names alone, and emitted
 * decomposed Unicode — all of which the backup's path contract rejects, and one
 * such file was enough to make an entire dossier impossible to back up.
 */
function safeSegment(value: string) {
  return portableArchiveSegment(value, "Unknown");
}

function normalizeText(text: string) {
  return normalizeAccountingAbbreviations(text)
    .replaceAll("\u0000", "")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAccountingAbbreviations(text: string) {
  return text
    .replace(/\bT\s*\.?\s*V\s*\.?\s*A\b/gi, "TVA")
    .replace(/\bT\s*\.?\s*T\s*\.?\s*C\b/gi, "TTC")
    .replace(/\bH\s*\.?\s*T\b/gi, "HT")
    .replace(/\bI\s*\.?\s*C\s*\.?\s*E\b/gi, "ICE")
    .replace(/\bI\s*\.?\s*F\b/gi, "IF");
}

function average(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function cleanValue(value: string) {
  return value.replace(/[|•]+/g, " ").replace(/\s+/g, " ").replace(/^[#:.\-\s]+|[#:.\-\s]+$/g, "").trim().slice(0, 160);
}

function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function resolveTessdataPath(app: App) {
  if (app.isPackaged) return path.join(process.resourcesPath, "tessdata");
  return path.join(process.cwd(), "resources", "tessdata");
}

function resolveTesseractNodeWorkerPath(app: App) {
  const relativeWorkerPath = path.join("node_modules", "tesseract.js", "src", "worker-script", "node", "index.js");
  if (app.isPackaged) return path.join(process.resourcesPath, "app.asar.unpacked", relativeWorkerPath);
  return path.join(process.cwd(), relativeWorkerPath);
}

function resolvePdfWorkerUrl(app: App) {
  const candidates = app.isPackaged
    ? [
      path.join(process.resourcesPath, "ocr", "pdf.worker.mjs"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(path.dirname(process.execPath), "resources", "ocr", "pdf.worker.mjs"),
    ]
    : [
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "pdf-parse", "esm", "pdf.worker.mjs"),
    ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ? pathToFileURL(found).toString() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHeader(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
