const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Reading a scanned bank statement with the provider the user authorised.
 *
 * The fault this pins: Wheat Lightweight does not package PaddleOCR, and the
 * bank importer called PaddleOCR for every scanned statement regardless. The
 * import stopped with "PaddleOCR local est requis pour ce relevé scanné", which
 * named a component that edition deliberately does not ship, and the assisted
 * AI pass never ran because it could only fill gaps in a table PaddleOCR had
 * already produced.
 *
 * Nothing here touches a network or a Python runtime: the provider is a literal
 * object returning a chosen reply, so every case is a decision Wheat makes
 * about a reply somebody could actually receive.
 *
 * What the suite is really defending is one sentence: **a model transcribes,
 * Wheat decides, and a person confirms.** Every ambiguity that could turn a
 * transcription into a wrong ledger is refused here rather than resolved.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let importer;
let extraction;
let cloud;

test.beforeAll(() => {
  importer = tsxRequire(path.join(root, "electron", "bankStatementImporter.ts"), __filename);
  extraction = tsxRequire(path.join(root, "electron", "bankStatementCloudExtraction.ts"), __filename);
  cloud = tsxRequire(path.join(root, "electron", "cloudOcr.ts"), __filename);
});

/** A Lightweight machine: packaged, and no PaddleOCR anywhere it would look. */
function lightweightApp() {
  const empty = path.join(os.tmpdir(), "wheat-bank-cloud-spec-resources");
  fs.mkdirSync(empty, { recursive: true });
  Object.defineProperty(process, "resourcesPath", { value: empty, configurable: true, writable: true });
  return {
    isPackaged: true,
    getPath: () => os.tmpdir(),
  };
}

function runtime(replies, { connected = true } = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls = [];
  return {
    calls,
    isConnected: () => connected,
    runVision: async (request) => {
      calls.push(request);
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      if (reply instanceof Error) throw reply;
      return {
        text: typeof reply === "string" ? reply : JSON.stringify(reply),
        provider: "OpenRouter",
        modelId: "some/vision-model:free",
      };
    },
  };
}

function plan(runtimeObject, { local = false, consentGiven = true } = {}) {
  return cloud.resolveRecognitionPlan({
    hasBundledLocalOcr: local,
    cloud: runtimeObject ? { runtime: runtimeObject, enabled: true, consentGiven } : null,
  });
}

/**
 * A page of a Moroccan statement as a provider would transcribe it: two money
 * columns, a repeated header, an opening and a closing balance.
 */
const MOROCCAN_PAGE = {
  currency: "MAD",
  confidence: 86,
  rows: [
    { line: 1, kind: "HEADER", label: "DATE LIBELLE CAPITAUX DEBIT CREDIT SOLDE" },
    { line: 2, kind: "OPENING_BALANCE", label: "SOLDE INITIAL AU 01 06 2026", balance: "12 500,00" },
    { line: 3, kind: "TRANSACTION", date: "25 06", valueDate: "25 06 2026", label: "VIREMENT RECU CHANI", reference: "VIR0091", debit: "", credit: "18 334,42" },
    { line: 4, kind: "TRANSACTION", date: "26 06", valueDate: "26 06 2026", label: "CHEQUE 4410021", reference: "4410021", debit: "3 200,00", credit: "" },
    { line: 5, kind: "SUBTOTAL", label: "TOTAL DES MOUVEMENTS", debit: "3 200,00", credit: "18 334,42" },
    { line: 6, kind: "CLOSING_BALANCE", label: "SOLDE FINAL AU 30 06 2026", balance: "27 634,42" },
    { line: 7, kind: "HEADER", label: "SA au capital de 1 000 000 DH - RC 12345 - ICE 001234567000089" },
  ],
};

const IMAGE_PAGE = [{ page: 1, mimeType: "image/jpeg", base64: "aGVsbG8=" }];

/* ------------------------------------------------ the fault, and the fix */

