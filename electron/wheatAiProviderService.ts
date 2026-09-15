import fs from "node:fs";
import path from "node:path";
import {
  MAX_ATTEMPTS,
  ModelDiscoveryCache,
  PROVIDER_LABELS,
  UnavailableModelRegistry,
  WheatAiProviderError,
  buildCandidateList,
  chatWithFailover,
  createProviderAdapter,
  redactSecrets,
  requestCarriesImages,
  type ChatResult,
  type FreeModel,
  type ModelDiscovery,
  type ProviderAdapter,
  type WheatAiChatMessage,
} from "./wheatAiProviders";
import { SecureStorageUnavailableError, WheatAiSecretStore, type ProviderId } from "./wheatAiSecrets";
import { WHEAT_EDITION_PROFILE } from "../src/wheatEdition";
import { authorizeCloudProvider, type AuthorizeOptions } from "./cloudAuthorization";
import type { CloudOcrRuntime } from "./cloudOcr";

/**
 * Wheat AI provider service.
 *
 * Owns the non-secret preferences file, the secret store, the model discovery
 * cache and the IPC surface. Everything that touches an API key stays here, in
 * the main process; the renderer only ever receives masked metadata.
 */

export const WHEAT_AI_PROVIDER_CHANNELS = {
  status: "wheat:ai:provider:status",
  setKey: "wheat:ai:provider:set-key",
  deleteKey: "wheat:ai:provider:delete-key",
  test: "wheat:ai:provider:test",
  preferences: "wheat:ai:provider:preferences",
  models: "wheat:ai:provider:models",
  cloudStatus: "wheat:cloud:status",
  cloudAuthorize: "wheat:cloud:authorize",
  cloudDisconnect: "wheat:cloud:disconnect",
  cloudPreferences: "wheat:cloud:preferences",
} as const;

/**
 * The provider Wheat Cloud AI connects to without an API key.
 *
 * One provider offers an authorisation flow appropriate to a desktop
 * application today, so that is the one "Activer Wheat Cloud AI" uses. Naming
 * it here rather than throughout the cloud code is what keeps adding a second
 * one a change to this constant and an adapter, not to the document workflow.
 */
export const CLOUD_AUTHORIZATION_PROVIDER: ProviderId = "openrouter";

export const PROVIDER_IDS: ProviderId[] = ["openrouter", "groq"];

/** Model id understood by the AI workspace for the automatic free-model mode. */
export const AUTOMATIC_FREE_MODEL_ID = "remote:auto";
export const REMOTE_MODEL_PREFIX = "remote:";

export type ProviderPreferences = {
  /** "auto" ranks every configured provider's free models together. */
  activeProvider: ProviderId | "auto";
  /** `Automatic — Free models` — the default mode. */
  automaticFreeModels: boolean;
  /** Explicit model, used only when `automaticFreeModels` is false. */
  pinnedModelId: string | null;
  /** User attests this key belongs to a Groq Free-plan account. */
  groqFreeTierConfirmed: boolean;
  /**
   * Opt-in AI re-reading of scanned accounting documents.
   *
   * Off by default and deliberately separate from the assistant: turning it on
   * means document text — and, with a vision model, page images — is handed to
   * the selected model. With a local Ollama model nothing leaves the machine;
   * with a remote provider it does, which is exactly why this is a decision the
   * user makes rather than a default.
   */
  documentAiReview: boolean;
  /** Model used for that review. `ollama:<name>` stays fully local. */
  documentAiReviewModelId: string | null;
  /**
   * The shared pre-submission review layer (`electron/wheatReview.ts`).
   *
   * On by default: with no model reachable it is exactly the deterministic
   * accounting preflight, which nobody should have to switch on. Turning it
   * off disables only the optional contextual re-reading.
   */
  assistedReview: boolean;
  /**
   * Explicit informed consent to let a *remote* provider read dossier
   * extracts during that review. Off by default: a local model needs no
   * consent because nothing leaves the machine; a remote one does, because
   * something does.
   */
  assistedReviewRemoteConsent: boolean;
  /**
   * Which model performs the shared pre-submission review.
   *
   * Deliberately its own setting rather than a reuse of `pinnedModelId` or of
   * `documentAiReviewModelId`: those answer "who talks to me in the assistant"
   * and "who re-reads a scan", and an accountant asking *what model reviews my
   * accounting work* is entitled to an answer that is not "whichever of three
   * settings happened to apply".
   *
   * `null` means automatic — a healthy local model first, then, with consent, a
   * ranked free remote one. An explicit `ollama:<name>` or `remote:<provider>:<model>`
   * is honoured as given: a chosen model that is unavailable is reported as
   * unavailable, never quietly replaced by a different one.
   */
  assistedReviewModelId: string | null;
  /**
   * Whether scanned pages may be read by the configured cloud provider.
   *
   * The default is the edition's, not a constant: Wheat Lightweight does not
   * package the local recognition runtime, so cloud reading is how it reads a
   * scan at all, while Standard reads locally and treats this as an addition.
   * It stays a stored preference in both, because it is the user's decision in
   * both — a Lightweight user may switch it off and keep the offline fallback,
   * and a Standard user may switch it on.
   */
  cloudDocumentOcr: boolean;
  /**
   * Explicit, informed consent that a selected document may leave this machine.
   *
   * Separate from the switch above and never implied by it. Turning cloud
   * reading on is a capability decision; this is the acknowledgement that an
   * invoice, with its client names, ICE, IF, RC and amounts, is sent to the
   * configured provider for analysis. Wheat asks once, in plain French, before
   * the first document is ever sent.
   */
  cloudDocumentOcrConsent: boolean;
};

