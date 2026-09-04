import { createHash, randomUUID } from "node:crypto";
import { STORED_SCHEMA_VERSIONS, WHEAT_AI_ORIGIN } from "./legacyDomainValues";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { rendererSerialize, requireId, requireText } from "./accounting";
import { buildBalanceFamily, buildBankTotal, buildBilan } from "./reporting21";
import { searchCompanyAccounts } from "./chartOfAccounts21";
import { PCGE_SOURCE } from "./pcgeData";
import { buildComparativeCpc, buildFiscalControl } from "./fiscal21";
import { fiscalTableDefinition } from "./fiscalCatalog";
import { wheatProductKnowledge, WHEAT_AI_MUTATION_CAPABILITIES, WHEAT_PRODUCT_KNOWLEDGE_VERSION } from "./wheatProductKnowledge";
import { WHEAT_APP_VERSION } from "../src/appVersion";
import {
  AUTOMATIC_FREE_MODEL_ID,
  REMOTE_MODEL_PREFIX,
  type WheatAiProviderService,
} from "./wheatAiProviderService";
import { PROVIDER_LABELS, WheatAiProviderError, wheatAiDiagnostic, type WheatAiChatMessage } from "./wheatAiProviders";
import {
  WHEAT_AI_CAPABILITY_REGISTRY,
  canonicalWheatAiCapabilityId,
  classifyWheatAiIntent,
  getWheatAiCapability,
  publicWheatAiCapabilities,
  selectWheatAiCapabilities,
  type WheatAiCapabilityDefinition,
  type WheatAiIntent,
} from "./wheatAiCapabilityRegistry";
import { createWheatAiDomainGateway, type WheatAiDocumentCommands, type WheatAiDomainGateway } from "./wheatAiDomainGateway";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };
type Send = (channel: string, payload: unknown) => void;
type PermissionMode = "READ_ONLY" | "ASSISTANT" | "AUTOMATED";
type LocalModelProvider = "WHEAT" | "OLLAMA" | "HUGGINGFACE" | "OPENROUTER" | "GROQ";

type ModelArtifact = {
  tier: "LITE" | "STANDARD" | "ADVANCED";
  id: string;
  displayName: string;
  fileName: string;
  url: string;
  sha256: string;
  bytes: number;
  source: string;
  baseModel: string;
  quantization: string;
  license: string;
  conversionProvenance?: string;
  minimumRamBytes: number;
  recommendedFreeRamBytes: number;
  recommendedGpuVramBytes?: number;
};

type ModelManifest = {
  schemaVersion: string;
  manifestVersion: string;
  runtime: { id: string; version: string; fileName: string; url: string; sha256: string; bytes: number; source: string; license: string };
  models: ModelArtifact[];
};

type LocalModel = {
  id: string;
  provider: LocalModelProvider;
  displayName: string;
  installed: boolean;
  chatReady: boolean;
  removable: boolean;
  integrity: "VERIFIED" | "LOCAL" | "ABSENT" | "INVALID";
  bytes: number;
  source: string;
  baseModel?: string;
  quantization?: string;
  tier?: ModelArtifact["tier"] | "EXTERNAL";
  fileName?: string;
  filePath?: string;
  repoRoot?: string;
  digest?: string;
  parameterSize?: string;
  /** True only when the provider's own metadata says the model accepts images. */
  supportsVision?: boolean;
  /**
   * True only when the provider's own metadata says the model can call tools.
   * Ollama refuses a request that carries a `tools` array for a model without
   * the capability, so this decides whether Wheat sends one at all.
   */
  supportsTools?: boolean;
  /**
   * True when Ollama reports the `thinking` capability. Such a model spends
   * part of its generation budget on a separate `thinking` field, so Wheat asks
   * it not to: the budget belongs to the answer, and the system prompt already
   * forbids exposing reasoning.
   */
  supportsThinking?: boolean;
  sizeLabel?: string;
  notes?: string;
};

type ZipEntry = {
  path: string;
  type: string;
  stream(): NodeJS.ReadableStream & { [Symbol.asyncIterator](): AsyncIterator<Buffer | string | Uint8Array> };
};
type UnzipperModule = { Open: { file(archivePath: string): Promise<{ files: ZipEntry[] }> } };

const unzipper = createRequire(import.meta.url)("unzipper") as UnzipperModule;
const execFileAsync = promisify(execFile);

export const WHEAT_AI_CHANNELS = {
  status: "wheat:ai:status",
  benchmark: "wheat:ai:benchmark",
  install: "wheat:ai:install",
  uninstall: "wheat:ai:uninstall",
  select: "wheat:ai:select",
  configure: "wheat:ai:configure",
  tools: "wheat:ai:tools",
  executeTool: "wheat:ai:execute-tool",
  executePlan: "wheat:ai:execute-plan",
  chat: "wheat:ai:chat",
  confirmAction: "wheat:ai:confirm-action",
  cancelAction: "wheat:ai:cancel-action",
  ollamaStart: "wheat:ai:ollama:start",
  progress: "wheat:ai:progress",
} as const;

/**
 * Optional remote-provider service (OpenRouter / Groq). When it is absent or
 * unconfigured, Wheat AI behaves exactly as before: local models only.
 */
let remoteProviderService: WheatAiProviderService | null = null;

export function setWheatAiRemoteProviderService(service: WheatAiProviderService | null) {
  remoteProviderService = service;
}

/**
 * Ollama is a separate background service, not a library Wheat controls. It can
 * be installed but stopped, listening on a non-default host (`OLLAMA_HOST`), or
 * still starting up while Wheat is already asking for its model list. Probing a
 * single hard-coded URL exactly once — which is what Wheat used to do — turned
 * every one of those into a permanent "Ollama indisponible" that only an
 * application restart could clear.
 */
function ollamaHostCandidates(): string[] {
  const configured = String(process.env.OLLAMA_HOST ?? "").trim();
  if (configured) {
    // An explicitly configured host is authoritative: someone who points Wheat
    // at a specific Ollama instance must not silently get a different one.
    const normalized = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
    return [normalized.replace(/\/+$/, "")];
  }
  // Otherwise sweep the addresses a default Ollama install can bind to: which
  // of them answers depends on the machine's IPv4/IPv6 resolution order.
  return ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"];
}

/** The candidate that last answered, tried first so the common case is one call. */
let ollamaBaseUrl: string | null = null;
const WHEAT_AI_SYSTEM_PROMPT = [
  "Tu es Wheat AI, l'assistant intégré à Wheat, logiciel de comptabilité marocaine.",
  "Utilise la connaissance produit versionnée pour expliquer exactement les modules, la navigation et les workflows. Utilise uniquement le contexte d'outils typés pour parler du dossier actif.",
  "Ne lis jamais directement une base, un chemin local ou un fichier libre. N'invente aucune donnée, preuve, référence légale, règle fiscale, taux ou conversion.",
  "Pour une demande d'action explicite, utilise les capacités typées pertinentes. Tu peux proposer plusieurs capacités seulement si elles forment un plan cohérent et entièrement demandé. Si la cible ou une valeur requise est ambiguë, pose une question courte et ne propose aucun outil.",
  // Ten. The assistant asked for an invoice number printed on the document it
  // had just been handed. Everything it can look up itself, it looks up first.
  "Avant de poser une question à l'utilisateur, cherche la réponse dans ce que Wheat sait déjà, dans cet ordre : le dossier actif, l'entité ou le document sélectionné, l'extraction OCR du document (documents.get), la facture concernée (invoices.get), les tiers existants (counterparties.resolve), le plan comptable (accounts.search, accounts.suggest), puis les écritures et règlements. Ne demande que ce qui reste réellement introuvable ou ambigu, et dis alors précisément ce qui manque.",
  "N'affirme jamais qu'aucun outil ne permet une action sans avoir consulté la liste des capacités fournie pour ce tour. Si l'action demandée n'y figure pas, nomme la capacité la plus proche et explique ce qui manque.",
  // Four and five. The identity rule, stated once, for every dossier.
  "Le sens d'une facture se déduit de l'identité des parties, jamais d'une valeur par défaut : si le dossier actif est l'émetteur, c'est une vente ; s'il est le destinataire, c'est un achat ; sinon le sens reste à confirmer par l'utilisateur. Ne propose jamais le dossier actif comme son propre client ou fournisseur ; vérifie une identité avec counterparties.resolve avant de créer un tiers.",
  // Eight. Reimbursements are not turnover.
  "Distingue les produits, les marchandises, les charges et les débours à l'identique : un débours refacturé sans marge n'est ni du chiffre d'affaires ni une base de TVA. Choisis un compte en interrogeant le plan du dossier (accounts.suggest, accounts.search) et jamais de mémoire ; un compte non affichable par la recherche n'existe pas dans ce dossier.",
  "Distingue toujours information, planification, prévisualisation et exécution. Une question, une demande d'explication ou « que se passerait-il » n'autorise jamais une mutation.",
  "Les montants d'outils sont des chaînes de centimes entiers. Les identifiants T01 à T25 désignent les workpapers de la liasse normale.",
  "Une proposition est seulement un brouillon: Wheat la normalise, montre l'avant/après et recontrôle sa version. Ne prétends jamais qu'elle est exécutée avant confirmation explicite dans l'application.",
  "La comptabilisation, l'extourne, la suppression, la clôture et la réouverture restent soumises aux validations et confirmations de niveau 3. Wheat ne télédéclare jamais.",
  "N'expose jamais ton raisonnement interne. Fournis uniquement la réponse finale, en français, clairement et brièvement.",
].join(" ");

const TOOL_DEFINITIONS = [
  { name: "search_accounts", risk: "READ" as const, description: "Rechercher des comptes PCGE et subdivisions du dossier.", input: { query: "string", classNo: "number?", limit: "number?" } },
  { name: "get_entries", risk: "READ" as const, description: "Lire un extrait borné du journal comptable.", input: { from: "YYYY-MM-DD?", to: "YYYY-MM-DD?", query: "string?", limit: "number?" } },
  { name: "get_balance", risk: "READ" as const, description: "Calculer une balance exacte depuis le moteur partagé.", input: { view: "BalanceView", from: "YYYY-MM-DD?", to: "YYYY-MM-DD" } },
  { name: "get_bilan", risk: "READ" as const, description: "Calculer le bilan normal ou simplifié depuis le moteur partagé.", input: { asOf: "YYYY-MM-DD", variant: "NORMAL|SIMPLIFIED" } },
  { name: "get_cpc", risk: "READ" as const, description: "Calculer le CPC comparatif et les soldes exacts de l'exercice.", input: { fiscalYearId: "string?" } },
  { name: "get_bank_position", risk: "READ" as const, description: "Lire la position de trésorerie par devise.", input: { asOf: "YYYY-MM-DD?" } },
  { name: "get_invoices", risk: "READ" as const, description: "Lire une liste bornée de factures ou avoirs sans contenu de fichier.", input: { from: "YYYY-MM-DD?", to: "YYYY-MM-DD?", query: "string?", limit: "number?" } },
  { name: "get_documents", risk: "READ" as const, description: "Lire les métadonnées bornées des documents, jamais leur chemin local ni leur contenu OCR complet.", input: { query: "string?", limit: "number?" } },
  { name: "get_vat_status", risk: "READ" as const, description: "Lire les périodes et montants TVA enregistrés dans le dossier.", input: { limit: "number?" } },
  { name: "get_payroll_summary", risk: "READ" as const, description: "Lire les périodes et états des traitements de paie sans données personnelles salarié.", input: { limit: "number?" } },
  { name: "get_fiscal_package", risk: "READ" as const, description: "Lire l'avancement et les contrôles des 25 tableaux de préparation normale.", input: {} },
  { name: "retrieve_company_knowledge", risk: "READ" as const, description: "Retrouver des schémas locaux avec leurs preuves et confiance.", input: { kind: "string?", limit: "number?" } },
  { name: "create_account_subdivision", risk: "MUTATING" as const, description: "Créer une subdivision de dossier héritant d'un parent PCGE.", input: { parentCode: "string", code: "string", label: "string" } },
  { name: "update_company_profile", risk: "MUTATING" as const, description: "Modifier des champs d'identité du dossier après confirmation.", input: { name: "string?", legalForm: "string?", ice: "string?", taxId: "string?", city: "string?", vatFrequency: "MONTHLY|QUARTERLY?" } },
  { name: "rename_custom_account", risk: "MUTATING" as const, description: "Renommer un compte personnalisé; un compte officiel PCGE reste immuable.", input: { accountCode: "string", label: "string" } },
  { name: "add_fiscal_table_row", risk: "MUTATING" as const, description: "Ajouter une ligne manuelle documentée à un tableau fiscal normal en brouillon. La ligne doit suivre les colonnes du tableau et contenir sourceRef pour tout montant.", input: { tableId: "T01|T02|T03|T04|T05|T06|T07|T08|T09|T10|T11|T12|T13|T14|T15|T16|T17|T18|T19|T20|T21|T22|T23|T24|T25", row: "object" } },
  { name: "mark_fiscal_table_not_applicable", risk: "MUTATING" as const, description: "Documenter un tableau fiscal normal en brouillon comme non applicable avec un motif précis.", input: { tableId: "T01|T02|T03|T04|T05|T06|T07|T08|T09|T10|T11|T12|T13|T14|T15|T16|T17|T18|T19|T20|T21|T22|T23|T24|T25", reason: "string" } },
  { name: "add_fiscal_adjustment", risk: "MUTATING" as const, description: "Ajouter une réintégration ou déduction documentée, non vérifiée, à la liasse normale en brouillon. Ne jamais inventer la référence légale.", input: { kind: "REINTEGRATION|DEDUCTION", label: "string", amountCents: "string", legalReference: "string" } },
  { name: "remember_company_knowledge", risk: "MUTATING" as const, description: "Enregistrer une règle propre au dossier avec sa preuve et son niveau de confiance.", input: { kind: "string", key: "string", value: "object", evidence: "array?", confidenceBps: "number?" } },
  { name: "post_entry", risk: "HIGH_STAKES" as const, description: "Indisponible à l'IA : la comptabilisation reste une action humaine dans l'écran de saisie.", input: {} },
] as const;

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La demande Wheat AI est invalide.");
  return value as Record<string, any>;
}

/**
 * Signatures of a fault in Wheat itself rather than in what was asked.
 *
 * A domain error — "le compte 445500 n'est pas configuré", "la facture n'est
 * plus un brouillon" — is written for the person reading it and is shown as
 * written. A `PrismaClientValidationError` naming an unknown field is not: it
 * tells the user nothing they can act on, and it is exactly what reached the
 * chat window when the assistant asked for a column the schema does not have.
 */
