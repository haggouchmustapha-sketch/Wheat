const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Model capability, provider failover and the OCR-review setting.
 *
 * Everything here is mocked: `fetchImpl` is injected into the provider service
 * and `safeStorage` is an in-memory double of Electron's credential vault, so
 * no test needs a key, a network, an Ollama service or a running application.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let providers;
let service;

test.beforeAll(() => {
  providers = tsxRequire(path.join(root, "electron", "wheatAiProviders.ts"), __filename);
  service = tsxRequire(path.join(root, "electron", "wheatAiProviderService.ts"), __filename);
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  };
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ai-capability-"));
}

function model(id, overrides = {}) {
  return {
    id,
    provider: "openrouter",
    label: id,
    contextTokens: 65536,
    supportsTools: true,
    supportsVision: false,
    score: 100,
    rankingReason: "test",
    ...overrides,
  };
}

function discovery(models, provider = "openrouter") {
  return { provider, models, rejected: [], fetchedAt: new Date().toISOString() };
}

/** Adapter double that records what each candidate was actually sent. */
function recordingRuntime(behaviour) {
  const attempts = [];
  return {
    attempts,
    runtime: {
      getKey: () => "sk-or-test-key-value",
      adapter: (provider) => ({
        id: provider,
        label: provider,
        listFreeModels: async () => discovery([]),
        chat: async (input) => {
          attempts.push({ provider, modelId: input.modelId, tools: input.tools?.length ?? 0, messages: input.messages });
          const outcome = behaviour(input.modelId, attempts.length);
          if (outcome instanceof Error) throw outcome;
          return { text: outcome, provider, modelId: input.modelId, toolCalls: [], failedOver: [], usage: {} };
        },
      }),
    },
  };
}

const TEXT_TURN = [{ role: "user", content: "Quel est le total ?" }];
const IMAGE_TURN = [{ role: "user", content: "Analyse cette image.", images: [{ mimeType: "image/png", base64: "aGVsbG8=" }] }];

/* --------------------------------------------------- one capability answer -- */

test("a request needing images is eligible only for a vision model", () => {
  const textOnly = { supportsTools: true, supportsVision: false };
  const vision = { supportsTools: false, supportsVision: true };

  expect(providers.isModelEligible(textOnly, { images: true, tools: false })).toEqual({ ok: false, reason: "IMAGE_UNSUPPORTED" });
  expect(providers.isModelEligible(vision, { images: true, tools: false })).toEqual({ ok: true });
  // Tool calling is not a hard requirement for an image request: an analysis
  // request must not be refused because the only vision model lacks tools.
  expect(providers.isModelEligible(vision, { images: true, tools: true })).toEqual({ ok: true });
  expect(providers.toolsForCandidate(vision, [{ type: "function" }])).toBeUndefined();
});

test("a text request still requires tool support when Wheat offers capabilities", () => {
  const textOnly = { supportsTools: false, supportsVision: false };
  expect(providers.isModelEligible(textOnly, { images: false, tools: true })).toEqual({ ok: false, reason: "TOOLS_UNSUPPORTED" });
  expect(providers.isModelEligible(textOnly, { images: false, tools: false })).toEqual({ ok: true });
});

test("OCR review of recognised text needs only text capability", () => {
  // The reviewer sends recognised text, never page images, so a plain chat
  // model is enough - this is the rule the review-model picker relies on.
  const plainChat = { supportsTools: false, supportsVision: false };
  expect(providers.isModelEligible(plainChat, { images: false, tools: false })).toEqual({ ok: true });
});

/* ------------------------------------------------------ candidate selection -- */

test("vision filtering happens before the candidate list is capped", () => {
  // Six high-ranked text models followed by one vision model: filtering after
  // the cap kept only text models and left an image request with nothing.
  const pool = [
    ...Array.from({ length: 6 }, (_, index) => model(`vendor/text-${index}`, { score: 900 - index })),
    model("vendor/sees-images", { score: 10, supportsVision: true }),
  ];
  const candidates = providers.buildCandidateList([discovery(pool)], { needs: { images: true, tools: true } });
  expect(candidates.map((entry) => entry.id)).toEqual(["vendor/sees-images"]);
});