test("a Lightweight build no longer demands PaddleOCR for a scanned statement", async () => {
  const app = lightweightApp();
  const provider = runtime(MOROCCAN_PAGE);
  const parsed = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64"),
    app,
    recognition: plan(provider),
  });

  expect(parsed.format).toBe("IMAGE_OCR");
  expect(parsed.parser).toBe("WheatCloudBankTableParser");
  expect(parsed.ocr.local).toBe(false);
  // The screen says which engine read it, not a fixed one: the same format now
  // covers a page read here and a page read by the authorised provider.
  expect(parsed.formatLabel).toBe("Image de relevé — Wheat Cloud AI");
  expect(parsed.ocr.cloud.provider).toBe("OpenRouter");
  // The provider was shown the page itself, not a transcription of it.
  expect(provider.calls[0].images).toHaveLength(1);
  expect(provider.calls[0].images[0].mimeType).toBe("image/jpeg");
  expect(provider.calls[0].images[0].base64.length).toBeGreaterThan(100);
});

test("the two movements arrive, and the balances and totals do not", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime(MOROCCAN_PAGE),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });

  expect(result.rows).toHaveLength(2);
  expect(result.blockingIssues).toEqual([]);
  expect(result.rows[0]["Crédit"]).toBe("18 334,42");
  expect(result.rows[0]["Débit"]).toBe("");
  expect(result.rows[1]["Débit"]).toBe("3 200,00");
  expect(result.currency).toBe("MAD");
  // A balance, a total and a registration footer are not movements.
  expect(result.rows.some((row) => /SOLDE|TOTAL|capital/i.test(row["Libellé"]))).toBe(false);
  // They are not dropped in silence either.
  expect(result.warnings.join(" ")).toContain("solde initial");
  expect(result.warnings.join(" ")).toContain("total");
});

test("balances read off a page are offered, never fed to the balance check", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime(MOROCCAN_PAGE),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.readBalances).toEqual([
    { kind: "OPENING_BALANCE", page: 1, label: "SOLDE INITIAL AU 01 06 2026", amount: "12 500,00" },
    { kind: "CLOSING_BALANCE", page: 1, label: "SOLDE FINAL AU 30 06 2026", amount: "27 634,42" },
  ]);

  // The statement-level equation is only ever run against balances a *format*
  // declares. A number read off a photograph is evidence for a person, not a
  // declaration Wheat may check itself and refuse an import over.
  const parsed = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64"),
    app: lightweightApp(),
    recognition: plan(runtime(MOROCCAN_PAGE)),
  });
  expect(parsed.declaredBalances).toBeUndefined();
});

test("the produced table maps itself, and money is carried exactly as printed", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime(MOROCCAN_PAGE),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  const mapping = importer.suggestStatementMapping(result.headers);
  expect(mapping.date).toBe("Date");
  expect(mapping.valueDate).toBe("Date valeur");
  expect(mapping.label).toBe("Libellé");
  expect(mapping.debit).toBe("Débit");
  expect(mapping.credit).toBe("Crédit");
  // "Solde" is never taken for a movement amount.
  expect(mapping.amount).toBeUndefined();

  // The characters the bank printed, not a number somebody re-rendered.
  expect(result.rows[0]["Crédit"]).toBe("18 334,42");
  for (const row of result.rows) {
    for (const value of Object.values(row)) expect(typeof value).toBe("string");
  }
});

/* -------------------------------------------- what Wheat refuses to decide */

test("a row carrying both a debit and a credit blocks confirmation", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({
      currency: "MAD",
      rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "AMBIGU", debit: "1 000,00", credit: "1 000,00" }],
    }),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.blockingIssues.join(" ")).toContain("débit et un crédit");
  // Kept, not discarded: an import must never look complete without it.
  expect(result.rows).toHaveLength(1);
});

test("a movement with no readable amount on either side blocks confirmation", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({ rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "ILLISIBLE", uncertain: ["debit", "credit"] }] }),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.blockingIssues.join(" ")).toContain("aucun montant lisible");
  expect(result.rows).toHaveLength(1);
});