const DEFAULT_PREFERENCES: ProviderPreferences = {
  activeProvider: "auto",
  automaticFreeModels: true,
  pinnedModelId: null,
  groqFreeTierConfirmed: false,
  documentAiReview: false,
  documentAiReviewModelId: null,
  assistedReview: true,
  assistedReviewRemoteConsent: false,
  assistedReviewModelId: null,
  cloudDocumentOcr: WHEAT_EDITION_PROFILE.cloudOcrByDefault,
  cloudDocumentOcrConsent: false,
};

type ProviderStatusRow = {
  id: ProviderId;
  label: string;
  configured: boolean;
  maskedKey: string | null;
  keyUpdatedAt: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  freeModelCount: number | null;
  freeTierConfirmationRequired: boolean;
  freeTierConfirmed: boolean | null;
  eligibilityNote: string;
};

export type ProviderStatus = {
  secureStorageAvailable: boolean;
  secureStorageNote: string;
  providers: ProviderStatusRow[];
  preferences: ProviderPreferences;
  /** Provider + model Wheat AI would use for the next question. */
  activeSelection: { provider: ProviderId | null; modelId: string | null; label: string; reason: string };
  maxFailoverAttempts: number;
};

export type CloudStatus = {
  connected: boolean;
  providers: string[];
  authorizationProvider: string;
  canAuthorize: boolean;
  secureStorageAvailable: boolean;
  documentOcrEnabled: boolean;
  consentGiven: boolean;
  localRecognitionAvailable: boolean;
};

type TestRecord = { testedAt: string; ok: boolean; message: string; freeModelCount: number | null };

type PreferencesFile = { version: 1; preferences: ProviderPreferences; tests: Partial<Record<ProviderId, TestRecord>> };

type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };
type FetchLike = (url: string, init?: any) => Promise<any>;

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function asProviderId(value: unknown): ProviderId {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "openrouter" || text === "groq") return text;
  throw new Error("Fournisseur inconnu. Choisissez OpenRouter ou Groq.");
}

function normalizeStoredPreferences(value: unknown): ProviderPreferences {
  const source = record(value);
  const activeProvider = source.activeProvider === "openrouter" || source.activeProvider === "groq"
    ? source.activeProvider
    : "auto";
  const automaticFreeModels = typeof source.automaticFreeModels === "boolean" ? source.automaticFreeModels : true;
  const pinnedModelId = typeof source.pinnedModelId === "string" ? source.pinnedModelId.trim().slice(0, 200) || null : null;
  const groqFreeTierConfirmed = source.groqFreeTierConfirmed === true;
  const documentAiReview = source.documentAiReview === true;
  const documentAiReviewModelId = typeof source.documentAiReviewModelId === "string"
    ? source.documentAiReviewModelId.trim().slice(0, 200) || null
    : null;
  return {
    activeProvider,
    automaticFreeModels,
    pinnedModelId: automaticFreeModels ? null : pinnedModelId,
    groqFreeTierConfirmed,
    // A review switched on without a model would silently do nothing.
    documentAiReview: documentAiReview && Boolean(documentAiReviewModelId),
    documentAiReviewModelId,
    assistedReview: source.assistedReview !== false,
    assistedReviewRemoteConsent: source.assistedReviewRemoteConsent === true,
    assistedReviewModelId: typeof source.assistedReviewModelId === "string"
      ? source.assistedReviewModelId.trim().slice(0, 200) || null
      : null,
    // Absent means "never decided", which is the edition's answer, not `false`:
    // a Lightweight install that had never opened this screen would otherwise
    // have no way to read a scan at all.
    cloudDocumentOcr: typeof source.cloudDocumentOcr === "boolean" ? source.cloudDocumentOcr : WHEAT_EDITION_PROFILE.cloudOcrByDefault,
    cloudDocumentOcrConsent: source.cloudDocumentOcrConsent === true,
  };
}

