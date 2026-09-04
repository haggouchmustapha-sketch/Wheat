const readline = require("node:readline");

const rows = [
  ["CODE", "DATE", "LIBELLE", "VALEUR", "DEBIT ... CREDIT", ""],
  ["REF-001", "2026-08-01", "Fournisseur Atlas", "2026-08-01", "1234.56", ""],
  ["REF-002", "2026-08-02", "Client Maroc", "2026-08-02", "", "2500.00"],
  ["REF-003", "2026-08-03", "Frais Banque", "2026-08-03", "15.25", ""],
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.action === "health") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: true,
      available: true,
      version: "3.7.0-test",
      pythonVersion: process.version,
      language: "fr",
      device: "cpu",
      reason: null,
    })}\n`);
    return;
  }
  if (request.action === "recognize") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: true,
      text: rows.flat().join(" "),
      confidence: 94,
      words: [{ text: "Date", confidence: 98, bbox: { x0: 1, y0: 2, x1: 30, y1: 12 } }],
      tables: request.mode === "structure" ? [rows] : [],
      engine: request.mode === "structure" ? "PaddleOCR PP-StructureV3" : "PaddleOCR PP-OCR",
      engineVersion: "3.7.0-test",
      language: "fr",
      pageCount: 1,
      warnings: [],
    })}\n`);
    return;
  }
  if (request.action === "shutdown") {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, stopped: true })}\n`);
    process.exit(0);
  }
});