const INTERNAL_ERROR_SIGNATURES = [
  /PrismaClient\w*Error/i,
  /Invalid `?prisma\./i,
  /Unknown (?:field|argument|arg)\b/i,
  /^(?:TypeError|ReferenceError|RangeError|SyntaxError)\b/,
  /Cannot read propert/i,
  /is not a function\b/,
  /ECONNREFUSED|ENOENT|EPERM|EACCES/,
];

function isInternalFault(error: unknown) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return INTERNAL_ERROR_SIGNATURES.some((pattern) => pattern.test(text));
}

/**
 * The sentence a user should read when a typed capability fails.
 *
 * Wheat's own refusals already say what is missing and what to do; they pass
 * through untouched. Anything that looks like an internal fault is replaced by
 * a message that names the capability and says the detail is in the log — and
 * the detail is sent to the diagnostic sink so the fault stays debuggable.
 */
export function describeCapabilityFailure(capabilityId: string, error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (!isInternalFault(error)) return raw || `L'action ${capabilityId} n'a pas abouti.`;
  wheatAiDiagnostic({
    event: "wheat-ai.capability-internal-error",
    capabilityId,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: raw.slice(0, 2000),
    stack: error instanceof Error ? String(error.stack ?? "").slice(0, 4000) : undefined,
  });
  return `Wheat n'a pas pu exécuter « ${capabilityId} » : une erreur interne est survenue. Le détail technique a été enregistré dans le journal Wheat AI. Réessayez, et si le problème persiste signalez-le avec l'horodatage de ce message.`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

const EMPTY_FINAL_RESPONSE = "Le modèle n’a pas fourni de réponse finale.";
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripModelReasoning(value: unknown) {
  let text = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text) return EMPTY_FINAL_RESPONSE;

  // Some chat templates expose explicit analysis/final channels instead of
  // XML-style reasoning tags. When a final channel exists, it is the only
  // model-authored content that may cross the renderer boundary.
  const channelMarkers = [
    /<\|start\|>assistant<\|channel\|>final<\|message\|>/gi,
    /<\|channel\|>final<\|message\|>/gi,
  ];
  for (const marker of channelMarkers) {
    const matches = [...text.matchAll(marker)];
    const last = matches.at(-1);
    if (last?.index !== undefined) text = text.slice(last.index + last[0].length);
  }

  for (const tag of ["think", "analysis", "reasoning"]) {
    const complete = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    text = text.replace(complete, "");

    const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
    const closes = [...text.matchAll(close)];
    const lastClose = closes.at(-1);
    if (lastClose?.index !== undefined) text = text.slice(lastClose.index + lastClose[0].length);

    // Never reveal an unterminated reasoning section. A malformed model turn
    // is safer as an empty final answer than as leaked chain-of-thought.
    const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
    const openIndex = text.search(open);
    if (openIndex >= 0) text = text.slice(0, openIndex);
  }

  for (const tag of ["THINK", "ANALYSIS", "REASONING"]) {
    const complete = new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, "gi");
    text = text.replace(complete, "");

    const closing = new RegExp(`\\[\\/${tag}\\]`, "gi");
    const closes = [...text.matchAll(closing)];
    const lastClose = closes.at(-1);
    if (lastClose?.index !== undefined) text = text.slice(lastClose.index + lastClose[0].length);

    const opening = new RegExp(`\\[${tag}\\]`, "i");
    const openIndex = text.search(opening);
    if (openIndex >= 0) text = text.slice(0, openIndex);
  }

  text = text.replace(/<\|(?:start|end|channel|message)\|>/gi, "").trim();

  // Handle plain-text reasoning only when the model also provides an explicit
  // final-answer delimiter, avoiding accidental removal of ordinary prose.
  if (/^(?:thinking|reasoning|analysis|réflexion|raisonnement)(?:\s*:|\s*\n)/i.test(text)) {
    const finalMarker = /(?:^|\n)\s*(?:final(?: answer| response)?|réponse(?: finale)?)\s*:\s*/gi;
    const matches = [...text.matchAll(finalMarker)];
    const last = matches.at(-1);
    text = last?.index !== undefined ? text.slice(last.index + last[0].length).trim() : "";
  }

  return text || EMPTY_FINAL_RESPONSE;
}

export async function readModelManifest(manifestPath: string): Promise<ModelManifest> {
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ModelManifest;
  if (parsed.schemaVersion !== STORED_SCHEMA_VERSIONS.localModels.current || !parsed.runtime || parsed.models?.length !== 3) throw new Error("Le manifeste des modèles locaux est invalide.");
  for (const artifact of [parsed.runtime, ...parsed.models]) {
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || !["github.com", "huggingface.co"].includes(url.hostname)) throw new Error(`URL de modèle non approuvée : ${artifact.url}`);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error(`Empreinte ou taille invalide pour ${artifact.id}.`);
  }
  return parsed;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

async function validPinnedFile(filePath: string, expectedBytes: number, expectedSha: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size === expectedBytes && await sha256File(filePath) === expectedSha;
  } catch { return false; }
}

async function downloadPinned(artifact: { id: string; url: string; sha256: string; bytes: number }, destination: string, send: Send) {
  if (await validPinnedFile(destination, artifact.bytes, artifact.sha256)) return destination;
  const partial = `${destination}.partial`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let received = 0;
  try { received = (await fs.stat(partial)).size; } catch { /* no partial */ }
  if (received > artifact.bytes) {
    await fs.rename(partial, `${partial}.invalid-${randomUUID()}`);
    received = 0;
  }
  if (received === artifact.bytes) {
    send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "VERIFY", receivedBytes: received, totalBytes: artifact.bytes });
    const resumedDigest = await sha256File(partial);
    if (resumedDigest !== artifact.sha256) {
      await fs.rename(partial, `${partial}.sha256-failed-${randomUUID()}`);
      throw new Error(`Échec SHA-256 pour ${artifact.id}. Le fichier repris a été isolé.`);
    }
    try { await fs.rename(destination, `${destination}.invalid-${randomUUID()}`); } catch { /* target absent */ }
    await fs.rename(partial, destination);
    return destination;
  }
  const abort = new AbortController();
  let inactivityTimer: NodeJS.Timeout | undefined;
  const armInactivityTimeout = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abort.abort(new Error("Aucun octet reçu depuis 60 secondes.")), 60_000);
  };
  armInactivityTimeout();
  try {
    const response = await fetch(artifact.url, { redirect: "follow", headers: received ? { Range: `bytes=${received}-` } : {}, signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`Téléchargement refusé (${response.status}) pour ${artifact.id}.`);
    if (received && response.status !== 206) {
      await fs.rename(partial, `${partial}.range-unsupported-${randomUUID()}`);
      return downloadPinned(artifact, destination, send);
    }
    const tracker = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      armInactivityTimeout();
      send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "DOWNLOAD", receivedBytes: received, totalBytes: artifact.bytes });
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as any), tracker, createWriteStream(partial, { flags: received ? "a" : "w" }));
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`Téléchargement interrompu pour ${artifact.id} après 60 secondes sans données. Le fichier partiel est conservé pour reprise.`, { cause: error });
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }
  const stat = await fs.stat(partial);
  if (stat.size !== artifact.bytes) throw new Error(`Taille reçue invalide pour ${artifact.id} (${stat.size}/${artifact.bytes}). Le fichier partiel est conservé pour reprise.`);
  send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "VERIFY", receivedBytes: stat.size, totalBytes: artifact.bytes });
  const digest = await sha256File(partial);
  if (digest !== artifact.sha256) {
    await fs.rename(partial, `${partial}.sha256-failed-${randomUUID()}`);
    throw new Error(`Échec SHA-256 pour ${artifact.id}. Le fichier rejeté a été isolé.`);
  }
  try {
    if (await validPinnedFile(destination, artifact.bytes, artifact.sha256)) { await fs.rename(partial, `${partial}.duplicate-${randomUUID()}`); return destination; }
    await fs.rename(destination, `${destination}.invalid-${randomUUID()}`);
  } catch { /* target absent */ }
  await fs.rename(partial, destination);
  return destination;
}

async function findFile(root: string, name: string): Promise<string | null> {
  try {
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      const target = path.join(root, item.name);
      if (item.isFile() && item.name.toLowerCase() === name.toLowerCase()) return target;
      if (item.isDirectory()) { const nested = await findFile(target, name); if (nested) return nested; }
    }
  } catch { /* absent */ }
  return null;
}

async function installRuntime(manifest: ModelManifest, root: string, send: Send) {
  const target = path.join(root, "runtime", manifest.runtime.version);
  const existing = await findFile(target, "llama-cli.exe");
  if (existing) return existing;
  const downloads = path.join(root, "downloads");
  const archive = await downloadPinned(manifest.runtime, path.join(downloads, manifest.runtime.fileName), send);
  const staging = path.join(root, "staging", `runtime-${manifest.runtime.version}-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  const directory = await unzipper.Open.file(archive);
  for (const entry of directory.files) {
    const relative = entry.path.replace(/\\/g, "/");
    const output = path.resolve(staging, relative);
    const boundary = `${path.resolve(staging)}${path.sep}`;
    if (!output.startsWith(boundary) || relative.includes("../") || path.isAbsolute(relative)) throw new Error("L'archive llama.cpp contient un chemin non sûr.");
    if (entry.type === "Directory") { await fs.mkdir(output, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(output, { flags: "wx" }));
  }
  const executable = await findFile(staging, "llama-cli.exe");
  if (!executable) throw new Error("L'archive llama.cpp vérifiée ne contient pas llama-cli.exe.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.rename(target, `${target}.invalid-${randomUUID()}`); } catch { /* absent */ }
  await fs.rename(staging, target);
  const installed = await findFile(target, "llama-cli.exe");
  if (!installed) throw new Error("L'installation du moteur local est incomplète.");
  return installed;
}

async function gpuProfile() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((gpu: any) => ({ name: String(gpu.Name ?? "GPU"), vramBytes: Number(gpu.AdapterRAM ?? 0), driverVersion: String(gpu.DriverVersion ?? "") }));
  } catch { return []; }
}

export async function profileHardware(modelRoot: string) {
  const disk = await fs.statfs(modelRoot).catch(async () => { await fs.mkdir(modelRoot, { recursive: true }); return fs.statfs(modelRoot); });
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "Unknown CPU",
    logicalCores: os.cpus().length,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    freeDiskBytes: disk.bavail * disk.bsize,
    gpus: await gpuProfile(),
  };
}

export function recommendModel(profile: Awaited<ReturnType<typeof profileHardware>>, manifest: ModelManifest) {
  const diskReserve = 2 * 1024 ** 3;
  const eligible = manifest.models.filter((model) => profile.totalRamBytes >= model.minimumRamBytes && profile.freeRamBytes >= model.recommendedFreeRamBytes && profile.freeDiskBytes >= model.bytes + manifest.runtime.bytes + diskReserve);
  const recommended = eligible.at(-1) ?? manifest.models[0];
  return {
    tier: recommended.tier,
    modelId: recommended.id,
    reason: eligible.length ? `${recommended.displayName} tient dans la RAM et l'espace libre mesurés.` : `${recommended.displayName} est le profil minimal; libérez de la mémoire et au moins ${Math.ceil((recommended.bytes + diskReserve) / 1024 ** 3)} Gio avant installation.`,
    eligibleModelIds: eligible.map((model) => model.id),
  };
}

async function localBenchmark() {
  const iterations = 1_250_000;
  let state = 0x9e3779b9;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) state = Math.imul(state ^ index, 2654435761) >>> 0;
  const durationMs = performance.now() - started;
  return { kind: "CPU_INTEGER_CALIBRATION", iterations, durationMs: Math.round(durationMs * 100) / 100, operationsPerSecond: Math.round(iterations / (durationMs / 1000)), checksum: state, measuredAt: new Date().toISOString() };
}

function modelPath(root: string, model: ModelArtifact) { return path.join(root, "models", model.fileName); }

async function modelStatuses(root: string, manifest: ModelManifest) {
  return Promise.all(manifest.models.map(async (model) => {
    const filePath = modelPath(root, model);
    let present = false; let valid = false;
    try { present = (await fs.stat(filePath)).isFile(); valid = present && await validPinnedFile(filePath, model.bytes, model.sha256); } catch { /* absent */ }
    const integrity: LocalModel["integrity"] = valid ? "VERIFIED" : present ? "INVALID" : "ABSENT";
    return { ...model, present, installed: valid, integrity };
  }));
}

async function ollamaFetch(baseUrl: string, endpoint: string, init?: RequestInit, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = (await response.text().catch(() => "")).trim();
      throw new Error(`Ollama a refusé la demande (${response.status})${details ? ` : ${details.slice(0, 500)}` : "."}`);
    }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Ollama n'a pas répondu dans le délai prévu.", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a request to whichever candidate host answers, remembering it so the
 * next call is a single round trip. A host that stops answering falls back to a
 * full sweep instead of failing outright: the service may simply have been
 * restarted on another address.
 */