test("a line whose nature could not be established is reported, not guessed", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({ rows: [{ line: 4, kind: "PEUT-ETRE", date: "25 06", label: "?", credit: "900,00" }] }),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.evidence[0].kind).toBe("UNCERTAIN");
  expect(result.blockingIssues.join(" ")).toContain("n'a pas pu établir");
});

test("a value that is not a number is refused as money, and the refusal is named", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({ rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "VIREMENT", credit: "environ mille" }] }),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.rows[0]["Crédit"]).toBe("");
  expect(result.evidence[0].corrections.join(" ")).toContain("environ mille");
  expect(result.blockingIssues.join(" ")).toContain("aucun montant lisible");
});

test("a movement with no date blocks confirmation", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({ rows: [{ line: 1, kind: "TRANSACTION", label: "VIREMENT", credit: "900,00" }] }),
    pages: IMAGE_PAGE,
    consentGiven: true,
  });
  expect(result.blockingIssues.join(" ")).toContain("aucune date");
});

test("a statement read in two currencies is not silently reduced to one", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime([
      { currency: "MAD", rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "A", credit: "10,00" }] },
      { currency: "EUR", rows: [{ line: 1, kind: "TRANSACTION", date: "26 06", label: "B", credit: "20,00" }] },
    ]),
    pages: [
      { page: 1, mimeType: "image/jpeg", base64: "aGVsbG8=" },
      { page: 2, mimeType: "image/jpeg", base64: "aGVsbG8=" },
    ],
    consentGiven: true,
  });
  expect(result.currency).toBeNull();
  expect(result.blockingIssues.join(" ")).toContain("Plusieurs devises");
});

/* -------------------------------------------------- the reply as hostile input */

test("a reply that is not a statement table is a failed reading, not an empty one", async () => {
  for (const reply of ["", "je ne peux pas lire cette image", "{}", '{"rows": "beaucoup"}', "null"]) {
    await expect(extraction.extractBankStatementWithCloud({
      runtime: runtime(reply),
      pages: IMAGE_PAGE,
      consentGiven: true,
    })).rejects.toThrow();
  }
});

test("the parser types every field and bounds every collection", () => {
  const parsed = extraction.parseCloudBankReply(JSON.stringify({
    currency: "mad",
    confidence: 5000,
    rows: [
      { line: 1, kind: "TRANSACTION", date: "25 06", label: "A".repeat(5000), credit: 900 },
      { line: -4, kind: "TRANSACTION", date: "26 06", label: { nested: true }, debit: ["x"] },
      { kind: "TRANSACTION", label: { nested: true }, debit: ["x"] },
      "not a row",
      null,
    ],
  }));
  expect(parsed.currency).toBe("MAD");
  expect(parsed.confidence).toBe(100);
  expect(parsed.rows[0].original.label.length).toBeLessThanOrEqual(300);
  // A number the provider sent as a number is still carried as printed text.
  expect(parsed.rows[0].original.credit).toBe("900");
  // A nonsense line number becomes "unknown", never a row index; a field that
  // is not a scalar is not a value, and is simply absent.
  expect(parsed.rows[1].line).toBeNull();
  expect(parsed.rows[1].original.label).toBeUndefined();
  expect(parsed.rows[1].original.debit).toBeUndefined();
  // A "row" with no usable field at all is not carried forward as an empty one.
  expect(parsed.rows).toHaveLength(2);
});

test("a page that fails after the first one refuses the whole statement", async () => {
  const failure = Object.assign(new Error("upstream"), { kind: "PROVIDER_ERROR" });
  await expect(extraction.extractBankStatementWithCloud({
    runtime: runtime([
      { rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "A", credit: "10,00" }] },
      failure,
    ]),
    pages: [
      { page: 1, mimeType: "image/jpeg", base64: "aGVsbG8=" },
      { page: 2, mimeType: "image/jpeg", base64: "aGVsbG8=" },
    ],
    consentGiven: true,
  })).rejects.toThrow(/incomplet/);
});

