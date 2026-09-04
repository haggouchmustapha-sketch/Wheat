/**
 * Field-level accuracy of the whole document pipeline, on the real batch.
 *
 * `npm run ocr:accuracy` runs recognition over `test documents for use/`, plans
 * the invoice each document would become, and compares every field against the
 * ground truth recorded in `tests/fixtures/real-batch-truth.json` — which was
 * read off the paper, not copied from a Wheat run.
 *
 * The measurement it makes is deliberately strict, because the loose version of
 * it is what let a pipeline look healthy while an accountant retyped invoices:
 *
 *   a field counts as correct only if the value reaches the *final Wheat field*.
 *
 * Not if the string appears somewhere in the OCR text. Not if it is present in
 * the extraction but dropped by the planner. If the recogniser reads the number
 * and `invoiceNo` is empty, that is a failure and it is scored as one, whichever
 * layer lost it. `layer` in the per-field output says which one did, so the
 * report names a place to go and not just a number.
 *
 * Every field lands in exactly one bucket:
 *
 *   correct    the final Wheat value equals the truth
 *   incorrect  a value reached the field, and it is the wrong one
 *   missing    the document states it and no value reached the field
 *   review     Wheat produced it but flagged it for a person
 *   absent     the document does not state it — scored against neither side
 *
 * `ACCURACY_BASELINE=1` measures the pipeline as it behaved before the dossier's
 * own counterparties were consulted for the direction and before an unattributed
 * document could be prepared for confirmation instead of refused. It exists so
 * the before/after in any report is a number anyone can reproduce on this
 * machine rather than a claim, and so a later change that quietly undoes either
 * of those has something to fail against.
 *
 *   BENCH_LABEL=after npm run ocr:accuracy
 *   ACCURACY_JSON=after.json npm run ocr:accuracy
 *   ACCURACY_DUMP=.dump.json npm run ocr:accuracy   # reuse a recognition dump
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? process.cwd();
const here = path.join(root, "scripts", "ocr-accuracy.cjs");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ocr-accuracy-"));
process.env.WHEAT_USER_DATA_DIR = userData;

const draft = tsxRequire(path.join(root, "electron", "documentInvoiceDraft.ts"), here);
const truth = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "real-batch-truth.json"), "utf8"));
const label = process.env.BENCH_LABEL ?? "run";
const baseline = process.env.ACCURACY_BASELINE === "1";
const docsDir = process.env.BENCH_DOCS ?? path.join(root, "test documents for use");

/** Amounts compare at the centime; nothing here is allowed a tolerance. */
const sameAmount = (left, right) => Math.round(Number(left) * 100) === Math.round(Number(right) * 100);
const sameText = (left, right) =>
  String(left ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "") ===
  String(right ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * One field's verdict.
 *
 * `layer` is the honest part: a value that the recogniser read and the planner
 * dropped is scored exactly like one the recogniser never read, but the report
 * says which happened, so the fix goes to the layer that actually lost it.
 */
function score({ expected, actual, uncertain, compare, layer }) {
  if (expected === null || expected === undefined) {
    return { bucket: actual === null || actual === undefined || actual === "" ? "absent" : "incorrect", actual, layer };
  }
  if (actual === null || actual === undefined || actual === "") return { bucket: "missing", actual, layer };
  if (!compare(actual, expected)) return { bucket: "incorrect", actual, layer };
  return { bucket: uncertain ? "review" : "correct", actual, layer };
}

(async () => {
  let recognised;
  if (process.env.ACCURACY_DUMP && fs.existsSync(process.env.ACCURACY_DUMP)) {
    recognised = JSON.parse(fs.readFileSync(process.env.ACCURACY_DUMP, "utf8"));
    process.stderr.write(`[${label}] lecture réutilisée depuis ${process.env.ACCURACY_DUMP}\n`);
  } else {
    const smartOcr = tsxRequire(path.join(root, "electron", "smartOcr.ts"), here);
    const paddle = tsxRequire(path.join(root, "electron", "paddleOcr.ts"), here);
    const app = { isPackaged: false, getPath: () => userData };
    const warmStarted = Date.now();
    await paddle.warmPaddleOcr(app).catch(() => undefined);
    process.stderr.write(`[${label}] préchauffage ${Date.now() - warmStarted} ms\n`);
    const files = fs.readdirSync(docsDir).map((name) => path.join(docsDir, name)).filter((file) => fs.statSync(file).isFile());
    const started = Date.now();
    const results = await smartOcr.processSmartOcrFiles(app, {
      companyId: "accuracy",
      companyName: truth.dossier.name,
      filePaths: files,
      existingDocuments: [],
      company: { name: truth.dossier.name, ice: truth.dossier.ice ?? "", taxId: truth.dossier.taxId ?? "" },
    });
    process.stderr.write(`[${label}] reconnaissance ${Date.now() - started} ms\n`);
    recognised = results.map((result) => ({ file: result.originalName, extracted: result.extracted, ocrText: result.ocrText }));
    await smartOcr.closeSmartOcrWorker();
  }

  const byFile = new Map(recognised.map((item) => [item.file, item]));
  // The roster grows as the batch is processed, exactly as it does in guided
  // work: a supplier confirmed on one invoice is known evidence for the next.
  const roster = [];
  const report = { label, baseline, documents: [], totals: { correct: 0, incorrect: 0, missing: 0, review: 0, absent: 0 } };

  for (const expected of truth.documents) {
    const found = byFile.get(expected.file);
    const row = { file: expected.file, fields: {}, blocked: null };
    if (!found) {
      row.blocked = "Document non reconnu.";
      report.documents.push(row);
      continue;
    }
    const extraction = found.extracted ?? {};
    const fields = extraction.fields ?? {};
    const uncertain = new Set((extraction.uncertainFields ?? []).map(String));
    const parties = extraction.parties ?? {};

    // Fields the extraction owns outright: no plan is involved in reading an
    // ICE, so a wrong one here is an extraction fault and is labelled as such.
    const check = (name, expectedValue, actualValue, compare, layer) => {
      row.fields[name] = score({ expected: expectedValue, actual: actualValue, uncertain: uncertain.has(name), compare, layer });
    };
    check("documentType", expected.documentType, extraction.documentType, sameText, "classification");
    check("issuer", expected.issuer, parties.issuer?.name ?? null, sameText, "extraction");
    check("recipient", expected.recipient, parties.recipient?.name ?? null, sameText, "extraction");
    check("ice", expected.ice, parties.issuer?.ice ?? fields.ice ?? null, sameText, "extraction");
    check("if", expected.if, parties.issuer?.taxId ?? fields.if ?? null, sameText, "extraction");
    check("rc", expected.rc, parties.issuer?.rc ?? fields.supplierRc ?? null, sameText, "extraction");

    if (expected.documentType !== "INVOICE") {
      // A bank statement has no invoice fields; scoring it against them would
      // pad the metric with easy absences.
      report.documents.push(row);
      for (const verdict of Object.values(row.fields)) report.totals[verdict.bucket] += 1;
      continue;
    }

    // Everything below is measured on the plan, because the plan is what a
    // draft is actually built from. A value present in `fields` and absent from
    // the plan has been lost, and is scored as lost.
    let plan = null;
    let planError = null;
    try {
      plan = draft.planInvoiceDraftFromDocument({
        extracted: extraction,
        documentTitle: expected.file,
        company: truth.dossier,
        paymentTermsDays: null,
        forcedKind: null,
        knownCounterparties: baseline ? [] : roster,
        allowProvisionalDirection: !baseline,
      });
    } catch (error) {
      planError = error;
      row.blocked = `[${error.code ?? error.name}] ${error.message}`;
      row.suggestion = error.suggestion ? error.suggestion.fields : null;
    }

    const provisional = plan?.directionProvisional === true;
    const planned = (key) => (plan === null ? null : key);
    check("direction", expected.direction, plan === null ? null : provisional ? null : plan.kind, sameText, plan ? "plan" : "plan/blocked");
    check("invoiceNumber", expected.invoiceNumber, plan?.invoiceNo ?? null, sameText, plan ? "plan" : "plan/blocked");
    check("date", expected.date, plan?.invoiceDate ?? null, sameText, plan ? "plan" : "plan/blocked");
    check("dueDate", expected.dueDate, plan?.dueDate ?? null, sameText, plan ? "plan" : "plan/blocked");
    check("currency", expected.currency, plan?.currency ?? null, sameText, plan ? "plan" : "plan/blocked");
    check("vatRate", expected.vatRate, plan?.vatRateBps ?? null, (a, b) => Number(a) === Number(b), plan ? "plan" : "plan/blocked");

    const cents = (value) => (value === null || value === undefined ? null : Number(value) / 100);
    // The plan's own HT carries the disbursement lines, so the taxable base is
    // the plan's HT less its disbursements — which is what the paper calls HT.
    const planHt = plan === null ? null : cents(BigInt(plan.htCents) - BigInt(plan.deboursCents));
    check("ht", expected.ht, planHt, sameAmount, plan ? "plan" : "plan/blocked");
    check("tva", expected.tva, plan === null ? null : cents(plan.vatCents), sameAmount, plan ? "plan" : "plan/blocked");
    check("ttc", expected.ttc, plan === null ? null : cents(BigInt(plan.htCents) + BigInt(plan.vatCents)), sameAmount, plan ? "plan" : "plan/blocked");
    check("debours", expected.debours, plan === null ? null : (BigInt(plan.deboursCents) > 0n ? cents(plan.deboursCents) : null), sameAmount, plan ? "plan" : "plan/blocked");

    if (plan && !provisional && plan.counterparty) {
      roster.push({
        kind: plan.counterparty.kind,
        displayName: plan.counterparty.displayName,
        ice: plan.counterparty.ice,
        taxId: plan.counterparty.taxId,
        rc: plan.counterparty.rc,
      });
    }
    row.status = plan === null ? "BLOCKED" : provisional ? "REVIEW (sens à confirmer)" : "PREPARED";
    void planned;
    void planError;
    report.documents.push(row);
    for (const verdict of Object.values(row.fields)) report.totals[verdict.bucket] += 1;
  }

  const pad = (value, width) => String(value).padEnd(width);
  process.stdout.write(`\n=== Exactitude des champs Wheat — ${label}${baseline ? " (comportement anterieur)" : ""} ===\n`);
  for (const document of report.documents) {
    process.stdout.write(`\n${document.file}  [${document.status ?? "—"}]\n`);
    if (document.blocked) process.stdout.write(`  BLOQUÉ : ${document.blocked}\n`);
    if (document.suggestion) process.stdout.write(`  CORRECTION PROPOSÉE : ${JSON.stringify(document.suggestion)}\n`);
    for (const [name, verdict] of Object.entries(document.fields)) {
      if (verdict.bucket === "absent") continue;
      const mark = { correct: "OK  ", incorrect: "FAUX", missing: "VIDE", review: "REVU" }[verdict.bucket];
      process.stdout.write(`  ${mark} ${pad(name, 15)} ${pad(JSON.stringify(verdict.actual), 34)} ${verdict.bucket === "correct" ? "" : `(couche : ${verdict.layer})`}\n`);
    }
  }
  const { correct, incorrect, missing, review, absent } = report.totals;
  const scored = correct + incorrect + missing + review;
  process.stdout.write(`\nTOTAL  correct ${correct} · incorrect ${incorrect} · manquant ${missing} · à relire ${review} · non applicable ${absent}\n`);
  process.stdout.write(`Champs renseignés correctement : ${scored ? Math.round((correct / scored) * 100) : 0} % de ${scored} champs mesurés.\n`);

  if (process.env.ACCURACY_JSON) fs.writeFileSync(process.env.ACCURACY_JSON, JSON.stringify(report, null, 2), "utf8");
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(1);
});
