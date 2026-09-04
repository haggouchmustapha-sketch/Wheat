import type { ProviderId } from "./wheatAiSecrets";

/**
 * Wheat AI remote providers — OpenRouter and Groq.
 *
 * Design constraints, in order of importance:
 *
 *  1. **No silent paid usage.** A model is éligible only when the provider's
 *     own metadata proves it is free. For OpenRouter that means prompt AND
 *     completion pricing parse to exactly zero; unknown or unparseable pricing
 *     is rejected, never assumed free. Groq does not expose billing tier or
 *     zero-cost pricing in `/models`; the provider service therefore requires
 *     an explicit Free-plan attestation before these discovered models become
 *     eligible — Wheat never invents or hard-codes a model identifier.
 *  2. **No key leakage.** Keys are passed as arguments, used once to build an
 *     Authorization header, and never logged or copied into an error message.
 *     `redactSecrets()` scrubs anything provider-shaped out of error text.
 *  3. **Bounded failover.** Retryable conditions (rate limit, quota, model
 *     unavailable, timeout, transient 5xx) move to the next éligible model, at
 *     most `MAX_ATTEMPTS` times, never revisiting a model. Non-retryable
 *     conditions (bad key, revoked authorization, malformed request, safety
 *     refusal, user cancellation) stop immediately.
 *
 * Everything here runs in the main process. The renderer never sees a key,
 * a raw provider response, or an unredacted provider error.
 */

export type WheatAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Base64 image payloads (no data: prefix) attached to this turn. Only ever
   * populated for a model whose provider metadata declares image input; the
   * provider adapter turns them into the OpenAI content-part shape.
   */
  images?: Array<{ mimeType: string; base64: string }>;
};

/**
 * OpenAI-compatible wire shape. A turn without images stays a plain string, so
 * a text-only model sees exactly the request it saw before image support
 * existed.
 */
function chatMessageForWire(message: WheatAiChatMessage) {
  if (!message.images?.length || message.role !== "user") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
      })),
    ],
  };
}

export type FreeModel = {
  id: string;
  provider: ProviderId;
  label: string;
  /** Maximum prompt + completion tokens the model accepts. */
  contextTokens: number;
  supportsTools: boolean;
  /**
   * True only when the provider's own metadata lists an image input modality.
   * Wheat AI shows the image attachment control for exactly these models and
   * refuses to send an image to any other, so an absent or unreadable modality
   * list must read as `false`, never as "probably yes".
   */
  supportsVision: boolean;
  /** Ranking score — higher is better. Explained by `rankingReason`. */
  score: number;
  rankingReason: string;
};

/**
 * Reads image support out of a provider model listing.
 *
 * OpenRouter publishes `architecture.input_modalities`; Groq's OpenAI-shaped
 * listing has no modality field at all, so its models stay text-only until the
 * provider says otherwise.
 */
export function readsImageInput(row: any): boolean {
  const architecture = row?.architecture;
  const modalities = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities
    : Array.isArray(row?.input_modalities)
      ? row.input_modalities
      : null;
  if (modalities) return modalities.some((entry: unknown) => String(entry).toLowerCase() === "image");
  const modality = typeof architecture?.modality === "string" ? architecture.modality.toLowerCase() : "";
  return modality.includes("image->") || modality.startsWith("image+") || modality.includes("+image");
}

export type ModelDiscovery = {
  provider: ProviderId;
  models: FreeModel[];
  /** Models the provider listed that Wheat refused, with the reason. */
  rejected: Array<{ id: string; reason: string }>;
  fetchedAt: string;
};

export type ChatResult = {
  text: string;
  provider: ProviderId;
  modelId: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Models tried and rejected before this one succeeded. */
  failedOver: Array<{ provider: ProviderId; modelId: string; reason: string }>;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export type FailureKind =
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_KEY"
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "SAFETY_REFUSAL"
  | "CANCELLED"
  | "EMPTY_RESPONSE"
  /**
   * The provider accepted the model but has no endpoint able to read an image
   * for it. OpenRouter reports this as a 404 whose body names image input, which
   * read as "this model no longer exists" until it was told apart here — and
   * that mislabelling is why an image request used to exhaust the whole
   * fallback chain with a message about withdrawn models.
   */
  | "IMAGE_UNSUPPORTED";

/** Only these move Wheat AI to the next éligible free model. */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "MODEL_UNAVAILABLE",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "EMPTY_RESPONSE",
  "IMAGE_UNSUPPORTED",
]);

