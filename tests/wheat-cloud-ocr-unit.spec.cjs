const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Cloud recognition: what Wheat accepts from a provider, and what it refuses.
 *
 * Nothing here touches a network. The runtime is a literal object, so every
 * case is a chosen provider reply and a chosen assertion about what Wheat does
 * with it.
 *
 * The rule under test throughout: a provider produces **recognised text**, and
 * recognised text is the *input* to Wheat's own deterministic readers, not a
 * substitute for them. A reply is therefore held to the same standard as any
 * other untrusted input — typed, bounded, and rejected outright when it is not
 * what it claims to be.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let cloud;

test.beforeAll(() => {
  cloud = tsxRequire(path.join(root, "electron", "cloudOcr.ts"), __filename);
});

const IMAGE = { mimeType: "image/png", base64: "aGVsbG8=" };

function runtime(reply, { connected = true } = {}) {
  return {
    isConnected: () => connected,
    runVision: async () => ({
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      provider: "OpenRouter",
      modelId: "some/vision-model:free",
    }),
  };
}

const GOOD_REPLY = {
  text: "FACTURE N° F-2026/0041\nICE 001234567000089\nTotal HT 12 000,00\nTVA 20% 2 400,00\nTotal TTC 14 400,00",
  confidence: 88,
  tables: [[["Désignation", "Montant"], ["Prestation", "12 000,00"]]],
};

/* ------------------------------------------------------------ engine order */

test("Standard reads locally first; Lightweight reads in the cloud", () => {
  expect(cloud.ocrEngineOrder({ hasBundledLocalOcr: true, cloudOcrEnabled: false })).toEqual(["paddle", "tesseract"]);
  expect(cloud.ocrEngineOrder({ hasBundledLocalOcr: false, cloudOcrEnabled: true })).toEqual(["cloud", "tesseract"]);
});

test("cloud reading in Standard is an addition, never a replacement", () => {
  // Turning cloud reading on in Standard must not take the local engine out of
  // the chain: a machine that can read a page itself should read it itself.
  expect(cloud.ocrEngineOrder({ hasBundledLocalOcr: true, cloudOcrEnabled: true })).toEqual(["paddle", "cloud", "tesseract"]);
});

test("every plan ends at the local fallback, so an offline machine still reads", () => {
  for (const local of [true, false]) {
    for (const cloudEnabled of [true, false]) {
      const order = cloud.ocrEngineOrder({ hasBundledLocalOcr: local, cloudOcrEnabled: cloudEnabled });
      expect(order[order.length - 1]).toBe("tesseract");
    }
  }
});

test("only a plan with no local engine in front actually depends on the cloud", () => {
  expect(cloud.requiresCloudRecognition(["cloud", "tesseract"])).toBe(true);
  expect(cloud.requiresCloudRecognition(["paddle", "cloud", "tesseract"])).toBe(false);
  expect(cloud.requiresCloudRecognition(["tesseract"])).toBe(false);
});

/* --------------------------------------------------------- authorisation */

test("no consent means nothing is sent, and the reason says so", async () => {
  let called = false;
  const spy = { isConnected: () => true, runVision: async () => { called = true; return { text: "{}", provider: "x", modelId: "y" }; } };
  const error = await recognizeError(spy, { consentGiven: false });
  expect(error.name).toBe("CloudOcrUnavailableError");
  expect(error.reason).toBe("CONSENT_REQUIRED");
  // The point of the check: the document never left the machine.
  expect(called).toBe(false);
});

test("no connection is reported as a step to complete, not a failed document", async () => {
  const error = await recognizeError(runtime(GOOD_REPLY, { connected: false }), { consentGiven: true });
  expect(error.name).toBe("CloudOcrUnavailableError");
  expect(error.reason).toBe("NOT_CONNECTED");
});

/* ------------------------------------------------------- accepted replies */

test("a well-formed transcription is carried through with its provider named", async () => {
  const result = await cloud.recognizeWithCloud(runtime(GOOD_REPLY), IMAGE, { consentGiven: true });
  expect(result.text).toContain("F-2026/0041");
  expect(result.confidence).toBe(88);
  expect(result.tables).toEqual([[["Désignation", "Montant"], ["Prestation", "12 000,00"]]]);
  expect(result.provider).toBe("OpenRouter");
  expect(result.engine).toContain("wheat-cloud-ocr");
});