async function ollamaRequest(endpoint: string, init?: RequestInit, timeoutMs = 12_000) {
  const candidates = ollamaHostCandidates();
  // The remembered address is only a reordering hint. It is ignored the moment
  // it stops being a candidate, so changing OLLAMA_HOST takes effect at once
  // instead of being shadowed by whatever answered last.
  const ordered = ollamaBaseUrl && candidates.includes(ollamaBaseUrl)
    ? [ollamaBaseUrl, ...candidates.filter((candidate) => candidate !== ollamaBaseUrl)]
    : candidates;
  let lastError: unknown = new Error("Aucune adresse Ollama n'a été essayée.");
  for (const baseUrl of ordered) {
    try {
      const result = await ollamaFetch(baseUrl, endpoint, init, timeoutMs);
      ollamaBaseUrl = baseUrl;
      return result;
    } catch (error) {
      lastError = error;
      // A refusal from a reachable service is a real answer: stop sweeping.
      if (error instanceof Error && error.message.startsWith("Ollama a refusé")) {
        ollamaBaseUrl = baseUrl;
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Well-known Windows install locations for the Ollama binary. */
function ollamaExecutableCandidates() {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  if (localAppData) candidates.push(path.join(localAppData, "Programs", "Ollama", "ollama.exe"));
  if (programFiles) candidates.push(path.join(programFiles, "Ollama", "ollama.exe"));
  candidates.push(path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama", "ollama.exe"));
  return [...new Set(candidates)];
}

/**
 * Finds the Ollama binary without running it, so Wheat can tell "not installed"
 * apart from "installed but not currently listening" - two situations that need
 * completely different words in the interface.
 */
async function findOllamaExecutable(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const candidate of ollamaExecutableCandidates()) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* next candidate */ }
  }
  return null;
}

/** Model manifests stay on disk even while the service is stopped. */
async function ollamaStoreHasModels(): Promise<boolean> {
  const root = process.env.OLLAMA_MODELS
    ? path.resolve(process.env.OLLAMA_MODELS, "manifests")
    : path.join(os.homedir(), ".ollama", "models", "manifests");
  try {
    return (await fs.readdir(root)).length > 0;
  } catch {
    return false;
  }
}

export type OllamaDiscovery = {
  available: boolean;
  error?: string;
  models: LocalModel[];
  /** The binary or the model store exists, whatever the service is doing. */
  installed: boolean;
  /** Installed, but nothing is answering on any candidate host. */
  serviceStopped: boolean;
  baseUrl?: string;
  executablePath?: string;
};

/**
 * Starts the local Ollama service on demand.
 *
 * Only ever called from an explicit user action in the Wheat AI screen - Wheat
 * never starts another product's background service on its own. The child is
 * detached so it outlives Wheat, exactly as the Ollama tray application does.
 */
export async function startOllamaService(): Promise<OllamaDiscovery> {
  const already = await listOllamaModels();
  if (already.available) return already;
  const executable = await findOllamaExecutable();
  if (!executable) throw new Error("Ollama n'est pas installé sur cet ordinateur.");
  const child = spawn(executable, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  // The service binds its port a moment after the process exists.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const discovered = await listOllamaModels();
    if (discovered.available) return discovered;
  }
  return listOllamaModels();
}

/**
 * Reads the installed Ollama models with the capability metadata the service
 * publishes. `capabilities` is what decides whether Wheat AI may offer an image
 * attachment for a model: it comes from Ollama itself, never from a guess based
 * on the model's name.
 */
export async function listOllamaModels(): Promise<OllamaDiscovery> {
  try {
    const payload = await ollamaRequest("/api/tags") as { models?: any[] };
    const models = (Array.isArray(payload.models) ? payload.models : []).map((item): LocalModel => {
      const name = String(item?.name ?? item?.model ?? "").trim();
      const capabilities = Array.isArray(item?.capabilities)
        ? item.capabilities.map((entry: unknown) => String(entry).toLowerCase())
        : [];
      return {
        id: `ollama:${name}`,
        provider: "OLLAMA",
        displayName: name,
        installed: Boolean(name),
        chatReady: Boolean(name),
        removable: true,
        integrity: "LOCAL",
        bytes: Math.max(0, Number(item?.size ?? 0)),
        source: "Ollama local",
        baseModel: String(item?.details?.family ?? "") || undefined,
        quantization: String(item?.details?.quantization_level ?? "") || undefined,
        parameterSize: String(item?.details?.parameter_size ?? "") || undefined,
        digest: String(item?.digest ?? "") || undefined,
        tier: "EXTERNAL",
        supportsVision: capabilities.includes("vision"),
        supportsTools: capabilities.includes("tools"),
        supportsThinking: capabilities.includes("thinking"),
      };
    }).filter((item) => item.installed);
    const executablePath = await findOllamaExecutable();
    return {
      available: true,
      models,
      installed: Boolean(executablePath) || models.length > 0,
      serviceStopped: false,
      baseUrl: ollamaBaseUrl ?? undefined,
      executablePath: executablePath ?? undefined,
    };
  } catch (error) {
    const executablePath = await findOllamaExecutable();
    const installed = Boolean(executablePath) || await ollamaStoreHasModels();
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      models: [],
      installed,
      serviceStopped: installed,
      executablePath: executablePath ?? undefined,
    };
  }
}

function huggingFaceCacheRoots() {
  const roots = new Set<string>();
  if (process.env.HF_HUB_CACHE) roots.add(path.resolve(process.env.HF_HUB_CACHE));
  if (process.env.HF_HOME) roots.add(path.resolve(process.env.HF_HOME, "hub"));
  roots.add(path.join(os.homedir(), ".cache", "huggingface", "hub"));
  if (process.platform === "win32") roots.add(path.join(os.homedir(), "AppData", "Local", "huggingface", "hub"));
  return [...roots];
}

async function collectGgufFiles(directory: string, depth: number, output: string[]) {
  if (depth > 5 || output.length >= 500) return;
  let entries: Array<import("node:fs").Dirent>;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= 500) return;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectGgufFiles(candidate, depth + 1, output);
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".gguf")) output.push(candidate);
  }
}

