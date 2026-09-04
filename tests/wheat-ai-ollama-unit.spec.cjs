const { test, expect } = require("@playwright/test");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The local Ollama path of Wheat AI.
 *
 * `fetch` is stubbed for the whole spec, so nothing here needs an Ollama
 * service, a downloaded model or a network. What is asserted is the protocol:
 * what Wheat puts on the wire for a given model's declared capabilities, and
 * what it makes of the reply it gets back.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const MANIFEST = path.join(root, "resources", "models", "wheat-model-manifest.json");

let wheatAi;
let realFetch;

/** Requests Wheat sent, in order. Reset by `stubOllama`. */
let sent = [];

/**
 * Stands in for a running Ollama service.
 *
 * `models` is what `/api/tags` publishes, capabilities included — that listing
 * is Wheat's only source of truth about what a local model can do.
 */
function stubOllama({ models, chat }) {
  sent = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/api/tags")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ models }) };
    }
    if (endpoint.endsWith("/api/chat")) {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return { ok: true, status: 200, text: async () => JSON.stringify(chat(body)) };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };
}

function ollamaModel(name, capabilities) {
  return { name, model: name, size: 2_000_000_000, digest: "a".repeat(64), details: { family: "test" }, capabilities };
}

function reply({ content = "", thinking = "", doneReason = "stop", toolCalls } = {}) {
  const message = { role: "assistant", content };
  if (thinking) message.thinking = thinking;
  if (toolCalls) message.tool_calls = toolCalls;
  return { model: "test", message, done: true, done_reason: doneReason, eval_count: 42 };
}

/**
 * A real PNG, base64-encoded. Wheat validates the MIME type, the base64 shape
 * and the decoded size before an attachment reaches any model, so a token
 * placeholder would be rejected long before the code under test.
 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const VISION_THINKER = ollamaModel("qwen3.5:9b", ["vision", "completion", "tools", "thinking"]);
const TEXT_ONLY = ollamaModel("mistral:7b", ["completion", "tools"]);
const PLAIN = ollamaModel("tiny:1b", ["completion"]);

test.beforeAll(() => {
  wheatAi = tsxRequire(path.join(root, "electron", "wheatAi.ts"), __filename);
  realFetch = globalThis.fetch;
});

test.afterAll(() => {
  globalThis.fetch = realFetch;
});

/* --------------------------------------------------- capability detection -- */

test("Ollama capabilities are read from the service, never guessed from the name", async () => {
  stubOllama({ models: [VISION_THINKER, TEXT_ONLY, PLAIN], chat: () => reply({ content: "ok" }) });
  const discovery = await wheatAi.listOllamaModels();

  const byName = Object.fromEntries(discovery.models.map((model) => [model.displayName, model]));
  expect(byName["qwen3.5:9b"]).toMatchObject({ supportsVision: true, supportsTools: true, supportsThinking: true });
  expect(byName["mistral:7b"]).toMatchObject({ supportsVision: false, supportsTools: true, supportsThinking: false });
  expect(byName["tiny:1b"]).toMatchObject({ supportsVision: false, supportsTools: false, supportsThinking: false });
});

test("capabilities of a model that is no longer installed read as absent", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "ok" }) });
  expect(await wheatAi.ollamaModelCapabilities("mistral:7b")).toEqual({ supportsVision: false, supportsTools: true, supportsThinking: false });
  expect(await wheatAi.ollamaModelCapabilities("deleted:model")).toBeNull();
});

/* ------------------------------------------------------ request construction */

test("a vision model receives the image as Ollama's per-message base64 array", async () => {
  stubOllama({ models: [VISION_THINKER], chat: () => reply({ content: "Une facture." }) });
  const model = (await wheatAi.listOllamaModels()).models[0];

  const result = await wheatAi.runOllamaChat(model, {
    messages: [{ role: "user", content: "Analyse cette image.", images: [{ mimeType: "image/png", base64: PNG_BASE64 }] }],
  });

  const turn = sent[0].messages.at(-1);
  expect(turn.images).toEqual([PNG_BASE64]);
  // Ollama takes raw base64, not an OpenAI-style data: URL content part.
  expect(turn.content).toBe("Analyse cette image.");
  expect(JSON.stringify(turn)).not.toMatch(/data:image/);
  expect(result.text).toBe("Une facture.");
});

test("reasoning is switched off for a thinking model so the budget goes to the answer", async () => {
  stubOllama({ models: [VISION_THINKER], chat: () => reply({ content: "ok" }) });
  const model = (await wheatAi.listOllamaModels()).models[0];
  await wheatAi.runOllamaChat(model, { messages: [{ role: "user", content: "Bonjour" }] });

  expect(sent[0].think).toBe(false);
  expect(sent[0].stream).toBe(false);
});