test("a reply wrapped in prose or a code fence is still read", async () => {
  const wrapped = "Voici la transcription :\n```json\n" + JSON.stringify(GOOD_REPLY) + "\n```\nJ'espère que cela convient.";
  const result = await cloud.recognizeWithCloud(runtime(wrapped), IMAGE, { consentGiven: true });
  expect(result.text).toContain("Total TTC");
});

/* ------------------------------------------------------- refused replies */

test("a reply that is not JSON is a recognition failure, not a blank document", async () => {
  await expect(cloud.recognizeWithCloud(runtime("Je ne peux pas lire cette image."), IMAGE, { consentGiven: true }))
    .rejects.toThrow(/transcription exploitable/i);
});

test("an empty transcription is refused rather than filed as a read blank page", async () => {
  // Accepting it would file the document as "read, and blank" — the one
  // outcome nobody reviews, and the one most likely to be wrong.
  await expect(cloud.recognizeWithCloud(runtime({ text: "", confidence: 99 }), IMAGE, { consentGiven: true }))
    .rejects.toThrow(/transcription exploitable/i);
  await expect(cloud.recognizeWithCloud(runtime({ text: "  \n ", confidence: 99 }), IMAGE, { consentGiven: true }))
    .rejects.toThrow(/transcription exploitable/i);
});

test("a reply whose text is not a string is refused", async () => {
  for (const text of [42, null, { a: 1 }, ["x"], true]) {
    expect(cloud.parseCloudOcrReply(JSON.stringify({ text, confidence: 90 }))).toBeNull();
  }
});

/* ------------------------------------------------------------- hardening */

test("confidence is clamped, and an absent one is deliberately middling", () => {
  expect(cloud.parseCloudOcrReply(JSON.stringify({ text: "a".repeat(40), confidence: 900 })).confidence).toBe(100);
  expect(cloud.parseCloudOcrReply(JSON.stringify({ text: "a".repeat(40), confidence: -20 })).confidence).toBe(0);
  expect(cloud.parseCloudOcrReply(JSON.stringify({ text: "a".repeat(40), confidence: "élevée" })).confidence).toBe(70);
  expect(cloud.parseCloudOcrReply(JSON.stringify({ text: "a".repeat(40) })).confidence).toBe(70);
});

test("the transcription is bounded, and says so when it was cut", () => {
  const parsed = cloud.parseCloudOcrReply(JSON.stringify({ text: "x".repeat(500_000), confidence: 90 }));
  expect(parsed.text.length).toBe(200_000);
  expect(parsed.warnings.join(" ")).toMatch(/tronqu/i);
});

test("tables are normalised to strings and bounded in every dimension", () => {
  const hostile = {
    text: "a".repeat(40),
    confidence: 80,
    tables: [
      "not a table",
      [["ok", 42, null, { nested: true }, ["deep"]]],
      [Array.from({ length: 200 }, (_, index) => `c${index}`)],
      Array.from({ length: 5000 }, () => ["row"]),
      [[], [""]],
    ],
  };
  const parsed = cloud.parseCloudOcrReply(JSON.stringify(hostile));
  for (const table of parsed.tables) {
    expect(table.length).toBeLessThanOrEqual(400);
    for (const row of table) {
      expect(row.length).toBeLessThanOrEqual(60);
      for (const cell of row) expect(typeof cell).toBe("string");
    }
  }
  // A string where a table was expected, and a table of empty rows, contribute
  // nothing rather than producing a malformed table.
  expect(parsed.tables.some((table) => table.length === 0)).toBe(false);
  expect(parsed.tables[0]).toEqual([["ok", "42", "", "", ""]]);
});

test("an absurd number of tables is capped instead of accepted", () => {
  const parsed = cloud.parseCloudOcrReply(JSON.stringify({
    text: "a".repeat(40),
    confidence: 80,
    tables: Array.from({ length: 500 }, () => [["cell"]]),
  }));
  expect(parsed.tables.length).toBeLessThanOrEqual(40);
  expect(parsed.warnings.join(" ")).toMatch(/limite/i);
});

