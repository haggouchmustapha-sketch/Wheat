import { WHEAT_EDITION_PROFILE } from "../src/wheatEdition";

/**
 * Cloud recognition of an accounting document.
 *
 * Wheat Lightweight does not carry the two-gigabyte local recognition runtime,
 * so the pages a scanner produced are read by the AI provider the *user* has
 * authorised instead. What comes back is recognised text — exactly what the
 * local engine produces — and it re-enters the pipeline at exactly the same
 * point. Everything after recognition is unchanged: the same field readers, the
 * same totals arithmetic, the same document understanding, the same review
 * screen, the same accounting validation.
 *
 * That is the whole safety argument. **A model never produces an accounting
 * record here.** It produces a transcription, which Wheat then reads with its
 * own deterministic rules and shows to a person before anything is posted. A
 * transcription that invents a number is caught by the same totals check that
 * catches a local engine misreading one.
 *
 * On top of that, everything crossing this boundary is treated as hostile
 * input: the reply is parsed defensively, every field is type-checked, every
 * collection is bounded, and a malformed answer is a recognition failure rather
 * than a partially-trusted result.
 *
 * Provider independence lives one layer down, in `wheatAiProviders.ts`: this
 * module asks for "a vision-capable model the user has authorised" and never
 * names OpenRouter. A future provider is a new adapter there, not a rewrite
 * here or anywhere in the document workflow.
 */

/** Hard ceilings on anything a provider can return. */
const MAX_TEXT_CHARS = 200_000;
const MAX_TABLES = 40;
const MAX_TABLE_ROWS = 400;
const MAX_TABLE_COLUMNS = 60;
const MAX_CELL_CHARS = 500;

export type CloudOcrResult = {
  text: string;
  confidence: number;
  tables: string[][][];
  engine: string;
  provider: string;
  modelId: string;
  warnings: string[];
};

/**
 * What the recognition needs from the provider layer.
 *
 * Deliberately this small: a connection question and one vision call. It keeps
 * the module testable without Electron, a network or a key, and it keeps the
 * credential where it belongs — the implementation in the main process reads it
 * from the OS vault and never returns it.
 */
export type CloudOcrRuntime = {
  /** True when a provider the user authorised is available right now. */
  isConnected(): boolean;
  runVision(request: {
    system: string;
    user: string;
    images: Array<{ mimeType: string; base64: string }>;
  }): Promise<{ text: string; provider: string; modelId: string }>;
};

/**
 * Why a cloud recognition cannot start.
 *
 * Raised *before* any document is read, so the interface can interrupt the
 * accountant's task, obtain what is missing, and resume the very same import —
 * rather than failing a batch and asking them to select thirty files again.
 */
export type CloudUnavailableReason = "NOT_CONNECTED" | "CONSENT_REQUIRED";

export class CloudOcrUnavailableError extends Error {
  readonly reason: CloudUnavailableReason;

  constructor(reason: CloudUnavailableReason) {
    super(reason === "CONSENT_REQUIRED"
      ? "La lecture des pièces par Wheat Cloud AI n'a pas encore été autorisée pour ce poste."
      : "Wheat Cloud AI n'est pas connecté sur ce poste.");
    this.name = "CloudOcrUnavailableError";
    this.reason = reason;
  }
}

/** A cloud recognition that started and did not produce a usable reading. */
export class CloudOcrFailureError extends Error {
  /** What the person can actually do about it, if anything. */
  readonly remedy: CloudOcrRemedy;

  constructor(message: string, remedy: CloudOcrRemedy = "RETRY", options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudOcrFailureError";
    this.remedy = remedy;
  }
}

/**
 * The shape of the answer, not the shape of the error.
 *
 * An accountant reading "HTTP 429 upstream x-provider-meta" learns nothing they
 * can act on. These are the four things that are actually true of a failed
 * cloud reading — wait, reconnect, look at the provider account, or nothing —
 * and the interface can offer the matching action for each.
 */
export type CloudOcrRemedy = "RETRY" | "RETRY_LATER" | "RECONNECT" | "MANAGE_ACCOUNT";

/**
 * Turns a provider failure into something a person can read and act on.
 *
 * `wheatAiProviders.ts` already classifies what went wrong — that is where the
 * HTTP status, the body and the provider's own vocabulary are understood. This
 * restates that classification in the language of *reading a document*, because
 * the accountant is not having a conversation with an assistant: they are
 * importing an invoice, and what they need to know is whether to try again,
 * wait, or look at their account.
 *
 * The usage and the quota belong to the user's own provider account. Wheat says
 * so plainly, and never silently moves to a paid model to get around it.
 */