test("a model without the thinking capability is never sent a think flag", async () => {
  // Ollama refuses `think` outright for a model that does not declare it, so
  // sending it unconditionally would break every non-reasoning model.
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "ok" }) });
  const model = (await wheatAi.listOllamaModels()).models[0];
  await wheatAi.runOllamaChat(model, { messages: [{ role: "user", content: "Bonjour" }] });

  expect("think" in sent[0]).toBe(false);
});

test("tools are sent only to a model that declares tool calling", async () => {
  const capabilities = [{ id: "accounting.search_accounts", mode: "READ", description: "Chercher", inputSchema: { type: "object", properties: {} } }];

  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "ok" }) });
  const withTools = (await wheatAi.listOllamaModels()).models[0];
  await wheatAi.runOllamaChat(withTools, { messages: [{ role: "user", content: "Bonjour" }], availableCapabilities: capabilities });
  expect(sent[0].tools).toHaveLength(1);

  stubOllama({ models: [PLAIN], chat: () => reply({ content: "ok" }) });
  const withoutTools = (await wheatAi.listOllamaModels()).models[0];
  await wheatAi.runOllamaChat(withoutTools, { messages: [{ role: "user", content: "Bonjour" }], availableCapabilities: capabilities });
  expect("tools" in sent[0]).toBe(false);
});

/* -------------------------------------------------------- response parsing -- */

test("a normal reply is returned through to completion", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "Le total est de 1 200,00 MAD." }) });
  const model = (await wheatAi.listOllamaModels()).models[0];
  const result = await wheatAi.runOllamaChat(model, { messages: [{ role: "user", content: "Le total ?" }] });

  expect(result.text).toBe("Le total est de 1 200,00 MAD.");
  expect(result.metrics.doneReason).toBe("stop");
});

test("a tool call with no prose still counts as an answer", async () => {
  stubOllama({
    models: [TEXT_ONLY],
    chat: () => reply({ content: "", toolCalls: [{ function: { name: "accounting_search_accounts", arguments: { query: "614" } } }] }),
  });
  const model = (await wheatAi.listOllamaModels()).models[0];
  const result = await wheatAi.runOllamaChat(model, { messages: [{ role: "user", content: "Cherche 614" }] });

  expect(result.proposedToolCalls).toHaveLength(1);
  expect(result.text).toMatch(/actions demand/);
});

test("a reply truncated by the length limit is reported as truncation, not as a missing answer", async () => {
  // The real failure behind "Ollama a terminé sans fournir de réponse finale":
  // a reasoning model spent the whole generation budget on its `thinking`
  // field and returned an empty `content` with done_reason "length".
  stubOllama({
    models: [VISION_THINKER],
    chat: () => reply({ content: "", thinking: "raisonnement interne tres long", doneReason: "length" }),
  });
  const model = (await wheatAi.listOllamaModels()).models[0];

  const failure = await wheatAi
    .runOllamaChat(model, { messages: [{ role: "user", content: "Analyse" }] })
    .then(() => null, (error) => error);

  expect(failure).toBeTruthy();
  expect(failure.message).toMatch(/limite de longueur/);
  // The reasoning itself is never surfaced.
  expect(failure.message).not.toMatch(/raisonnement interne tres long/);
});

test("reasoning without an answer is named as such and never leaked", async () => {
  stubOllama({
    models: [VISION_THINKER],
    chat: () => reply({ content: "", thinking: "secret interne", doneReason: "stop" }),
  });
  const model = (await wheatAi.listOllamaModels()).models[0];

  const failure = await wheatAi
    .runOllamaChat(model, { messages: [{ role: "user", content: "Analyse" }] })
    .then(() => null, (error) => error);

  expect(failure.message).toMatch(/raisonnement interne/);
  expect(failure.message).not.toMatch(/secret interne/);
});

test("inline reasoning tags are still stripped out of the visible answer", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "<think>calcul prive</think>Le solde est nul." }) });
  const model = (await wheatAi.listOllamaModels()).models[0];
  const result = await wheatAi.runOllamaChat(model, { messages: [{ role: "user", content: "Le solde ?" }] });

  expect(result.text).toBe("Le solde est nul.");
  expect(result.text).not.toMatch(/calcul prive/);
});

/* --------------------------------------------------- the pre-send capability gate */