export async function listHuggingFaceGgufModels(): Promise<{ roots: string[]; models: LocalModel[] }> {
  const roots: string[] = [];
  const models: LocalModel[] = [];
  const seenFiles = new Set<string>();
  for (const root of huggingFaceCacheRoots()) {
    let repositories: Array<import("node:fs").Dirent>;
    try { repositories = await fs.readdir(root, { withFileTypes: true }); roots.push(root); } catch { continue; }
    for (const repository of repositories) {
      if (!repository.isDirectory() || !repository.name.startsWith("models--")) continue;
      const repoRoot = path.resolve(root, repository.name);
      const candidates: string[] = [];
      await collectGgufFiles(path.join(repoRoot, "snapshots"), 0, candidates);
      for (const candidate of candidates) {
        try {
          const realPath = path.resolve(await fs.realpath(candidate));
          if (realPath !== repoRoot && !realPath.startsWith(`${repoRoot}${path.sep}`)) continue;
          const key = realPath.toLocaleLowerCase("en-US");
          if (seenFiles.has(key)) continue;
          seenFiles.add(key);
          const stat = await fs.stat(realPath);
          if (!stat.isFile()) continue;
          const repoId = repository.name.slice("models--".length).replace("--", "/");
          const fileName = path.basename(candidate);
          const id = `huggingface:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
          models.push({
            id,
            provider: "HUGGINGFACE",
            displayName: `${repoId} · ${fileName}`,
            installed: true,
            chatReady: false,
            removable: false,
            integrity: "LOCAL",
            bytes: stat.size,
            source: "Cache Hugging Face local",
            baseModel: repoId,
            quantization: fileName.match(/(?:Q\d[^.]*)/i)?.[0],
            tier: "EXTERNAL",
            fileName,
            filePath: realPath,
            repoRoot,
          });
        } catch { /* Ignore incomplete cache entries. */ }
      }
    }
  }
  return { roots, models };
}

async function discoverLocalModels(root: string, manifest: ModelManifest) {
  const runtimeExecutable = await findFile(path.join(root, "runtime", manifest.runtime.version), "llama-cli.exe");
  const [bundledModels, ollama, huggingFace] = await Promise.all([
    modelStatuses(root, manifest),
    listOllamaModels(),
    listHuggingFaceGgufModels(),
  ]);
  const bundled: LocalModel[] = bundledModels.map((model) => ({
    ...model,
    provider: "WHEAT",
    displayName: model.displayName,
    installed: model.installed,
    chatReady: model.installed && Boolean(runtimeExecutable),
    removable: model.installed,
    integrity: model.integrity,
    filePath: modelPath(root, model),
  }));
  const huggingFaceModels = huggingFace.models.map((model) => ({ ...model, chatReady: Boolean(runtimeExecutable) }));
  const remote = await discoverRemoteModels();
  return { models: [...remote, ...ollama.models, ...huggingFaceModels, ...bundled], runtimeExecutable, ollama, huggingFace };
}

/**
 * Free remote models, exposed alongside the local ones so the AI workspace can
 * offer them in the same picker. The first entry is the automatic mode, which
 * lets Wheat rank and fail over across every verified free model.
 */
async function discoverRemoteModels(): Promise<LocalModel[]> {
  if (!remoteProviderService?.isRemoteAvailable()) return [];
  const listedModels: Array<{ selectionId: string; provider: "openrouter" | "groq"; label: string; contextTokens: number; rankingReason: string; supportsVision: boolean; supportsTools: boolean }> = [];
  try {
    const listed = await remoteProviderService.listSelectableModels({});
    listedModels.push(...listed.models);
  } catch {
    // A discovery failure must never hide the local models; the provider card
    // in Settings reports the reason.
  }

  const models: LocalModel[] = [{
    id: AUTOMATIC_FREE_MODEL_ID,
    provider: "OPENROUTER",
    displayName: "Automatique — modeles gratuits",
    installed: true,
    chatReady: true,
    removable: false,
    sizeLabel: "Selection automatique",
    notes: "Wheat classe les modeles gratuits verifies et bascule automatiquement en cas d'indisponibilite.",
    // Automatic mode can take an image exactly when at least one verified free
    // model reads images: the failover chain filters candidates on that same
    // capability, so an image is never routed to a text-only model. Declaring
    // it `false` unconditionally hid the attachment control from every user of
    // the recommended mode, including those whose provider had vision models.
    supportsVision: listedModels.some((model) => model.supportsVision === true),
    supportsTools: listedModels.some((model) => model.supportsTools === true),
  } as unknown as LocalModel];

  for (const model of listedModels) {
    models.push({
      id: model.selectionId,
      provider: model.provider === "groq" ? "GROQ" : "OPENROUTER",
      displayName: model.label,
      installed: true,
      chatReady: true,
      removable: false,
      sizeLabel: `${Math.round(model.contextTokens / 1000)}k contexte`,
      notes: `${PROVIDER_LABELS[model.provider]} · gratuit verifie · ${model.rankingReason}`,
      supportsVision: model.supportsVision === true,
      supportsTools: model.supportsTools === true,
    } as unknown as LocalModel);
  }
  return models;
}

/** Remote chat, mapped onto the same result shape the local runners return. */
async function runRemoteChat(model: LocalModel, payload: Record<string, any>) {
  if (!remoteProviderService) throw new Error("Le service de fournisseurs Wheat AI n'est pas disponible.");
  const messages = normalizedChatMessages(payload);
  if (!messages.length) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `\n\nContexte d'outils types (JSON):\n${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `\n\nConnaissance produit verifiee:\n${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const capabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const allowed = payload.mutationToolsAllowed === false
    ? capabilities.filter((item) => item.mode === "READ" || item.mode === "NAVIGATION")
    : capabilities;

  const chatMessages: WheatAiChatMessage[] = [
    { role: "system", content: `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}` },
    ...messages.map((item) => (item.role === "assistant"
      ? { role: "assistant" as const, content: item.content }
      : { role: "user" as const, content: item.content, images: item.images })),
  ];

  const pinned = model.id === AUTOMATIC_FREE_MODEL_ID ? null : model.id;
  const result = await remoteProviderService.chat({
    messages: chatMessages,
    tools: allowed.map((definition) => ({
      type: "function",
      function: {
        name: modelCapabilityName(definition.id),
        description: definition.description,
        parameters: definition.inputSchema,
      },
    })),
    temperature: 0.2,
    maxTokens: 1024,
    pinnedModelId: pinned,
  });

  const proposedToolCalls = result.toolCalls.map((call) => ({
    capabilityId: capabilityIdFromModelName(call.name),
    arguments: call.arguments,
  }));
  const text = result.text || (proposedToolCalls.length
    ? "J'ai prepare les actions demandees. Wheat appliquera les regles de risque et de confirmation ci-dessous."
    : EMPTY_FINAL_RESPONSE);
  // A successful failover is invisible to the user. It used to be appended to
  // the assistant's answer, which put an internal routing decision — provider,
  // model identifier, retry count — into the conversation, where it was stored
  // as message content, replayed on reopening and fed back to the model as
  // context. It is a diagnostic event, and `chatWithFailover` records it as
  // one; `metrics` below never leaves the main process.

  return {
    text,
    proposedToolCall: proposedToolCalls[0] ? { toolName: proposedToolCalls[0].capabilityId, arguments: proposedToolCalls[0].arguments } : null,
    proposedToolCalls,
    metrics: { evalCount: result.usage?.completionTokens, promptTokens: result.usage?.promptTokens, remoteModelId: result.modelId, remoteProvider: result.provider, failedOverCount: result.failedOver.length },
  };
}

function publicModel(model: LocalModel) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model)) {
    if (key !== "filePath" && key !== "repoRoot") safe[key] = value;
  }
  return safe;
}

async function verifyInstalledModel(executable: string, modelFile: string) {
  const { stdout: versionOutput, stderr: versionErrors } = await execFileAsync(executable, ["--version"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const { stdout: inferenceOutput } = await execFileAsync(executable, [
    "-m", modelFile,
    "-p", "Réponds uniquement par OK.",
    "-n", "8",
    "-c", "512",
    "-t", String(Math.max(1, Math.min(4, os.cpus().length))),
    "-ngl", "0",
    "--temp", "0",
    "--no-display-prompt",
    "--single-turn",
  ], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (!inferenceOutput.trim()) throw new Error("Le test d'inférence local n'a produit aucune réponse.");
  return {
    runtimeVersion: (versionOutput || versionErrors).trim().slice(0, 500),
    inferenceSample: inferenceOutput.trim().slice(0, 500),
  };
}

async function getSettings(prisma: PrismaLike, companyId: string) {
  return prisma.wheatAiSettings.findUnique({ where: { companyId } });
}

type MutationPreview = {
  summary: string;
  target: string;
  changes: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  warnings: string[];
};

function normalizeCompanyProfileChanges(args: Record<string, any>) {
  const data: Record<string, string> = {};
  if (args.name !== undefined) data.name = requireText(args.name, "La raison sociale", 180);
  if (args.legalForm !== undefined) data.legalForm = requireText(args.legalForm, "La forme juridique", 80);
  if (args.city !== undefined) data.city = requireText(args.city, "La ville", 120);
  if (args.ice !== undefined) {
    const ice = String(args.ice ?? "").trim();
    if (ice && !/^\d{15}$/.test(ice)) throw new Error("L'ICE doit contenir exactement 15 chiffres.");
    data.ice = ice;
  }
  if (args.taxId !== undefined) data.taxId = String(args.taxId ?? "").trim().slice(0, 40);
  if (args.vatFrequency !== undefined) {
    const frequency = String(args.vatFrequency).toUpperCase();
    if (!new Set(["MONTHLY", "QUARTERLY"]).has(frequency)) throw new Error("La fréquence TVA est invalide.");
    data.vatFrequency = frequency;
  }
  if (!Object.keys(data).length) throw new Error("Aucun champ du dossier n'a été proposé.");
  return data;
}

function positiveCentString(value: unknown, label: string) {
  const raw = requireText(value, label, 30);
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(`${label} doit contenir un nombre positif de centimes entiers.`);
  return BigInt(raw).toString();
}

export async function prepareWheatAiMutation(prisma: PrismaLike, companyId: string, toolName: string, rawArgs: Record<string, any>) {
  const args = { ...rawArgs };
  let preview: MutationPreview;
  let preconditions: Record<string, unknown> = {};
  if (toolName === "create_account_subdivision") {
    const parentCode = requireText(args.parentCode, "Le compte parent", 20).toUpperCase();
    const code = requireText(args.code, "Le nouveau compte", 20).toUpperCase();
    const label = requireText(args.label, "Le libellé", 180);
    if (!/^[0-9][0-9A-Z._-]{1,19}$/.test(code)) throw new Error("Le code du sous-compte est invalide.");
    const parent = await prisma.account.findFirst({ where: { companyId, code: parentCode } });
    if (!parent) throw new Error(`Le compte parent ${parentCode} n'existe pas dans ce dossier.`);
    if (!parent.active) throw new Error(`Le compte parent ${parentCode} est inactif.`);
    if (!code.startsWith(parent.code) || code.length <= parent.code.length) throw new Error(`Le sous-compte doit prolonger le code parent ${parent.code}.`);
    if (await prisma.account.findFirst({ where: { companyId, code }, select: { id: true } })) throw new Error(`Le compte ${code} existe déjà dans ce dossier.`);
    Object.assign(args, { parentCode, code, label });
    preview = { summary: `Créer la subdivision ${code}`, target: `Compte parent ${parent.code} · ${parent.label}`, changes: [{ field: "account", label: "Nouveau compte", before: "Absent", after: `${code} · ${label}` }], warnings: ["Le nouveau compte héritera des mappings et de la nature du compte parent."] };
    preconditions = { parentAccountId: parent.id, parentAccountVersion: parent.version, accountCodeMustBeAbsent: code };
  } else if (toolName === "update_company_profile") {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error("La société n'existe plus.");
    const data = normalizeCompanyProfileChanges(args);
    const changes = Object.entries(data).filter(([field, value]) => String(company[field] ?? "") !== value).map(([field, value]) => ({ field, label: ({ name: "Raison sociale", legalForm: "Forme juridique", ice: "ICE", taxId: "Identifiant fiscal", city: "Ville", vatFrequency: "Fréquence TVA" } as Record<string, string>)[field] ?? field, before: company[field] ?? "", after: value }));
    if (!changes.length) throw new Error("Les valeurs proposées sont déjà enregistrées dans le dossier.");
    Object.keys(args).forEach((key) => { if (!(key in data)) delete args[key]; });
    Object.assign(args, data);
    preview = { summary: "Modifier l'identité du dossier", target: company.name, changes, warnings: ["La version du dossier sera incrémentée et l'action sera auditée."] };
    preconditions = { companyVersion: company.version };
  } else if (toolName === "rename_custom_account") {
    const accountCode = requireText(args.accountCode, "Le compte", 20).toUpperCase();
    const label = requireText(args.label, "Le libellé", 180);
    const account = await prisma.account.findFirst({ where: { companyId, code: accountCode } });
    if (!account) throw new Error(`Le compte ${accountCode} n'existe pas dans ce dossier.`);
    if (account.isStandard) throw new Error("Un compte officiel PCGE ne peut pas être renommé.");
    if (account.label === label) throw new Error("Le compte porte déjà ce libellé.");
    Object.assign(args, { accountCode, label });
    preview = { summary: `Renommer le compte ${accountCode}`, target: `${accountCode} · ${account.label}`, changes: [{ field: "label", label: "Libellé", before: account.label, after: label }], warnings: ["Les libellés instantanés des écritures encore en brouillon seront actualisés."] };
    preconditions = { accountId: account.id, accountVersion: account.version };
  } else if (toolName === "add_fiscal_table_row" || toolName === "mark_fiscal_table_not_applicable") {
    const tableId = requireText(args.tableId, "Le tableau", 10).toUpperCase();
    const definition = fiscalTableDefinition(tableId);
    if (!definition) throw new Error("Le tableau fiscal doit être compris entre T01 et T25.");
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
    if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
    const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId } });
    if (!workpaper || workpaper.status !== "DRAFT") throw new Error("Le tableau fiscal ciblé n'est plus modifiable.");
    Object.assign(args, { tableId, _fiscalPackageId: fiscalPackage.id, _expectedRevision: workpaper.revision });
    if (toolName === "add_fiscal_table_row") {
      if (!args.row || typeof args.row !== "object" || Array.isArray(args.row)) throw new Error("La ligne fiscale proposée est invalide.");
      preview = { summary: `Ajouter une ligne au tableau ${definition.number}`, target: definition.label, changes: [{ field: "manualRows", label: "Nouvelle ligne", before: "Aucune modification", after: args.row }], warnings: ["La ligne sera enregistrée en brouillon et devra satisfaire les contrôles du tableau avant revue."] };
    } else {
      const reason = requireText(args.reason, "Le motif de non-applicabilité", 500);
      if (reason.length < 5) throw new Error("Le motif de non-applicabilité doit être suffisamment précis.");
      args.reason = reason;
      preview = { summary: `Marquer le tableau ${definition.number} non applicable`, target: definition.label, changes: [{ field: "status", label: "Statut", before: "Brouillon", after: "Non applicable" }, { field: "reason", label: "Motif", before: "", after: reason }], warnings: ["Le tableau restera visible et comptera comme complet."] };
    }
    preconditions = { fiscalPackageId: fiscalPackage.id, fiscalPackageStatus: fiscalPackage.status, workpaperId: workpaper.id, workpaperRevision: workpaper.revision, workpaperStatus: workpaper.status };
  } else if (toolName === "add_fiscal_adjustment") {
    const kind = requireText(args.kind, "Le type d'ajustement", 20).toUpperCase();
    if (!new Set(["REINTEGRATION", "DEDUCTION"]).has(kind)) throw new Error("Le type d'ajustement fiscal est invalide.");
    const label = requireText(args.label, "Le libellé", 250);
    const amountCents = positiveCentString(args.amountCents, "Le montant");
    const legalReference = requireText(args.legalReference, "La référence légale", 500);
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
    if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
    Object.assign(args, { kind, label, amountCents, legalReference, _fiscalPackageId: fiscalPackage.id });
    preview = { summary: kind === "REINTEGRATION" ? "Ajouter une réintégration fiscale" : "Ajouter une déduction fiscale", target: `Liasse ${fiscalPackage.templateVersion}`, changes: [{ field: "adjustment", label: label, before: "Absent", after: `${amountCents} centimes · ${legalReference}` }], warnings: ["L'ajustement sera non vérifié et bloquera la revue du tableau 3 jusqu'à validation humaine."] };
    preconditions = { fiscalPackageId: fiscalPackage.id, fiscalPackageStatus: fiscalPackage.status };
  } else if (toolName === "remember_company_knowledge") {
    const kind = requireText(args.kind, "Le type de règle", 60).toUpperCase();
    const key = requireText(args.key, "La clé de la règle", 160);
    const confidenceBps = Math.min(10_000, Math.max(0, Number(args.confidenceBps ?? 5_000)));
    if (!Number.isInteger(confidenceBps)) throw new Error("Le niveau de confiance doit être exprimé en points de base entiers.");
    Object.assign(args, { kind, key, confidenceBps, value: args.value ?? {}, evidence: Array.isArray(args.evidence) ? args.evidence : [] });
    preview = { summary: `Mémoriser la règle ${key}`, target: `Connaissance ${kind}`, changes: [{ field: "knowledge", label: "Règle dossier", before: "Non enregistrée ou ancienne valeur", after: args.value }], warnings: ["Cette connaissance reste propre au dossier et ne constitue pas une règle légale."] };
  } else {
    throw new Error("Cette modification Wheat AI n'est pas prise en charge.");
  }
  return { arguments: args, preview, preconditions };
}

/** Image formats Wheat AI accepts as an attachment. */
const CHAT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

export type ChatImageAttachment = { mimeType: string; base64: string };

/**
 * Validates the attachments carried by one chat turn.
 *
 * Renderer input is never trusted: the MIME type has to be one Wheat declared,
 * the payload has to be real base64, and the decoded size has to stay inside a
 * bound the provider will actually accept.
 */
function normalizedChatImages(value: unknown): ChatImageAttachment[] {
  if (!Array.isArray(value) || !value.length) return [];
  if (value.length > MAX_CHAT_IMAGES) throw new Error(`Wheat AI accepte au maximum ${MAX_CHAT_IMAGES} images par message.`);
  return value.map((item: any) => {
    const mimeType = String(item?.mimeType ?? "").trim().toLowerCase();
    if (!CHAT_IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Format d'image non pris en charge : utilisez PNG, JPG ou WebP.");
    const base64 = String(item?.base64 ?? "").replace(/^data:[^;]+;base64,/, "").trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length < 32) throw new Error("Cette image est illisible.");
    if (Math.floor(base64.length * 3 / 4) > MAX_CHAT_IMAGE_BYTES) throw new Error("Chaque image doit peser moins de 8 Mo.");
    return { mimeType, base64 };
  });
}

function normalizedChatMessages(payload: Record<string, any>) {
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages.slice(-20).map((item: any) => ({
    role: item?.role === "assistant" ? "assistant" as const : "user" as const,
    content: String(item?.content ?? "").slice(0, 8000),
    images: item?.role === "assistant" ? [] : normalizedChatImages(item?.images),
  })).filter((item: { content: string; images: ChatImageAttachment[] }) => item.content.trim() || item.images.length);
}

/** True when any turn in this request carries an image. */
function payloadCarriesImages(payload: Record<string, any>) {
  return normalizedChatMessages(payload).some((item) => item.images.length > 0);
}

function boundedReference(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, any>;
  const allowed = ["id", "entryId", "invoiceId", "paymentId", "documentId", "fiscalPackageId", "tableId", "movementId", "reconciliationId", "batchId", "code", "number", "label", "displayName", "status", "lifecycleStatus", "version", "revision", "date"];
  const result: Record<string, unknown> = Object.fromEntries(allowed.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, String(source[key]).slice(0, 240)]));
  if (source.navigation && typeof source.navigation === "object") result.navigation = { target: String(source.navigation.target ?? "").slice(0, 40), entityId: source.navigation.entityId ? String(source.navigation.entityId).slice(0, 200) : null };
  return Object.keys(result).length ? result : null;
}

function boundedRecentActionContext(payload: Record<string, any>) {
  if (!Array.isArray(payload.messages)) return [];
  const recent: Array<Record<string, unknown>> = [];
  for (const message of payload.messages.slice(-10)) {
    const proposals = Array.isArray(message?.actionProposals) ? message.actionProposals : message?.actionProposal ? [message.actionProposal] : [];
    for (const proposal of proposals.slice(0, 10)) {
      recent.push({ kind: "PROPOSAL", capabilityId: String(proposal?.toolName ?? proposal?.capabilityId ?? "").slice(0, 100), status: String(proposal?.actionStatus ?? "PENDING").slice(0, 40), arguments: boundedReference(proposal?.arguments), affectedRecords: Array.isArray(proposal?.preview?.affectedRecords) ? proposal.preview.affectedRecords.slice(0, 20).map(boundedReference).filter(Boolean) : [] });
    }
    for (const action of (Array.isArray(message?.actionResults) ? message.actionResults : []).slice(0, 25)) {
      const rawResult = action?.result?.result ?? action?.result;
      recent.push({ kind: "RESULT", capabilityId: String(action?.capabilityId ?? action?.toolName ?? "").slice(0, 100), status: String(action?.status ?? "UNKNOWN").slice(0, 40), entity: boundedReference(rawResult), affectedRecords: Array.isArray(action?.affectedRecords) ? action.affectedRecords.slice(0, 20).map(boundedReference).filter(Boolean) : [] });
    }
  }
  return recent.slice(-30);
}

function isoDay(value: unknown) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
}

function lastUserMessage(payload: Record<string, any>) {
  return [...normalizedChatMessages(payload)].reverse().find((item) => item.role === "user")?.content ?? "";
}

function modelCapabilityName(id: string) {
  return `wheat__${id.replace(/\./g, "__")}`;
}

function capabilityIdFromModelName(value: unknown) {
  const name = String(value ?? "");
  return name.startsWith("wheat__") ? name.slice(7).replace(/__/g, ".") : canonicalWheatAiCapabilityId(name);
}

function ollamaCapabilitySchema(definition: WheatAiCapabilityDefinition) {
  return { type: "function", function: { name: modelCapabilityName(definition.id), description: `[Niveau ${definition.riskLevel} · ${definition.mode}] ${definition.description}`, parameters: definition.inputSchema } };
}

function boundedToolResult(name: string, value: any) {
  if (["get_entries", "search_accounts", "get_invoices", "get_documents", "get_vat_status", "get_payroll_summary", "retrieve_company_knowledge"].includes(name) && Array.isArray(value)) return value.slice(0, 100);
  if (name === "get_balance" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 80), omittedRowCount: Math.max(0, value.rows.length - 80) };
  if (name === "get_bilan") return { ...value, actif: value?.actif?.slice?.(0, 80) ?? [], passif: value?.passif?.slice?.(0, 80) ?? [], omittedRowCount: Math.max(0, Number(value?.actif?.length ?? 0) + Number(value?.passif?.length ?? 0) - 160) };
  if (name === "get_cpc" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 100), omittedRowCount: Math.max(0, value.rows.length - 100) };
  if (name === "get_bank_position" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 100), omittedRowCount: Math.max(0, value.rows.length - 100) };
  if (name === "retrieve_company_knowledge" && Array.isArray(value?.patterns)) return { ...value, patterns: value.patterns.slice(0, 30), omittedPatternCount: Math.max(0, value.patterns.length - 30) };
  return value;
}