export function describeCloudOcrFailure(error: unknown): { message: string; remedy: CloudOcrRemedy } {
  const kind = (error as { kind?: string } | null)?.kind;
  switch (kind) {
    case "QUOTA_EXHAUSTED":
      return {
        message: "Wheat Cloud AI a atteint la limite d'utilisation actuelle de ce compte. La lecture en ligne reprendra une fois la limite renouvelée.",
        remedy: "MANAGE_ACCOUNT",
      };
    case "RATE_LIMITED":
      return {
        message: "Wheat Cloud AI reçoit trop de demandes en ce moment. Patientez quelques instants avant de relancer la lecture.",
        remedy: "RETRY_LATER",
      };
    case "INVALID_KEY":
    case "UNAUTHORIZED":
      return {
        message: "L'autorisation de Wheat Cloud AI n'est plus acceptée par le fournisseur. Reconnectez Wheat Cloud AI pour reprendre la lecture des pièces.",
        remedy: "RECONNECT",
      };
    case "TIMEOUT":
      return {
        message: "Le service de lecture en ligne n'a pas répondu à temps. Vérifiez votre connexion, puis relancez la lecture.",
        remedy: "RETRY",
      };
    case "IMAGE_UNSUPPORTED":
    case "MODEL_UNAVAILABLE":
      return {
        message: "Aucun modèle capable de lire une image n'est disponible actuellement sur ce compte. Réessayez plus tard ou vérifiez les réglages avancés.",
        remedy: "MANAGE_ACCOUNT",
      };
    case "SAFETY_REFUSAL":
      return {
        message: "Le fournisseur a refusé d'analyser cette pièce. Corrigez la lecture manuellement, ou relancez avec une image plus nette.",
        remedy: "RETRY",
      };
    case "EMPTY_RESPONSE":
    case "PROVIDER_ERROR":
    case "BAD_REQUEST":
      return {
        message: "Le service de lecture en ligne n'a pas pu analyser cette pièce. Relancez la lecture ; Wheat utilisera le moteur local en attendant.",
        remedy: "RETRY",
      };
    default:
      return {
        message: "La lecture en ligne n'a pas abouti. Vérifiez votre connexion, puis relancez la lecture.",
        remedy: "RETRY",
      };
  }
}

const SYSTEM_PROMPT = [
  "Tu transcris une page de document comptable photographiee ou scannee.",
  "Tu ne resumes pas, tu n'interpretes pas et tu n'inventes rien : tu retranscris ce qui est imprime sur la page.",
  "Reponds uniquement par un objet JSON, sans texte autour et sans bloc de code.",
  "Le JSON contient exactement ces cles :",
  "\"text\" : la transcription complete de la page, ligne par ligne, dans l'ordre de lecture, avec les sauts de ligne.",
  "\"confidence\" : un entier de 0 a 100 indiquant la lisibilite de la page.",
  "\"tables\" : un tableau de tableaux de lignes ; chaque ligne est un tableau de cellules en texte. Tableau vide s'il n'y a aucun tableau.",
  "Conserve les montants, dates, numeros, ICE, IF et RC exactement tels qu'ils sont imprimes, sans reformatage.",
  "Si une zone est illisible, transcris ce qui est lisible et n'ajoute rien a la place du reste.",
].join(" ");

const USER_PROMPT = [
  "Transcris integralement cette page.",
  "Rends la totalite du texte visible, y compris les en-tetes, les lignes de detail, les totaux et les mentions de bas de page.",
].join(" ");

/**
 * Recognises one prepared page image.
 *
 * `image` is the same normalised PNG the local engine would have received, so
 * the two paths differ in who reads the page and in nothing else.
 */
export async function recognizeWithCloud(
  runtime: CloudOcrRuntime,
  image: { mimeType: string; base64: string },
  options: { consentGiven: boolean },
): Promise<CloudOcrResult> {
  if (!options.consentGiven) throw new CloudOcrUnavailableError("CONSENT_REQUIRED");
  if (!runtime.isConnected()) throw new CloudOcrUnavailableError("NOT_CONNECTED");

  let reply: Awaited<ReturnType<CloudOcrRuntime["runVision"]>>;
  try {
    reply = await runtime.runVision({ system: SYSTEM_PROMPT, user: USER_PROMPT, images: [image] });
  } catch (error) {
    // Restated in the language of reading a document, and never as a status
    // code: the original classification is kept as the cause for diagnostics.
    const described = describeCloudOcrFailure(error);
    throw new CloudOcrFailureError(described.message, described.remedy, { cause: error });
  }
  const parsed = parseCloudOcrReply(reply.text);
  if (!parsed) {
    throw new CloudOcrFailureError(
      "Le service de lecture en ligne n'a pas renvoyé de transcription exploitable. Wheat utilise le moteur local pour cette pièce.",
      "RETRY",
    );
  }
  return {
    ...parsed,
    engine: `wheat-cloud-ocr:${reply.provider}`,
    provider: reply.provider,
    modelId: reply.modelId,
  };
}

/**
 * Turns a provider reply into a bounded, fully typed recognition — or nothing.
 *
 * Exported because this is the part worth testing exhaustively: it is the only
 * place where text an external service composed becomes data Wheat carries.
 * Every branch either produces a value of the declared type or returns null; it
 * never returns a half-trusted object.
 */
