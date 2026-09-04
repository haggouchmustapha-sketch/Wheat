/**
 * Optional AI review layer for Wheat's OCR pipeline.
 *
 * Recognition and the rule-based readers work on lines. A language model can
 * look at the document as a whole and answer questions a line cannot: which of
 * three companies on the page is the supplier, whether "F-2026/0041" is the
 * invoice number or an order reference, whether the total near the bottom is
 * the amount due or a carried subtotal.
 *
 * It is a **review**, never a source of truth:
 *
 *  - It is off unless the user turns it on, so no accounting document is ever
 *    sent anywhere by default. The local offline path stays the default path.
 *  - It may only fill a field Wheat read weakly or not at all, or contradict
 *    one — a contradiction is surfaced as a review flag, it never overwrites.
 *  - Every value it supplies is stamped `ai-review` with a capped confidence,
 *    so the posting workbench can show where the value came from.
 *  - A value it returns that does not appear in the recognised text is
 *    rejected outright: the model may re-read the document, not compose one.
 */

export type AiReviewField = {
  value: string | number | null;
  /** 0-100. Capped below the confidence of a directly recognised field. */
  confidence: number;
  source: "ai-review";
  /** The recognised text this value was corroborated against. */
  evidence?: string;
};

export type AiReviewOutcome = {
  applied: boolean;
  provider: string;
  modelId: string;
  /** Fields the review supplied, keyed the same way as the OCR fields. */
  fields: Record<string, AiReviewField>;
  /** Fields where the review disagrees with a confident OCR read. */
  disagreements: Array<{ field: string; recognised: string; suggested: string }>;
  notes: string[];
};

export type AiReviewInput = {
  /** Full recognised document text, already assembled across pages. */
  text: string;
  documentType: string;
  /** Current field values and how confident the recogniser was. */
  fields: Record<string, { value: string | number | null; confidence: number }>;
  /** Base64 page images, only for a model whose provider declares vision. */
  images?: Array<{ mimeType: string; base64: string }>;
};

export type AiReviewChat = (request: {
  system: string;
  user: string;
  images?: Array<{ mimeType: string; base64: string }>;
}) => Promise<{ text: string; provider: string; modelId: string }>;

/** Fields the review is allowed to touch. Anything else is ignored. */
const REVIEWABLE_FIELDS = [
  "counterparty",
  "supplier",
  "client",
  "ice",
  "if",
  "rc",
  "invoiceNumber",
  "reference",
  "date",
  "dueDate",
  "currency",
  "ht",
  "tva",
  "ttc",
  "vatRate",
] as const;

/** Above this, the recogniser's own read wins and the review only comments. */
const CONFIDENT_ENOUGH = 80;
/** Ceiling on any value the review supplies. */
const MAX_REVIEW_CONFIDENCE = 70;

const SYSTEM_PROMPT = [
  "Tu relis l'extraction d'un document comptable marocain deja reconnu par OCR.",
  "Reponds uniquement par un objet JSON, sans texte autour et sans bloc de code.",
  "Chaque cle est un champ; chaque valeur est un objet {\"value\": ..., \"evidence\": \"extrait exact du texte\"}.",
  "N'invente jamais une valeur absente du texte. Si un champ est illisible ou absent, omets-le.",
  "Les montants sont des nombres decimaux en unites du document (pas de centimes, pas de separateur de milliers).",
  "vatRate est un nombre en points de base (20 % => 2000).",
  "date et dueDate sont au format AAAA-MM-JJ.",
].join(" ");