/*
 * The sentence an accountant actually reads when the provider fails.
 *
 * Found by a real run against a real OpenRouter account: every free model was
 * rate-limited or returned nothing, and Wheat told the accountant it would
 * "utilise le moteur local en attendant" — a promise a Lightweight bank import
 * cannot keep, because there is no local engine for a bank table. The advice
 * has to be the one that always works.
 */
test("a provider failure on a statement never promises a local engine", () => {
  for (const kind of ["EMPTY_RESPONSE", "PROVIDER_ERROR", "BAD_REQUEST"]) {
    const described = cloud.describeCloudOcrFailure({ kind }, "BANK_STATEMENT");
    expect(described.message, kind).not.toMatch(/moteur local/);
    expect(described.message, kind).toMatch(/CSV, XLSX, OFX, MT940 ou CAMT\.053/);
    // The document path keeps its own sentence, which is true there.
    expect(cloud.describeCloudOcrFailure({ kind }).message, kind).toMatch(/moteur local/);
  }
});

test("waiting on a quota or a rate limit points at the formats that need no reading", () => {
  for (const kind of ["QUOTA_EXHAUSTED", "RATE_LIMITED", "MODEL_UNAVAILABLE"]) {
    expect(cloud.describeCloudOcrFailure({ kind }, "BANK_STATEMENT").message, kind)
      .toMatch(/CSV, XLSX, OFX, MT940 ou CAMT\.053/);
    // And a document is never told about bank formats it cannot use.
    expect(cloud.describeCloudOcrFailure({ kind }).message, kind).not.toMatch(/MT940/);
  }
});

test("a statement that reaches the provider and fails reports it, and writes nothing", async () => {
  const failure = Object.assign(new Error("free tier"), { kind: "RATE_LIMITED" });
  const error = await extraction.extractBankStatementWithCloud({
    runtime: runtime(failure),
    pages: IMAGE_PAGE,
    consentGiven: true,
  }).catch((caught) => caught);
  expect(error.name).toBe("CloudOcrFailureError");
  expect(error.remedy).toBe("RETRY_LATER");
  expect(error.message).toMatch(/CSV, XLSX, OFX, MT940 ou CAMT\.053/);
});

/* --------------------------------------------------- consent and authorisation */

test("no consent and no connection are raised before any page is sent", async () => {
  const provider = runtime(MOROCCAN_PAGE);
  await expect(extraction.extractBankStatementWithCloud({
    runtime: provider, pages: IMAGE_PAGE, consentGiven: false,
  })).rejects.toMatchObject({ name: "CloudOcrUnavailableError", reason: "CONSENT_REQUIRED" });

  const offline = runtime(MOROCCAN_PAGE, { connected: false });
  await expect(extraction.extractBankStatementWithCloud({
    runtime: offline, pages: IMAGE_PAGE, consentGiven: true,
  })).rejects.toMatchObject({ name: "CloudOcrUnavailableError", reason: "NOT_CONNECTED" });

  expect(provider.calls).toHaveLength(0);
  expect(offline.calls).toHaveLength(0);
});

test("a Lightweight import with no authorisation asks, and never mentions PaddleOCR", async () => {
  const app = lightweightApp();
  const bytes = fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64");
  const error = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: bytes,
    app,
    recognition: plan(runtime(MOROCCAN_PAGE), { consentGiven: false }),
  }).catch((caught) => caught);

  expect(error.name).toBe("CloudOcrUnavailableError");
  expect(error.reason).toBe("CONSENT_REQUIRED");
  expect(String(error.message)).not.toContain("PaddleOCR");
});