test("a model that just failed as unavailable is skipped while the memory lasts", () => {
  const unavailable = new providers.UnavailableModelRegistry(60_000);
  unavailable.note("openrouter", "vendor/dead", "MODEL_UNAVAILABLE");
  const candidates = providers.buildCandidateList(
    [discovery([model("vendor/dead", { score: 900 }), model("vendor/alive", { score: 100 })])],
    { unavailable },
  );
  expect(candidates.map((entry) => entry.id)).toEqual(["vendor/alive"]);
});

test("the unavailable memory expires so a model that returns is used again", async () => {
  const unavailable = new providers.UnavailableModelRegistry(10);
  unavailable.note("openrouter", "vendor/blip", "MODEL_UNAVAILABLE");
  expect(unavailable.isSuppressed("openrouter", "vendor/blip")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(unavailable.isSuppressed("openrouter", "vendor/blip")).toBe(false);
});

/* -------------------------------------------------------------- failover ---- */

test("an image request only ever reaches models that read images", async () => {
  const { runtime, attempts } = recordingRuntime(() => "vu");
  const candidates = [
    model("vendor/text-only"),
    model("vendor/vision", { supportsVision: true }),
  ];
  const result = await providers.chatWithFailover(runtime, candidates, { messages: IMAGE_TURN, tools: [{ type: "function" }] });

  expect(attempts.map((entry) => entry.modelId)).toEqual(["vendor/vision"]);
  expect(result.text).toBe("vu");
});

test("a dead model is skipped and the next eligible model answers", async () => {
  const dead = new providers.WheatAiProviderError("MODEL_UNAVAILABLE", "openrouter", "retire", "vendor/dead");
  const { runtime, attempts } = recordingRuntime((modelId) => (modelId === "vendor/dead" ? dead : "reponse"));
  const result = await providers.chatWithFailover(
    runtime,
    [model("vendor/dead"), model("vendor/alive")],
    { messages: TEXT_TURN },
  );
  expect(attempts.map((entry) => entry.modelId)).toEqual(["vendor/dead", "vendor/alive"]);
  expect(result.text).toBe("reponse");
  expect(result.failedOver).toHaveLength(1);
});

test("failover remembers the models it burned so later requests skip them", async () => {
  const unavailable = new providers.UnavailableModelRegistry(60_000);
  const { runtime } = recordingRuntime((modelId) =>
    modelId === "vendor/dead"
      ? new providers.WheatAiProviderError("MODEL_UNAVAILABLE", "openrouter", "retire", modelId)
      : "ok");
  await providers.chatWithFailover(runtime, [model("vendor/dead"), model("vendor/alive")], { messages: TEXT_TURN }, { unavailable });
  expect(unavailable.isSuppressed("openrouter", "vendor/dead")).toBe(true);
  expect(unavailable.isSuppressed("openrouter", "vendor/alive")).toBe(false);
});

test("an authentication failure stops the chain instead of burning every model", async () => {
  const invalid = new providers.WheatAiProviderError("INVALID_KEY", "openrouter", "cle refusee", "vendor/a");
  const { runtime, attempts } = recordingRuntime(() => invalid);
  await expect(
    providers.chatWithFailover(runtime, [model("vendor/a"), model("vendor/b"), model("vendor/c")], { messages: TEXT_TURN }),
  ).rejects.toThrow(/cle refusee/);
  expect(attempts).toHaveLength(1);
});

test("OpenRouter's image-capability refusal is not read as a withdrawn model", async () => {
  // OpenRouter answers an image sent to a text-only model with a 404 whose body
  // names image input. Classified as MODEL_UNAVAILABLE it produced the useless
  // "OpenRouter ne propose plus ce modele" for a perfectly live model.
  const directory = temporaryDirectory();
  const instance = new service.WheatAiProviderService({
    directory,
    safeStorage: fakeSafeStorage(),
    fetchImpl: async (url) => {
      if (url.includes("/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "vendor/vision:free", context_length: 65536, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
            ],
          }),
          text: async () => "",
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { message: "No endpoints found that support image input.", code: 404 } }),
      };
    },
  });
  instance.setKey("openrouter", "sk-or-abcdefghijklmnop");

  const failure = await instance
    .chat({ messages: IMAGE_TURN })
    .then(() => null, (error) => error);

  expect(failure).toBeTruthy();
  expect(failure.message).not.toMatch(/ne propose plus ce mod/);
  expect(failure.message).toMatch(/image/i);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the user-facing failure is one sentence with no model ids or retry counts", async () => {
  const { runtime } = recordingRuntime((modelId) => new providers.WheatAiProviderError("PROVIDER_ERROR", "openrouter", `panne ${modelId}`, modelId));
  const failure = await providers
    .chatWithFailover(runtime, [model("vendor/aaa"), model("vendor/bbb")], { messages: TEXT_TURN })
    .then(() => null, (error) => error);

  expect(failure).toBeTruthy();
  expect(failure.message).not.toMatch(/vendor\//);
  expect(failure.message).not.toMatch(/tentative/i);
  expect(failure.message).not.toMatch(/\b(404|429|500)\b/);
  expect(failure.message).toMatch(/Aucun modèle compatible/);
});