/** Minimal Prisma double: the chat path reads settings and appends an audit row. */
function prismaDouble(selectedModelId) {
  const audit = [];
  return {
    audit,
    client: {
      wheatAiSettings: {
        findUnique: async () => ({ companyId: "company-1", enabled: true, selectedModelId, permissionMode: "READ_ONLY" }),
      },
      wheatAiAuditEvent: { create: async ({ data }) => { audit.push(data); return data; } },
      company: {
        findUnique: async () => ({
          id: "company-1",
          name: "ACME SARL",
          legalForm: "SARL",
          ice: "001234567000089",
          taxId: "12345678",
          city: "Casablanca",
          baseCurrency: "MAD",
          vatFrequency: "MONTHLY",
          version: 1,
          fiscalYears: [],
          _count: { accounts: 0, journals: 0, entries: 0, invoices: 0, documents: 0 },
        }),
      },
    },
  };
}

test("an image sent to a text-only Ollama model is refused before any request leaves Wheat", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "jamais atteint" }) });
  const prisma = prismaDouble("ollama:mistral:7b");

  const failure = await wheatAi
    .runLocalChat(
      path.join(os.tmpdir(), "wheat-ai-models-absent"),
      await wheatAi.readModelManifest(MANIFEST),
      prisma.client,
      {},
      {
        companyId: "company-1",
        messages: [{ role: "user", content: "Analyse", images: [{ mimeType: "image/png", base64: PNG_BASE64 }] }],
      },
    )
    .then(() => null, (error) => error);

  expect(failure).toBeTruthy();
  expect(failure.message).toMatch(/ne lit pas les images/);
  // The point of the gate: no doomed request, and therefore no obscure
  // backend error for the user to decode.
  expect(sent).toHaveLength(0);
});

test("a vision Ollama model is allowed through the gate and answers", async () => {
  stubOllama({ models: [VISION_THINKER], chat: () => reply({ content: "Une facture d'achat." }) });
  const prisma = prismaDouble("ollama:qwen3.5:9b");

  const result = await wheatAi.runLocalChat(
    path.join(os.tmpdir(), "wheat-ai-models-absent"),
    await wheatAi.readModelManifest(MANIFEST),
    prisma.client,
    {},
    {
      companyId: "company-1",
      messages: [{ role: "user", content: "Analyse", images: [{ mimeType: "image/png", base64: PNG_BASE64 }] }],
    },
  );

  expect(sent).toHaveLength(1);
  expect(sent[0].messages.at(-1).images).toEqual([PNG_BASE64]);
  expect(result.text).toContain("Une facture d'achat.");
  // Nothing about routing, retries or model identifiers reaches the answer.
  expect(result.text).not.toMatch(/bascul|Tentative|Fallback|ollama:/i);
});

test("plain text chat on a local model is unaffected", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "Bonjour, je suis Wheat AI." }) });
  const prisma = prismaDouble("ollama:mistral:7b");

  const result = await wheatAi.runLocalChat(
    path.join(os.tmpdir(), "wheat-ai-models-absent"),
    await wheatAi.readModelManifest(MANIFEST),
    prisma.client,
    {},
    { companyId: "company-1", messages: [{ role: "user", content: "Bonjour" }] },
  );

  expect(result.text).toContain("Bonjour, je suis Wheat AI.");
  expect(result.provider).toBe("OLLAMA");
  expect(prisma.audit).toHaveLength(1);
});

/* ------------------------------------------------------------- OCR review -- */

test("OCR review runs on recognised text with a text-only model", async () => {
  stubOllama({
    models: [TEXT_ONLY],
    chat: () => reply({ content: '{"invoiceNumber":{"value":"F-2026/0041","evidence":"F-2026/0041"}}' }),
  });

  const answer = await wheatAi.runOllamaPlainChat("mistral:7b", {
    system: "Tu relis une extraction.",
    user: "Texte reconnu : Facture F-2026/0041",
  });

  expect(answer).toContain("F-2026/0041");
  // No vision requirement anywhere on this path: the review reads text.
  expect("images" in sent[0].messages.at(-1)).toBe(false);
});

test("OCR review never sends an image to a model that cannot read one", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "{}" }) });
  await wheatAi.runOllamaPlainChat("mistral:7b", {
    system: "Tu relis une extraction.",
    user: "Texte reconnu",
    images: [{ mimeType: "image/png", base64: PNG_BASE64 }],
  });
  expect("images" in sent[0].messages.at(-1)).toBe(false);
});

test("OCR review with a removed model fails with a sentence naming the setting", async () => {
  stubOllama({ models: [TEXT_ONLY], chat: () => reply({ content: "{}" }) });

  const failure = await wheatAi
    .runOllamaPlainChat("supprime:7b", { system: "Tu relis.", user: "Texte" })
    .then(() => null, (error) => error);

  expect(failure).toBeTruthy();
  expect(failure.message).toMatch(/Reglages|Réglages/);
  expect(sent).toHaveLength(0);
});