/**
 * Failures that say something durable about the model rather than about this
 * one request. They are remembered for a short while so the same dead or
 * text-only model is not retried on every question.
 */
const MODEL_LEVEL_FAILURES: ReadonlySet<FailureKind> = new Set<FailureKind>(["MODEL_UNAVAILABLE", "IMAGE_UNSUPPORTED"]);

export class WheatAiProviderError extends Error {
  readonly kind: FailureKind;
  readonly provider: ProviderId;
  readonly modelId?: string;
  readonly retryable: boolean;

  constructor(kind: FailureKind, provider: ProviderId, message: string, modelId?: string) {
    super(redactSecrets(message));
    this.name = "WheatAiProviderError";
    this.kind = kind;
    this.provider = provider;
    this.modelId = modelId;
    this.retryable = RETRYABLE.has(kind);
  }
}

/* -------------------------------------------------------- model capability */

/**
 * What a model can do, as its own provider describes it.
 *
 * Every eligibility question in Wheat — the assistant's failover chain, the
 * image-attachment control, the OCR review picker — is answered from this one
 * shape by `isModelEligible`, so "can this model handle this request" has a
 * single implementation rather than one guess per call site.
 */
export type ModelCapabilities = { supportsTools: boolean; supportsVision: boolean };

/** What a particular request actually needs from a model. */
export type RequestNeeds = { images: boolean; tools: boolean };

export type EligibilityVerdict = { ok: true } | { ok: false; reason: "IMAGE_UNSUPPORTED" | "TOOLS_UNSUPPORTED" };

/**
 * The one answer to "can this model handle this request".
 *
 * Vision is a hard requirement: an image sent to a text-only model is either
 * silently dropped or refused by the provider, and neither is an answer.
 *
 * Tool support is a hard requirement only for a text request, where a model
 * that cannot call a capability cannot prepare a Wheat action. An image request
 * is an analysis request first: refusing every vision model that happens not to
 * expose tool calling would leave the user with no model at all, so tools are
 * simply omitted for such a candidate (`toolsForCandidate`).
 */
export function isModelEligible(model: ModelCapabilities, needs: RequestNeeds): EligibilityVerdict {
  if (needs.images && !model.supportsVision) return { ok: false, reason: "IMAGE_UNSUPPORTED" };
  if (!needs.images && needs.tools && !model.supportsTools) return { ok: false, reason: "TOOLS_UNSUPPORTED" };
  return { ok: true };
}

/** Tools are sent only to a candidate that declares them. */
export function toolsForCandidate<T>(model: ModelCapabilities, tools: T[] | undefined): T[] | undefined {
  return tools?.length && model.supportsTools ? tools : undefined;
}

/** True when any turn of this request carries an image. */
export function requestCarriesImages(messages: WheatAiChatMessage[]): boolean {
  return messages.some((message) => (message.images?.length ?? 0) > 0);
}

/* ------------------------------------------------------------ diagnostics */

export type WheatAiDiagnosticEvent = Record<string, unknown> & { event: string };
type DiagnosticSink = (event: WheatAiDiagnosticEvent) => void;

let diagnosticSink: DiagnosticSink | null = null;

/**
 * Installs the process-wide diagnostic sink.
 *
 * Provider routing — which model was tried, why it was skipped, whether the
 * fallback continued — belongs here and nowhere near the conversation the user
 * reads. Every string value is redacted on the way out, and no caller ever
 * passes prompt text, document content or image bytes.
 */
export function setWheatAiDiagnosticSink(sink: DiagnosticSink | null): void {
  diagnosticSink = sink;
}