test("an image request with no vision model anywhere says so plainly", async () => {
  const { runtime, attempts } = recordingRuntime(() => "jamais atteint");
  const failure = await providers
    .chatWithFailover(runtime, [model("vendor/text-only")], { messages: IMAGE_TURN })
    .then(() => null, (error) => error);

  expect(attempts).toHaveLength(0);
  expect(failure.kind).toBe("IMAGE_UNSUPPORTED");
  expect(failure.message).toMatch(/lire une image/);
});

/* ---------------------------------------------------------- diagnostics ----- */

test("fallback is reported to diagnostics and never to the conversation", async () => {
  const events = [];
  providers.setWheatAiDiagnosticSink((event) => events.push(event));
  try {
    const { runtime } = recordingRuntime((modelId) =>
      modelId === "vendor/dead"
        ? new providers.WheatAiProviderError("MODEL_UNAVAILABLE", "openrouter", "retire", modelId)
        : "Voici ce que contient l'image.");
    const result = await providers.chatWithFailover(
      runtime,
      [model("vendor/dead", { supportsVision: true }), model("vendor/alive", { supportsVision: true })],
      { messages: IMAGE_TURN },
    );

    // The answer is exactly the model's answer: no switch notice, no counter.
    expect(result.text).toBe("Voici ce que contient l'image.");
    expect(result.text).not.toMatch(/bascul|Fallback|Tentative|indisponible/i);

    const names = events.map((event) => event.event);
    expect(names).toContain("wheat-ai.attempt-failed");
    expect(names).toContain("wheat-ai.failover-succeeded");
    const succeeded = events.find((event) => event.event === "wheat-ai.failover-succeeded");
    expect(succeeded.modelId).toBe("vendor/alive");
    expect(succeeded.skipped).toBe(1);
  } finally {
    providers.setWheatAiDiagnosticSink(null);
  }
});

test("a diagnostic never carries an API key", () => {
  const events = [];
  providers.setWheatAiDiagnosticSink((event) => events.push(event));
  try {
    providers.wheatAiDiagnostic({ event: "test", detail: "echec avec sk-or-abcdefghijklmnopqrstuvwxyz" });
    expect(events[0].detail).not.toMatch(/sk-or-abcdef/);
    expect(events[0].detail).toMatch(/masqu/);
  } finally {
    providers.setWheatAiDiagnosticSink(null);
  }
});

test("a failing diagnostic sink never fails the request", () => {
  providers.setWheatAiDiagnosticSink(() => { throw new Error("disque plein"); });
  try {
    expect(() => providers.wheatAiDiagnostic({ event: "test" })).not.toThrow();
  } finally {
    providers.setWheatAiDiagnosticSink(null);
  }
});

/* ------------------------------------------------- OCR review preferences --- */

function ipcDouble() {
  const handlers = new Map();
  return {
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    invoke: (channel, payload) => handlers.get(channel)(null, payload),
  };
}