export class WheatAiProviderService {
  private readonly secrets: WheatAiSecretStore;
  private readonly preferencesPath: string;
  private readonly cache = new ModelDiscoveryCache();
  /**
   * Models the providers have just refused outright. Consulted when the
   * candidate list is built so a withdrawn model is not re-tried on every
   * question, and cleared with the discovery cache when a key changes.
   */
  private readonly unavailable = new UnavailableModelRegistry();
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  /**
   * How this service reaches a provider. Held rather than only handed to the
   * adapters because the authorisation exchange is the same outbound call to
   * the same host, and must not reach it by a different route than everything
   * else — a machine where one works and the other does not is the worst
   * possible split.
   */
  private readonly fetchImpl: FetchLike;

  constructor(options: { directory: string; safeStorage: ConstructorParameters<typeof WheatAiSecretStore>[0]["safeStorage"]; fetchImpl?: FetchLike }) {
    this.secrets = new WheatAiSecretStore({ directory: options.directory, safeStorage: options.safeStorage });
    this.preferencesPath = path.join(options.directory, "wheat-ai-providers.json");
    this.fetchImpl = options.fetchImpl ?? ((url: string, init?: any) => (globalThis as any).fetch(url, init));
    for (const provider of PROVIDER_IDS) this.adapters.set(provider, createProviderAdapter(provider, this.fetchImpl));
  }

  /* ------------------------------------------------------------ preferences */