export function wheatAiDiagnostic(event: WheatAiDiagnosticEvent): void {
  if (!diagnosticSink) return;
  const safe: WheatAiDiagnosticEvent = { event: event.event };
  for (const [key, value] of Object.entries(event)) {
    safe[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  // A diagnostic must never be able to fail a user request.
  try { diagnosticSink(safe); } catch { /* ignored on purpose */ }
}

/* ------------------------------------------------- unavailable-model memory */

/**
 * Short-lived memory of models the provider has just refused outright.
 *
 * A model withdrawn from OpenRouter, or one whose endpoints cannot read an
 * image, answers the same way to every question for as long as that is true.
 * Remembering it for a few minutes keeps the next request from spending its
 * whole failover budget re-discovering the same dead ends, while the TTL means
 * a model that comes back is picked up again without restarting Wheat.
 */
export class UnavailableModelRegistry {
  private readonly entries = new Map<string, { expiresAt: number; reason: string }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 15 * 60_000) {
    this.ttlMs = ttlMs;
  }

  private static key(provider: ProviderId, modelId: string) {
    return `${provider}:${modelId}`;
  }

  note(provider: ProviderId, modelId: string, reason: string): void {
    this.entries.set(UnavailableModelRegistry.key(provider, modelId), { expiresAt: Date.now() + this.ttlMs, reason });
  }

  reason(provider: ProviderId, modelId: string): string | null {
    const key = UnavailableModelRegistry.key(provider, modelId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.reason;
  }

  isSuppressed(provider: ProviderId, modelId: string): boolean {
    return this.reason(provider, modelId) !== null;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Hard ceiling on failover hops, so a bad day never becomes an infinite loop. */
export const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 90_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MODEL_CACHE_TTL_MS = 10 * 60_000;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
};

const ENDPOINTS: Record<ProviderId, { models: string; chat: string }> = {
  openrouter: {
    models: "https://openrouter.ai/api/v1/models",
    chat: "https://openrouter.ai/api/v1/chat/completions",
  },
  groq: {
    models: "https://api.groq.com/openai/v1/models",
    chat: "https://api.groq.com/openai/v1/chat/completions",
  },
};

/**
 * Strips anything shaped like a provider credential out of text before it can
 * reach a log line, an IPC payload or an error message shown to the user.
 */
export function redactSecrets(value: string): string {
  return String(value ?? "")
    .replace(/sk-or-[A-Za-z0-9._-]{8,}/g, "sk-or-[clé masquée]")
    .replace(/gsk_[A-Za-z0-9._-]{8,}/g, "gsk_[clé masquée]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [clé masquée]");
}

/** True only when the provider's metadata proves the price is exactly zero. */
export function isZeroPrice(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

async function requestJson(
  fetchImpl: FetchLike,
  provider: ProviderId,
  url: string,
  init: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  if (signal?.aborted) {
    throw new WheatAiProviderError("CANCELLED", provider, "La demande a été annulée.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await httpFailure(provider, response);
    return await response.json();
  } catch (error) {
    if (error instanceof WheatAiProviderError) throw error;
    if (signal?.aborted) throw new WheatAiProviderError("CANCELLED", provider, "La demande a été annulée.");
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new WheatAiProviderError("TIMEOUT", provider, `${PROVIDER_LABELS[provider]} n'a pas répondu dans le délai imparti.`);
    }
    throw new WheatAiProviderError(
      "PROVIDER_ERROR",
      provider,
      `${PROVIDER_LABELS[provider]} est injoignable : ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function httpFailure(provider: ProviderId, response: any): Promise<WheatAiProviderError> {
  let detail: string;
  try {
    detail = String(await response.text()).slice(0, 400);
  } catch {
    detail = "";
  }
  const label = PROVIDER_LABELS[provider];
  const status = Number(response.status);

  if (status === 401) {
    return new WheatAiProviderError("INVALID_KEY", provider, `${label} a refusé la clé d'API. Vérifiez-la ou remplacez-la dans Réglages.`);
  }
  if (status === 403) {
    return new WheatAiProviderError("UNAUTHORIZED", provider, `${label} a refusé l'acces a cette ressource avec cette clé.`);
  }
  if (status === 429) {
    return new WheatAiProviderError("RATE_LIMITED", provider, `${label} limite temporairement le nombre de requetes.`);
  }
  if (status === 402) {
    return new WheatAiProviderError("QUOTA_EXHAUSTED", provider, `Le quota gratuit ${label} est épuisé pour ce modèle.`);
  }
  if (status === 404) {
    // OpenRouter answers an image sent to a model whose endpoints only read
    // text with a 404 naming image input, not with a 400. Read literally that
    // says "this model is gone", which is both wrong and unhelpful: it is the
    // image the model cannot take, and the next vision model may well succeed.
    if (mentionsImageInput(detail)) {
      return new WheatAiProviderError("IMAGE_UNSUPPORTED", provider, `${label} n'a aucun point d'accès capable de lire une image pour ce modèle.`);
    }
    return new WheatAiProviderError("MODEL_UNAVAILABLE", provider, `${label} ne propose plus ce modèle.`);
  }
  if (status === 400 || status === 422) {
    if (mentionsImageInput(detail)) {
      return new WheatAiProviderError("IMAGE_UNSUPPORTED", provider, `${label} a refusé l'image pour ce modèle.`);
    }
    return new WheatAiProviderError("BAD_REQUEST", provider, `${label} a rejeté la requête : ${detail || "requête invalide"}.`);
  }
  if (status >= 500) {
    return new WheatAiProviderError("PROVIDER_ERROR", provider, `${label} rencontre une panne temporaire (HTTP ${status}).`);
  }
  return new WheatAiProviderError("PROVIDER_ERROR", provider, `${label} a répondu HTTP ${status}. ${detail}`);
}

/**
 * True when a provider's refusal is about image input rather than the model's
 * existence or the request's shape.
 */
function mentionsImageInput(detail: string): boolean {
  const text = String(detail ?? "").toLowerCase();
  if (!text) return false;
  return /image/.test(text)
    && /(support|endpoint|modalit|input|capab|not (?:a )?(?:valid|allowed)|unsupported|cannot|can't)/.test(text);
}

function authHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    // OpenRouter asks callers to identify themselves; both values are public.
    headers["HTTP-Referer"] = "https://wheat.local/";
    headers["X-Title"] = "Wheat";
  }
  return headers;
}

/* ------------------------------------------------------------------ ranking */

/**
 * Scores an éligible free model for Wheat AI's accounting workload.
 *
 * Weighted, in order:
 *   - tool calling (Wheat AI drives typed capabilities — a model without it
 *     can answer but cannot prepare an action);
 *   - context capacity (dossier context and workpaper extracts are long);
 *   - a small bonus for instruction-tuned families known to follow a strict
 *     JSON tool schema reliably;
 *   - a penalty for preview/experimental tags, which are withdrawn without
 *     notice and therefore fail over more often.
 */
export function scoreModel(input: { id: string; contextTokens: number; supportsTools: boolean }): { score: number; reason: string } {
  const id = input.id.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (input.supportsTools) {
    score += 500;
    reasons.push("compatible avec les actions Wheat AI");
  } else {
    reasons.push("réponses uniquement, sans action");
  }

  const contextScore = Math.min(300, Math.round(input.contextTokens / 512));
  score += contextScore;
  if (input.contextTokens >= 100_000) reasons.push("très grande fenêtre de contexte");
  else if (input.contextTokens >= 32_000) reasons.push("grande fenêtre de contexte");
  else if (input.contextTokens > 0) reasons.push("fenêtre de contexte limitée");

  if (/(instruct|-it\b|chat)/.test(id)) {
    score += 60;
    reasons.push("modèle instruit");
  }
  if (/(llama|qwen|mistral|gemma|deepseek|phi)/.test(id)) {
    score += 40;
    reasons.push("famille éprouvée sur des taches structurees");
  }
  if (/(preview|experimental|alpha|beta|-exp)/.test(id)) {
    score -= 120;
    reasons.push("version expérimentale, disponibilité incertaine");
  }
  if (/(vision|image|audio|whisper|tts|embed|guard|rerank)/.test(id)) {
    // A specialised model must never outrank a plain chat model, whatever its
    // context size or tool support: Wheat AI is a conversational workload.
    score -= 1200;
    reasons.push("modèle spécialisé non conversationnel");
  }

  return { score, reason: reasons.join(" · ") };
}

/* --------------------------------------------------------------- discovery */

/**
 * OpenRouter: a model is free only when the official metadata reports a prompt
 * price AND a completion price that both parse to exactly zero. Anything with
 * missing, non-numeric or non-zero pricing is rejected with a stated reason —
 * never assumed free.
 */
export function selectOpenRouterFreeModels(payload: any): { models: FreeModel[]; rejected: Array<{ id: string; reason: string }> } {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models: FreeModel[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;

    const pricing = row?.pricing;
    if (!pricing || typeof pricing !== "object") {
      rejected.push({ id, reason: "tarification absente des métadonnées" });
      continue;
    }
    if (!("prompt" in pricing) || !("completion" in pricing)) {
      rejected.push({ id, reason: "tarification incomplète" });
      continue;
    }
    if (!isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) {
      rejected.push({ id, reason: "modèle payant" });
      continue;
    }
    // Some listings price the request itself separately; a non-zero value there
    // is still a chargé, so it disqualifies the model.
    for (const extra of ["request", "image", "web_search", "internal_reasoning"]) {
      if (extra in pricing && !isZeroPrice((pricing as any)[extra])) {
        rejected.push({ id, reason: `frais additionnel (${extra})` });
      }
    }
    if (rejected.some((entry) => entry.id === id)) continue;

    const contextTokens = Number(row?.context_length ?? row?.top_provider?.context_length ?? 0);
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
      rejected.push({ id, reason: "fenêtre de contexte inconnue" });
      continue;
    }

    const parameters: string[] = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
    const supportsTools = parameters.includes("tools") || parameters.includes("tool_choice");
    const { score, reason } = scoreModel({ id, contextTokens, supportsTools });
    models.push({
      id,
      provider: "openrouter",
      label: typeof row?.name === "string" && row.name.trim() ? row.name.trim() : id,
      contextTokens,
      supportsTools,
      supportsVision: readsImageInput(row),
      score,
      rankingReason: reason,
    });
  }

  models.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { models, rejected };
}

/**
 * Groq's `/models` listing proves availability, but not the account's billing
 * tier. This selector therefore only performs availability/capability checks;
 * the provider service must gate its result behind explicit Free-plan consent
 * before exposing any entry as an eligible model.
 */
export function selectGroqFreeModels(payload: any): { models: FreeModel[]; rejected: Array<{ id: string; reason: string }> } {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models: FreeModel[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    if (row?.active === false) {
      rejected.push({ id, reason: "modèle désactivé par le fournisseur" });
      continue;
    }
    if (/(whisper|tts|guard|embed|rerank|vision)/i.test(id)) {
      rejected.push({ id, reason: "modèle spécialisé non conversationnel" });
      continue;
    }
    const contextTokens = Number(row?.context_window ?? 0);
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
      rejected.push({ id, reason: "fenêtre de contexte inconnue" });
      continue;
    }
    // Groq exposes tool calling on its instruction-tuned chat models.
    const supportsTools = !/(guard|whisper|tts)/i.test(id);
    const { score, reason } = scoreModel({ id, contextTokens, supportsTools });
    models.push({
      id,
      provider: "groq",
      label: id,
      contextTokens,
      supportsTools,
      // Groq's OpenAI-shaped listing carries no modality field; without a
      // provider statement Wheat treats the model as text-only.
      supportsVision: readsImageInput(row),
      score,
      rankingReason: reason,
    });
  }

  models.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { models, rejected };
}

/* ----------------------------------------------------------------- adapter */

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  listFreeModels(apiKey: string, signal?: AbortSignal): Promise<ModelDiscovery>;
  chat(input: {
    apiKey: string;
    modelId: string;
    messages: WheatAiChatMessage[];
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<ChatResult>;
};

function parseChatResponse(provider: ProviderId, modelId: string, payload: any): ChatResult {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const finishReason = String(choice?.finish_reason ?? "");
  if (finishReason === "content_filter") {
    throw new WheatAiProviderError("SAFETY_REFUSAL", provider, "Le fournisseur a refusé de répondre a cette demande.", modelId);
  }

  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content.trim() : "";
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls
    .slice(0, 25)
    .map((call: any) => {
      const name = typeof call?.function?.name === "string" ? call.function.name : "";
      if (!name) return null;
      let args: Record<string, unknown> = {};
      const raw = call?.function?.arguments;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        args = raw as Record<string, unknown>;
      }
      return { name, arguments: args };
    })
    .filter(Boolean) as ChatResult["toolCalls"];

  if (!text && !toolCalls.length) {
    throw new WheatAiProviderError("EMPTY_RESPONSE", provider, `${PROVIDER_LABELS[provider]} n'a fourni aucune réponse exploitable.`, modelId);
  }

  return {
    text,
    provider,
    modelId,
    toolCalls,
    failedOver: [],
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens) || undefined,
      completionTokens: Number(payload?.usage?.completion_tokens) || undefined,
    },
  };
}