test("a Lightweight import with no provider at all says what to do instead", async () => {
  const app = lightweightApp();
  const bytes = fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64");
  const error = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: bytes,
    app,
    recognition: plan(null, { local: false }),
  }).catch((caught) => caught);

  // This build has no local recogniser, so nothing tries to launch one: the
  // refusal names the setting to turn on and the formats that need no reading
  // at all, and never a component this edition deliberately does not ship.
  expect(String(error.message)).toMatch(/CSV, XLSX, OFX, MT940 ou CAMT\.053/);
  expect(String(error.message)).toContain("Wheat Cloud AI");
  expect(String(error.message)).not.toContain("PaddleOCR");
});

test("Lightweight with cloud reading switched off still never reaches for PaddleOCR", async () => {
  // The case the engine order alone would have missed. With the preference off
  // the plan is Tesseract only, which is not a bank-table reader — and the old
  // routing fell straight through to the local engine and its error.
  const app = lightweightApp();
  const offPlan = cloud.resolveRecognitionPlan({ hasBundledLocalOcr: false, cloud: null });
  expect(offPlan.order).toEqual(["tesseract"]);

  const error = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64"),
    app,
    recognition: offPlan,
  }).catch((caught) => caught);

  expect(error.name).toBe("BankStatementImportError");
  expect(String(error.message)).not.toContain("PaddleOCR");
  expect(String(error.message)).toContain("Réglages");
});

/* ------------------------------------------- Standard never uploads by itself */

test("Standard does not send a statement to the cloud without being asked", async () => {
  const provider = runtime(MOROCCAN_PAGE);
  const app = lightweightApp();
  const bytes = fs.readFileSync(path.join(root, "test documents for use", "WhatsApp Image 2026-08-13 at 23.31.16.png")).toString("base64");

  // A Standard plan: local first. The local engine is absent on this machine,
  // so the reading fails — and the file must still not leave the computer.
  await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: bytes,
    app,
    recognition: plan(provider, { local: true }),
  }).catch(() => undefined);
  expect(provider.calls).toHaveLength(0);

  // Asked for explicitly, it reads.
  const parsed = await importer.parseBankStatement({
    sourceName: "releve.png",
    bytesBase64: bytes,
    app,
    recognition: plan(provider, { local: true }),
    cloudRequested: true,
  });
  expect(provider.calls).toHaveLength(1);
  expect(parsed.ocr.local).toBe(false);
});

/* ----------------------------------------------- cancellation, and its cost */

test("a cancelled reading stops and produces nothing", async () => {
  const controller = new AbortController();
  const provider = runtime([
    { rows: [{ line: 1, kind: "TRANSACTION", date: "25 06", label: "A", credit: "10,00" }] },
    { rows: [{ line: 1, kind: "TRANSACTION", date: "26 06", label: "B", credit: "20,00" }] },
  ]);
  await expect(extraction.extractBankStatementWithCloud({
    runtime: provider,
    pages: [
      { page: 1, mimeType: "image/jpeg", base64: "aGVsbG8=" },
      { page: 2, mimeType: "image/jpeg", base64: "aGVsbG8=" },
    ],
    consentGiven: true,
    onPage: () => controller.abort(),
    signal: controller.signal,
  })).rejects.toMatchObject({ name: "BankStatementReadCancelledError" });
  expect(provider.calls).toHaveLength(1);
});

/* ------------------------------------------------------- evidence for review */

test("every proposed movement carries where it came from and what was uncertain", async () => {
  const result = await extraction.extractBankStatementWithCloud({
    runtime: runtime({
      rows: [
        { line: 3, kind: "TRANSACTION", date: "25 06", label: "VIREMENT", credit: "18 334,42", uncertain: ["reference"] },
      ],
    }),
    pages: [{ page: 2, mimeType: "image/jpeg", base64: "aGVsbG8=" }],
    consentGiven: true,
  });
  expect(result.evidence[0]).toMatchObject({ row: 1, page: 2, lineOnPage: 3, kind: "TRANSACTION" });
  expect(result.evidence[0].original.credit).toBe("18 334,42");
  expect(result.evidence[0].uncertainFields).toEqual(["reference"]);
  expect(result.rows[0].__wheatSourcePage).toBe("2");
});