export async function buildWheatAiChatContext(prisma: PrismaLike, companyId: string, payload: Record<string, any>, appVersion: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true, name: true, legalForm: true, ice: true, taxId: true, city: true, baseCurrency: true, vatFrequency: true, version: true,
      fiscalYears: { orderBy: { endsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true, status: true, lockedTo: true } },
      _count: { select: { accounts: true, journals: true, entries: true, invoices: true, documents: true, bankAccounts: true, payments: true, counterparties: true, taxPeriods: true, employees: true, payrollRuns: true, fiscalPackages: true, wheatKnowledgePatterns: true } },
    },
  });
  if (!company) throw new Error("La société n'existe plus.");
  const fiscalYear = company.fiscalYears.find((year: any) => year.status === "OPEN") ?? company.fiscalYears[0];
  const prompt = lastUserMessage(payload);
  const normalized = prompt.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const date = prompt.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const to = date ?? (fiscalYear ? isoDay(fiscalYear.endsOn) : undefined);
  const from = fiscalYear ? isoDay(fiscalYear.startsOn) : undefined;
  const results: Record<string, unknown> = {};
  const toolsUsed: string[] = [];
  const contextSources = [`Guide produit Wheat ${appVersion}`, `Dossier ${company.name}`];
  // The routed reads are independent of one another and were awaited one after
  // the next, so a prompt that touched four subjects paid for four round trips
  // in series before the model saw a single token. They are queued here and
  // resolved together; ordering in the context is preserved by recording each
  // result under its own name once every task has settled.
  const tasks: Array<{ name: string; run: () => Promise<unknown> }> = [];
  const queue = (name: string, run: () => Promise<unknown>) => { tasks.push({ name, run }); };
  const recordToolResult = (name: string, result: unknown) => { results[name] = boundedToolResult(name, result); toolsUsed.push(name); contextSources.push(name); };
  if (fiscalYear && /\b(balance|soldes? des comptes)\b/.test(normalized) && !/\bbilan\b/.test(normalized)) {
    queue("get_balance", () => buildBalanceFamily(prisma, { companyId, view: "GENERAL", from, to }));
  }
  if (fiscalYear && /\b(bilan|actif|passif)\b/.test(normalized)) queue("get_bilan", () => buildBilan(prisma, { companyId, asOf: to, variant: "NORMAL", view: "COMPARATIVE" }));
  if (fiscalYear && /\b(cpc|esg|solde[s]? de gestion|resultat comptable)\b/.test(normalized)) queue("get_cpc", () => buildComparativeCpc(prisma, { companyId, fiscalYearId: fiscalYear.id }));
  if (/\b(tresorerie|banque|position bancaire|cash)\b/.test(normalized)) queue("get_bank_position", () => buildBankTotal(prisma, { companyId, asOf: to }));
  if (/\b(ecriture|journal|piece comptable)\b/.test(normalized)) {
    queue("get_entries", () => prisma.entry.findMany({ where: { companyId, ...(from && to ? { date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } : {}) }, select: { id: true, number: true, pieceNumber: true, date: true, label: true, status: true, source: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 40 }));
  }
  if (/\b(compte|pcge|plan comptable)\b/.test(normalized)) {
    const accountCodes = [...new Set(normalized.match(/\b[0-9][0-9a-z._-]{1,19}\b/g) ?? [])].slice(0, 4);
    if (accountCodes.length) {
      queue("search_accounts", async () => {
        const matches = (await Promise.all(accountCodes.map((query) => searchCompanyAccounts(prisma, companyId, { query, active: true, limit: 15 })))).flat();
        return [...new Map(matches.map((item: any) => [item.id ?? item.code, item])).values()].slice(0, 40);
      });
    } else queue("search_accounts", () => searchCompanyAccounts(prisma, companyId, { query: prompt.slice(0, 200), active: true, limit: 40 }));
  }
  if (/\b(factures?|avoirs?|echeances?|impayes?|clients?|fournisseurs?)\b/.test(normalized)) {
    queue("get_invoices", () => prisma.invoice.findMany({ where: { companyId, ...(from && to ? { invoiceDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } : {}) }, select: { id: true, kind: true, documentType: true, invoiceNo: true, invoiceDate: true, dueDate: true, counterparty: true, currency: true, htCents: true, vatCents: true, ttcCents: true, lifecycleStatus: true, needsReview: true }, orderBy: [{ invoiceDate: "desc" }, { invoiceNo: "desc" }], take: 40 }));
  }
  if (/\b(documents?|pieces? jointes?|ocr|justificatifs?)\b/.test(normalized)) queue("get_documents", () => prisma.document.findMany({ where: { companyId }, select: { id: true, title: true, type: true, fiscalYear: true, tags: true, status: true, contentSha256: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 40 }));
  if (/\b(tva|taxe sur la valeur ajoutee|declaration tva)\b/.test(normalized)) queue("get_vat_status", () => prisma.taxPeriod.findMany({ where: { companyId }, select: { id: true, label: true, collectedVatCents: true, deductibleVatCents: true, dueVatCents: true, creditVatCents: true, status: true, declarationDue: true }, orderBy: { declarationDue: "desc" }, take: 24 }));
  if (/\b(paie|salaire|bulletin|masse salariale)\b/.test(normalized)) queue("get_payroll_summary", () => prisma.payrollRun.findMany({ where: { companyId }, select: { id: true, period: true, status: true, postedAt: true, voidedAt: true, _count: { select: { lines: true } } }, orderBy: { period: "desc" }, take: 24 }));
  if (/\b(liasse|fiscal|tableau fiscal)\b/.test(normalized)) {
    queue("get_fiscal_package", async () => {
      const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
      return fiscalPackage ? buildFiscalControl(prisma, { companyId, fiscalPackageId: fiscalPackage.id }) : { prepared: false, message: "Aucune liasse normale n'a encore été préparée." };
    });
  }
  if (/\b(habitude|regle du dossier|schema|connaissance|modif|creer|ajouter|renommer|memoriser)\b/.test(normalized) && prisma.wheatKnowledgePattern?.findMany) {
    queue("retrieve_company_knowledge", async () => ({ source: PCGE_SOURCE, patterns: await prisma.wheatKnowledgePattern.findMany({ where: { companyId, active: true }, orderBy: [{ confidenceBps: "desc" }, { updatedAt: "desc" }], take: 30 }) }));
  }
  // One failed read must not cost the whole answer: the assistant is told which
  // subject it could not see rather than losing the turn to it.
  const settled = await Promise.allSettled(tasks.map((task) => task.run()));
  settled.forEach((outcome, index) => {
    const { name } = tasks[index];
    if (outcome.status === "fulfilled") recordToolResult(name, outcome.value);
    else {
      wheatAiDiagnostic({ event: "wheat-ai.routed-read-failed", tool: name, companyId, errorMessage: outcome.reason instanceof Error ? outcome.reason.message.slice(0, 500) : String(outcome.reason).slice(0, 500) });
      recordToolResult(name, { unavailable: true, message: `Cette lecture (${name}) a échoué pour ce dossier ; ne t'appuie pas dessus et dis-le à l'utilisateur si elle est nécessaire.` });
    }
  });
  const dossier = {
    ...company,
    activeFiscalYearId: fiscalYear?.id ?? null,
    activeFiscalYearSelection: company.fiscalYears.some((year: any) => year.status === "OPEN") ? "LATEST_OPEN" : "LATEST_AVAILABLE",
    availableModules: {
      accounting: true,
      invoicing: true,
      documents: true,
      banking: true,
      vat: true,
      payroll: true,
      fiscalPreparation: true,
      wheatAi: true,
      statutoryFiscalExport: false,
    },
    fiscalYears: company.fiscalYears.map((year: any) => ({ ...year, startsOn: isoDay(year.startsOn), endsOn: isoDay(year.endsOn), lockedTo: year.lockedTo ? isoDay(year.lockedTo) : null })),
  };
  return {
    productKnowledge: wheatProductKnowledge(appVersion),
    dossier,
    routedResults: results,
    contextSources,
    toolsUsed,
  };
}

function actionFromText(textValue: unknown) {
  const text = String(textValue ?? "");
  const marker = text.search(/ACTION_PROPOSAL\s*:?/i);
  if (marker < 0) return null;
  const start = text.indexOf("{", marker);
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, index + 1));
        const legacy = TOOL_DEFINITIONS.find((tool) => tool.name === parsed?.toolName && tool.risk === "MUTATING");
        const capability = getWheatAiCapability(parsed?.toolName);
        if ((!legacy && (!capability || capability.mode === "READ")) || !parsed.arguments || typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments)) return null;
        return { toolName: capability?.id ?? legacy!.name, arguments: parsed.arguments, visibleText: text.slice(0, marker).trim() };
      } catch { return null; }
    }
  }
  return null;
}

function capabilityActionLabel(definition: WheatAiCapabilityDefinition, prepared: { preview: { summary: string } }) {
  return prepared.preview.summary || definition.description;
}

/**
 * Whether a capability needs a person to say yes before it runs.
 *
 * Level 1 is the registry's safe-edit boundary: once the user's wording clearly
 * authorises execution, these reversible draft/metadata changes run in both
 * assistant and automated modes. Level 2 waits in assistant mode and runs in
 * automated mode. Level 3 always waits. READ_ONLY is enforced by each caller
 * before this decision is consulted.
 */
function capabilityRequiresConfirmation(definition: WheatAiCapabilityDefinition, permissionMode: PermissionMode) {
  if (definition.confirmation === "NEVER" || definition.riskLevel === 0) return false;
  if (definition.confirmation === "ALWAYS" || definition.riskLevel === 3) return true;
  if (definition.riskLevel === 1) return false;
  return permissionMode !== "AUTOMATED";
}

/**
 * A model-provided direction is not evidence that the user chose that
 * direction. An explicit imperative mentioning exactly one side is evidence;
 * otherwise a forced OCR direction gets its own confirmation even in automated
 * mode. A contradictory tool argument is refused instead of being presented as
 * the user's choice.
 */
function explicitInvoiceKindFromPrompt(promptValue: unknown): "SALE" | "PURCHASE" | null {
  const prompt = String(promptValue ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const sale = /\b(?:facture|brouillon|document|piece|sens|type|classe(?:r|z)?|classifie(?:r|z)?|traite(?:r|z)?|enregistre(?:r|z)?|cree(?:r|z)?)\b.{0,45}\b(?:vente|sale)\b/.test(prompt)
    || /\b(?:vente|sale)\b.{0,35}\b(?:facture|brouillon|document|piece|sens|type)\b/.test(prompt);
  const purchase = /\b(?:facture|brouillon|document|piece|sens|type|classe(?:r|z)?|classifie(?:r|z)?|traite(?:r|z)?|enregistre(?:r|z)?|cree(?:r|z)?)\b.{0,45}\b(?:achat|purchase)\b/.test(prompt)
    || /\b(?:achat|purchase)\b.{0,35}\b(?:facture|brouillon|document|piece|sens|type)\b/.test(prompt);
  return sale === purchase ? null : sale ? "SALE" : "PURCHASE";
}

function directionOverrideDecision(definition: WheatAiCapabilityDefinition, args: Record<string, any>, prompt?: string) {
  if (definition.id !== "documents.create_invoice_draft" || (args.kind !== "SALE" && args.kind !== "PURCHASE")) {
    return { conflicts: false, requiresConfirmation: false };
  }
  const explicit = explicitInvoiceKindFromPrompt(prompt);
  return { conflicts: explicit !== null && explicit !== args.kind, requiresConfirmation: explicit !== args.kind };
}

function resolvedAffectedRecords(prepared: { preview: { affectedRecords: Array<Record<string, any>> } } | null, result: unknown) {
  const records = (prepared?.preview.affectedRecords ?? []).map((item) => ({ ...item }));
  const reference = boundedReference(result) as Record<string, any> | null;
  if (!records.length && reference?.id) records.push({ type: "record", id: reference.id, label: reference.label ?? reference.displayName ?? reference.code ?? reference.number ?? reference.id });
  if (records[0] && reference) {
    records[0].id ??= reference.id;
    records[0].label = [reference.code ?? reference.number, reference.label ?? reference.displayName].filter(Boolean).join(" — ") || records[0].label;
  }
  return records;
}

async function persistCapabilityProposal(prisma: PrismaLike, gateway: WheatAiDomainGateway, input: { companyId: string; actorUserId?: string | null; sessionId: string; permissionMode: PermissionMode; capabilityId: string; arguments: Record<string, any> }) {
  const prepared = await gateway.prepare(input.companyId, input.capabilityId, input.arguments);
  const event = await prisma.wheatAiAuditEvent.create({ data: {
    companyId: input.companyId,
    actorUserId: input.actorUserId ?? null,
    sessionId: input.sessionId,
    toolName: prepared.definition.id,
    permissionMode: input.permissionMode,
    requestJson: safeJson(prepared.arguments).slice(0, 100_000),
    resultSummaryJson: safeJson({ category: prepared.definition.category, riskLevel: prepared.definition.riskLevel, origin: WHEAT_AI_ORIGIN }),
    confirmationJson: safeJson({ required: true, confirmed: false, preview: prepared.preview, preconditions: prepared.preconditions, riskLevel: prepared.definition.riskLevel, auditCategory: prepared.definition.auditCategory }),
    status: "PENDING_CONFIRMATION",
    durationMs: 0,
  } });
  return { id: event.id, toolName: prepared.definition.id, capabilityId: prepared.definition.id, label: capabilityActionLabel(prepared.definition, prepared), arguments: prepared.arguments, preview: prepared.preview, riskLevel: prepared.definition.riskLevel, requiresConfirmation: true, actionStatus: "PENDING" };
}

async function auditImmediateCapability(prisma: PrismaLike, input: { companyId: string; actorUserId?: string | null; sessionId: string; permissionMode: PermissionMode; definition: WheatAiCapabilityDefinition; arguments: Record<string, any>; status: string; durationMs: number; result?: unknown; error?: unknown; intent: WheatAiIntent }) {
  const summary = input.error
    ? { origin: WHEAT_AI_ORIGIN, riskLevel: input.definition.riskLevel, intent: input.intent, error: input.error instanceof Error ? input.error.message : String(input.error) }
    : { origin: WHEAT_AI_ORIGIN, riskLevel: input.definition.riskLevel, intent: input.intent, resultKind: Array.isArray(input.result) ? "ARRAY" : typeof input.result };
  await prisma.wheatAiAuditEvent.create({ data: {
    companyId: input.companyId, actorUserId: input.actorUserId ?? null, sessionId: input.sessionId, toolName: input.definition.id, permissionMode: input.permissionMode,
    requestJson: safeJson(input.arguments).slice(0, 100_000), resultSummaryJson: safeJson(summary), confirmationJson: safeJson({ required: false, confirmed: false, intent: input.intent }), status: input.status, durationMs: input.durationMs,
  } }).catch(() => undefined);
}

export async function processWheatAiCapabilityCalls(input: {
  prisma: PrismaLike;
  gateway: WheatAiDomainGateway;
  companyId: string;
  actorUserId?: string | null;
  sessionId: string;
  permissionMode: PermissionMode;
  prompt: string;
  dryRun: boolean;
  calls: Array<{ capabilityId?: string; toolName?: string; arguments?: Record<string, any> }>;
}) {
  const intent = classifyWheatAiIntent(input.prompt, input.dryRun);
  const proposals: any[] = [];
  const results: any[] = [];
  for (const [index, call] of input.calls.slice(0, 25).entries()) {
    const capabilityId = canonicalWheatAiCapabilityId(call.capabilityId ?? call.toolName);
    const definition = getWheatAiCapability(capabilityId);
    if (!definition) {
      results.push({ index, capabilityId, status: "REJECTED", error: "Capacité inconnue." });
      continue;
    }
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
    if (definition.mode !== "READ" && definition.mode !== "NAVIGATION" && input.permissionMode === "READ_ONLY") {
      results.push({ index, capabilityId, status: "REJECTED", error: "Wheat AI est en lecture seule." });
      continue;
    }
    if (definition.riskLevel > 0 && intent !== "EXECUTION" && intent !== "PREVIEW") {
      results.push({ index, capabilityId, status: "NOT_AUTHORIZED_BY_INTENT", error: "La formulation ne constitue pas une autorisation explicite de modifier le dossier." });
      continue;
    }
    if (definition.riskLevel > 0 && intent === "PREVIEW") {
      try {
        const prepared = await input.gateway.prepare(input.companyId, definition.id, args);
        proposals.push({ id: `dry-run-${randomUUID()}`, toolName: definition.id, capabilityId: definition.id, label: capabilityActionLabel(definition, prepared), arguments: prepared.arguments, preview: prepared.preview, riskLevel: definition.riskLevel, requiresConfirmation: false, dryRun: true, actionStatus: "DRY_RUN" });
        results.push({ index, capabilityId: definition.id, status: "DRY_RUN", preview: prepared.preview });
      } catch (error) {
        results.push({ index, capabilityId: definition.id, status: "FAILED", error: describeCapabilityFailure(definition.id, error) });
      }
      continue;
    }
    const directionOverride = directionOverrideDecision(definition, args, input.prompt);
    if (directionOverride.conflicts) {
      results.push({ index, capabilityId: definition.id, status: "REJECTED", error: "Le sens proposé par le modèle contredit le sens explicitement demandé par l'utilisateur." });
      continue;
    }
    if (definition.riskLevel > 0 && (capabilityRequiresConfirmation(definition, input.permissionMode) || directionOverride.requiresConfirmation)) {
      try {
        const proposal = await persistCapabilityProposal(input.prisma, input.gateway, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, capabilityId: definition.id, arguments: args });
        proposals.push(proposal);
        results.push({ index, capabilityId: definition.id, status: "PENDING_CONFIRMATION", proposalId: proposal.id });
      } catch (error) {
        results.push({ index, capabilityId: definition.id, status: "FAILED", error: describeCapabilityFailure(definition.id, error) });
      }
      continue;
    }
    const started = Date.now();
    try {
      const prepared = definition.riskLevel > 0 ? await input.gateway.prepare(input.companyId, definition.id, args) : null;
      const executed = await input.gateway.execute(input.companyId, definition.id, prepared?.arguments ?? args, { preconditions: prepared?.preconditions, sessionId: input.sessionId });
      results.push({ index, capabilityId: definition.id, status: "SUCCEEDED", result: executed.result, affectedRecords: resolvedAffectedRecords(prepared, executed.result) });
      await auditImmediateCapability(input.prisma, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, definition, arguments: prepared?.arguments ?? args, status: "SUCCEEDED", durationMs: Date.now() - started, result: executed.result, intent });
    } catch (error) {
      results.push({ index, capabilityId: definition.id, status: "FAILED", error: describeCapabilityFailure(definition.id, error) });
      await auditImmediateCapability(input.prisma, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, definition, arguments: args, status: "FAILED", durationMs: Date.now() - started, error, intent });
    }
  }
  return { intent, proposals, results };
}