export function createProviderAdapter(provider: ProviderId, fetchImpl: FetchLike): ProviderAdapter {
  return {
    id: provider,
    label: PROVIDER_LABELS[provider],

    async listFreeModels(apiKey, signal) {
      const payload = await requestJson(
        fetchImpl,
        provider,
        ENDPOINTS[provider].models,
        { method: "GET", headers: authHeaders(provider, apiKey) },
        DISCOVERY_TIMEOUT_MS,
        signal,
      );
      const sélection = provider === "openrouter" ? selectOpenRouterFreeModels(payload) : selectGroqFreeModels(payload);
      return { provider, models: sélection.models, rejected: sélection.rejected, fetchedAt: new Date().toISOString() };
    },

    async chat(input) {
      const body: Record<string, unknown> = {
        model: input.modelId,
        messages: input.messages.map(chatMessageForWire),
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 1024,
        stream: false,
      };
      if (input.tools?.length) {
        body.tools = input.tools;
        body.tool_choice = "auto";
      }
      const payload = await requestJson(
        fetchImpl,
        provider,
        ENDPOINTS[provider].chat,
        { method: "POST", headers: authHeaders(provider, apiKey_(input.apiKey)), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS,
        input.signal,
      );
      return parseChatResponse(provider, input.modelId, payload);
    },
  };
}

/** Identity pass-through that documents where the only key use happens. */
function apiKey_(value: string): string {
  return value;
}

/* ----------------------------------------------------------------- failover */

export type ProviderRuntime = {
  /** Returns the decrypted key, or null when the provider is not configured. */
  getKey(provider: ProviderId): string | null;
  adapter(provider: ProviderId): ProviderAdapter;
};

/**
 * Builds the ordered candidate list for `Automatic — Free models`.
 *
 * Ranking is provider-agnostic: models from both providers are merged and
 * sorted by score, so the best free model wins regardless of who serves it.
 * Cross-provider fallback only happens when both keys are configured; with a
 * single key the list stays inside that provider.
 */
export function buildCandidateList(
  discoveries: ModelDiscovery[],
  options: {
    preferredProvider?: ProviderId | "auto";
    pinnedProvider?: ProviderId | null;
    pinnedModelId?: string | null;
    limit?: number;
    /** What the request needs. Ineligible models are dropped before the limit. */
    needs?: RequestNeeds;
    unavailable?: UnavailableModelRegistry;
  } = {},
): FreeModel[] {
  const limit = options.limit ?? MAX_ATTEMPTS;
  let pool = discoveries.flatMap((discovery) => discovery.models);

  // Eligibility is applied here, before the list is cut to `limit`. Filtering
  // afterwards meant an image request kept the four best-ranked models — all
  // text-only, because ranking is about tool use and context — and then had
  // nothing left to try.
  if (options.needs) {
    const needs = options.needs;
    pool = pool.filter((model) => isModelEligible(model, needs).ok);
  }
  if (options.unavailable) {
    const unavailable = options.unavailable;
    pool = pool.filter((model) => !unavailable.isSuppressed(model.provider, model.id));
  }

  if (options.preferredProvider && options.preferredProvider !== "auto") {
    const preferred = pool.filter((model) => model.provider === options.preferredProvider);
    const others = pool.filter((model) => model.provider !== options.preferredProvider);
    pool = [...preferred, ...others];
  } else {
    pool = [...pool].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  if (options.pinnedModelId) {
    const pinned = pool.find((model) =>
      model.id === options.pinnedModelId && (!options.pinnedProvider || model.provider === options.pinnedProvider),
    );
    if (pinned) pool = [pinned, ...pool.filter((model) => model !== pinned)];
  }

  // De-duplicate on provider+id so a model never gets a second attempt.
  const seen = new Set<string>();
  const ordered: FreeModel[] = [];
  for (const model of pool) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(model);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

/**
 * Runs one chat request with bounded failover across the candidate list.
 *
 * A candidate is abandoned only for a retryable failure. The first
 * non-retryable failure (invalid key, revoked authorization, malformed
 * request, safety refusal, cancellation) aborts the whole run so Wheat never
 * masks a configuration problem behind a silent model switch.
 */
export async function chatWithFailover(
  runtime: ProviderRuntime,
  candidates: FreeModel[],
  request: { messages: WheatAiChatMessage[]; tools?: Array<Record<string, unknown>>; temperature?: number; maxTokens?: number; signal?: AbortSignal },
  options: { unavailable?: UnavailableModelRegistry } = {},
): Promise<ChatResult> {
  const needs: RequestNeeds = { images: requestCarriesImages(request.messages), tools: Boolean(request.tools?.length) };
  const unavailable = options.unavailable;

  const eligibleCandidates: FreeModel[] = [];
  for (const candidate of candidates) {
    const verdict = isModelEligible(candidate, needs);
    if (!verdict.ok) {
      wheatAiDiagnostic({
        event: "wheat-ai.candidate-skipped",
        provider: candidate.provider,
        modelId: candidate.id,
        needsImages: needs.images,
        needsTools: needs.tools,
        reason: verdict.reason,
      });
      continue;
    }
    const suppressed = unavailable?.reason(candidate.provider, candidate.id);
    if (suppressed) {
      wheatAiDiagnostic({
        event: "wheat-ai.candidate-skipped",
        provider: candidate.provider,
        modelId: candidate.id,
        needsImages: needs.images,
        needsTools: needs.tools,
        reason: "RECENTLY_UNAVAILABLE",
        detail: suppressed,
      });
      continue;
    }
    eligibleCandidates.push(candidate);
  }

  if (!eligibleCandidates.length) {
    wheatAiDiagnostic({ event: "wheat-ai.no-eligible-model", needsImages: needs.images, needsTools: needs.tools, considered: candidates.length });
    throw new WheatAiProviderError(
      needs.images ? "IMAGE_UNSUPPORTED" : "MODEL_UNAVAILABLE",
      candidates[0]?.provider ?? "openrouter",
      needs.images
        ? "Aucun modèle capable de lire une image n'est disponible chez vos fournisseurs. Choisissez un modèle local doté de la vision, ou envoyez votre demande sans image."
        : "Aucun modèle compatible n'est disponible. Ouvrez Réglages > Wheat AI pour vérifier le fournisseur et la clé d'API.",
    );
  }

  const failedOver: ChatResult["failedOver"] = [];
  let lastError: WheatAiProviderError | null = null;
  const attempts = eligibleCandidates.slice(0, MAX_ATTEMPTS);

  for (const [index, candidate] of attempts.entries()) {
    const apiKey = runtime.getKey(candidate.provider);
    if (!apiKey) {
      failedOver.push({ provider: candidate.provider, modelId: candidate.id, reason: "aucune clé configuree pour ce fournisseur" });
      continue;
    }
    wheatAiDiagnostic({
      event: "wheat-ai.attempt",
      provider: candidate.provider,
      modelId: candidate.id,
      attempt: index + 1,
      of: attempts.length,
      needsImages: needs.images,
      // Tool calling is dropped rather than the candidate when a vision model
      // does not expose it; the log says which happened.
      toolsSent: Boolean(toolsForCandidate(candidate, request.tools)?.length),
    });
    try {
      const result = await runtime.adapter(candidate.provider).chat({
        apiKey,
        modelId: candidate.id,
        messages: request.messages,
        tools: toolsForCandidate(candidate, request.tools),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });
      if (failedOver.length) {
        // The fallback succeeded. That is a routing fact, not conversation:
        // it is recorded here and never added to the assistant's answer.
        wheatAiDiagnostic({
          event: "wheat-ai.failover-succeeded",
          provider: candidate.provider,
          modelId: candidate.id,
          skipped: failedOver.length,
        });
      }
      return { ...result, failedOver };
    } catch (error) {
      const failure = error instanceof WheatAiProviderError
        ? error
        : new WheatAiProviderError("PROVIDER_ERROR", candidate.provider, error instanceof Error ? error.message : String(error), candidate.id);
      lastError = failure;
      if (MODEL_LEVEL_FAILURES.has(failure.kind)) unavailable?.note(candidate.provider, candidate.id, failure.kind);
      wheatAiDiagnostic({
        event: "wheat-ai.attempt-failed",
        provider: candidate.provider,
        modelId: candidate.id,
        kind: failure.kind,
        retryable: failure.retryable,
        willContinue: failure.retryable && index + 1 < attempts.length,
        detail: failure.message,
      });
      if (!failure.retryable) throw failure;
      failedOver.push({ provider: candidate.provider, modelId: candidate.id, reason: failure.message });
    }
  }

  // Every eligible model failed. The user gets one sentence they can act on;
  // the model identifiers, kinds and counts stay in the diagnostics above.
  wheatAiDiagnostic({ event: "wheat-ai.all-candidates-failed", attempts: failedOver.length, lastKind: lastError?.kind ?? "PROVIDER_ERROR" });
  throw new WheatAiProviderError(
    lastError?.kind ?? "PROVIDER_ERROR",
    lastError?.provider ?? eligibleCandidates[0].provider,
    userFacingFailoverMessage(lastError?.kind ?? "PROVIDER_ERROR", needs),
  );
}

/**
 * The single sentence shown when no eligible model answered.
 *
 * It names the situation and the next step, never a model identifier, an HTTP
 * status or a retry count — those are diagnostics, and putting them in front of
 * the user explained nothing while making a routing detail look like an answer.
 */
export function userFacingFailoverMessage(kind: FailureKind, needs: RequestNeeds): string {
  switch (kind) {
    case "INVALID_KEY":
      return "La clé d'API a été refusée. Vérifiez-la dans Réglages > Wheat AI.";
    case "UNAUTHORIZED":
      return "Votre clé d'API n'autorise pas cette demande. Vérifiez le compte du fournisseur dans Réglages > Wheat AI.";
    case "RATE_LIMITED":
      return "Le fournisseur limite temporairement les requêtes. Réessayez dans quelques instants.";
    case "QUOTA_EXHAUSTED":
      return "Le quota gratuit du fournisseur est épuisé pour le moment. Réessayez plus tard ou utilisez un modèle local.";
    case "TIMEOUT":
      return "Le fournisseur n'a pas répondu dans le délai prévu. Vérifiez votre connexion, puis réessayez.";
    case "IMAGE_UNSUPPORTED":
      return "Aucun modèle capable de lire une image n'a pu traiter cette demande. Choisissez un modèle doté de la vision, ou envoyez votre demande sans image.";
    case "BAD_REQUEST":
      return "Le fournisseur a rejeté la demande. Reformulez-la ou choisissez un autre modèle.";
    case "SAFETY_REFUSAL":
      return "Le fournisseur a refusé de répondre à cette demande.";
    case "CANCELLED":
      return "La demande a été annulée.";
    default:
      return needs.images
        ? "Aucun modèle compatible n'a pu traiter cette image. Vérifiez votre connexion ou votre fournisseur, ou choisissez un autre modèle."
        : "Aucun modèle compatible n'a pu traiter cette demande. Vérifiez votre connexion, votre fournisseur ou choisissez un autre modèle.";
  }
}

/* -------------------------------------------------------- discovery cache */

/** Short-lived cache so a burst of questions does not re-list models each time. */
export class ModelDiscoveryCache {
  private readonly entries = new Map<ProviderId, { discovery: ModelDiscovery; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = MODEL_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(provider: ProviderId): ModelDiscovery | null {
    const entry = this.entries.get(provider);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(provider);
      return null;
    }
    return entry.discovery;
  }

  set(provider: ProviderId, discovery: ModelDiscovery): void {
    this.entries.set(provider, { discovery, expiresAt: Date.now() + this.ttlMs });
  }

  clear(provider?: ProviderId): void {
    if (provider) this.entries.delete(provider);
    else this.entries.clear();
  }
}
