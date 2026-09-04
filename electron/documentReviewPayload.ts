/**
 * The reviewable state of one recognised document, with a lifecycle.
 *
 * Recognition produces far more than the handful of values that end up in the
 * books: every word it placed, every candidate it considered, the totals it
 * rejected and why, and — when the reviewer ran — what a model proposed. All of
 * that is evidence for the person deciding whether the reading is right, and
 * almost none of it is worth keeping once they have decided.
 *
 * It used to be one unversioned JSON blob on `Document.extracted` that nothing
 * owned: no schema version, so it could not be evolved or validated; no
 * revision, so a second recognition pass silently replaced the first; no record
 * of what a person had corrected, so **re-running recognition destroyed every
 * manual correction they had made**; and no cleanup, so several hundred
 * recognised words per document stayed on disk for the life of the dossier.
 *
 * This module owns that state instead. It keeps living on `Document.extracted`,
 * beside the canonical field values rather than in a second store — splitting
 * one document's extraction across two tables would buy nothing, and the
 * canonical values are what every reader of that column already wants. What it
 * adds is the part that was missing: a version, a revision, a status, the
 * corrections a person made, and a compaction step.
 *
 * Four rules, in the order they matter:
 *
 *   1. **A manual correction outranks any later reading.** Recognition is a
 *      proposal; a person typing a value is a decision. A rerun carries every
 *      correction forward and re-applies it, so the only thing that replaces a
 *      corrected value is somebody correcting it again.
 *   2. **Nothing canonical is ever compacted away.** Compaction removes the
 *      recogniser's working material — placed words, rejected candidates — and
 *      never `fields`, `fieldConfidence`, the accounting checks, the
 *      corrections, or the record that a review happened.
 *   3. **The source document is never touched.** This is derived state. The
 *      attachment on disk and its checksum outlive every payload built from it.
 *   4. **No provider or model identifier is added here.** What the reviewer
 *      proposed is kept as findings; who was asked stays where diagnostics
 *      already put it, out of the accounting screens.
 */

/** Raised when the shape changes in a way a reader must notice. */
export const DOCUMENT_REVIEW_SCHEMA_VERSION = 1;

export type DocumentReviewStatus =
  /** Recognition has run; nobody has looked at it yet. */
  | "PREPARED"
  /** A person has corrected or examined it, and it is not yet committed. */
  | "REVIEWED"
  /** Its values became an invoice, a payment or an entry. */
  | "CONFIRMED"
  /** Abandoned. Kept as a fact, without its body. */
  | "DISCARDED";

export type DocumentReviewCorrection = {
  field: string;
  /** What the person put there. */
  value: unknown;
  /** What recognition had proposed, so the two remain distinguishable. */
  replaced: unknown;
  at: string;
};

export type DocumentReview = {
  schemaVersion: number;
  status: DocumentReviewStatus;
  /** Increments on every recognition pass over the same document. */
  extractionRevision: number;
  documentType: string;
  /** The bytes this reading came from. Never recomputed from the payload. */
  sourceFingerprint: string | null;
  preparedAt: string;
  updatedAt: string;
  /** Every correction ever made, oldest first. Never pruned by compaction. */
  userCorrections: DocumentReviewCorrection[];
  /** Whether the recogniser's working material has been dropped. */
  compacted: boolean;
};

type Extracted = Record<string, unknown>;

/**
 * The recogniser's working material: large, useful only while somebody is
 * deciding, and removable without touching a single accounting value.
 */
const DISPOSABLE_DIAGNOSTICS = ["recognizedElements", "candidates", "totalsAlternatives", "fieldEvidence"] as const;

