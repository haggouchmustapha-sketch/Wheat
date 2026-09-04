/**
 * Which model reviews the accounting work, and what happens when it cannot.
 *
 * Two faults are fixed here and both were invisible from the interface, which
 * is what made them worth testing rather than merely fixing.
 *
 * A model chosen explicitly was only honoured when it was a local one. A person
 * who picked a remote model in the settings got Wheat's automatic local ranking
 * instead, and the surface then attributed the reading to whatever had actually
 * run — so the setting appeared to work and did not. A chosen model that cannot
 * answer is now reported as having failed; it is never quietly replaced, because
 * a different model's opinion presented as the chosen one's is worse than no
 * opinion at all.
 *
 * And local-model discovery was an HTTP round trip in front of *every* review.
 * On a machine with no Ollama it was a connection failure the person waited
 * through before the deterministic result could even be shown.
 *
 * The preference is exercised through the real service and a real preferences
 * file, so persistence across a restart is asserted rather than assumed. No
 * provider key appears anywhere in this file, and no request leaves the machine.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const providerModule = tsxRequire(path.join(root, "electron", "wheatAiProviderService.ts"), __filename);

test.describe("AI reviewer model selection", () => {
  let userData;

  test.beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-review-model-"));
  });

  test.afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  /** Reversible stand-in for Electron `safeStorage`; never a real OS keychain. */
  const fakeSafeStorage = () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  });

  const service = () => new providerModule.WheatAiProviderService({
    directory: userData,
    safeStorage: fakeSafeStorage(),
    // No network is reachable from this suite: a reviewer-model preference is a
    // stored choice, and storing one must never call a provider.
    fetchImpl: () => { throw new Error("aucune requête réseau n'est permise dans ce test"); },
  });

  /* ------------------------------------------------------ the preference */

  test("the reviewer's model is its own setting, and starts automatic", () => {
    const preferences = service().getPreferences();
    // `null` is automatic. It is deliberately not the assistant's pinned model
    // nor the scan reader's: those answer different questions.
    expect(preferences.assistedReviewModelId).toBeNull();
    expect(preferences).toHaveProperty("pinnedModelId");
    expect(preferences).toHaveProperty("documentAiReviewModelId");
  });

  test("an explicit reviewer model survives a restart", () => {
    const first = service();
    first.setPreferences({ assistedReviewModelId: "ollama:qwen2.5:14b" });
    expect(first.getPreferences().assistedReviewModelId).toBe("ollama:qwen2.5:14b");

    // A new service over the same profile is what a restart looks like.
    expect(service().getPreferences().assistedReviewModelId).toBe("ollama:qwen2.5:14b");
  });

  test("choosing a reviewer model does not disturb the assistant's or the scanner's", () => {
    const instance = service();
    // The assistant's own pin only exists while its automatic mode is off —
    // that coupling is the assistant's, and the reviewer must not inherit it.
    instance.setPreferences({ automaticFreeModels: false, pinnedModelId: "remote:openrouter:some-model", documentAiReviewModelId: "ollama:llava" });
    instance.setPreferences({ assistedReviewModelId: "ollama:qwen2.5:14b" });
    const preferences = instance.getPreferences();
    expect(preferences.assistedReviewModelId).toBe("ollama:qwen2.5:14b");
    expect(preferences.pinnedModelId).toBe("remote:openrouter:some-model");
    expect(preferences.documentAiReviewModelId).toBe("ollama:llava");
  });

  test("the reviewer's model is not cleared by the assistant's automatic mode", () => {
    // `automaticFreeModels` erases the assistant's pin by design. The reviewer's
    // model is a different question and keeps its answer.
    const instance = service();
    instance.setPreferences({ assistedReviewModelId: "ollama:qwen2.5:14b", automaticFreeModels: false, pinnedModelId: "remote:groq:x" });
    instance.setPreferences({ automaticFreeModels: true });
    expect(instance.getPreferences().pinnedModelId).toBeNull();
    expect(instance.getPreferences().assistedReviewModelId).toBe("ollama:qwen2.5:14b");
  });

  test("returning to automatic is a value, not a deletion", () => {
    const instance = service();
    instance.setPreferences({ assistedReviewModelId: "ollama:qwen2.5:14b" });
    instance.setPreferences({ assistedReviewModelId: null });
    expect(instance.getPreferences().assistedReviewModelId).toBeNull();
  });

  test("a non-string reviewer model is refused rather than coerced", () => {
    expect(() => service().setPreferences({ assistedReviewModelId: 42 })).toThrow(/modele de relecture/i);
  });

  test("the stored reviewer model is bounded, like every other stored string", () => {
    const instance = service();
    instance.setPreferences({ assistedReviewModelId: "ollama:".concat("x".repeat(500)) });
    expect(instance.getPreferences().assistedReviewModelId.length).toBeLessThanOrEqual(200);
  });

  /* --------------------------------------------------- credential safety */

  test("preferences never carry a provider key", () => {
    const instance = service();
    instance.setPreferences({ assistedReviewModelId: "remote:openrouter:free-model" });
    const serialised = JSON.stringify(instance.getPreferences());
    // The vault holds keys; the preferences hold choices. Nothing that crosses
    // the bridge may contain a secret.
    expect(serialised).not.toMatch(/sk-|api[_-]?key|Bearer/i);
    for (const value of Object.values(instance.getPreferences())) {
      expect(typeof value === "string" ? value : "").not.toMatch(/^sk-/);
    }
  });

  test("the profile file written to disk carries no key either", () => {
    const instance = service();
    instance.setPreferences({ assistedReviewModelId: "remote:groq:free-model", assistedReviewRemoteConsent: true });
    const files = fs.readdirSync(userData, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
    for (const file of files) {
      const contents = fs.readFileSync(file, "utf8");
      expect(contents, `${file} must not contain a key`).not.toMatch(/sk-[A-Za-z0-9]{8}/);
    }
  });

  /* ------------------------------------------------- free-model discipline */

  test("only a provider's own zero price makes a model free", () => {
    // OpenRouter states prompt and completion pricing per model. A model whose
    // price is absent, unparseable or above zero is rejected rather than
    // assumed free: an accountant must not be billed by a default.
    const openRouter = tsxRequire(path.join(root, "electron", "wheatAiProviders.ts"), __filename);
    const { models, rejected } = openRouter.selectOpenRouterFreeModels({
      data: [
        { id: "free/one", name: "Free one", context_length: 32768, pricing: { prompt: "0", completion: "0" } },
        { id: "paid/one", name: "Paid one", context_length: 32768, pricing: { prompt: "0.0000012", completion: "0.000002" } },
        { id: "unknown/one", name: "Unknown price", context_length: 32768, pricing: {} },
        { id: "half/one", name: "Half free", context_length: 32768, pricing: { prompt: "0", completion: "0.000001" } },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["free/one"]);
    // And every rejection is explained, so "why is this model missing" has an
    // answer that is not "Wheat decided".
    expect(rejected.map((item) => item.id).sort()).toEqual(["half/one", "paid/one", "unknown/one"]);
    for (const item of rejected) expect(item.reason).toBeTruthy();
  });
});
