/**
 * The reviewable reading of a document, and what is allowed to replace it.
 *
 * Recognition produces a proposal. A person reading the page and typing a
 * value produces a decision. The defect this suite exists for is that Wheat
 * could not tell the two apart: the extraction was one unversioned blob, and
 * re-running recognition rebuilt it from the page — destroying every manual
 * correction an accountant had made, silently, on a button labelled "relancer".
 *
 * So the rule pinned hardest here is precedence: a correction outranks any
 * later reading, and the only thing that replaces a corrected value is somebody
 * correcting it again.
 *
 * The second rule is about disposal. Several hundred placed words per page are
 * worth keeping while somebody decides and are dead weight afterwards, so the
 * payload is compacted when the reading becomes accounting data — without ever
 * dropping a canonical value, a check, a correction, or the source document.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const payload = tsxRequire(path.join(root, "electron", "documentReviewPayload.ts"), __filename);

const clock = (iso) => () => new Date(iso);

function recognised() {
  return {
    fields: { ttc: "1 250,00", ice: "001234567890123", invoiceNumber: "F-2026/0041" },
    fieldConfidence: { ttc: 74, ice: 88, invoiceNumber: 61 },
    fieldSources: { ttc: "ocr", ice: "ocr", invoiceNumber: "ocr" },
    accountingChecks: [{ code: "HT_TVA_TTC", status: "PASSED" }],
    aiReview: { applied: true, suppliedFields: ["ice"], disagreements: [], notes: [] },
    diagnostics: {
      totalsStrategy: "explicit",
      accountingScore: 91,
      recognizedElements: Array.from({ length: 800 }, (_, index) => ({ page: 1, text: `mot-${index}`, confidence: 90 })),
      candidates: Array.from({ length: 120 }, (_, index) => ({ field: "ttc", value: index })),
      totalsAlternatives: [{ ttc: "1 250,00" }],
      fieldEvidence: { ttc: ["TOTAL TTC 1 250,00"] },
    },
  };
}

test("a fresh reading is revision one, versioned, and tied to the bytes it came from", () => {
  const prepared = payload.prepareDocumentReview(recognised(), {
    documentType: "PURCHASE_INVOICE",
    sourceFingerprint: "a".repeat(64),
    now: clock("2026-09-04T10:00:00.000Z"),
  });
  const review = payload.readDocumentReview(prepared);
  expect(review.schemaVersion).toBe(payload.DOCUMENT_REVIEW_SCHEMA_VERSION);
  expect(review.status).toBe("PREPARED");
  expect(review.extractionRevision).toBe(1);
  expect(review.documentType).toBe("PURCHASE_INVOICE");
  expect(review.sourceFingerprint).toBe("a".repeat(64));
  expect(review.userCorrections).toEqual([]);
  expect(review.compacted).toBe(false);
  // The canonical values are untouched by being wrapped.
  expect(prepared.fields).toEqual(recognised().fields);
});

test("an extraction written before this module existed is readable, not a crash", () => {
  expect(payload.readDocumentReview({ fields: { ttc: "10,00" } })).toBeNull();
  expect(payload.readDocumentReview(null)).toBeNull();
  expect(payload.readDocumentReview("not an object")).toBeNull();
  // And it can be brought forward without inventing a history it never had.
  const adopted = payload.prepareDocumentReview({ fields: { ttc: "10,00" } }, { documentType: "OTHER" });
  expect(payload.readDocumentReview(adopted).extractionRevision).toBe(1);
  expect(payload.readDocumentReview(adopted).userCorrections).toEqual([]);
});

test("a correction is recorded as a decision, with what it replaced", () => {
  const prepared = payload.prepareDocumentReview(recognised(), { documentType: "PURCHASE_INVOICE" });
  const corrected = payload.recordUserCorrections(prepared, { ttc: "1 520,00" }, { now: clock("2026-09-04T11:00:00.000Z") });
  const review = payload.readDocumentReview(corrected);

  expect(review.status).toBe("REVIEWED");
  expect(review.userCorrections).toEqual([
    { field: "ttc", value: "1 520,00", replaced: "1 250,00", at: "2026-09-04T11:00:00.000Z" },
  ]);
  // The value is in place, at full confidence, and no longer attributed to OCR.
  expect(corrected.fields.ttc).toBe("1 520,00");
  expect(corrected.fieldConfidence.ttc).toBe(100);
  expect(corrected.fieldSources.ttc).toBe("manual");
  // Fields nobody touched keep the recogniser's own confidence.
  expect(corrected.fieldConfidence.ice).toBe(88);
});

/*
 * The defect, stated as a test. This is the one that used to lose work.
 */