test("a cell is truncated rather than carried at arbitrary length", () => {
  const parsed = cloud.parseCloudOcrReply(JSON.stringify({
    text: "a".repeat(40),
    confidence: 80,
    tables: [[["y".repeat(9000)]]],
  }));
  expect(parsed.tables[0][0][0].length).toBe(500);
});

async function recognizeError(runtimeDouble, options) {
  try {
    await cloud.recognizeWithCloud(runtimeDouble, IMAGE, options);
  } catch (error) {
    return error;
  }
  throw new Error("recognizeWithCloud resolved where it should have refused.");
}

/* --------------------------------------------------------------- error UX */

test("a provider failure becomes a sentence an accountant can act on", async () => {
  const cases = [
    ["QUOTA_EXHAUSTED", /limite d'utilisation actuelle de ce compte/, "MANAGE_ACCOUNT"],
    ["RATE_LIMITED", /trop de demandes/, "RETRY_LATER"],
    ["INVALID_KEY", /Reconnectez Wheat Cloud AI/, "RECONNECT"],
    ["UNAUTHORIZED", /Reconnectez Wheat Cloud AI/, "RECONNECT"],
    ["TIMEOUT", /connexion/, "RETRY"],
    ["IMAGE_UNSUPPORTED", /lire une image/, "MANAGE_ACCOUNT"],
    ["PROVIDER_ERROR", /moteur local/, "RETRY"],
  ];
  for (const [kind, pattern, remedy] of cases) {
    const failing = {
      isConnected: () => true,
      runVision: async () => { throw Object.assign(new Error(`HTTP 429 upstream x-provider-meta ${kind}`), { kind }); },
    };
    const error = await recognizeError(failing, { consentGiven: true });
    expect(error.name).toBe("CloudOcrFailureError");
    expect(error.message).toMatch(pattern);
    expect(error.remedy).toBe(remedy);
    // No status code, no provider vocabulary, no header name.
    expect(error.message).not.toMatch(/HTTP|429|upstream|x-provider|[A-Z]{4,}_[A-Z]{4,}/);
    // The original classification survives for diagnostics, just not on screen.
    expect(error.cause?.kind).toBe(kind);
  }
});

test("an unclassified failure still produces a usable sentence", () => {
  const described = cloud.describeCloudOcrFailure(new Error("ECONNRESET"));
  expect(described.message).toMatch(/lecture en ligne n'a pas abouti/i);
  expect(described.remedy).toBe("RETRY");
  expect(described.message).not.toContain("ECONNRESET");
});

test("Wheat never answers a quota problem by reaching for a paid model", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(root, "electron", "cloudOcr.ts"), "utf8");
  const quota = source.slice(source.indexOf('case "QUOTA_EXHAUSTED"'), source.indexOf('case "RATE_LIMITED"'));
  // The allowance belongs to the user's own provider account. Wheat says so and
  // stops; spending their money to get past it is not Wheat's decision to make.
  expect(quota).toMatch(/limite d'utilisation actuelle de ce compte/);
  expect(quota).not.toMatch(/paid|payant|upgrade|credits?/i);
});

/* ------------------------------- the cloud as an addition, not a dependency */

test("a Standard import is never abandoned because the cloud is not connected", () => {
  /*
   * The distinction that keeps cloud reading optional in Standard. When the
   * cloud is the only recogniser a build has, a missing connection stops the
   * import so the interface can obtain one and resume. When a local engine
   * comes first, it is not a decision at all: the page is read locally, exactly
   * as it would have been before cloud reading existed.
   *
   * `recognizeImageWithPreprocessing` reads this to decide whether a
   * CloudOcrUnavailableError leaves the recogniser at all.
   */
  expect(cloud.requiresCloudRecognition(cloud.ocrEngineOrder({ hasBundledLocalOcr: true, cloudOcrEnabled: true }))).toBe(false);
  expect(cloud.requiresCloudRecognition(cloud.ocrEngineOrder({ hasBundledLocalOcr: false, cloudOcrEnabled: true }))).toBe(true);

  const fs = require("node:fs");
  const recogniser = fs.readFileSync(path.join(root, "electron", "smartOcr.ts"), "utf8");
  const branch = recogniser.slice(recogniser.indexOf("if (error instanceof CloudOcrUnavailableError) {"));
  expect(branch.slice(0, 1200)).toMatch(/if \(requiresCloudRecognition\(plan\.order\)\) throw error;/);
});
