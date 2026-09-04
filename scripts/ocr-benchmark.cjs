/**
 * Repeatable OCR pipeline benchmark.
 *
 * `npm run ocr:bench` runs the real recognition pipeline over the sample
 * documents in `test documents for use/` and prints wall-clock timings plus the
 * fields that were actually read. It exists because "the OCR feels slow" is not
 * a measurement: the only way to tell an optimisation from a regression is to
 * compare the same documents, on the same machine, before and after — and to
 * compare what was *extracted* at the same time, so a speed-up that quietly
 * loses a total is visible immediately.
 *
 *   BENCH_LABEL=baseline  npm run ocr:bench
 *   BENCH_REPEAT=3        npm run ocr:bench     # 21 documents instead of 7
 *   BENCH_JSON=out.json   npm run ocr:bench
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? process.cwd();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ocr-bench-"));
process.env.WHEAT_USER_DATA_DIR = userData;

const app = { isPackaged: false, getPath: () => userData };
const smartOcr = tsxRequire(path.join(root, "electron", "smartOcr.ts"), path.join(root, "scripts", "ocr-benchmark.cjs"));

const docsDir = process.env.BENCH_DOCS ?? path.join(root, "test documents for use");
const label = process.env.BENCH_LABEL ?? "run";
const repeat = Math.max(1, Number(process.env.BENCH_REPEAT ?? 1));

function field(result, key) {
  const value = result.extracted?.fields?.[key];
  return value === undefined || value === null || value === "" ? null : value;
}

(async () => {
  if (!fs.existsSync(docsDir)) throw new Error(`Aucun dossier de documents à mesurer : ${docsDir}`);
  const files = fs.readdirSync(docsDir).map((name) => path.join(docsDir, name)).filter((file) => fs.statSync(file).isFile());
  const filePaths = [];
  for (let index = 0; index < repeat; index += 1) filePaths.push(...files);
  if (!filePaths.length) throw new Error("Aucun document à mesurer.");

  process.stderr.write(`[${label}] ${filePaths.length} document(s) depuis ${docsDir}\n`);

  // Warm-up is measured separately: in the application it happens at startup,
  // long before anybody imports anything, so charging it to the import would
  // measure a cost the user never actually waits for. `BENCH_WARM=0` folds it
  // back in, which is how the pre-optimisation baseline was taken.
  let warmupMs = 0;
  if (process.env.BENCH_WARM !== "0") {
    const paddle = tsxRequire(path.join(root, "electron", "paddleOcr.ts"), path.join(root, "scripts", "ocr-benchmark.cjs"));
    const warmStarted = Date.now();
    await paddle.warmPaddleOcr(app);
    warmupMs = Date.now() - warmStarted;
    process.stderr.write(`[${label}] préchauffage ${warmupMs} ms\n`);
  }

  const perDocument = [];
  const onProgress = (event) => {
    if (event.phase === "DOCUMENT_DONE") perDocument.push({ file: event.fileName, ms: event.elapsedMs });
  };

  const started = Date.now();
  const results = await smartOcr.processSmartOcrFiles(app, {
    companyId: "bench",
    companyName: "BENCH SARL",
    filePaths,
    existingDocuments: [],
    company: { name: "BENCH SARL", ice: "", taxId: "" },
    onProgress,
  });
  const totalMs = Date.now() - started;

  const report = {
    label,
    warmupMs,
    totalMs,
    perDocumentAverageMs: Math.round(totalMs / filePaths.length),
    documentCount: filePaths.length,
    concurrency: Number(process.env.WHEAT_OCR_CONCURRENCY ?? 0) || null,
    perDocument,
    extraction: results.map((result) => ({
      file: result.originalName,
      type: result.type,
      status: result.status,
      confidence: result.extracted?.confidence ?? null,
      ocrConfidence: result.extracted?.ocrConfidence ?? null,
      engine: result.extracted?.pages?.[0]?.engine ?? null,
      textLength: (result.ocrText || "").length,
      number: field(result, "invoiceNumber") ?? field(result, "number"),
      date: field(result, "date"),
      ht: field(result, "ht"),
      tva: field(result, "tva"),
      ttc: field(result, "ttc"),
      supplier: field(result, "supplier") ?? field(result, "counterparty"),
      uncertainFields: result.extracted?.uncertainFields ?? [],
    })),
  };

  const serialized = JSON.stringify(report, null, 2);
  if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, serialized, "utf8");
  process.stdout.write(`${serialized}\n`);

  await smartOcr.closeSmartOcrWorker();
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(1);
});