/**
 * A single, tool-free Ollama exchange.
 *
 * Used by the optional OCR document review, which needs a plain question and a
 * plain answer — not the assistant's capability registry, dossier context or
 * action-proposal machinery. Keeping it separate means the review can never
 * accidentally reach a Wheat capability.
 */
export async function runOllamaPlainChat(
  modelName: string,
  request: { system: string; user: string; images?: Array<{ mimeType: string; base64: string }> },
  timeoutMs = 180_000,
) {
  const capabilities = await ollamaModelCapabilities(modelName);
  if (!capabilities) {
    throw new Error(`Le modele Ollama « ${modelName} » n'est plus installe sur ce poste. Choisissez-en un autre dans Reglages > Wheat AI.`);
  }
  // The review sends recognised text. Images are only ever attached when the
  // model itself declares vision; a text-only model still performs the review
  // on the text, which is what the feature is for.
  const images = capabilities.supportsVision ? request.images ?? [] : [];
  const userMessage: Record<string, unknown> = { role: "user", content: request.user };
  if (images.length) userMessage.images = images.map((image) => image.base64);
  const response = await ollamaChatRequest({
    model: modelName,
    capabilities,
    messages: [{ role: "system", content: request.system }, userMessage],
    numPredict: 1024,
    temperature: 0,
    timeoutMs,
    kind: "ocr-review",
    imageCount: images.length,
  });
  return String(response.content ?? "");
}

/**
 * Capabilities Ollama publishes for one installed model, or `null` when it is
 * not installed any more.
 *
 * Reading them from the service rather than guessing from the model's name is
 * what makes "can this model read an image", "may Wheat send it tools" and
 * "does it reason in a separate field" answerable at all.
 */
export async function ollamaModelCapabilities(modelName: string): Promise<{ supportsVision: boolean; supportsTools: boolean; supportsThinking: boolean } | null> {
  const discovery = await listOllamaModels();
  const model = discovery.models.find((item) => item.displayName === modelName);
  if (!model) return null;
  return {
    supportsVision: model.supportsVision === true,
    supportsTools: model.supportsTools === true,
    supportsThinking: model.supportsThinking === true,
  };
}

/**
 * One non-streaming Ollama `/api/chat` round trip, with the protocol details
 * that decide whether an answer comes back at all.
 *
 * Two of them were silently getting this wrong:
 *
 *  - **`tools`.** Ollama rejects a request carrying a tool schema for a model
 *    without the `tools` capability, so the array is sent only to a model that
 *    declares it.
 *  - **`think`.** A reasoning model splits its output between `thinking` and
 *    `content`, and both are drawn from the same `num_predict` budget. With a
 *    long accounting context and an image to describe, the reasoning could
 *    consume the entire budget: Ollama then returned `done_reason: "length"`,
 *    an empty `content`, and Wheat reported "Ollama a terminé sans fournir de
 *    réponse finale" — a truncation described as a missing answer. Wheat now
 *    turns reasoning off for a model that supports it (the system prompt
 *    forbids exposing it anyway) and, when a reply still comes back truncated,
 *    says so instead of implying the model failed.
 */
async function ollamaChatRequest(input: {
  model: string;
  capabilities: { supportsVision: boolean; supportsTools: boolean; supportsThinking: boolean };
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  numPredict: number;
  temperature: number;
  timeoutMs: number;
  kind: string;
  imageCount: number;
}): Promise<{ content: string; toolCalls: any[]; doneReason: string }> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: false,
    options: { temperature: input.temperature, num_predict: input.numPredict },
  };
  const tools = input.capabilities.supportsTools ? input.tools ?? [] : [];
  if (tools.length) body.tools = tools;
  if (input.capabilities.supportsThinking) body.think = false;

  const response = await ollamaRequest("/api/chat", { method: "POST", body: JSON.stringify(body) }, input.timeoutMs) as any;

  const rawContent = String(response?.message?.content ?? "");
  const content = rawContent.trim() ? stripModelReasoning(rawContent) : "";
  const toolCalls = Array.isArray(response?.message?.tool_calls) ? response.message.tool_calls : [];
  const doneReason = String(response?.done_reason ?? "");
  const producedReasoning = Boolean(String(response?.message?.thinking ?? "").trim());

  // Protocol state only: never the prompt, the answer or the image bytes.
  wheatAiDiagnostic({
    event: "wheat-ai.ollama-response",
    kind: input.kind,
    model: input.model,
    doneReason,
    imageCount: input.imageCount,
    toolsSent: tools.length,
    thinkingDisabled: input.capabilities.supportsThinking,
    producedReasoning,
    contentCharacters: content.length,
    toolCallCount: toolCalls.length,
    evalCount: Number(response?.eval_count) || 0,
  });

  if ((!content || content === EMPTY_FINAL_RESPONSE) && !toolCalls.length) {
    if (doneReason === "length") {
      throw new Error(
        `${input.model} a atteint la limite de longueur avant de terminer sa reponse. Reessayez avec une demande plus courte, ou choisissez un modele avec une fenetre de contexte plus grande.`,
      );
    }
    if (producedReasoning) {
      throw new Error(`${input.model} n'a produit qu'un raisonnement interne, sans reponse. Reessayez, ou choisissez un autre modele.`);
    }
    throw new Error(`${input.model} a termine sans fournir de reponse (${doneReason || "raison inconnue"}).`);
  }

  return { content, toolCalls, doneReason };
}

export async function runOllamaChat(model: LocalModel, payload: Record<string, any>) {
  const messages = normalizedChatMessages(payload);
  if (!messages.length) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `

Contexte d'outils typés (JSON):
${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `

Connaissance produit vérifiée:
${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const capabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const modelCapabilities = {
    supportsVision: model.supportsVision === true,
    supportsTools: model.supportsTools === true,
    supportsThinking: model.supportsThinking === true,
  };
  const imageCount = messages.reduce((total, item) => total + item.images.length, 0);
  const response = await ollamaChatRequest({
    model: model.displayName,
    capabilities: modelCapabilities,
    // Ollama takes attachments as a per-message array of raw base64 strings.
    messages: [
      { role: "system", content: `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}` },
      ...messages.map((item) => (item.images.length
        ? { role: item.role, content: item.content, images: item.images.map((image) => image.base64) }
        : { role: item.role, content: item.content })),
    ],
    tools: payload.mutationToolsAllowed === false
      ? capabilities.filter((item) => item.mode === "READ" || item.mode === "NAVIGATION").map(ollamaCapabilitySchema)
      : capabilities.map(ollamaCapabilitySchema),
    // Reasoning is off for a thinking model, so this budget is the answer's.
    numPredict: 1024,
    temperature: 0.2,
    timeoutMs: 300_000,
    kind: "assistant",
    imageCount,
  });
  const text = response.content;
  const proposedToolCalls = response.toolCalls
    .slice(0, 25)
    .map((item: any) => item?.function)
    .filter((toolCall: any) => toolCall && typeof toolCall.name === "string" && toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments))
    .map((toolCall: any) => ({ capabilityId: capabilityIdFromModelName(toolCall.name), arguments: toolCall.arguments }));
  const proposedToolCall = proposedToolCalls[0] ? { toolName: proposedToolCalls[0].capabilityId, arguments: proposedToolCalls[0].arguments } : null;
  return { text: proposedToolCalls.length && (!text || text === EMPTY_FINAL_RESPONSE) ? "J'ai préparé les actions demandées. Wheat appliquera les règles de risque et de confirmation ci-dessous." : text, proposedToolCall, proposedToolCalls, metrics: { doneReason: response.doneReason } };
}