function normalizeForEvidence(value: string) {
  return value
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * True when the suggested value can actually be found in the recognised text.
 *
 * This is the anti-hallucination gate. Punctuation, spacing and accents differ
 * between what a model writes back and what OCR produced, so both sides are
 * reduced to letters and digits before comparing.
 */
export function corroborated(text: string, value: unknown): boolean {
  const needle = normalizeForEvidence(String(value ?? ""));
  if (needle.length < 2) return false;
  const haystack = normalizeForEvidence(text);
  if (haystack.includes(needle)) return true;
  // Amounts are frequently written "12 000,00" and returned as "12000". The
  // digit-only form covers that without loosening the check for names.
  const digits = needle.replace(/[^0-9]/g, "");
  return digits.length >= 3 && haystack.replace(/[^0-9]/g, "").includes(digits);
}

/** Pulls the first JSON object out of a model reply that may carry prose. */
export function parseReviewJson(reply: string): Record<string, any> | null {
  const trimmed = String(reply ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function suggestedValue(entry: unknown) {
  if (entry === null || entry === undefined) return { value: null as string | number | null, evidence: "" };
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const value = record.value;
    return {
      value: typeof value === "number" || typeof value === "string" ? value : null,
      evidence: String(record.evidence ?? "").slice(0, 400),
    };
  }
  return { value: typeof entry === "number" || typeof entry === "string" ? entry : null, evidence: "" };
}

/**
 * Runs the review and returns only what survives corroboration.
 *
 * Any failure — provider unreachable, unparseable reply, nothing corroborated —
 * returns `applied: false`. OCR output is never degraded by a failed review.
 */
export async function reviewDocumentWithAi(input: AiReviewInput, chat: AiReviewChat): Promise<AiReviewOutcome> {
  const empty: AiReviewOutcome = { applied: false, provider: "", modelId: "", fields: {}, disagreements: [], notes: [] };
  const text = String(input.text ?? "").trim();
  if (text.length < 40) return { ...empty, notes: ["Texte reconnu trop court pour une relecture."] };

  const known = Object.fromEntries(
    REVIEWABLE_FIELDS
      .filter((field) => input.fields[field])
      .map((field) => [field, { value: input.fields[field].value, confidence: input.fields[field].confidence }]),
  );

  const user = [
    `Type de document detecte : ${input.documentType}.`,
    `Champs demandes : ${REVIEWABLE_FIELDS.join(", ")}.`,
    `Extraction actuelle (avec sa confiance sur 100) :\n${JSON.stringify(known)}`,
    `Texte reconnu :\n${text.slice(0, 24_000)}`,
  ].join("\n\n");

  let reply: { text: string; provider: string; modelId: string };
  try {
    reply = await chat({ system: SYSTEM_PROMPT, user, images: input.images });
  } catch (error) {
    return { ...empty, notes: [`Relecture IA indisponible : ${error instanceof Error ? error.message : String(error)}`] };
  }

  const parsed = parseReviewJson(reply.text);
  if (!parsed) return { ...empty, provider: reply.provider, modelId: reply.modelId, notes: ["La relecture IA n'a pas renvoye de JSON exploitable."] };

  const fields: Record<string, AiReviewField> = {};
  const disagreements: AiReviewOutcome["disagreements"] = [];
  const notes: string[] = [];

  for (const field of REVIEWABLE_FIELDS) {
    if (!(field in parsed)) continue;
    const { value, evidence } = suggestedValue(parsed[field]);
    if (value === null || String(value).trim() === "") continue;
    if (!corroborated(text, value)) {
      notes.push(`${field} : valeur proposee absente du texte reconnu, ignoree.`);
      continue;
    }
    const current = input.fields[field];
    const currentText = String(current?.value ?? "").trim();
    if (currentText && String(value).trim() !== currentText) {
      if ((current?.confidence ?? 0) >= CONFIDENT_ENOUGH) {
        // The recogniser was sure and the review disagrees. Neither wins
        // automatically; a person decides.
        disagreements.push({ field, recognised: currentText, suggested: String(value) });
        continue;
      }
    }
    if (currentText && String(value).trim() === currentText) continue;
    fields[field] = {
      value,
      confidence: Math.min(MAX_REVIEW_CONFIDENCE, Math.max(40, (current?.confidence ?? 0) + 20)),
      source: "ai-review",
      evidence: evidence || undefined,
    };
  }

  return {
    applied: Object.keys(fields).length > 0 || disagreements.length > 0,
    provider: reply.provider,
    modelId: reply.modelId,
    fields,
    disagreements,
    notes,
  };
}
