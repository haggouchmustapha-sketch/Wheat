const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Wheat AI remote providers — OpenRouter and Groq.
 *
 * Every case here is fully mocked: no test ever needs a real API key, and no
 * test performs a network request. `fetchImpl` is injected, and `safeStorage`
 * is a deterministic in-memory double of Electron's OS credential vault.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let providers;
let secrets;
let service;

test.beforeAll(() => {
  providers = tsxRequire(path.join(root, "electron", "wheatAiProviders.ts"), __filename);
  secrets = tsxRequire(path.join(root, "electron", "wheatAiSecrets.ts"), __filename);
  service = tsxRequire(path.join(root, "electron", "wheatAiProviderService.ts"), __filename);
});

/** Reversible stand-in for Electron `safeStorage`; never a real OS keychain. */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  };
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ai-providers-"));
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status, body = "provider error") {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

/* ------------------------------------------------------- free-model rules -- */

test("OpenRouter models are eligible only when the official pricing is exactly zero", () => {
  const selection = providers.selectOpenRouterFreeModels({
    data: [
      { id: "vendor/free-instruct:free", name: "Free Instruct", context_length: 65536, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "vendor/zero-number", context_length: 8192, pricing: { prompt: 0, completion: 0 }, supported_parameters: [] },
      { id: "vendor/paid", context_length: 128000, pricing: { prompt: "0.0000005", completion: "0" } },
      { id: "vendor/half-paid", context_length: 128000, pricing: { prompt: "0", completion: "0.000002" } },
      { id: "vendor/no-pricing", context_length: 8192 },
      { id: "vendor/partial-pricing", context_length: 8192, pricing: { prompt: "0" } },
      { id: "vendor/unparseable", context_length: 8192, pricing: { prompt: "gratuit", completion: "gratuit" } },
      { id: "vendor/no-context", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/request-fee", context_length: 8192, pricing: { prompt: "0", completion: "0", request: "0.001" } },
    ],
  });

  expect(selection.models.map((model) => model.id)).toEqual(["vendor/free-instruct:free", "vendor/zero-number"]);
  const reasons = Object.fromEntries(selection.rejected.map((entry) => [entry.id, entry.reason]));
  expect(reasons["vendor/paid"]).toBe("modèle payant");
  expect(reasons["vendor/half-paid"]).toBe("modèle payant");
  expect(reasons["vendor/no-pricing"]).toBe("tarification absente des métadonnées");
  expect(reasons["vendor/partial-pricing"]).toBe("tarification incomplète");
  expect(reasons["vendor/unparseable"]).toBe("modèle payant");
  expect(reasons["vendor/no-context"]).toBe("fenêtre de contexte inconnue");
  expect(reasons["vendor/request-fee"]).toMatch(/frais additionnel/);
});

test("isZeroPrice accepts only a value that provably parses to zero", () => {
  for (const value of [0, "0", "0.0", "0.00000000", " 0 "]) expect(providers.isZeroPrice(value)).toBe(true);
  for (const value of ["", null, undefined, "free", "0.0000001", -0.5, {}, []]) expect(providers.isZeroPrice(value)).toBe(false);
});

test("Groq discovery filters capability but leaves free-tier eligibility to explicit service consent", () => {
  const selection = providers.selectGroqFreeModels({
    data: [
      { id: "llama-3.3-70b-versatile", context_window: 131072, active: true },
      { id: "accessible-but-unpriced", context_window: 131072, active: true },
      { id: "accessible-but-paid", context_window: 131072, active: true, pricing: { prompt: "0.01", completion: "0.02" } },
      { id: "whisper-large-v3", context_window: 448 },
      { id: "llama-guard-4-12b", context_window: 131072 },
      { id: "retired-model", context_window: 8192, active: false },
      { id: "no-window-model" },
    ],
  });

  expect(selection.models.map((model) => model.id)).toEqual(["llama-3.3-70b-versatile", "accessible-but-paid", "accessible-but-unpriced"]);
  const reasons = Object.fromEntries(selection.rejected.map((entry) => [entry.id, entry.reason]));
  expect(reasons["whisper-large-v3"]).toMatch(/spécialisé/);
  expect(reasons["retired-model"]).toMatch(/désactivé/);
  expect(reasons["no-window-model"]).toMatch(/inconnue/);
});

test("ranking prefers tool-capable, large-context, non-experimental models", () => {
  const toolCapable = providers.scoreModel({ id: "vendor/llama-3.3-70b-instruct", contextTokens: 131072, supportsTools: true });
  const chatOnly = providers.scoreModel({ id: "vendor/llama-3.3-70b-instruct", contextTokens: 131072, supportsTools: false });
  const small = providers.scoreModel({ id: "vendor/llama-3.2-1b-instruct", contextTokens: 4096, supportsTools: true });
  const preview = providers.scoreModel({ id: "vendor/llama-preview-exp", contextTokens: 131072, supportsTools: true });
  const speech = providers.scoreModel({ id: "vendor/whisper-audio", contextTokens: 131072, supportsTools: true });

  expect(toolCapable.score).toBeGreaterThan(chatOnly.score);
  expect(toolCapable.score).toBeGreaterThan(small.score);
  expect(toolCapable.score).toBeGreaterThan(preview.score);
  expect(speech.score).toBeLessThan(chatOnly.score);
  expect(toolCapable.reason).toMatch(/actions Wheat AI/);
});

/* ------------------------------------------------------------- failover --- */

function candidate(provider, id, score) {
  return { id, provider, label: id, contextTokens: 32768, supportsTools: true, score, rankingReason: "test" };
}

function runtimeWith(handlers, keys = { openrouter: "sk-or-test", groq: "gsk_test" }) {
  const calls = [];
  return {
    calls,
    runtime: {
      getKey: (provider) => keys[provider] ?? null,
      adapter: (provider) => ({
        id: provider,
        label: provider,
        listFreeModels: async () => ({ provider, models: [], rejected: [], fetchedAt: "" }),
        chat: async ({ modelId }) => {
          calls.push(`${provider}/${modelId}`);
          const handler = handlers[`${provider}/${modelId}`];
          if (typeof handler === "function") return handler();
          return { text: "ok", provider, modelId, toolCalls: [], failedOver: [] };
        },
      }),
    },
  };
}

test("a rate-limited model fails over to the next eligible free model", async () => {
  const { runtime, calls } = runtimeWith({
    "openrouter/first": () => {
      throw new providers.WheatAiProviderError("RATE_LIMITED", "openrouter", "limite temporaire", "first");
    },
  });

  const result = await providers.chatWithFailover(runtime, [candidate("openrouter", "first", 900), candidate("openrouter", "second", 800)], {
    messages: [{ role: "user", content: "bonjour" }],
  });

  expect(calls).toEqual(["openrouter/first", "openrouter/second"]);
  expect(result.modelId).toBe("second");
  expect(result.failedOver).toHaveLength(1);
  expect(result.failedOver[0].reason).toMatch(/limite temporaire/);
});

test("quota, unavailability, timeout and empty answers are all retryable", async () => {
  for (const kind of ["QUOTA_EXHAUSTED", "MODEL_UNAVAILABLE", "TIMEOUT", "PROVIDER_ERROR", "EMPTY_RESPONSE"]) {
    const { runtime, calls } = runtimeWith({
      "openrouter/first": () => {
        throw new providers.WheatAiProviderError(kind, "openrouter", kind, "first");
      },
    });
    const result = await providers.chatWithFailover(runtime, [candidate("openrouter", "first", 900), candidate("openrouter", "second", 800)], {
      messages: [{ role: "user", content: "bonjour" }],
    });
    expect(calls, kind).toEqual(["openrouter/first", "openrouter/second"]);
    expect(result.modelId, kind).toBe("second");
  }
});

test("an invalid key, a revoked authorization, a malformed request, a refusal or a cancellation stop immediately", async () => {
  for (const kind of ["INVALID_KEY", "UNAUTHORIZED", "BAD_REQUEST", "SAFETY_REFUSAL", "CANCELLED"]) {
    const { runtime, calls } = runtimeWith({
      "openrouter/first": () => {
        throw new providers.WheatAiProviderError(kind, "openrouter", kind, "first");
      },
    });
    await expect(
      providers.chatWithFailover(runtime, [candidate("openrouter", "first", 900), candidate("openrouter", "second", 800)], {
        messages: [{ role: "user", content: "bonjour" }],
      }),
    ).rejects.toThrow(kind);
    // The second model is never tried: a configuration problem must surface.
    expect(calls, kind).toEqual(["openrouter/first"]);
  }
});

test("failover is bounded, never revisits a model and never loops", async () => {
  const alwaysRateLimited = (provider, id) => () => {
    throw new providers.WheatAiProviderError("RATE_LIMITED", provider, "429", id);
  };
  const handlers = {};
  const list = [];
  for (let index = 0; index < 10; index += 1) {
    handlers[`openrouter/model-${index}`] = alwaysRateLimited("openrouter", `model-${index}`);
    list.push(candidate("openrouter", `model-${index}`, 900 - index));
  }
  const { runtime, calls } = runtimeWith(handlers);

  // The exhausted-chain message is now one user-facing sentence: the models
  // tried and the retry count are diagnostics, not conversation.
  const failure = await providers
    .chatWithFailover(runtime, list, { messages: [{ role: "user", content: "x" }] })
    .then(() => null, (error) => error);
  expect(failure).toBeTruthy();
  expect(failure.message).toMatch(/limite temporairement/);
  expect(failure.message).not.toMatch(/model-\d/);
  expect(calls).toHaveLength(providers.MAX_ATTEMPTS);
  expect(new Set(calls).size).toBe(calls.length);
});

test("cross-provider fallback happens only when both keys are configured", async () => {
  const handlers = {
    "openrouter/a": () => {
      throw new providers.WheatAiProviderError("RATE_LIMITED", "openrouter", "429", "a");
    },
  };
  const both = runtimeWith(handlers, { openrouter: "sk-or-test", groq: "gsk_test" });
  const bothResult = await providers.chatWithFailover(both.runtime, [candidate("openrouter", "a", 900), candidate("groq", "b", 800)], {
    messages: [{ role: "user", content: "x" }],
  });
  expect(bothResult.provider).toBe("groq");

  const single = runtimeWith(handlers, { openrouter: "sk-or-test", groq: null });
  await expect(
    providers.chatWithFailover(single.runtime, [candidate("openrouter", "a", 900), candidate("groq", "b", 800)], {
      messages: [{ role: "user", content: "x" }],
    }),
  ).rejects.toThrow();
  expect(single.calls).toEqual(["openrouter/a"]);
});

test("the candidate list is de-duplicated, capped and honours a pinned model", () => {
  const discoveries = [
    { provider: "openrouter", fetchedAt: "", rejected: [], models: [candidate("openrouter", "top", 900), candidate("openrouter", "mid", 500)] },
    { provider: "groq", fetchedAt: "", rejected: [], models: [candidate("groq", "best", 950), candidate("openrouter", "top", 900)] },
  ];

  const auto = providers.buildCandidateList(discoveries, { preferredProvider: "auto" });
  expect(auto[0].id).toBe("best");
  expect(auto.map((model) => `${model.provider}:${model.id}`)).toEqual([...new Set(auto.map((model) => `${model.provider}:${model.id}`))]);
  expect(auto.length).toBeLessThanOrEqual(providers.MAX_ATTEMPTS);

  const preferred = providers.buildCandidateList(discoveries, { preferredProvider: "openrouter" });
  expect(preferred[0].provider).toBe("openrouter");

  const pinned = providers.buildCandidateList(discoveries, { preferredProvider: "auto", pinnedModelId: "mid" });
  expect(pinned[0].id).toBe("mid");

  const shared = [
    { provider: "openrouter", fetchedAt: "", rejected: [], models: [candidate("openrouter", "shared", 990)] },
    { provider: "groq", fetchedAt: "", rejected: [], models: [candidate("groq", "shared", 500)] },
  ];
  const exactPin = providers.buildCandidateList(shared, { preferredProvider: "groq", pinnedProvider: "groq", pinnedModelId: "shared" });
  expect(exactPin[0].provider).toBe("groq");
});

test("tool-bearing requests skip models that cannot satisfy the requested capability", async () => {
  const incapable = { ...candidate("openrouter", "chat-only", 999), supportsTools: false };
  const capable = candidate("openrouter", "tools", 500);
  const { runtime, calls } = runtimeWith({});
  const result = await providers.chatWithFailover(runtime, [incapable, capable], {
    messages: [{ role: "user", content: "prépare une action" }],
    tools: [{ type: "function", function: { name: "test", parameters: { type: "object" } } }],
  });
  expect(calls).toEqual(["openrouter/tools"]);
  expect(result.modelId).toBe("tools");
});

/* ------------------------------------------------------------- HTTP map --- */

test("HTTP statuses map onto the right retryable / non-retryable failure kinds", async () => {
  const cases = [
    [401, "INVALID_KEY", false],
    [403, "UNAUTHORIZED", false],
    [400, "BAD_REQUEST", false],
    [429, "RATE_LIMITED", true],
    [402, "QUOTA_EXHAUSTED", true],
    [404, "MODEL_UNAVAILABLE", true],
    [503, "PROVIDER_ERROR", true],
  ];
  for (const [status, kind, retryable] of cases) {
    const adapter = providers.createProviderAdapter("openrouter", async () => errorResponse(status));
    const failure = await adapter.listFreeModels("sk-or-test").catch((error) => error);
    expect(failure.kind, String(status)).toBe(kind);
    expect(failure.retryable, String(status)).toBe(retryable);
  }
});

test("a content-filter finish reason is a refusal, not a retryable failure", async () => {
  const adapter = providers.createProviderAdapter("groq", async () =>
    jsonResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
  );
  const failure = await adapter.chat({ apiKey: "gsk_test", modelId: "m", messages: [{ role: "user", content: "x" }] }).catch((error) => error);
  expect(failure.kind).toBe("SAFETY_REFUSAL");
  expect(failure.retryable).toBe(false);
});

test("a request cancelled before dispatch never reaches fetch and never fails over", async () => {
  let calls = 0;
  const adapter = providers.createProviderAdapter("openrouter", async () => {
    calls += 1;
    return jsonResponse({ data: [] });
  });
  const controller = new AbortController();
  controller.abort();
  const failure = await adapter.listFreeModels("sk-or-test", controller.signal).catch((error) => error);
  expect(failure.kind).toBe("CANCELLED");
  expect(failure.retryable).toBe(false);
  expect(calls).toBe(0);
});

test("tool calls are parsed and a malformed argument payload is dropped rather than guessed", async () => {
  const adapter = providers.createProviderAdapter("openrouter", async () =>
    jsonResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "Voici le plan.",
          tool_calls: [
            { function: { name: "entries_create_draft", arguments: '{"journalId":"j1"}' } },
            { function: { name: "broken", arguments: "{not json" } },
            { function: { name: "", arguments: "{}" } },
          ],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    }),
  );
  const result = await adapter.chat({ apiKey: "sk-or-test", modelId: "m", messages: [{ role: "user", content: "x" }] });
  expect(result.toolCalls).toEqual([{ name: "entries_create_draft", arguments: { journalId: "j1" } }]);
  expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 34 });
});