async function runLlamaCppChat(model: LocalModel, executable: string | null, payload: Record<string, any>) {
  if (!executable) throw new Error("Le moteur llama.cpp vérifié est requis pour ce modèle GGUF.");
  if (!model.filePath) throw new Error("Le fichier GGUF sélectionné est introuvable.");
  const messages = normalizedChatMessages(payload).map((item) => `${item.role === "assistant" ? "Assistant" : "Utilisateur"}: ${item.content}`).join("\n");
  if (!messages) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `\nContexte d'outils typés (JSON):\n${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `\n\nConnaissance produit vérifiée:\n${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const availableCapabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const mutationTools = payload.mutationToolsAllowed === false ? "Aucun : Wheat AI est en lecture seule." : safeJson(availableCapabilities.map((tool) => ({ name: tool.id, riskLevel: tool.riskLevel, description: tool.description, inputSchema: tool.inputSchema })));
  const actionFormat = "Pour appeler une capacité, termine par ACTION_PROPOSAL: {\"toolName\":\"identifiant.capacite\",\"arguments\":{...},\"visibleText\":\"résumé utilisateur\"}. N'émets ce bloc que pour une exécution explicitement demandée; une question ou prévisualisation reste sans action exécutée.";
  const prompt = `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}\nCapacités pertinentes: ${mutationTools}\n${actionFormat}\n\n${messages}\nAssistant:`;
  const { stdout } = await execFileAsync(executable, ["-m", model.filePath, "-p", prompt, "-n", "512", "-c", "4096", "--temp", "0.2", "--no-display-prompt", "--single-turn"], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const text = stripModelReasoning(stdout);
  const action = actionFromText(text);
  const proposedToolCall = action ? { toolName: canonicalWheatAiCapabilityId(action.toolName), arguments: action.arguments } : null;
  return { text: action?.visibleText || (action ? "Je peux préparer cette action. Vérifiez-la puis confirmez-la dans Wheat." : text), proposedToolCall, proposedToolCalls: proposedToolCall ? [{ capabilityId: proposedToolCall.toolName, arguments: proposedToolCall.arguments }] : [], metrics: {} };
}

async function runModelHealthCheck(root: string, manifest: ModelManifest, modelId: string) {
  const discovered = await discoverLocalModels(root, manifest);
  const model = discovered.models.find((item) => item.id === modelId && item.installed);
  if (!model) throw new Error("Sélectionnez un modèle local disponible avant de lancer le test.");
  const started = Date.now();
  if (model.provider === "OLLAMA") {
    const result = await runOllamaChat(model, { messages: [{ role: "user", content: "Réponds uniquement par OK." }] });
    return { kind: "MODEL_INFERENCE", provider: model.provider, modelId: model.id, durationMs: Date.now() - started, response: result.text.slice(0, 120), ...result.metrics, measuredAt: new Date().toISOString() };
  }
  if (!model.filePath || !discovered.runtimeExecutable) throw new Error("Le moteur llama.cpp vérifié est requis pour tester ce modèle GGUF.");
  const health = await verifyInstalledModel(discovered.runtimeExecutable, model.filePath);
  return { kind: "MODEL_INFERENCE", provider: model.provider, modelId: model.id, durationMs: Date.now() - started, response: stripModelReasoning(health.inferenceSample).slice(0, 120), runtimeVersion: health.runtimeVersion, measuredAt: new Date().toISOString() };
}

export async function runLocalChat(root: string, manifest: ModelManifest, prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null, appVersion = WHEAT_APP_VERSION) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const settings = await getSettings(prisma, companyId);
  const selectedModelId = String(payload.modelId ?? settings?.selectedModelId ?? "");
  if (!settings?.enabled || !selectedModelId) throw new Error("Sélectionnez un modèle local pour activer Wheat AI sur ce dossier.");
  const discovered = await discoverLocalModels(root, manifest);
  const model = discovered.models.find((item) => item.id === selectedModelId && item.installed);
  if (!model) throw new Error("Le modèle sélectionné n'est plus disponible pour ce dossier.");
  if (!model.chatReady) throw new Error("Le moteur nécessaire à ce modèle n'est pas disponible.");
  // Capability gate. The renderer hides the attachment control for a text-only
  // model; this is the boundary that makes that true rather than cosmetic.
  if (payloadCarriesImages(payload) && model.supportsVision !== true) {
    throw new Error(`${model.displayName} ne lit pas les images. Choisissez un modele dote de la vision, ou envoyez votre demande sans image.`);
  }
  const isRemoteModel = selectedModelId === AUTOMATIC_FREE_MODEL_ID || selectedModelId.startsWith(REMOTE_MODEL_PREFIX);
  // Context assembly reads the dossier. A fault here — a stale query, a schema
  // that moved — used to surface in the chat window verbatim as
  // "PrismaClientValidationError: Unknown field `revision`", which told the
  // person keeping the books nothing they could act on. The detail is logged;
  // the window gets a sentence.
  let routed: Awaited<ReturnType<typeof buildWheatAiChatContext>>;
  try {
    routed = await buildWheatAiChatContext(prisma, companyId, payload, appVersion);
  } catch (error) {
    if (isInternalFault(error)) {
      wheatAiDiagnostic({
        event: "wheat-ai.chat-context-failed",
        companyId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        stack: error instanceof Error ? String(error.stack ?? "").slice(0, 4000) : undefined,
      });
      throw new Error(
        "Wheat n'a pas pu rassembler le contexte du dossier pour Wheat AI. Le détail technique a été enregistré dans le journal. Réessayez ; si le problème persiste, signalez-le avec l'horodatage de ce message.",
        { cause: error },
      );
    }
    throw error;
  }
  const prompt = lastUserMessage(payload);
  const availableCapabilities = selectWheatAiCapabilities(prompt, payload.applicationContext?.module ?? payload.activeModule);
  const enrichedPayload = {
    ...payload,
    productKnowledge: routed.productKnowledge,
    toolContext: {
      dossier: routed.dossier,
      routedResults: routed.routedResults,
      applicationContext: {
        module: String(payload.applicationContext?.module ?? payload.activeModule ?? "wheat-ai").slice(0, 80),
        selectedEntity: boundedReference(payload.applicationContext?.selectedEntity),
      },
      recentActions: boundedRecentActionContext(payload),
    },
    mutationToolsAllowed: settings.permissionMode !== "READ_ONLY",
    availableCapabilities,
  };
  const started = Date.now(); let status = "SUCCEEDED"; let resultSummary: Record<string, unknown> = {};
  try {
    const result = isRemoteModel
      ? await runRemoteChat(model, enrichedPayload)
      : model.provider === "OLLAMA"
        ? await runOllamaChat(model, enrichedPayload)
        : await runLlamaCppChat(model, discovered.runtimeExecutable, enrichedPayload);
    const embeddedAction = actionFromText(result.text);
    const candidates = Array.isArray(result.proposedToolCalls) && result.proposedToolCalls.length
      ? result.proposedToolCalls
      : result.proposedToolCall
        ? [{ capabilityId: result.proposedToolCall.toolName, arguments: result.proposedToolCall.arguments }]
        : embeddedAction
          ? [{ capabilityId: embeddedAction.toolName, arguments: embeddedAction.arguments }]
          : [];
    const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
    const processed = candidates.length ? await processWheatAiCapabilityCalls({ prisma, gateway, companyId, actorUserId, sessionId, permissionMode: settings.permissionMode, prompt, dryRun: payload.dryRun === true, calls: candidates }) : { intent: classifyWheatAiIntent(prompt, payload.dryRun === true), proposals: [], results: [] };
    const actionProposal = processed.proposals[0] ?? null;
    const succeeded = processed.results.filter((item: any) => item.status === "SUCCEEDED").length;
    const failed = processed.results.filter((item: any) => ["FAILED", "REJECTED", "NOT_AUTHORIZED_BY_INTENT"].includes(item.status)).length;
    const pending = processed.results.filter((item: any) => item.status === "PENDING_CONFIRMATION").length;
    const dryRuns = processed.results.filter((item: any) => item.status === "DRY_RUN").length;
    const executionSummary = processed.results.length
      ? `\n\nPlan Wheat AI : ${succeeded} exécutée(s), ${pending} en attente de confirmation, ${dryRuns} prévisualisée(s), ${failed} en échec ou refusée(s).`
      : "";
    const baseText = embeddedAction?.visibleText || result.text;
    const text = `${baseText && baseText !== EMPTY_FINAL_RESPONSE ? baseText : "Action analysée."}${executionSummary}`;
    resultSummary = { provider: model.provider, modelId: model.id, responseCharacters: text.length, toolsUsed: routed.toolsUsed, availableCapabilityCount: availableCapabilities.length, intent: processed.intent, actionProposed: actionProposal?.toolName ?? null, actionCount: processed.results.length, succeeded, pending, dryRuns, failed };
    return { text, local: true, provider: model.provider, modelId: model.id, toolBoundary: "TYPED_TOOLS_ONLY", capabilityBoundary: "TYPED_CAPABILITY_REGISTRY", contextSources: routed.contextSources, toolsUsed: routed.toolsUsed, availableCapabilities: availableCapabilities.map((item) => item.id), productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION, intent: processed.intent, actionProposal, actionProposals: processed.proposals, actionResults: processed.results };
  } catch (error) {
    status = "FAILED";
    // A provider failure already arrives as one finished, user-facing French
    // sentence; wrapping it again produced "Le fournisseur Wheat AI n'a pas
    // répondu : Aucun modèle compatible…" and buried the actionable half.
    if (error instanceof WheatAiProviderError) throw new Error(error.message, { cause: error });
    throw new Error(
      `${isRemoteModel ? "Le fournisseur Wheat AI" : "Le modèle local"} n'a pas répondu : ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await prisma.wheatAiAuditEvent.create({ data: { companyId, actorUserId: actorUserId ?? null, sessionId: String(payload.sessionId ?? randomUUID()).slice(0, 120), toolName: "wheat_ai_chat", permissionMode: settings.permissionMode, requestJson: safeJson({ messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0, productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION, provider: model.provider, modelId: model.id }), resultSummaryJson: safeJson(resultSummary), status, durationMs: Date.now() - started } }).catch(() => undefined);
  }
}

/**
 * Keeps payloads emitted by pre-registry renderers working without keeping the
 * old direct-Prisma executor alive at the IPC boundary. Translation may read
 * only the active dossier and produces the strict arguments accepted by the
 * canonical capability; execution still goes through the domain gateway.
 */
async function translateLegacyCapabilityRequest(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const requested = String(payload.capabilityId ?? payload.toolName ?? "").trim();
  const capabilityId = canonicalWheatAiCapabilityId(requested);
  const source = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments)
    ? payload.arguments as Record<string, any>
    : {};
  let args: Record<string, any> = { ...source };

  switch (requested) {
    case "get_entries":
      args = { from: source.from, to: source.to, search: source.query, pageSize: source.limit };
      break;
    case "get_invoices":
      args = { from: source.from, to: source.to, search: source.query, limit: source.limit };
      break;
    case "get_payroll_summary":
      args = { take: source.limit };
      break;
    case "get_vat_status":
    case "get_fiscal_package":
      args = {};
      break;
    case "create_account_subdivision": {
      const parentCode = requireText(source.parentCode, "Le compte parent", 20).toUpperCase();
      const parent = await prisma.account.findFirst({ where: { companyId, code: parentCode }, select: { type: true } });
      if (!parent) throw new Error(`Le compte parent ${parentCode} n'existe pas dans ce dossier.`);
      args = { parentCode, code: source.code, label: source.label, type: parent.type };
      break;
    }
    case "update_company_profile": {
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) throw new Error("La société n'existe plus.");
      args = {
        expectedVersion: company.version,
        name: source.name ?? company.name,
        legalForm: source.legalForm ?? company.legalForm,
        ice: source.ice ?? company.ice,
        taxId: source.taxId ?? company.taxId,
        city: source.city ?? company.city,
        vatFrequency: source.vatFrequency ?? company.vatFrequency,
      };
      break;
    }
    case "rename_custom_account": {
      const accountCode = requireText(source.accountCode, "Le compte", 20).toUpperCase();
      const account = await prisma.account.findFirst({ where: { companyId, code: accountCode } });
      if (!account) throw new Error(`Le compte ${accountCode} n'existe pas dans ce dossier.`);
      args = { id: account.id, expectedVersion: account.version, code: account.code, label: source.label, type: account.type };
      break;
    }
    case "add_fiscal_table_row":
    case "mark_fiscal_table_not_applicable": {
      const tableId = requireText(source.tableId, "Le tableau", 10).toUpperCase();
      const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
      if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
      const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId } });
      if (!workpaper || workpaper.status !== "DRAFT") throw new Error("Le tableau fiscal ciblé n'est plus modifiable.");
      if (requested === "add_fiscal_table_row") {
        const existing = JSON.parse(workpaper.manualJson || "[]");
        args = { fiscalPackageId: fiscalPackage.id, tableId, expectedRevision: workpaper.revision, manualRows: [...existing, source.row] };
      } else {
        args = { fiscalPackageId: fiscalPackage.id, tableId, expectedRevision: workpaper.revision, reason: source.reason };
      }
      break;
    }
    case "add_fiscal_adjustment": {
      const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
      if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
      args = { fiscalPackageId: fiscalPackage.id, kind: source.kind, label: source.label, amountCents: source.amountCents, legalReference: source.legalReference, evidence: [] };
      break;
    }
    default:
      break;
  }

  // Optional legacy properties must be absent rather than present as
  // `undefined`; the strict schema validator deliberately rejects unknown or
  // ill-typed input instead of silently coercing it.
  args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  return { ...payload, companyId, capabilityId, arguments: args };
}