function providerServiceForPreferences(directory) {
  return new service.WheatAiProviderService({
    directory,
    safeStorage: fakeSafeStorage(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" }),
  });
}

test("choosing a review model over IPC actually persists it", async () => {
  const directory = temporaryDirectory();
  const ipc = ipcDouble();
  const instance = providerServiceForPreferences(directory);
  service.registerWheatAiProviderIpc({ ipcMain: ipc.ipcMain, service: instance });

  const status = await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: "ollama:qwen3.5:9b" });

  // The status handed back is what re-renders the selector: a dropped field
  // there is indistinguishable from a dropdown that refuses the choice.
  expect(status.preferences.documentAiReviewModelId).toBe("ollama:qwen3.5:9b");
  expect(instance.getPreferences().documentAiReviewModelId).toBe("ollama:qwen3.5:9b");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the review model survives a restart", async () => {
  const directory = temporaryDirectory();
  const ipc = ipcDouble();
  service.registerWheatAiProviderIpc({ ipcMain: ipc.ipcMain, service: providerServiceForPreferences(directory) });
  await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: "ollama:qwen3.5:9b" });
  await ipc.invoke("wheat:ai:provider:preferences", { documentAiReview: true });

  // A second service over the same profile directory is what a restart is.
  const restarted = providerServiceForPreferences(directory);
  expect(restarted.getPreferences().documentAiReviewModelId).toBe("ollama:qwen3.5:9b");
  expect(restarted.getPreferences().documentAiReview).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("review activation is accepted once a model is chosen, and persists", async () => {
  const directory = temporaryDirectory();
  const ipc = ipcDouble();
  const instance = providerServiceForPreferences(directory);
  service.registerWheatAiProviderIpc({ ipcMain: ipc.ipcMain, service: instance });

  // Without a model the switch cannot latch: a review with nothing to run on
  // would be a setting that silently does nothing.
  const refused = await ipc.invoke("wheat:ai:provider:preferences", { documentAiReview: true });
  expect(refused.preferences.documentAiReview).toBe(false);

  const accepted = await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: "remote:openrouter:vendor/model:free", documentAiReview: true });
  expect(accepted.preferences.documentAiReview).toBe(true);
  expect(providerServiceForPreferences(directory).getPreferences().documentAiReview).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("clearing the review model turns the review off rather than leaving it armed", async () => {
  const directory = temporaryDirectory();
  const ipc = ipcDouble();
  service.registerWheatAiProviderIpc({ ipcMain: ipc.ipcMain, service: providerServiceForPreferences(directory) });
  await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: "ollama:llava", documentAiReview: true });

  const cleared = await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: null });
  expect(cleared.preferences.documentAiReviewModelId).toBeNull();
  expect(cleared.preferences.documentAiReview).toBe(false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("other provider preferences are not disturbed by the review settings", async () => {
  const directory = temporaryDirectory();
  const ipc = ipcDouble();
  service.registerWheatAiProviderIpc({ ipcMain: ipc.ipcMain, service: providerServiceForPreferences(directory) });
  await ipc.invoke("wheat:ai:provider:preferences", { automaticFreeModels: false, pinnedModelId: "remote:openrouter:vendor/pinned" });
  const status = await ipc.invoke("wheat:ai:provider:preferences", { documentAiReviewModelId: "ollama:qwen3.5:9b" });

  expect(status.preferences.automaticFreeModels).toBe(false);
  expect(status.preferences.pinnedModelId).toBe("remote:openrouter:vendor/pinned");
  expect(status.preferences.documentAiReviewModelId).toBe("ollama:qwen3.5:9b");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a stored review model that disappeared is kept rather than silently erased", async () => {
  const directory = temporaryDirectory();
  fs.writeFileSync(
    path.join(directory, "wheat-ai-providers.json"),
    JSON.stringify({ version: 1, preferences: { documentAiReview: true, documentAiReviewModelId: "ollama:supprime" }, tests: {} }),
  );
  const instance = providerServiceForPreferences(directory);
  const preferences = instance.getPreferences();

  // The choice is not erased behind the user's back - the settings screen
  // explains it is gone - and the OCR pipeline degrades to local-only.
  expect(preferences.documentAiReviewModelId).toBe("ollama:supprime");
  expect(preferences.documentAiReview).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});