test("re-running recognition carries every correction forward and re-applies it", () => {
  const first = payload.prepareDocumentReview(recognised(), { documentType: "PURCHASE_INVOICE" });
  const corrected = payload.recordUserCorrections(first, { ttc: "1 520,00", invoiceNumber: "F-2026/0041-BIS" });

  // A second pass over the same page. The recogniser reads it differently —
  // and worse — which is exactly when a correction matters most.
  const second = payload.prepareDocumentReview(
    { ...recognised(), fields: { ttc: "1 260,00", ice: "001234567890123", invoiceNumber: "F 2026 0041" } },
    { documentType: "PURCHASE_INVOICE", previous: corrected },
  );

  expect(second.fields.ttc).toBe("1 520,00");
  expect(second.fields.invoiceNumber).toBe("F-2026/0041-BIS");
  expect(second.fieldConfidence.ttc).toBe(100);
  // A field nobody corrected takes the new reading, which is the point of a rerun.
  expect(second.fields.ice).toBe("001234567890123");

  const review = payload.readDocumentReview(second);
  expect(review.extractionRevision).toBe(2);
  expect(review.userCorrections).toHaveLength(2);
});

test("the most recent correction to a field is the one that survives", () => {
  const prepared = payload.prepareDocumentReview(recognised(), { documentType: "PURCHASE_INVOICE" });
  const once = payload.recordUserCorrections(prepared, { ttc: "1 520,00" }, { now: clock("2026-09-04T11:00:00.000Z") });
  const twice = payload.recordUserCorrections(once, { ttc: "1 530,00" }, { now: clock("2026-09-04T12:00:00.000Z") });

  expect(twice.fields.ttc).toBe("1 530,00");
  const corrections = payload.readDocumentReview(twice).userCorrections;
  expect(corrections).toHaveLength(2);
  // Both are kept: the history of a value is part of the review.
  expect(corrections[0].value).toBe("1 520,00");
  expect(corrections[1].replaced).toBe("1 520,00");

  // Re-applying is idempotent, so reading the payload twice cannot drift.
  expect(payload.applyUserCorrections(twice).fields.ttc).toBe("1 530,00");
});

test("compaction drops the recogniser's working material and nothing else", () => {
  const prepared = payload.prepareDocumentReview(recognised(), { documentType: "PURCHASE_INVOICE" });
  const corrected = payload.recordUserCorrections(prepared, { ttc: "1 520,00" });
  const before = JSON.stringify(corrected).length;

  const settled = payload.settleDocumentReview(corrected, "CONFIRMED");

  // Gone: only useful while somebody was deciding.
  expect(settled.diagnostics.recognizedElements).toBeUndefined();
  expect(settled.diagnostics.candidates).toBeUndefined();
  expect(settled.diagnostics.totalsAlternatives).toBeUndefined();
  expect(settled.diagnostics.fieldEvidence).toBeUndefined();

  // Kept: everything anybody reads afterwards.
  expect(settled.fields.ttc).toBe("1 520,00");
  expect(settled.fieldConfidence.ttc).toBe(100);
  expect(settled.accountingChecks).toEqual([{ code: "HT_TVA_TTC", status: "PASSED" }]);
  expect(settled.aiReview.suppliedFields).toEqual(["ice"]);
  expect(settled.diagnostics.totalsStrategy).toBe("explicit");
  expect(settled.diagnostics.accountingScore).toBe(91);
  expect(payload.readDocumentReview(settled).userCorrections).toHaveLength(1);

  expect(payload.readDocumentReview(settled).status).toBe("CONFIRMED");
  expect(payload.readDocumentReview(settled).compacted).toBe(true);
  expect(JSON.stringify(settled).length, "compaction saved nothing").toBeLessThan(before / 2);
});

test("an abandoned reading keeps the fact and loses the bulk", () => {
  const prepared = payload.prepareDocumentReview(recognised(), { documentType: "PURCHASE_INVOICE" });
  const discarded = payload.settleDocumentReview(prepared, "DISCARDED");
  expect(payload.readDocumentReview(discarded).status).toBe("DISCARDED");
  expect(discarded.diagnostics.recognizedElements).toBeUndefined();
  // The reading itself is still there; discarding a review is not deleting data.
  expect(discarded.fields.ttc).toBe("1 250,00");
});

/*
 * The wiring, read from the source: a lifecycle nothing calls is not a
 * lifecycle. Each of the three transitions has exactly one owner.
 */
test("the lifecycle is actually driven by the main process", () => {
  const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");

  // Recognition prepares, on first import and on a rerun.
  expect(main).toMatch(/extracted: JSON\.stringify\(prepareDocumentReview\(/);
  expect(main).toContain("const rerunExtracted = prepareDocumentReview(");
  // The rerun is given the previous extraction, which is what carries
  // corrections across. Passing nothing here is the original defect.
  expect(main).toContain("previous: previousExtracted");

  // A manual correction is recorded rather than merely written into `fields`.
  expect(main).toContain("recordUserCorrections(previous, correctedFields)");

  // And becoming an invoice draft settles and compacts it.
  expect(main).toMatch(/settleDocumentReview\(JSON\.parse\(current\?\.extracted \|\| "\{\}"\), "CONFIRMED"\)/);
});

test("the source document is never deleted by any of this", () => {
  const module = fs.readFileSync(path.join(root, "electron", "documentReviewPayload.ts"), "utf8");
  // Derived state only: nothing here touches disk, the attachment, or a row.
  expect(module).not.toMatch(/unlink|rm\(|rmSync|deleteMany|prisma|storedPath/);
});