/* -------------------------------------------------------------- secrets --- */

test("an API key is never stored in plaintext and never returned to the renderer", () => {
  const directory = temporaryDirectory();
  try {
    const store = new secrets.WheatAiSecretStore({ directory, safeStorage: fakeSafeStorage() });
    store.setKey("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789");

    const raw = fs.readFileSync(path.join(directory, "wheat-ai-credentials.json"), "utf8");
    expect(raw).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.parse(raw).secrets.openrouter.ciphertext).toBeTruthy();

    const described = store.describe("openrouter");
    expect(described.configured).toBe(true);
    expect(described.maskedKey).toBe("sk-or••••••••6789");
    expect(described.maskedKey).not.toContain("abcdefghij");

    expect(store.getKey("openrouter")).toBe("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789");
    store.deleteKey("openrouter");
    expect(store.describe("openrouter").configured).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("storage is refused outright when the OS vault is unavailable — never downgraded to plaintext", () => {
  const directory = temporaryDirectory();
  try {
    const store = new secrets.WheatAiSecretStore({ directory, safeStorage: fakeSafeStorage({ available: false }) });
    expect(() => store.setKey("groq", "gsk_abcdefghijklmnopqrstuvwxyz")).toThrow(secrets.SecureStorageUnavailableError);
    expect(fs.existsSync(path.join(directory, "wheat-ai-credentials.json"))).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("key shape is validated before the key can ever reach a provider", () => {
  expect(secrets.validateApiKeyShape("openrouter", "gsk_wrong_provider_key_value").ok).toBe(false);
  expect(secrets.validateApiKeyShape("groq", "sk-or-wrong-provider-key").ok).toBe(false);
  expect(secrets.validateApiKeyShape("openrouter", "sk-or-tiny").ok).toBe(false);
  expect(secrets.validateApiKeyShape("openrouter", "sk-or-v1-with space-0123456789").ok).toBe(false);
  expect(secrets.validateApiKeyShape("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz").ok).toBe(true);
  expect(secrets.validateApiKeyShape("groq", "gsk_abcdefghijklmnopqrstuvwxyz").ok).toBe(true);
});

test("redaction scrubs anything key-shaped out of provider error text", () => {
  const text = providers.redactSecrets(
    'HTTP 401 {"error":"invalid key sk-or-v1-abcdefghijklmnopqrst"} header Bearer gsk_abcdefghijklmnopqrstuv',
  );
  expect(text).not.toContain("sk-or-v1-abcdefghijklmnopqrst");
  expect(text).not.toContain("gsk_abcdefghijklmnopqrstuv");
  expect(text).toContain("clé masquée");
});

/* -------------------------------------------------------------- service --- */

function buildService(fetchImpl, { available = true } = {}) {
  const directory = temporaryDirectory();
  const instance = new service.WheatAiProviderService({
    directory,
    safeStorage: fakeSafeStorage({ available }),
    fetchImpl,
  });
  return { instance, directory };
}

test("the connection test lists models instead of prompting, so it cannot consume free quota", async () => {
  const requested = [];
  const { instance, directory } = buildService(async (url) => {
    requested.push(url);
    return jsonResponse({
      data: [{ id: "vendor/free:free", context_length: 32768, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }],
    });
  });
  try {
    instance.setKey("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz");
    const result = await instance.testProvider("openrouter");
    expect(result.ok).toBe(true);
    expect(result.freeModelCount).toBe(1);
    expect(requested).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(requested.some((url) => url.includes("chat/completions"))).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Groq connection succeeds but selection fails closed until Free-plan consent is explicit", async () => {
  const { instance, directory } = buildService(async () => jsonResponse({ data: [{ id: "llama-chat", context_window: 8192, active: true }] }));
  try {
    instance.setKey("groq", "gsk_abcdefghijklmnopqrstuvwxyz");
    const result = await instance.testProvider("groq");
    expect(result.ok).toBe(true);
    expect(result.freeModelCount).toBe(0);
    expect(result.sampleModelId).toBeNull();
    expect(result.message).toMatch(/confirmez votre compte Free/i);
    expect((await instance.listSelectableModels()).models).toEqual([]);

    instance.setPreferences({ groqFreeTierConfirmed: true });
    expect((await instance.listSelectableModels()).models.map((model) => model.id)).toEqual(["llama-chat"]);

    instance.setKey("groq", "gsk_replacement_abcdefghijklmnopqrstuvwxyz");
    expect(instance.getPreferences().groqFreeTierConfirmed).toBe(false);
    expect((await instance.listSelectableModels()).models).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("status exposes masked metadata only, and automatic mode is the default", async () => {
  const { instance, directory } = buildService(async () =>
    jsonResponse({ data: [{ id: "vendor/free:free", context_length: 65536, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }),
  );
  try {
    instance.setKey("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz");
    const status = await instance.getStatus();

    expect(status.preferences.automaticFreeModels).toBe(true);
    expect(status.preferences.activeProvider).toBe("auto");
    expect(status.preferences.groqFreeTierConfirmed).toBe(false);
    expect(status.maxFailoverAttempts).toBe(providers.MAX_ATTEMPTS);

    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz");
    expect(serialised).not.toContain("ciphertext");

    const openrouter = status.providers.find((entry) => entry.id === "openrouter");
    expect(openrouter.configured).toBe(true);
    expect(openrouter.maskedKey).toMatch(/^sk-or•+.{4}$/);
    expect(status.activeSelection.modelId).toBe("vendor/free:free");
    expect(openrouter.eligibilityNote).toMatch(/métadonnées de prix/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("choosing a model manually clears automatic mode, and re-enabling automatic clears the pin", async () => {
  const { instance, directory } = buildService(async () => jsonResponse({ data: [] }));
  try {
    let preferences = instance.setPreferences({ automaticFreeModels: false, pinnedModelId: "remote:groq:llama-3.3-70b-versatile" });
    expect(preferences.pinnedModelId).toBe("remote:groq:llama-3.3-70b-versatile");

    preferences = instance.setPreferences({ automaticFreeModels: true });
    expect(preferences.pinnedModelId).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deleting a provider key also drops a pinned model that belonged to it", async () => {
  const { instance, directory } = buildService(async () => jsonResponse({ data: [] }));
  try {
    instance.setKey("groq", "gsk_abcdefghijklmnopqrstuvwxyz");
    instance.setPreferences({ activeProvider: "groq", automaticFreeModels: false, pinnedModelId: "remote:groq:llama-3.3-70b-versatile" });

    instance.deleteKey("groq");

    const preferences = instance.getPreferences();
    expect(preferences.pinnedModelId).toBeNull();
    expect(preferences.automaticFreeModels).toBe(true);
    expect(preferences.activeProvider).toBe("auto");
    expect(instance.configuredProviders()).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a chat is refused with a clear message when no key is configured", async () => {
  const { instance, directory } = buildService(async () => jsonResponse({ data: [] }));
  try {
    await expect(instance.chat({ messages: [{ role: "user", content: "bonjour" }] })).rejects.toThrow(/Aucune clé d'API/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote model identifiers round-trip through the selection id", () => {
  expect(service.parseRemoteModelId("remote:openrouter:vendor/model:free")).toEqual({ provider: "openrouter", modelId: "vendor/model:free" });
  expect(service.parseRemoteModelId("remote:groq:llama-3.3-70b-versatile")).toEqual({ provider: "groq", modelId: "llama-3.3-70b-versatile" });
  expect(service.parseRemoteModelId("remote:unknown:x")).toBeNull();
  expect(service.parseRemoteModelId("local-model")).toBeNull();
  expect(service.parseRemoteModelId(service.AUTOMATIC_FREE_MODEL_ID)).toBeNull();
});

test("the IPC surface is registered exactly once per channel and returns masked status", async () => {
  const handlers = new Map();
  const { instance, directory } = buildService(async () => jsonResponse({ data: [] }));
  try {
    service.registerWheatAiProviderIpc({
      ipcMain: {
        handle(channel, listener) {
          expect(handlers.has(channel), `duplicate handler for ${channel}`).toBe(false);
          handlers.set(channel, listener);
        },
      },
      service: instance,
    });

    expect([...handlers.keys()].sort()).toEqual([
      "wheat:ai:provider:delete-key",
      "wheat:ai:provider:models",
      "wheat:ai:provider:preferences",
      "wheat:ai:provider:set-key",
      "wheat:ai:provider:status",
      "wheat:ai:provider:test",
    ]);

    const status = await handlers.get("wheat:ai:provider:status")(null, {});
    expect(status.providers).toHaveLength(2);
    expect(JSON.stringify(status)).not.toContain("ciphertext");

    await expect(handlers.get("wheat:ai:provider:set-key")(null, { provider: "unknown", apiKey: "x" })).rejects.toThrow(/Fournisseur inconnu/);
    await expect(handlers.get("wheat:ai:provider:preferences")(null, { automaticFreeModels: "false" })).rejects.toThrow(/automatique.*invalide/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected key never appears in the error the renderer receives", async () => {
  const handlers = new Map();
  const { instance, directory } = buildService(async () => jsonResponse({ data: [] }));
  try {
    service.registerWheatAiProviderIpc({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      service: instance,
    });
    const rejected = await handlers
      .get("wheat:ai:provider:set-key")(null, { provider: "openrouter", apiKey: "sk-or-v1-badkeywithspace here" })
      .catch((error) => error);
    expect(rejected.message).not.toContain("badkeywithspace");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("no source file hard-codes a provider API key", () => {
  const suspicious = /(sk-or-v1-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{30,})/;
  const roots = [path.join(root, "electron"), path.join(root, "src")];
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated" || entry.name === "node_modules") continue;
        walk(target);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        if (suspicious.test(fs.readFileSync(target, "utf8"))) offenders.push(target);
      }
    }
  };
  roots.forEach(walk);
  expect(offenders).toEqual([]);
});