function nowIso(clock?: () => Date): string {
  return (clock ? clock() : new Date()).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** The review block of an extraction, or `null` when it predates this module. */
export function readDocumentReview(extracted: unknown): DocumentReview | null {
  const review = asRecord(asRecord(extracted).review);
  if (typeof review.schemaVersion !== "number") return null;
  return {
    schemaVersion: review.schemaVersion,
    status: (typeof review.status === "string" ? review.status : "PREPARED") as DocumentReviewStatus,
    extractionRevision: typeof review.extractionRevision === "number" ? review.extractionRevision : 1,
    documentType: typeof review.documentType === "string" ? review.documentType : "",
    sourceFingerprint: typeof review.sourceFingerprint === "string" ? review.sourceFingerprint : null,
    preparedAt: typeof review.preparedAt === "string" ? review.preparedAt : "",
    updatedAt: typeof review.updatedAt === "string" ? review.updatedAt : "",
    userCorrections: Array.isArray(review.userCorrections)
      ? review.userCorrections.filter((item): item is DocumentReviewCorrection => Boolean(item) && typeof (item as DocumentReviewCorrection).field === "string")
      : [],
    compacted: review.compacted === true,
  };
}

/**
 * Attaches a review to a freshly recognised extraction.
 *
 * `previous` is the extraction being replaced, when there is one. Its
 * corrections are carried forward and re-applied, which is the whole point: a
 * rerun is a better reading of the page, not permission to discard what a
 * person established about it.
 */
export function prepareDocumentReview(
  extracted: Extracted,
  options: {
    documentType: string;
    sourceFingerprint?: string | null;
    previous?: unknown;
    now?: () => Date;
  },
): Extracted {
  const previousReview = readDocumentReview(options.previous);
  const timestamp = nowIso(options.now);
  const review: DocumentReview = {
    schemaVersion: DOCUMENT_REVIEW_SCHEMA_VERSION,
    status: "PREPARED",
    extractionRevision: (previousReview?.extractionRevision ?? 0) + 1,
    documentType: options.documentType,
    sourceFingerprint: options.sourceFingerprint ?? null,
    preparedAt: previousReview?.preparedAt || timestamp,
    updatedAt: timestamp,
    userCorrections: previousReview?.userCorrections ?? [],
    compacted: false,
  };
  return applyUserCorrections({ ...extracted, review });
}

/**
 * Puts every correction back on top of the values recognition produced.
 *
 * Idempotent, and applied in order, so the most recent correction to a field
 * is the one that survives. A corrected field is stamped at full confidence
 * because its confidence is no longer a question about the recogniser.
 */
export function applyUserCorrections(extracted: Extracted): Extracted {
  const review = readDocumentReview(extracted);
  if (!review?.userCorrections.length) return extracted;
  const fields = asRecord(extracted.fields);
  const confidence = asRecord(extracted.fieldConfidence);
  const sources = asRecord(extracted.fieldSources);
  for (const correction of review.userCorrections) {
    fields[correction.field] = correction.value;
    confidence[correction.field] = 100;
    sources[correction.field] = "manual";
  }
  return { ...extracted, fields, fieldConfidence: confidence, fieldSources: sources };
}

/**
 * Records what a person changed, and moves the payload to REVIEWED.
 *
 * A correction that restates the value already there is still recorded: it is
 * a person saying "yes, this one", and that is what stops a later rerun from
 * treating the field as merely recognised.
 */
export function recordUserCorrections(
  extracted: Extracted,
  corrections: Record<string, unknown>,
  options: { now?: () => Date } = {},
): Extracted {
  const existing = readDocumentReview(extracted);
  const timestamp = nowIso(options.now);
  const previousFields = asRecord(extracted.fields);
  const review: DocumentReview = {
    schemaVersion: DOCUMENT_REVIEW_SCHEMA_VERSION,
    status: "REVIEWED",
    extractionRevision: existing?.extractionRevision ?? 1,
    documentType: existing?.documentType ?? "",
    sourceFingerprint: existing?.sourceFingerprint ?? null,
    preparedAt: existing?.preparedAt || timestamp,
    updatedAt: timestamp,
    userCorrections: [
      ...(existing?.userCorrections ?? []),
      ...Object.entries(corrections).map(([field, value]) => ({
        field,
        value,
        replaced: previousFields[field] ?? null,
        at: timestamp,
      })),
    ],
    compacted: existing?.compacted ?? false,
  };
  return applyUserCorrections({ ...extracted, review });
}

/**
 * Drops the recogniser's working material.
 *
 * Everything an accountant or a later reader needs stays: the field values,
 * their confidence and origin, the accounting checks, the reviewer's findings
 * and every correction. What goes is the material that only helped somebody
 * decide, and only while they were deciding.
 */
export function compactDocumentReview(extracted: Extracted, options: { now?: () => Date } = {}): Extracted {
  const existing = readDocumentReview(extracted);
  const diagnostics = asRecord(extracted.diagnostics);
  for (const key of DISPOSABLE_DIAGNOSTICS) delete diagnostics[key];
  const review: DocumentReview = {
    ...(existing ?? {
      schemaVersion: DOCUMENT_REVIEW_SCHEMA_VERSION,
      status: "PREPARED",
      extractionRevision: 1,
      documentType: "",
      sourceFingerprint: null,
      preparedAt: nowIso(options.now),
      userCorrections: [],
    } as unknown as DocumentReview),
    schemaVersion: DOCUMENT_REVIEW_SCHEMA_VERSION,
    compacted: true,
    updatedAt: nowIso(options.now),
  };
  return { ...extracted, diagnostics, review };
}

/**
 * The end of the lifecycle: the reading became accounting data, or was
 * abandoned. Either way the working material goes and the fact remains — an
 * audit trail records that review happened, and this records what was approved.
 */
export function settleDocumentReview(
  extracted: Extracted,
  status: Extract<DocumentReviewStatus, "CONFIRMED" | "DISCARDED">,
  options: { now?: () => Date } = {},
): Extracted {
  const compacted = compactDocumentReview(extracted, options);
  const review = readDocumentReview(compacted);
  return { ...compacted, review: { ...review, status, updatedAt: nowIso(options.now) } };
}