export function parseCloudOcrReply(reply: string): { text: string; confidence: number; tables: string[][][]; warnings: string[] } | null {
  const object = firstJsonObject(reply);
  if (!object) return null;

  const rawText = typeof object.text === "string" ? object.text : "";
  const text = rawText.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT_CHARS);
  // A reply with no transcription is a failed recognition, not an empty page:
  // accepting it would file the document as "read, and blank", which is the one
  // outcome nobody reviews.
  if (text.length < 8) return null;

  const warnings: string[] = [];
  if (rawText.length > MAX_TEXT_CHARS) warnings.push("La transcription a été tronquée à la limite acceptée par Wheat.");

  const tables = normalizeTables(object.tables, warnings);

  return { text, confidence: boundedConfidence(object.confidence), tables, warnings };
}

function firstJsonObject(reply: string): Record<string, unknown> | null {
  const trimmed = String(reply ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A default that says "check this".
 *
 * A provider that returns no confidence, or a value that is not a number, gets
 * a deliberately middling one rather than a flattering one: the document review
 * screen surfaces low-confidence readings, and a cloud transcription nobody
 * scored should land there rather than sail past as certain.
 */
function boundedConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 70;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeTables(value: unknown, warnings: string[]): string[][][] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TABLES) warnings.push("Certains tableaux détectés n'ont pas été conservés (limite Wheat atteinte).");
  const tables: string[][][] = [];
  for (const rawTable of value.slice(0, MAX_TABLES)) {
    if (!Array.isArray(rawTable)) continue;
    const rows: string[][] = [];
    for (const rawRow of rawTable.slice(0, MAX_TABLE_ROWS)) {
      if (!Array.isArray(rawRow)) continue;
      const cells = rawRow.slice(0, MAX_TABLE_COLUMNS).map((cell) => {
        if (cell === null || cell === undefined) return "";
        if (typeof cell === "object") return "";
        return String(cell).slice(0, MAX_CELL_CHARS).trim();
      });
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/**
 * Which engines read a page, in order, for this edition and these settings.
 *
 * The one place the edition influences recognition. It chooses *who reads the
 * page*, never what the reading means:
 *
 *   - **Standard** reads locally first, exactly as it always has. Cloud reading
 *     is an addition the user may switch on, and it sits after the local engine
 *     rather than in front of it.
 *   - **Lightweight** reads in the cloud, because the local recognition runtime
 *     is not packaged with it.
 *
 * Both end at the same local Tesseract fallback, so a machine with no
 * connection still reads what it can instead of refusing the document.
 */
export type OcrEngine = "paddle" | "cloud" | "tesseract";

export function ocrEngineOrder(options: {
  hasBundledLocalOcr?: boolean;
  cloudOcrEnabled: boolean;
}): OcrEngine[] {
  const local = options.hasBundledLocalOcr ?? WHEAT_EDITION_PROFILE.hasBundledLocalOcr;
  const order: OcrEngine[] = [];
  if (local) order.push("paddle");
  if (options.cloudOcrEnabled) order.push("cloud");
  order.push("tesseract");
  return order;
}

/**
 * Whether a page recognised by this plan genuinely depends on the cloud.
 *
 * True only when nothing local can read the page first. It is what decides
 * whether an import stops to ask for authorisation or simply carries on, so it
 * is deliberately conservative: a build that can read locally never interrupts
 * an accountant to talk about a cloud service.
 */
export function requiresCloudRecognition(order: readonly OcrEngine[]): boolean {
  return order[0] === "cloud";
}

/**
 * Who reads a page, for this build and these settings.
 *
 * Threaded through recognition rather than read from a module-level constant so
 * that the decision is made once, by the caller, and every page of every
 * document — or of every bank statement — in one import is read by the same
 * engines in the same order. It is also what makes the whole path testable
 * without an edition-specific build.
 */
export type RecognitionPlan = {
  /**
   * Engines to try, in order. The document pipeline always ends at the local
   * Tesseract fallback; the bank importer stops before it, because a table
   * nobody can trust is worse than a refusal (see `bankStatementImporter.ts`).
   */
  order: OcrEngine[];
  cloud: { runtime: CloudOcrRuntime; consentGiven: boolean } | null;
  /**
   * Called when a cloud reading was attempted and did not work.
   *
   * The document is still read — the local fallback takes over — so this is not
   * an error the import has to stop for. It is the difference between "Wheat
   * read your invoice, less well than it could have, and never said why" and a
   * sentence telling the accountant that their provider allowance is used up.
   */
  onCloudFailure?: (failure: { message: string; remedy: CloudOcrRemedy }) => void;
};

export function resolveRecognitionPlan(input: {
  cloud?: { runtime: CloudOcrRuntime; enabled: boolean; consentGiven: boolean } | null;
  hasBundledLocalOcr?: boolean;
}): RecognitionPlan {
  const cloud = input.cloud ?? null;
  const order = ocrEngineOrder({
    hasBundledLocalOcr: input.hasBundledLocalOcr,
    cloudOcrEnabled: Boolean(cloud?.enabled),
  });
  return { order, cloud: cloud?.enabled ? { runtime: cloud.runtime, consentGiven: cloud.consentGiven } : null };
}