export async function confirmWheatAiAction(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const proposalId = requireId(payload.proposalId, "La proposition");
  if (payload.confirmed !== true) throw new Error("L'action Wheat AI exige une confirmation explicite.");
  const proposal = await prisma.wheatAiAuditEvent.findFirst({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" } });
  if (!proposal) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  const args = JSON.parse(proposal.requestJson || "{}");
  const confirmation = JSON.parse(proposal.confirmationJson || "{}");
  // Claim before executing. Reading the proposal is intentionally not the
  // lock: two windows can read the same row. Exactly one conditional update
  // may move it out of PENDING_CONFIRMATION, so a capability can run once.
  const claimed = await prisma.wheatAiAuditEvent.updateMany({
    where: { id: proposal.id, companyId, status: "PENDING_CONFIRMATION" },
    data: {
      status: "CONFIRMATION_EXECUTING",
      confirmationJson: safeJson({ ...confirmation, required: true, confirmed: true, claimedAt: new Date(), actorUserId: actorUserId ?? null }),
    },
  });
  if (claimed.count !== 1) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  try {
    const translated = await translateLegacyCapabilityRequest(prisma, { companyId, sessionId: proposal.sessionId, toolName: proposal.toolName, arguments: args });
    const capability = getWheatAiCapability(translated.capabilityId);
    if (!capability) throw new Error("Cette capacité Wheat AI n'est plus enregistrée.");
    const executed = await gateway.execute(companyId, capability.id, translated.arguments, { preconditions: confirmation.preconditions ?? {}, sessionId: proposal.sessionId });
    await prisma.wheatAiAuditEvent.updateMany({ where: { id: proposal.id, companyId, status: "CONFIRMATION_EXECUTING" }, data: { status: "CONFIRMED_EXECUTED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: true, confirmedAt: new Date(), actorUserId: actorUserId ?? null }), resultSummaryJson: safeJson({ executedTool: capability.id, resultKind: Array.isArray(executed.result) ? "ARRAY" : "OBJECT" }) } });
    return { ...executed, proposalId, confirmed: true, actionStatus: "EXECUTED", affectedRecords: resolvedAffectedRecords({ preview: confirmation.preview ?? { affectedRecords: [] } }, executed.result), text: `${capability.description} : action exécutée et auditée.` };
  } catch (error) {
    await prisma.wheatAiAuditEvent.updateMany({ where: { id: proposal.id, companyId, status: "CONFIRMATION_EXECUTING" }, data: { status: "CONFIRMATION_FAILED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: true, failedAt: new Date(), actorUserId: actorUserId ?? null }), resultSummaryJson: safeJson({ error: error instanceof Error ? error.message : String(error) }) } }).catch(() => undefined);
    throw error;
  }
}

export async function cancelWheatAiAction(prisma: PrismaLike, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const proposalId = requireId(payload.proposalId, "La proposition");
  const proposal = await prisma.wheatAiAuditEvent.findFirst({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" } });
  if (!proposal) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  const confirmation = JSON.parse(proposal.confirmationJson || "{}");
  const result = await prisma.wheatAiAuditEvent.updateMany({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" }, data: { status: "CANCELLED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: false, cancelledAt: new Date(), actorUserId: actorUserId ?? null }) } });
  if (result.count !== 1) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  return { proposalId, cancelled: true };
}

export async function executeRegisteredCapability(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const capabilityId = canonicalWheatAiCapabilityId(payload.capabilityId ?? payload.toolName);
  const definition = getWheatAiCapability(capabilityId);
  if (!definition) throw new Error("Cette capacité Wheat AI n'est pas enregistrée.");
  const settings = await getSettings(prisma, companyId);
  const permissionMode = String(settings?.permissionMode ?? "ASSISTANT") as PermissionMode;
  if (definition.riskLevel > 0 && permissionMode === "READ_ONLY") throw new Error("Wheat AI est en lecture seule.");
  const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments as Record<string, any> : {};
  const prepared = definition.riskLevel > 0 ? await gateway.prepare(companyId, definition.id, args) : null;
  if (payload.dryRun === true) return { capabilityId: definition.id, dryRun: true, executed: false, preview: prepared?.preview ?? null, riskLevel: definition.riskLevel };
  const directionOverride = directionOverrideDecision(definition, args);
  if ((capabilityRequiresConfirmation(definition, permissionMode) || directionOverride.requiresConfirmation) && payload.confirmed !== true) throw new Error(`La capacité ${definition.id} exige une confirmation explicite immédiatement avant l'exécution.`);
  const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
  const started = Date.now();
  try {
    const executed = await gateway.execute(companyId, definition.id, prepared?.arguments ?? args, { preconditions: prepared?.preconditions, sessionId });
    await auditImmediateCapability(prisma, { companyId, actorUserId, sessionId, permissionMode, definition, arguments: prepared?.arguments ?? args, status: "SUCCEEDED", durationMs: Date.now() - started, result: executed.result, intent: "EXECUTION" });
    return { ...executed, executed: true, riskLevel: definition.riskLevel, affectedRecords: resolvedAffectedRecords(prepared, executed.result) };
  } catch (error) {
    await auditImmediateCapability(prisma, { companyId, actorUserId, sessionId, permissionMode, definition, arguments: prepared?.arguments ?? args, status: "FAILED", durationMs: Date.now() - started, error, intent: "EXECUTION" });
    throw error;
  }
}

export async function executeRegisteredPlan(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  if (!Array.isArray(payload.calls) || payload.calls.length < 1 || payload.calls.length > 25) throw new Error("Un plan Wheat AI doit contenir entre 1 et 25 actions.");
  const settings = await getSettings(prisma, companyId);
  const permissionMode = String(settings?.permissionMode ?? "ASSISTANT") as PermissionMode;
  const prepared: any[] = [];
  for (const callValue of payload.calls) {
    const call = record(callValue);
    const translated = await translateLegacyCapabilityRequest(prisma, { ...call, companyId });
    const definition = getWheatAiCapability(translated.capabilityId);
    if (!definition) throw new Error("Le plan contient une capacité non enregistrée.");
    if (definition.riskLevel > 0 && permissionMode === "READ_ONLY") throw new Error("Wheat AI est en lecture seule.");
    const args = translated.arguments;
    const item = definition.riskLevel > 0 ? await gateway.prepare(companyId, definition.id, args) : { definition, arguments: args, preview: null, preconditions: {} };
    prepared.push({ capabilityId: definition.id, arguments: item.arguments, preconditions: item.preconditions, preview: item.preview, requiresConfirmation: capabilityRequiresConfirmation(definition, permissionMode) || directionOverrideDecision(definition, args).requiresConfirmation });
  }
  if (payload.dryRun === true) return { dryRun: true, executed: false, actions: prepared };
  if (prepared.some((item) => item.requiresConfirmation) && payload.confirmed !== true) throw new Error("Ce plan contient une ou plusieurs actions exigeant une confirmation explicite.");
  const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
  const result = await gateway.executePlan(companyId, prepared, { stopOnError: payload.stopOnError !== false, sessionId });
  await prisma.wheatAiAuditEvent.create({ data: { companyId, actorUserId: actorUserId ?? null, sessionId, toolName: "wheat_ai_plan", permissionMode, requestJson: safeJson(prepared.map((item) => ({ capabilityId: item.capabilityId, arguments: item.arguments }))).slice(0, 100_000), resultSummaryJson: safeJson({ origin: WHEAT_AI_ORIGIN, total: result.total, completed: result.completed, failed: result.failed, stoppedEarly: result.stoppedEarly }), confirmationJson: safeJson({ required: prepared.some((item) => item.requiresConfirmation), confirmed: payload.confirmed === true }), status: result.failed ? "PARTIAL_FAILURE" : "SUCCEEDED" } }).catch(() => undefined);
  return { dryRun: false, executed: true, ...result };
}

export function registerWheatAiIpc(options: { ipcMain: IpcLike; getPrisma: GetPrisma; getActorUserId?: () => string | null | Promise<string | null>; documentCommands?: WheatAiDocumentCommands; manifestPath: string; modelRoot: string; appVersion?: string; send: Send; serialize?: <T>(value: T) => T }) {
  const serialize = options.serialize ?? rendererSerialize;
  const gateway = createWheatAiDomainGateway({ getPrisma: options.getPrisma, getActorUserId: options.getActorUserId, documentCommands: options.documentCommands });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.status, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    await gateway.authorize(companyId, getWheatAiCapability("company.get")!);
    const manifest = await readModelManifest(options.manifestPath);
    const [profile, discovered, prisma] = await Promise.all([profileHardware(options.modelRoot), discoverLocalModels(options.modelRoot, manifest), options.getPrisma()]);
    return serialize({
      manifestVersion: manifest.manifestVersion,
      runtime: { ...manifest.runtime, installed: Boolean(discovered.runtimeExecutable) },
      models: discovered.models.map(publicModel),
      profile,
      recommendation: recommendModel(profile, manifest),
      settings: await getSettings(prisma, companyId),
      providers: {
        ollama: {
          available: discovered.ollama.available,
          error: discovered.ollama.error,
          modelCount: discovered.ollama.models.length,
          // "installed but stopped" and "not installed at all" need different
          // words and different offered actions, so both travel to the UI.
          installed: discovered.ollama.installed,
          serviceStopped: discovered.ollama.serviceStopped,
          baseUrl: discovered.ollama.baseUrl,
          canStart: discovered.ollama.serviceStopped && Boolean(discovered.ollama.executablePath),
        },
        huggingFace: { cacheRoots: discovered.huggingFace.roots, compatibleGgufCount: discovered.huggingFace.models.length },
      },
      productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION,
      confirmedMutationCapabilities: WHEAT_AI_MUTATION_CAPABILITIES,
      capabilityRegistry: {
        version: "WHEAT_CAPABILITIES_2_1_1",
        total: WHEAT_AI_CAPABILITY_REGISTRY.length,
        categories: [...new Set(WHEAT_AI_CAPABILITY_REGISTRY.map((item) => item.category))],
        byRiskLevel: Object.fromEntries([0, 1, 2, 3].map((riskLevel) => [riskLevel, WHEAT_AI_CAPABILITY_REGISTRY.filter((item) => item.riskLevel === riskLevel).length])),
        dryRunCount: WHEAT_AI_CAPABILITY_REGISTRY.filter((item) => item.supportsDryRun).length,
      },
      privacy: { localOnly: true, databaseAccess: false, toolBoundary: "TYPED_TOOLS_ONLY", capabilityBoundary: "TYPED_CAPABILITY_REGISTRY", rawSql: false, rawPrisma: false, shell: false, arbitraryFilesystem: false },
    });
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.benchmark, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    const prisma = await options.getPrisma();
    const settings = await getSettings(prisma, companyId);
    const modelId = String(payload.modelId ?? settings?.selectedModelId ?? "");
    const result = modelId
      ? await runModelHealthCheck(options.modelRoot, await readModelManifest(options.manifestPath), modelId)
      : await localBenchmark();
    await prisma.wheatAiSettings.upsert({ where: { companyId }, create: { companyId, benchmarkJson: safeJson(result) }, update: { benchmarkJson: safeJson(result), ...(modelId ? { lastHealthCheckAt: new Date() } : {}) } });
    return result;
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.install, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    if (payload.confirmed !== true) throw new Error("Le téléchargement du modèle exige une confirmation explicite.");
    const manifest = await readModelManifest(options.manifestPath);
    const model = manifest.models.find((item) => item.id === payload.modelId);
    if (!model) throw new Error("Ce modèle n'appartient pas au manifeste Wheat.");
    const profile = await profileHardware(options.modelRoot);
    if (profile.freeDiskBytes < model.bytes + manifest.runtime.bytes + 1024 ** 3) throw new Error("L'espace disque libre est insuffisant pour télécharger, vérifier et installer ce modèle.");
    const runtime = await installRuntime(manifest, options.modelRoot, options.send);
    const target = modelPath(options.modelRoot, model);
    const knownWorkingBefore = await validPinnedFile(target, model.bytes, model.sha256);
    await downloadPinned(model, target, options.send);
    let health;
    try {
      health = await verifyInstalledModel(runtime, target);
    } catch (error) {
      if (!knownWorkingBefore) {
        await fs.rename(target, `${target}.inference-failed-${randomUUID()}`).catch(() => undefined);
      }
      throw new Error(`Le modèle téléchargé a échoué au test d'inférence et n'a pas été activé : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const prisma = await options.getPrisma();
    await prisma.wheatAiSettings.upsert({
      where: { companyId },
      create: { companyId, enabled: true, selectedTier: model.tier, selectedModelId: model.id, modelManifestVersion: manifest.manifestVersion, runtimeVersion: manifest.runtime.version, hardwareProfileJson: safeJson(profile), lastHealthCheckAt: new Date() },
      update: { enabled: true, selectedTier: model.tier, selectedModelId: model.id, modelManifestVersion: manifest.manifestVersion, runtimeVersion: manifest.runtime.version, hardwareProfileJson: safeJson(profile), lastHealthCheckAt: new Date() },
    });
    options.send(WHEAT_AI_CHANNELS.progress, { artifactId: model.id, phase: "READY", receivedBytes: model.bytes, totalBytes: model.bytes });
    return { installed: true, modelId: model.id, path: target, runtimeHealth: health.runtimeVersion, testInference: health.inferenceSample };
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.uninstall, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    if (payload.confirmed !== true) throw new Error("La suppression du modèle exige une confirmation explicite.");
    const manifest = await readModelManifest(options.manifestPath);
    const discovered = await discoverLocalModels(options.modelRoot, manifest);
    const model = discovered.models.find((item) => item.id === payload.modelId && item.installed);
    if (!model) throw new Error("Le modèle local sélectionné n'est plus disponible.");
    let recoverable = false;
    if (model.provider === "OLLAMA") {
      await ollamaRequest("/api/delete", { method: "DELETE", body: JSON.stringify({ model: model.displayName }) }, 120_000);
    } else if (model.provider === "HUGGINGFACE") {
      throw new Error("Wheat ne supprime pas directement un dépôt Hugging Face partagé. Utilisez le gestionnaire de cache Hugging Face pour éviter de corrompre ses snapshots.");
    } else if (model.filePath) {
      if (payload.permanent === true) await fs.rm(model.filePath, { force: true });
      else {
        await fs.rename(model.filePath, `${model.filePath}.uninstalled-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        recoverable = true;
      }
    }
    const prisma = await options.getPrisma();
    await prisma.wheatAiSettings.updateMany({ where: { companyId, selectedModelId: model.id }, data: { enabled: false, selectedModelId: null, selectedTier: null } });
    if (model.provider === "WHEAT" && payload.permanent !== true) return { uninstalled: true, recoverable: true };
    return { uninstalled: true, recoverable, provider: model.provider, modelId: model.id };
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.select, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    const modelId = String(payload.modelId ?? "").trim();
    const prisma = await options.getPrisma();
    if (!modelId) {
      return prisma.wheatAiSettings.upsert({ where: { companyId }, create: { companyId, enabled: false }, update: { enabled: false, selectedModelId: null, selectedTier: null } });
    }
    const manifest = await readModelManifest(options.manifestPath);
    const model = (await discoverLocalModels(options.modelRoot, manifest)).models.find((item) => item.id === modelId && item.installed);
    if (!model) throw new Error("Le modèle choisi n'est plus installé sur cet ordinateur.");
    if (!model.chatReady) throw new Error("Ce modèle GGUF a besoin du moteur llama.cpp local avant de pouvoir dialoguer.");
    return prisma.wheatAiSettings.upsert({
      where: { companyId },
      create: { companyId, enabled: true, selectedTier: model.tier ?? "EXTERNAL", selectedModelId: model.id, modelManifestVersion: model.provider === "WHEAT" ? manifest.manifestVersion : model.provider, runtimeVersion: model.provider === "OLLAMA" ? "OLLAMA_LOCAL_API" : manifest.runtime.version, lastHealthCheckAt: null },
      update: { enabled: true, selectedTier: model.tier ?? "EXTERNAL", selectedModelId: model.id, modelManifestVersion: model.provider === "WHEAT" ? manifest.manifestVersion : model.provider, runtimeVersion: model.provider === "OLLAMA" ? "OLLAMA_LOCAL_API" : manifest.runtime.version, lastHealthCheckAt: null },
    });
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.configure, async (_event, payloadValue) => { const payload = record(payloadValue); const companyId = requireId(payload.companyId, "La société"); const permissionMode = String(payload.permissionMode ?? "ASSISTANT") as PermissionMode; if (!["READ_ONLY", "ASSISTANT", "AUTOMATED"].includes(permissionMode)) throw new Error("Le mode de permission Wheat AI est invalide."); if (permissionMode === "AUTOMATED" && payload.confirmed !== true) throw new Error("Le mode automatisé exige une confirmation explicite."); const prisma = await options.getPrisma(); return prisma.wheatAiSettings.upsert({ where: { companyId }, create: { companyId, permissionMode }, update: { permissionMode } }); });
  // Explicit, user-triggered start of the local Ollama service. Wheat only ever
  // starts it because someone pressed the button in the Wheat AI screen.
  options.ipcMain.handle(WHEAT_AI_CHANNELS.ollamaStart, async () => {
    const discovered = await startOllamaService();
    return serialize({
      available: discovered.available,
      error: discovered.error,
      modelCount: discovered.models.length,
      installed: discovered.installed,
      serviceStopped: discovered.serviceStopped,
      baseUrl: discovered.baseUrl,
    });
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.tools, () => publicWheatAiCapabilities());
  options.ipcMain.handle(WHEAT_AI_CHANNELS.executeTool, async (_event, payloadValue) => {
    const prisma = await options.getPrisma();
    const payload = await translateLegacyCapabilityRequest(prisma, payloadValue);
    return serialize(await executeRegisteredCapability(prisma, gateway, payload, await options.getActorUserId?.()));
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.executePlan, async (_event, payload) => serialize(await executeRegisteredPlan(await options.getPrisma(), gateway, payload, await options.getActorUserId?.())));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.chat, async (_event, payload) => serialize(await runLocalChat(options.modelRoot, await readModelManifest(options.manifestPath), await options.getPrisma(), gateway, payload, await options.getActorUserId?.(), options.appVersion)));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.confirmAction, async (_event, payload) => serialize(await confirmWheatAiAction(await options.getPrisma(), gateway, payload, await options.getActorUserId?.())));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.cancelAction, async (_event, payload) => serialize(await cancelWheatAiAction(await options.getPrisma(), payload, await options.getActorUserId?.())));
  return WHEAT_AI_CHANNELS;
}
