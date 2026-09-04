const { test, expect } = require("@playwright/test");
const { require: tsxRequire } = require("tsx/cjs/api");
const { jsPDF } = require("jspdf");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const paddle = tsxRequire(path.join(cwd, "electron", "paddleOcr.ts"), __filename);
const smartOcr = tsxRequire(path.join(cwd, "electron", "smartOcr.ts"), __filename);
const importer = tsxRequire(path.join(cwd, "electron", "bankStatementImporter.ts"), __filename);
const reconciliation = tsxRequire(path.join(cwd, "electron", "reconciliation.ts"), __filename);
const mockWorker = path.join(cwd, "tests", "fixtures", "paddleocr-mock-worker.cjs");

let tempDir;
let priorPython;
let priorWorker;

test.beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-paddle-test-"));
  priorPython = process.env.WHEAT_PADDLEOCR_PYTHON;
  priorWorker = process.env.WHEAT_PADDLEOCR_WORKER;
  process.env.WHEAT_PADDLEOCR_PYTHON = process.execPath;
  process.env.WHEAT_PADDLEOCR_WORKER = mockWorker;
  await paddle.closePaddleOcrWorker();
});

test.afterEach(async () => {
  await paddle.closePaddleOcrWorker();
  if (priorPython === undefined) delete process.env.WHEAT_PADDLEOCR_PYTHON;
  else process.env.WHEAT_PADDLEOCR_PYTHON = priorPython;
  if (priorWorker === undefined) delete process.env.WHEAT_PADDLEOCR_WORKER;
  else process.env.WHEAT_PADDLEOCR_WORKER = priorWorker;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fakeApp() {
  return { isPackaged: false, getPath: () => tempDir };
}

test("local sidecar reports health and cleans temporary OCR buffers", async () => {
  const status = await paddle.getPaddleOcrStatus(fakeApp(), true);
  expect(status).toMatchObject({ available: true, local: true, version: "3.7.0-test", language: "fr", device: "cpu" });
  const result = await paddle.recognizeWithPaddle(fakeApp(), Buffer.from("private-image-bytes"), { mode: "ocr", extension: ".png" });
  expect(result).toMatchObject({ confidence: 94, engine: "PaddleOCR PP-OCR", engineVersion: "3.7.0-test" });
  expect(result.words[0]).toMatchObject({ text: "Date", confidence: 98 });
  const temporaryDirectory = path.join(tempDir, "ocr-temp");
  expect(fs.existsSync(temporaryDirectory) ? fs.readdirSync(temporaryDirectory) : []).toEqual([]);
});

test("document OCR returns PaddleOCR directly as the primary engine", async () => {
  const sharp = require("sharp");
  const imagePath = path.join(tempDir, "document.png");
  await sharp({
    create: { width: 240, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toFile(imagePath);

  const results = await smartOcr.processSmartOcrFiles(fakeApp(), {
    companyId: "company-paddle",
    companyName: "Paddle Test",
    filePaths: [imagePath],
    existingDocuments: [],
  });

  expect(results).toHaveLength(1);
  expect(results[0].extracted.engineVersion).toBe("2.1.0");
  expect(results[0].extracted.pages[0].engine).toContain("PaddleOCR PP-OCR");
  expect(results[0].extracted.pages[0].candidates).toEqual([
    { engine: "PaddleOCR PP-OCR:3.7.0-test", confidence: 94 },
  ]);
  expect(results[0].extracted.preprocessing).toContain("paddleocr-local-primary");
});

test("scanned bank PDF uses PP-StructureV3 rows without bypassing normalization", async () => {
  const pdf = new jsPDF();
  pdf.setFillColor(20, 20, 20);
  pdf.rect(10, 10, 180, 250, "F");
  const bytes = Buffer.from(pdf.output("arraybuffer"));
  const parsed = await importer.parseBankStatement({ sourceName: "releve-scan.pdf", bytesBase64: bytes.toString("base64"), app: fakeApp() });
  expect(parsed).toMatchObject({
    format: "PDF_OCR",
    formatLabel: "PDF scanné — PaddleOCR local",
    parser: "PaddleOcrBankTableParser",
    rowCount: 3,
    ocr: { local: true, confidence: 94, pageCount: 1 },
  });
  expect(parsed.suggestedMapping).toMatchObject({
    date: "DATE",
    valueDate: "Date valeur",
    label: "LIBELLE",
    reference: "Référence / code",
    debit: "Débit",
    credit: "Crédit",
  });
  const normalized = reconciliation.normalizeStatementRows({
    bankAccountId: "bank-paddle",
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
  }).map((row) => ({ date: row.date.toISOString().slice(0, 10), amountCents: row.amountCents.toString() }));
  expect(normalized).toEqual([
    { date: "2026-08-01", amountCents: "-123456" },
    { date: "2026-08-02", amountCents: "250000" },
    { date: "2026-08-03", amountCents: "-1525" },
  ]);
  expect(parsed.warnings.join(" ")).toContain("vérifiez chaque cellule");
});