  private readFile(): PreferencesFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.preferencesPath, "utf8")) as PreferencesFile;
      if (!parsed || parsed.version !== 1) return { version: 1, preferences: { ...DEFAULT_PREFERENCES }, tests: {} };
      return {
        version: 1,
        preferences: normalizeStoredPreferences(parsed.preferences),
        tests: record(parsed.tests) as PreferencesFile["tests"],
      };
    } catch {
      return { version: 1, preferences: { ...DEFAULT_PREFERENCES }, tests: {} };
    }
  }

  private writeFile(file: PreferencesFile): void {
    fs.mkdirSync(path.dirname(this.preferencesPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.preferencesPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.preferencesPath);
  }

  getPreferences(): ProviderPreferences {
    return this.readFile().preferences;
  }

  setPreferences(patch: Partial<ProviderPreferences>): ProviderPreferences {
    const file = this.readFile();
    const next: ProviderPreferences = { ...file.preferences };

    if (patch.activeProvider !== undefined) {
      const value = String(patch.activeProvider);
      next.activeProvider = value === "auto" ? "auto" : asProviderId(value);
    }
    if (patch.automaticFreeModels !== undefined) {
      if (typeof patch.automaticFreeModels !== "boolean") throw new Error("Le mode de sélection automatique est invalide.");
      next.automaticFreeModels = patch.automaticFreeModels;
    }
    if (patch.pinnedModelId !== undefined) {
      if (patch.pinnedModelId !== null && typeof patch.pinnedModelId !== "string") throw new Error("Le modèle sélectionné est invalide.");
      const value = patch.pinnedModelId === null ? null : patch.pinnedModelId.trim().slice(0, 200);
      next.pinnedModelId = value || null;
    }
    if (patch.groqFreeTierConfirmed !== undefined) {
      if (typeof patch.groqFreeTierConfirmed !== "boolean") throw new Error("La confirmation du forfait gratuit Groq est invalide.");
      next.groqFreeTierConfirmed = patch.groqFreeTierConfirmed;
    }
    if (patch.documentAiReviewModelId !== undefined) {
      if (patch.documentAiReviewModelId !== null && typeof patch.documentAiReviewModelId !== "string") throw new Error("Le modele de relecture des documents est invalide.");
      const value = patch.documentAiReviewModelId === null ? null : patch.documentAiReviewModelId.trim().slice(0, 200);
      next.documentAiReviewModelId = value || null;
    }
    if (patch.assistedReview !== undefined) {
      if (typeof patch.assistedReview !== "boolean") throw new Error("Le reglage de relecture partagee est invalide.");
      next.assistedReview = patch.assistedReview;
    }
    if (patch.assistedReviewRemoteConsent !== undefined) {
      if (typeof patch.assistedReviewRemoteConsent !== "boolean") throw new Error("Le consentement de relecture distante est invalide.");
      next.assistedReviewRemoteConsent = patch.assistedReviewRemoteConsent;
    }
    if (patch.assistedReviewModelId !== undefined) {
      if (patch.assistedReviewModelId !== null && typeof patch.assistedReviewModelId !== "string") throw new Error("Le modele de relecture est invalide.");
      const value = patch.assistedReviewModelId === null ? null : patch.assistedReviewModelId.trim().slice(0, 200);
      next.assistedReviewModelId = value || null;
    }
    if (patch.cloudDocumentOcr !== undefined) {
      if (typeof patch.cloudDocumentOcr !== "boolean") throw new Error("Le reglage de lecture des pieces par le cloud est invalide.");
      next.cloudDocumentOcr = patch.cloudDocumentOcr;
    }
    if (patch.cloudDocumentOcrConsent !== undefined) {
      if (typeof patch.cloudDocumentOcrConsent !== "boolean") throw new Error("Le consentement de traitement cloud est invalide.");
      next.cloudDocumentOcrConsent = patch.cloudDocumentOcrConsent;
    }
    if (patch.documentAiReview !== undefined) {
      if (typeof patch.documentAiReview !== "boolean") throw new Error("Le reglage de relecture IA des documents est invalide.");
      next.documentAiReview = patch.documentAiReview;
    }
    // The review cannot be on without a model to run it.
    if (!next.documentAiReviewModelId) next.documentAiReview = false;
    // Automatic mode never keeps a pinned model: the two settings would
    // contradict each other the moment the pinned model became unavailable.
    if (next.automaticFreeModels) next.pinnedModelId = null;

    this.writeFile({ ...file, preferences: next });
    return next;
  }

  /* ----------------------------------------------------------------- keys */

  isSecureStorageAvailable(): boolean {
    return this.secrets.isSecureStorageAvailable();
  }

  setKey(provider: ProviderId, apiKey: string): void {
    this.secrets.setKey(provider, apiKey);
    this.cache.clear(provider);
    this.unavailable.clear();
    const file = this.readFile();
    delete file.tests[provider];
    if (provider === "groq") file.preferences.groqFreeTierConfirmed = false;
    this.writeFile(file);
  }

  deleteKey(provider: ProviderId): void {
    this.secrets.deleteKey(provider);
    this.cache.clear(provider);
    this.unavailable.clear();
    const file = this.readFile();
    delete file.tests[provider];
    // A pinned model belonging to the removed provider can no longer be used.
    if (file.preferences.pinnedModelId?.startsWith(`${REMOTE_MODEL_PREFIX}${provider}:`)) {
      file.preferences.pinnedModelId = null;
      file.preferences.automaticFreeModels = true;
    }
    if (file.preferences.activeProvider === provider) file.preferences.activeProvider = "auto";
    if (provider === "groq") file.preferences.groqFreeTierConfirmed = false;
    this.writeFile(file);
  }

  configuredProviders(): ProviderId[] {
    return this.secrets.configuredProviders();
  }

  /** Main-process only. Never expose the return value over IPC. */
  private key(provider: ProviderId): string | null {
    return this.secrets.getKey(provider);
  }

  /* ------------------------------------------------------------ discovery */

  private async discoverAvailable(provider: ProviderId, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelDiscovery> {
    if (!options.refresh) {
      const cached = this.cache.get(provider);
      if (cached) return cached;
    }
    const apiKey = this.key(provider);
    if (!apiKey) throw new Error(`Aucune clé d'API n'est enregistrée pour ${PROVIDER_LABELS[provider]}.`);
    const discovery = await this.adapters.get(provider)!.listFreeModels(apiKey, options.signal);
    this.cache.set(provider, discovery);
    return discovery;
  }

  async discover(provider: ProviderId, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelDiscovery> {
    const discovery = await this.discoverAvailable(provider, options);
    if (provider !== "groq" || this.getPreferences().groqFreeTierConfirmed) return discovery;
    return {
      ...discovery,
      models: [],
      rejected: [
        ...discovery.rejected,
        ...discovery.models.map((model) => ({
          id: model.id,
          reason: "Groq ne publie pas le forfait ni un prix nul dans /models : confirmez explicitement que cette clé appartient à un compte Groq Free.",
        })),
      ],
    };
  }

  /** Free models across every configured provider, ranked best-first. */
  async discoverAll(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ discoveries: ModelDiscovery[]; errors: Array<{ provider: ProviderId; message: string }> }> {
    const discoveries: ModelDiscovery[] = [];
    const errors: Array<{ provider: ProviderId; message: string }> = [];
    for (const provider of this.configuredProviders()) {
      try {
        discoveries.push(await this.discover(provider, options));
      } catch (error) {
        errors.push({ provider, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      }
    }
    return { discoveries, errors };
  }

  /* ---------------------------------------------------------------- test */

  /**
   * Vérifiés a stored key by listing models. It never sends a chat request, so
   * a connection test can never consume the user's free quota.
   */
  async testProvider(provider: ProviderId): Promise<{ ok: boolean; message: string; freeModelCount: number | null; sampleModelId: string | null }> {
    const file = this.readFile();
    let result: { ok: boolean; message: string; freeModelCount: number | null; sampleModelId: string | null };
    try {
      const discovery = await this.discoverAvailable(provider, { refresh: true });
      if (provider === "groq" && discovery.models.length) {
        const confirmed = file.preferences.groqFreeTierConfirmed;
        result = {
          ok: true,
          message: confirmed
            ? `Connexion réussie. ${discovery.models.length} modèle(s) Groq accessible(s) sous votre confirmation de forfait Free.`
            : `Connexion réussie. ${discovery.models.length} modèle(s) Groq accessible(s). Groq ne fournit ni forfait ni prix nul dans /models : confirmez votre compte Free avant toute utilisation.`,
          freeModelCount: confirmed ? discovery.models.length : 0,
          sampleModelId: confirmed ? discovery.models[0].id : null,
        };
      } else {
      result = discovery.models.length
        ? {
            ok: true,
            message: `Connexion réussie. ${discovery.models.length} modèle(s) gratuit(s) vérifié(s) sur ${PROVIDER_LABELS[provider]}.`,
            freeModelCount: discovery.models.length,
            sampleModelId: discovery.models[0].id,
          }
        : {
            ok: false,
            message: `La clé fonctionne, mais ${PROVIDER_LABELS[provider]} n'expose actuellement aucun modèle dont la gratuité soit confirmée par ses métadonnées. Wheat refusé d'utiliser un modèle au tarif inconnu.`,
            freeModelCount: 0,
            sampleModelId: null,
          };
      }
    } catch (error) {
      result = {
        ok: false,
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
        freeModelCount: null,
        sampleModelId: null,
      };
    }
    file.tests[provider] = {
      testedAt: new Date().toISOString(),
      ok: result.ok,
      message: result.message,
      freeModelCount: result.freeModelCount,
    };
    this.writeFile(file);
    return result;
  }

  /* --------------------------------------------------------------- status */

  async getStatus(options: { refreshModels?: boolean } = {}): Promise<ProviderStatus> {
    const file = this.readFile();
    const secureStorageAvailable = this.isSecureStorageAvailable();

    const providers: ProviderStatusRow[] = PROVIDER_IDS.map((provider) => {
      const described = this.secrets.describe(provider);
      const test = file.tests[provider];
      return {
        id: provider,
        label: PROVIDER_LABELS[provider],
        configured: described.configured,
        maskedKey: described.maskedKey,
        keyUpdatedAt: described.updatedAt,
        lastTestedAt: test?.testedAt ?? null,
        lastTestOk: test?.ok ?? null,
        lastTestMessage: test?.message ?? null,
        freeModelCount: provider === "groq" && !file.preferences.groqFreeTierConfirmed
          ? 0
          : test?.freeModelCount ?? this.cache.get(provider)?.models.length ?? null,
        freeTierConfirmationRequired: provider === "groq",
        freeTierConfirmed: provider === "groq" ? file.preferences.groqFreeTierConfirmed : null,
        eligibilityNote: provider === "groq"
          ? file.preferences.groqFreeTierConfirmed
            ? "Modèles accessibles autorisés sous votre confirmation que cette clé appartient à un compte Groq Free."
            : "Groq ne publie pas le forfait ni un prix nul dans /models. Confirmez que cette clé appartient à un compte Groq Free avant toute sélection ou requête."
          : "La gratuité OpenRouter est vérifiée modèle par modèle dans les métadonnées de prix.",
      };
    });

    let activeSelection: ProviderStatus["activeSelection"] = {
      provider: null,
      modelId: null,
      label: "Aucun fournisseur configure",
      reason: "Ajoutez une clé d'API OpenRouter ou Groq pour activer Wheat AI à distance.",
    };

    if (this.configuredProviders().length) {
      if (file.preferences.automaticFreeModels) {
        const { discoveries } = await this.discoverAll({ refresh: options.refreshModels });
        const candidates = buildCandidateList(discoveries, { preferredProvider: file.preferences.activeProvider });
        activeSelection = candidates.length
          ? {
              provider: candidates[0].provider,
              modelId: candidates[0].id,
              label: `${candidates[0].label} · ${PROVIDER_LABELS[candidates[0].provider]}`,
              reason: `Automatique — modèles gratuits : ${candidates[0].rankingReason}.`,
            }
          : {
              provider: null,
              modelId: null,
              label: "Aucun modèle gratuit éligible",
              reason: this.configuredProviders().includes("groq") && !file.preferences.groqFreeTierConfirmed
                ? "Confirmez dans Réglages que la clé appartient à un compte Groq Free; Wheat refuse sinon toute sélection ou requête Groq."
                : "Aucun modèle dont la gratuité soit confirmée n'est actuellement disponible chez les fournisseurs configures.",
            };
      } else if (file.preferences.pinnedModelId) {
        const parsed = parseRemoteModelId(file.preferences.pinnedModelId);
        activeSelection = {
          provider: parsed?.provider ?? null,
          modelId: parsed?.modelId ?? file.preferences.pinnedModelId,
          label: parsed ? `${parsed.modelId} · ${PROVIDER_LABELS[parsed.provider]}` : file.preferences.pinnedModelId,
          reason: "Modèle choisi manuellement. Le basculement automatique reste actif en cas d'indisponibilite.",
        };
      } else {
        activeSelection = {
          provider: null,
          modelId: null,
          label: "Aucun modèle sélectionné",
          reason: "Activez « Automatique — modèles gratuits » ou choisissez un modèle dans la liste.",
        };
      }
    }

    return {
      secureStorageAvailable,
      secureStorageNote: secureStorageAvailable
        ? "Les clés sont chiffrees par le coffre-fort du système d'exploitation et ne quittent jamais ce poste."
        : "Le coffre-fort du système est indisponible : Wheat refusé d'enregistrer une clé tant qu'il ne peut pas la chiffrer.",
      providers,
      preferences: file.preferences,
      activeSelection,
      maxFailoverAttempts: MAX_ATTEMPTS,
    };
  }

  /* ---------------------------------------------------------- Wheat Cloud AI */

  /**
   * What the accountant's "Wheat Cloud AI" panel shows.
   *
   * Deliberately not the advanced provider screen. That screen exists, keeps
   * every one of its capabilities, and belongs to whoever wants to pin a model
   * or paste a key of their own. This is the other audience: a status line, a
   * connect button and nothing they have to understand.
   */
  getCloudStatus(): CloudStatus {
    const preferences = this.getPreferences();
    const configured = this.configuredProviders();
    const connected = configured.length > 0;
    return {
      connected,
      // Named only when it is the connection the guided flow established;
      // a hand-configured provider is still a connection, and still counts.
      providers: configured.map((provider) => PROVIDER_LABELS[provider]),
      authorizationProvider: PROVIDER_LABELS[CLOUD_AUTHORIZATION_PROVIDER],
      canAuthorize: this.isSecureStorageAvailable(),
      secureStorageAvailable: this.isSecureStorageAvailable(),
      documentOcrEnabled: preferences.cloudDocumentOcr,
      consentGiven: preferences.cloudDocumentOcrConsent,
      /**
       * Whether a scan can be read at all without the cloud on this build.
       * True for Standard, which packages the local recognition runtime.
       */
      localRecognitionAvailable: WHEAT_EDITION_PROFILE.hasBundledLocalOcr,
    };
  }

  /**
   * Connects Wheat Cloud AI to the user's own provider account.
   *
   * The key that comes back is theirs, is stored through the OS credential
   * vault by the same store every other key uses, and is never returned to the
   * renderer. Wheat holds no credential of its own anywhere in this path.
   */
  async authorizeCloud(options: AuthorizeOptions): Promise<CloudStatus> {
    if (!this.isSecureStorageAvailable()) throw new SecureStorageUnavailableError();
    const key = await authorizeCloudProvider({ fetchImpl: this.fetchImpl, ...options });
    // Through `setKey`, so shape validation, cache invalidation and the masked
    // record behave exactly as they do for a key somebody typed in.
    this.setKey(CLOUD_AUTHORIZATION_PROVIDER, key);
    return this.getCloudStatus();
  }

  /** Forgets the stored credential. The provider account itself is untouched. */
  disconnectCloud(): CloudStatus {
    for (const provider of this.configuredProviders()) this.deleteKey(provider);
    return this.getCloudStatus();
  }

  /**
   * The recognition runtime handed to the OCR pipeline.
   *
   * The pipeline sees a connection test and one vision call; the credential,
   * the model ranking, the vision-capability filter and the bounded failover
   * all stay here, behind the main-process boundary.
   */
  cloudOcrRuntime(): CloudOcrRuntime {
    return {
      isConnected: () => this.isRemoteAvailable(),
      runVision: async (request) => {
        const result = await this.chat({
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user, images: request.images },
          ],
          temperature: 0,
          // A full page of transcription is long; the assistant's 1024 default
          // would cut an invoice off halfway down its line items.
          maxTokens: 4096,
        });
        return { text: result.text, provider: PROVIDER_LABELS[result.provider], modelId: result.modelId };
      },
    };
  }

  /** Free models exposed to the UI, prefixed so the AI workspace can route them. */
  async listSelectableModels(options: { refresh?: boolean } = {}): Promise<{
    models: Array<FreeModel & { selectionId: string }>;
    rejected: Array<{ provider: ProviderId; id: string; reason: string }>;
    errors: Array<{ provider: ProviderId; message: string }>;
  }> {
    const { discoveries, errors } = await this.discoverAll({ refresh: options.refresh });
    const models = discoveries
      .flatMap((discovery) => discovery.models)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((model) => ({ ...model, selectionId: `${REMOTE_MODEL_PREFIX}${model.provider}:${model.id}` }));
    const rejected = discoveries.flatMap((discovery) =>
      discovery.rejected.map((entry) => ({ provider: discovery.provider, id: entry.id, reason: entry.reason })),
    );
    return { models, rejected, errors };
  }

  /* ----------------------------------------------------------------- chat */

  isRemoteAvailable(): boolean {
    return this.configuredProviders().length > 0;
  }

  /**
   * Runs a Wheat AI question against the ranked free models, with bounded
   * failover. Cross-provider fallback happens only when both keys exist.
   */
  async chat(request: {
    messages: WheatAiChatMessage[];
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    maxTokens?: number;
    pinnedModelId?: string | null;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    const preferences = this.getPreferences();
    const configured = this.configuredProviders();
    if (!configured.length) {
      throw new Error("Aucune clé d'API n'est enregistrée. Ouvrez Réglages > Wheat AI pour en ajouter une.");
    }

    const { discoveries, errors } = await this.discoverAll({ signal: request.signal });
    if (!discoveries.length) {
      const detail = errors.map((entry) => `${PROVIDER_LABELS[entry.provider]} : ${entry.message}`).join(" ");
      throw new Error(`La liste des modèles gratuits n'a pas pu etre chargée. ${detail}`.trim());
    }

    // `null` from a caller means "automatic, and I mean it": the reviewer picks
    // its own model independently of the assistant's, and inheriting the
    // workspace's pinned model here let one setting silently answer for the
    // other. Only an omitted field falls back to the stored preference.
    const requestedPin = request.pinnedModelId !== undefined
      ? request.pinnedModelId
      : (preferences.automaticFreeModels ? null : preferences.pinnedModelId);
    const parsedPin = requestedPin ? parseRemoteModelId(requestedPin) : null;

    // A single configured provider stays inside that provider; with both keys
    // present the ranked list may cross providers.
    const preferredProvider = configured.length === 1 ? configured[0] : (parsedPin?.provider ?? preferences.activeProvider);

    // Eligibility travels with the request rather than being re-derived: an
    // image request must only ever reach a model whose provider says it reads
    // images, and that decision is made once, here and in `chatWithFailover`.
    const needs = { images: requestCarriesImages(request.messages), tools: Boolean(request.tools?.length) };

    const candidates = buildCandidateList(discoveries, {
      preferredProvider,
      pinnedProvider: parsedPin?.provider ?? null,
      pinnedModelId: parsedPin?.modelId ?? null,
      needs,
      unavailable: this.unavailable,
    });

    /*
     * A provider that could not be reached leaves no models behind, and an
     * empty list is indistinguishable from a provider that genuinely offers
     * nothing suitable — except that `errors` remembers the difference. Without
     * this, a dropped connection while one provider still answers with zero
     * usable models is reported as "no model here can read an image", which
     * sends somebody to their account settings to fix their internet. The
     * partial failure is the more likely explanation and the actionable one, so
     * it is the one reported.
     */
    if (!candidates.length && errors.length) {
      const detail = errors.map((entry) => `${PROVIDER_LABELS[entry.provider]} : ${entry.message}`).join(" ");
      throw new WheatAiProviderError(
        "PROVIDER_ERROR",
        errors[0].provider,
        `La liste des modèles n'a pas pu être chargée entièrement, aucun modèle utilisable n'est disponible. ${detail}`.trim(),
      );
    }

    return chatWithFailover(
      {
        getKey: (provider) => this.key(provider),
        adapter: (provider) => this.adapters.get(provider)!,
      },
      candidates,
      request,
      { unavailable: this.unavailable },
    );
  }
}

/** `remote:openrouter:meta-llama/llama-3.3-70b-instruct:free` → parts. */
export function parseRemoteModelId(value: string): { provider: ProviderId; modelId: string } | null {
  const text = String(value ?? "");
  if (!text.startsWith(REMOTE_MODEL_PREFIX)) return null;
  const rest = text.slice(REMOTE_MODEL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const provider = rest.slice(0, separator);
  const modelId = rest.slice(separator + 1);
  if ((provider !== "openrouter" && provider !== "groq") || !modelId) return null;
  return { provider, modelId };
}

/* ------------------------------------------------------------------- IPC */

/**
 * Minimal IPC surface. Every payload is validated here; nothing that could
 * carry a key back to the renderer is ever returned.
 */
export function registerWheatAiProviderIpc(options: {
  ipcMain: IpcLike;
  service: WheatAiProviderService;
  /** Opens a URL in the system browser. Supplied by the main process. */
  openExternal: (url: string) => Promise<void> | void;
}): WheatAiProviderService {
  const { ipcMain, service } = options;

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.status, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    return service.getStatus({ refreshModels: payload.refreshModels === true });
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.setKey, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const provider = asProviderId(payload.provider);
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
    try {
      service.setKey(provider, apiKey);
    } catch (error) {
      if (error instanceof SecureStorageUnavailableError) throw error;
      // Never let the submitted key echo back inside a validation message.
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)), { cause: error });
    }
    return service.getStatus();
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.deleteKey, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    service.deleteKey(asProviderId(payload.provider));
    return service.getStatus();
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.test, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    return service.testProvider(asProviderId(payload.provider));
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.preferences, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    // Every field of `ProviderPreferences` is forwarded. Listing only some of
    // them silently dropped the two OCR-review settings: the renderer sent the
    // chosen review model, the main process wrote the file without it, and the
    // status that came back re-rendered the selector as empty — which looked
    // exactly like a dropdown that refuses to accept a choice.
    service.setPreferences({
      activeProvider: payload.activeProvider as ProviderPreferences["activeProvider"] | undefined,
      automaticFreeModels: payload.automaticFreeModels as boolean | undefined,
      pinnedModelId: payload.pinnedModelId as string | null | undefined,
      groqFreeTierConfirmed: payload.groqFreeTierConfirmed as boolean | undefined,
      documentAiReview: payload.documentAiReview as boolean | undefined,
      documentAiReviewModelId: payload.documentAiReviewModelId as string | null | undefined,
      assistedReview: payload.assistedReview as boolean | undefined,
      assistedReviewRemoteConsent: payload.assistedReviewRemoteConsent as boolean | undefined,
      assistedReviewModelId: payload.assistedReviewModelId as string | null | undefined,
      cloudDocumentOcr: payload.cloudDocumentOcr as boolean | undefined,
      cloudDocumentOcrConsent: payload.cloudDocumentOcrConsent as boolean | undefined,
    });
    return service.getStatus();
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.models, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    try {
      return await service.listSelectableModels({ refresh: payload.refresh === true });
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)), { cause: error });
    }
  });

  /* ------------------------------------------------------- Wheat Cloud AI */

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.cloudStatus, async () => service.getCloudStatus());

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.cloudAuthorize, async () => {
    try {
      // The URL is built inside the authorisation flow and opened in the
      // *system* browser. The renderer never supplies it, so nothing it could
      // send can make Wheat open an address of the renderer's choosing.
      return await service.authorizeCloud({ openExternal: options.openExternal });
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)), { cause: error });
    }
  });

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.cloudDisconnect, async () => service.disconnectCloud());

  ipcMain.handle(WHEAT_AI_PROVIDER_CHANNELS.cloudPreferences, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    service.setPreferences({
      cloudDocumentOcr: payload.documentOcrEnabled as boolean | undefined,
      cloudDocumentOcrConsent: payload.consentGiven as boolean | undefined,
    });
    return service.getCloudStatus();
  });

  return service;
}

export { WheatAiProviderError };
