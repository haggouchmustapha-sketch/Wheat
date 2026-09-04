/**
 * Guided work: Wheat prepares, the accountant approves.
 *
 * The previous guided journey answered one question — *what should I do next?* —
 * and then sent the user to a screen to do all of it by hand. It read the
 * dossier and it read it well, but it prepared nothing, proposed nothing and
 * executed nothing: fifteen stages of advice in front of the same manual forms.
 * For a fiduciaire holding thirty purchase invoices, advice is not the scarce
 * resource.
 *
 * This module keeps that detection — `wheatJourney.ts` still derives every
 * status from the dossier's own records — and adds the five stages that were
 * missing, so a step now runs end to end:
 *
 *   DETECT    the journey says which step is actually next
 *   PREPARE   this module builds the concrete operations that step needs
 *   VALIDATE  each one is checked deterministically, before anybody sees it
 *   REVIEW    every operation carries its confidence and what to look at
 *   APPROVE   the accountant accepts, rejects or corrects — per operation
 *   EXECUTE   the existing domain services perform the approved ones
 *   NEXT      the journey is recomputed, and the next step is prepared
 *
 * Three rules shape everything below.
 *
 * *Nothing is executed without approval.* A proposal is a plain description of
 * what would happen; `approve` is the only entry point that writes, it only
 * ever performs the operation ids it was given, and each one is re-validated by
 * the domain service that owns it, inside that service's own transaction.
 *
 * *No accounting logic lives here.* Directions, counterparties, accounts and
 * amounts come from `documentInvoiceDraft.ts` and `partyIdentity.ts`; writes go
 * through the invoice, tax and fiscal-year services unchanged. This module is a
 * planner and a scheduler, never a second implementation of the ledger.
 *
 * *One bad document never stops a batch.* Preparation catches per-item failures
 * and turns them into a `BLOCKED` operation carrying the reason; execution runs
 * each approved operation in its own transaction and reports the failures
 * alongside the successes.
 *
 * Progress itself is still not stored. `GuidedStepDecision` holds exactly the
 * two facts no record can show — that somebody postponed a step, or declared it
 * inapplicable to this dossier — and nothing else.
 */

import {
  InvoiceDraftPlanError,
  missingAccountMessage,
  planInvoiceDraftFromDocument,
  requiredRolesForPlan,
  resolveAccountRole,
  documentAmountToCents,
  type ChartAccount,
  type InvoiceDraftPlan,
  type KnownCounterparty,
  type PlanCorrectionSuggestion,
} from "./documentInvoiceDraft";
import { matchPartyIdentity, normalizeCompanyName } from "./partyIdentity";
import { createWheatJourneyService, type WheatJourneyStage, type WheatJourneyState } from "./wheatJourney";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const WHEAT_GUIDED_CHANNELS = {
  state: "wheat:guided:state",
  prepare: "wheat:guided:prepare",
  approve: "wheat:guided:approve",
  decide: "wheat:guided:decide",
} as const;

/* ------------------------------------------------------------------ */
/* What a proposal is                                                  */
/* ------------------------------------------------------------------ */

/**
 * Whether an operation may be approved as it stands.
 *
 * The three are deliberately not a confidence score in disguise. `READY` means
 * every value was read confidently and every deterministic check passed;
 * `REVIEW` means Wheat produced a complete operation but something in it wants
 * a human eye; `BLOCKED` means Wheat could not build the operation at all and
 * says exactly what is missing. Only the first two can be approved, and the
 * screen defaults to selecting only the first.
 */
export type GuidedOperationStatus = "READY" | "REVIEW" | "BLOCKED";

export type GuidedOperation = {
  /** Stable within one proposal; approval names these and nothing else. */
  id: string;
  kind: string;
  label: string;
  detail: string;
  status: GuidedOperationStatus;
  /** 0-100. What Wheat thinks of its own reading, not a promise. */
  confidence: number;
  /** Why this status, in plain French. */
  reasons: string[];
  /** The specific fields a reviewer should look at, if any. */
  attention: string[];
  /**
   * Where the underlying record lives. Guided work is a shortcut, never a
   * prison: every proposed operation can be opened, edited or refused in the
   * ordinary screen that owns it.
   */
  target: { page: string; recordId: string | null } | null;
  /**
   * The fields a reviewer may settle without leaving guided work.
   *
   * A proposal that is complete except for one unknown should cost one choice,
   * not a trip to another screen and back. Editing one of these re-runs
   * preparation with the correction applied, so the status, the confidence and
   * every dependent amount are recomputed by the same code that produced them —
   * an edit prepares, it never posts.
   */
  edits: GuidedFieldEdit[];
  /** A correction the document's own arithmetic determines, if there is one. */
  suggestion: PlanCorrectionSuggestion | null;
  /** Everything `approve` needs. Never trusted on the way back in. */
  payload: Record<string, unknown>;
};

/** One inline-correctable field of a prepared operation. */
export type GuidedFieldEdit = {
  field: string;
  label: string;
  kind: "CHOICE" | "AMOUNT" | "TEXT" | "DATE";
  /** The value preparation currently holds, in the extraction's own units. */
  value: string;
  choices?: Array<{ value: string; label: string }>;
  /** Why Wheat is asking about this field. */
  note: string | null;
  /**
   * True when approval is refused until a person sets it. Reserved for the
   * decisions Wheat must not make on its own — the ledger side of a document it
   * could not attribute — never for a field it merely read with less certainty.
   */
  required: boolean;
};

/** A reviewer's inline corrections to one prepared operation. */
export type GuidedCorrection = { operationId: string; fields: Record<string, string> };

export type GuidedFinding = { severity: "INFO" | "WARNING" | "BLOCKER"; message: string };

export type GuidedProposal = {
  stepId: string;
  title: string;
  /** One sentence: what Wheat found and what it proposes to do about it. */
  summary: string;
  /** What detection actually saw, so the summary can be checked. */
  detected: Array<{ label: string; value: string }>;
  operations: GuidedOperation[];
  findings: GuidedFinding[];
  readyCount: number;
  reviewCount: number;
  blockedCount: number;
  /** The confirmation button's text, naming what approving will do. */
  approveLabel: string;
  /** False when there is nothing a person could usefully approve. */
  approvable: boolean;
  preparedAt: string;
};

export type GuidedExecution = {
  stepId: string;
  executed: Array<{ operationId: string; label: string; recordId: string | null }>;
  failed: Array<{ operationId: string; label: string; reason: string }>;
  message: string;
};

export type GuidedDecisionKind = "POSTPONED" | "NOT_APPLICABLE" | "RESUMED";

export type GuidedStep = WheatJourneyStage & {
  /** A human decision that the dossier's records cannot show. */
  decision: { kind: string; note: string | null; decidedAt: string } | null;
  /** True when Wheat can prepare work for this step rather than only advise. */
  automatable: boolean;
};

export type GuidedState = {
  version: "WHEAT_GUIDED_1";
  companyId: string | null;
  companyName: string | null;
  steps: GuidedStep[];
  completed: number;
  total: number;
  /** The step the screen puts in front of the user right now. */
  next: GuidedStep | null;
  /** Prepared for `next`, when that step is one Wheat can act on. */
  proposal: GuidedProposal | null;
  inferred: string[];
  computedAt: string;
};

/* ------------------------------------------------------------------ */
/* The domain services guided work drives                              */
/* ------------------------------------------------------------------ */

/**
 * Everything guided work is allowed to change, and the only way it may.
 *
 * These are the same functions the ordinary screens call. Injecting them keeps
 * one implementation of every rule — a draft created from guided work is
 * byte-for-byte the draft the documents screen would have created — and lets
 * the tests drive the planner without an Electron main process.
 */
export type GuidedDomainServices = {
  createInvoiceDraftFromDocument(input: { companyId: string; documentId: string; forcedKind?: "SALE" | "PURCHASE" | null }): Promise<{ invoiceDraft?: { id?: string } } & Record<string, any>>;
  /**
   * The ordinary OCR-correction path. An inline edit to an amount is the same
   * correction the review screen makes — same merge, same confidence, same
   * `SMART_OCR_CORRECT` audit entry — so guided work calls it rather than
   * writing to the document itself.
   */
  updateDocumentExtraction(input: { companyId: string; documentId: string; fields: Record<string, unknown> }): Promise<Record<string, any>>;
  postInvoice(input: { companyId: string; id: string; expectedVersion: number }): Promise<Record<string, any>>;
  saveFiscalYear(input: Record<string, unknown>): Promise<Record<string, any>>;
  saveTaxConfigDraft(input: Record<string, unknown>): Promise<Record<string, any>>;
  activateTaxConfig(input: Record<string, unknown>): Promise<Record<string, any>>;
};

export type GuidedWorkOptions = {
  getPrisma: GetPrisma;
  services: GuidedDomainServices;
  getActorUserId?: () => string | null | Promise<string | null>;
  serialize?: <T>(value: T) => T;
  /** Overridable so tests can pin "today". */
  now?: () => Date;
};

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};

const text = (value: unknown): string => String(value ?? "").trim();

function requireCompanyId(payload: Record<string, any>): string {
  const companyId = text(payload.companyId);
  if (!companyId) throw new Error("Le dossier est obligatoire.");
  return companyId;
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function centsToText(value: unknown) {
  const cents = typeof value === "bigint" ? value : BigInt(Math.round(Number(value ?? 0)));
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const units = absolute / 100n;
  const remainder = absolute % 100n;
  return `${negative ? "-" : ""}${units.toString()},${remainder.toString().padStart(2, "0")}`;
}

/** Parses a document's stored extraction without letting one bad row throw. */
function readExtraction(document: { extracted?: string | null }): Record<string, any> {
  try {
    return asRecord(JSON.parse(document.extracted || "{}"));
  } catch {
    return {};
  }
}

/**
 * Steps Wheat can actually prepare work for.
 *
 * Everything else in the journey stays advice, and says so. Claiming a step is
 * automated when approving it would do nothing is the failure mode this list
 * exists to prevent.
 */
const AUTOMATABLE_STEPS = new Set(["fiscal-year", "vat-configuration", "documents", "invoices"]);

/* ------------------------------------------------------------------ */
/* Inline correction                                                   */
/* ------------------------------------------------------------------ */

/**
 * The corrections a reviewer made on the screen, in a shape preparation can use.
 *
 * Everything here is untrusted: it arrives from the renderer alongside the
 * operation ids and is applied by re-running preparation, never by writing
 * anything. Values are kept as the strings they were typed as and parsed by the
 * layer that owns each one — an amount by the exact-decimal reader, a direction
 * by the two-valued check below — so a malformed correction produces a refusal
 * from the same code that would have refused a malformed document.
 */
function readCorrections(value: unknown): Map<string, Record<string, string>> {
  const corrections = new Map<string, Record<string, string>>();
  if (!Array.isArray(value)) return corrections;
  for (const entry of value.slice(0, 500)) {
    const record = asRecord(entry);
    const operationId = text(record.operationId);
    if (!operationId) continue;
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(asRecord(record.fields))) {
      if (!CORRECTABLE_FIELDS.has(key)) continue;
      const trimmed = text(raw);
      if (trimmed) fields[key] = trimmed.slice(0, 200);
    }
    if (Object.keys(fields).length) corrections.set(operationId, fields);
  }
  return corrections;
}

/**
 * What a reviewer may settle inline.
 *
 * Deliberately a fixed list rather than "whatever the renderer sends": these
 * are the fields the recogniser reads and can get wrong, and each one is
 * re-validated by the planner. The counterparty, the accounts and the lines are
 * absent on purpose — changing those is a different operation, and the row's
 * "Ouvrir" link leads to the screen that owns it.
 */
const CORRECTABLE_FIELDS = new Set(["kind", "invoiceNumber", "date", "dueDate", "currency", "ht", "tva", "ttc", "debours", "discount", "vatRate"]);

/** Amount-shaped corrections, which reach the extraction as document units. */
const AMOUNT_FIELDS = new Set(["ht", "tva", "ttc", "debours", "discount"]);

const DIRECTION_CHOICES = [
  { value: "PURCHASE", label: "Achat — le dossier reçoit cette facture" },
  { value: "SALE", label: "Vente — le dossier a émis cette facture" },
];

function readKindCorrection(value: unknown): "SALE" | "PURCHASE" | null {
  const kind = text(value).toUpperCase();
  return kind === "SALE" || kind === "PURCHASE" ? kind : null;
}

/**
 * Folds a reviewer's corrections into a stored reading.
 *
 * The corrected values are marked fully confident because a person stated them,
 * which is the same rule the OCR review screen applies when it saves one. The
 * original object is never mutated: preparation runs many times against the
 * same document as a reviewer tries a value, and each run must start from what
 * the recogniser actually read.
 */
function applyExtractionCorrection(extraction: Record<string, any>, correction: Record<string, string>): Record<string, any> {
  const entries = Object.entries(correction).filter(([field]) => field !== "kind");
  if (!entries.length) return extraction;
  const fields: Record<string, any> = { ...asRecord(extraction.fields) };
  const fieldConfidence: Record<string, any> = { ...asRecord(extraction.fieldConfidence) };
  for (const [field, raw] of entries) {
    if (AMOUNT_FIELDS.has(field)) {
      const cents = documentAmountToCents(raw);
      // A value that is not an amount is dropped rather than stored: leaving
      // the recognised reading in place makes the planner report the original
      // problem, which is more useful than a second, invented one.
      if (cents === null) continue;
      fields[field] = Number(cents) / 100;
    } else if (field === "vatRate") {
      const bps = Number(raw);
      if (!Number.isFinite(bps)) continue;
      fields[field] = Math.round(bps);
    } else {
      fields[field] = raw;
    }
    fieldConfidence[field] = 100;
  }
  return { ...extraction, fields, fieldConfidence, uncertainFields: (Array.isArray(extraction.uncertainFields) ? extraction.uncertainFields : []).filter((item: unknown) => !correction[String(item)]) };
}

const fieldValue = (extraction: Record<string, any>, correction: Record<string, string>, field: string) =>
  correction[field] ?? (asRecord(extraction.fields)[field] === null || asRecord(extraction.fields)[field] === undefined ? "" : String(asRecord(extraction.fields)[field]));

/** The direction chooser, offered whenever the plan did not settle it itself. */
function directionEdit(current: "SALE" | "PURCHASE", provisional: boolean, alternative: InvoiceDraftPlan["directionAlternative"], correction: Record<string, string>): GuidedFieldEdit {
  return {
    field: "kind",
    label: "Sens de la pièce",
    kind: "CHOICE",
    value: correction.kind ?? (provisional ? "" : current),
    choices: DIRECTION_CHOICES,
    note: provisional
      ? `Wheat a lu la pièce entièrement mais n'a pas pu dire de quel côté du grand livre elle se place : ni l'ICE ni la raison sociale du dossier n'y figurent.${alternative?.counterpartyName ? ` En vente, le tiers serait « ${alternative.counterpartyName} ».` : ""}`
      : "Le sens a été déduit et non lu sur la pièce : confirmez-le ou corrigez-le.",
    // Only an assumption has to be settled. A deduction Wheat can defend is
    // offered for correction, not demanded — otherwise a reviewer would have to
    // re-tick every invoice a known supplier sent.
    required: provisional,
  };
}

/** What a reviewer may correct on an operation Wheat did manage to plan. */
function editsForPlan(plan: InvoiceDraftPlan, extraction: Record<string, any>, correction: Record<string, string>): GuidedFieldEdit[] {
  const edits: GuidedFieldEdit[] = [];
  if (plan.directionStatus !== "RESOLVED") {
    edits.push(directionEdit(plan.kind, plan.directionProvisional, plan.directionAlternative, correction));
  }
  const uncertain = new Set((Array.isArray(extraction.uncertainFields) ? extraction.uncertainFields : []).map(String));
  for (const [field, label] of AMOUNT_LABELS) {
    // An amount is offered for correction when the recogniser itself flagged
    // it, or when the reviewer has already touched it. Offering all of them on
    // every clean invoice would bury the one that matters.
    if (!uncertain.has(field) && correction[field] === undefined) continue;
    edits.push({
      field,
      label,
      kind: "AMOUNT",
      value: fieldValue(extraction, correction, field),
      note: uncertain.has(field) ? "Montant lu avec réserve sur la pièce." : null,
      required: false,
    });
  }
  return edits;
}

const AMOUNT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["ht", "Total HT"],
  ["tva", "TVA"],
  ["ttc", "Total TTC"],
  ["debours", "Débours"],
  ["discount", "Remise"],
];

/**
 * What a reviewer may correct on an operation Wheat had to refuse.
 *
 * The planner names the fields it could not work with, and those become the
 * form — pre-filled with the reading its arithmetic determined when there is
 * one, so accepting Wheat's own proposal is a single action rather than four
 * numbers to retype from the paper.
 */
function editsForBlockedPlan(error: InvoiceDraftPlanError | null, extraction: Record<string, any>, correction: Record<string, string>): GuidedFieldEdit[] {
  if (!error) return [];
  const suggested = asRecord(error.suggestion?.fields);
  const edits: GuidedFieldEdit[] = [];
  for (const field of error.missingFields) {
    if (field === "kind") {
      edits.push(directionEdit("PURCHASE", true, null, correction));
      continue;
    }
    if (!CORRECTABLE_FIELDS.has(field)) continue;
    const proposed = suggested[field];
    edits.push({
      field,
      label: AMOUNT_LABELS.find(([key]) => key === field)?.[1] ?? field,
      kind: AMOUNT_FIELDS.has(field) ? "AMOUNT" : field === "date" || field === "dueDate" ? "DATE" : "TEXT",
      value: correction[field] ?? (proposed === undefined ? fieldValue(extraction, correction, field) : String(proposed)),
      note: proposed === undefined ? null : "Valeur déduite de l'arithmétique de la pièce elle-même ; à confirmer.",
      required: true,
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export function createWheatGuidedWorkService(options: GuidedWorkOptions) {
  const journey = createWheatJourneyService({ getPrisma: options.getPrisma });
  const now = options.now ?? (() => new Date());

  /* ---------------------------------------------------------------- */
  /* DETECT                                                            */
  /* ---------------------------------------------------------------- */

  async function state(payloadValue: unknown): Promise<GuidedState> {
    const payload = asRecord(payloadValue);
    const derived: WheatJourneyState = await journey.state(payload);
    const companyId = derived.companyId;

    const decisions: Map<string, any> = new Map();
    if (companyId) {
      const prisma = await options.getPrisma();
      const rows = await prisma.guidedStepDecision.findMany({ where: { companyId } });
      for (const row of rows) decisions.set(row.stepId, row);
    }

    const steps: GuidedStep[] = derived.stages.map((stage) => {
      const decision = decisions.get(stage.id);
      return {
        ...stage,
        automatable: AUTOMATABLE_STEPS.has(stage.id),
        decision: decision && decision.decision !== "RESUMED"
          ? { kind: String(decision.decision), note: decision.note ?? null, decidedAt: new Date(decision.decidedAt).toISOString() }
          : null,
      };
    });

    // A postponed step is not the next thing to do, but it is never hidden: it
    // keeps its place and its status, and the user can resume it whenever.
    const skipped = new Set(steps.filter((step) => step.decision).map((step) => step.id));
    const pick = (status: WheatJourneyStage["status"]) =>
      steps.find((step) => step.status === status && !skipped.has(step.id)) ?? null;
    const next = pick("NEEDS_ANSWER") ?? pick("READY") ?? pick("BLOCKED") ?? null;

    let proposal: GuidedProposal | null = null;
    if (companyId && next && AUTOMATABLE_STEPS.has(next.id) && next.status !== "BLOCKED") {
      // Preparation reads the dossier and can be slow on a large batch; it must
      // never turn "show me where I am" into an error.
      proposal = await prepareQuietly(companyId, next.id);
    }

    return {
      version: "WHEAT_GUIDED_1",
      companyId,
      companyName: derived.companyName,
      steps,
      completed: derived.completed,
      total: derived.total,
      next,
      proposal,
      inferred: derived.inferred,
      computedAt: derived.computedAt,
    };
  }

  async function prepareQuietly(companyId: string, stepId: string): Promise<GuidedProposal | null> {
    try {
      return await prepare({ companyId, stepId });
    } catch (error) {
      return {
        stepId,
        title: stepId,
        summary: "Wheat n'a pas pu préparer cette étape.",
        detected: [],
        operations: [],
        findings: [{ severity: "BLOCKER", message: error instanceof Error ? error.message : String(error) }],
        readyCount: 0,
        reviewCount: 0,
        blockedCount: 0,
        approveLabel: "",
        approvable: false,
        preparedAt: now().toISOString(),
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* PREPARE + VALIDATE                                                */
  /* ---------------------------------------------------------------- */

  async function prepare(payloadValue: unknown): Promise<GuidedProposal> {
    const payload = asRecord(payloadValue);
    const companyId = requireCompanyId(payload);
    const stepId = text(payload.stepId);
    const corrections = readCorrections(payload.corrections);
    const prisma = await options.getPrisma();
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error("Le dossier actif n'existe plus.");

    switch (stepId) {
      case "fiscal-year": return prepareFiscalYear(prisma, company);
      case "vat-configuration": return prepareVatConfiguration(prisma, company);
      case "documents": return prepareInvoiceDrafts(prisma, company, corrections);
      case "invoices": return prepareInvoicePosting(prisma, company);
      default:
        throw new Error(`Wheat ne prépare pas encore l'étape « ${stepId} » ; elle se fait depuis son écran.`);
    }
  }

  /** An accounting year, when the dossier has none open. */
  async function prepareFiscalYear(prisma: PrismaLike, company: any): Promise<GuidedProposal> {
    const today = now();
    const years = await prisma.fiscalYear.findMany({ where: { companyId: company.id }, orderBy: { startsOn: "desc" } });
    const open = years.find((year: any) => year.status === "OPEN" && new Date(year.startsOn) <= today && new Date(year.endsOn) >= today);
    const detected: Array<{ label: string; value: string }> = [
      { label: "Exercices existants", value: years.length ? years.map((year: any) => year.label).join(", ") : "aucun" },
    ];

    if (open) {
      return proposal("fiscal-year", "Exercice comptable", `L'exercice ${open.label} est ouvert et couvre la date du jour.`, detected, [], [
        { severity: "INFO", message: "Rien à créer : l'exercice courant existe déjà." },
      ], "");
    }

    // The Moroccan civil year is the overwhelmingly common case and the one the
    // dossier creation wizard already assumes; a dossier that closes on another
    // date corrects the proposal rather than typing it from scratch.
    const startsOn = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    const endsOn = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
    const overlap = years.find((year: any) => new Date(year.startsOn) <= endsOn && new Date(year.endsOn) >= startsOn);
    const label = `Exercice ${isoDay(startsOn)} au ${isoDay(endsOn)}`;

    const operation: GuidedOperation = {
      id: `fiscal-year:${isoDay(startsOn)}`,
      kind: "CREATE_FISCAL_YEAR",
      label,
      detail: `Du ${isoDay(startsOn)} au ${isoDay(endsOn)}, ouvert.`,
      status: overlap ? "BLOCKED" : "READY",
      confidence: overlap ? 0 : 92,
      reasons: overlap
        ? [`Les dates chevauchent l'exercice « ${overlap.label} » déjà enregistré.`]
        : ["Année civile, la clôture usuelle au Maroc et celle que l'assistant de création applique."],
      attention: overlap ? ["startsOn", "endsOn"] : [],
      edits: [],
      suggestion: null,
      target: { page: "settings", recordId: null },
      payload: { companyId: company.id, label, startsOn: isoDay(startsOn), endsOn: isoDay(endsOn) },
    };

    return proposal(
      "fiscal-year",
      "Exercice comptable",
      overlap
        ? "Un exercice couvrant l'année en cours existe déjà mais n'est pas ouvert : ouvrez-le depuis les paramètres."
        : `Wheat propose de créer l'exercice ${label}.`,
      detected,
      [operation],
      [],
      "Créer l'exercice",
    );
  }

  /**
   * The VAT configuration, built from what the dossier's own pieces show.
   *
   * The rates are not invented: they are the ones actually printed on the
   * documents already imported and on the invoices already recorded. The
   * statutory set is used only when the dossier holds nothing yet, and the
   * proposal says which of the two happened. The accounts come from the
   * dossier's own chart through the same resolver the invoice builder uses, so
   * a fiduciaire's custom subdivision is honoured rather than overwritten.
   */
  async function prepareVatConfiguration(prisma: PrismaLike, company: any): Promise<GuidedProposal> {
    const [existingActive, accounts, fiscalYears, invoiceLines, documents] = await Promise.all([
      prisma.taxConfigurationVersion.findFirst({ where: { companyId: company.id, status: "ACTIVE" } }),
      prisma.account.findMany({ where: { companyId: company.id, active: true }, select: { id: true, code: true, label: true, active: true, postable: true } }),
      prisma.fiscalYear.findMany({ where: { companyId: company.id }, orderBy: { startsOn: "desc" } }),
      prisma.invoiceLine.findMany({ where: { invoice: { companyId: company.id } }, select: { vatRateBps: true }, take: 5000 }),
      prisma.document.findMany({ where: { companyId: company.id }, select: { extracted: true }, take: 500 }),
    ]);

    const frequency = text(company.vatFrequency).toUpperCase();
    const detected: Array<{ label: string; value: string }> = [];
    const findings: GuidedFinding[] = [];

    if (existingActive) {
      return proposal("vat-configuration", "Configuration de TVA", `La configuration « ${existingActive.name} » est déjà active.`, detected, [], [
        { severity: "INFO", message: "Rien à activer : une configuration de TVA est déjà en vigueur." },
      ], "");
    }
    if (frequency !== "MONTHLY" && frequency !== "QUARTERLY") {
      // The one thing Wheat must never guess. It is a question, not a default.
      return proposal("vat-configuration", "Configuration de TVA", "Wheat ne connaît pas encore le rythme de déclaration du dossier.", detected, [], [
        { severity: "BLOCKER", message: "Indiquez si la société déclare la TVA tous les mois ou tous les trimestres avant que Wheat prépare la configuration. Le rythme découpe les périodes ; il ne se déduit pas des pièces." },
      ], "");
    }

    // Rates the dossier actually uses, strongest evidence first.
    const observed = new Map<number, string>();
    for (const line of invoiceLines) {
      const bps = Number(line.vatRateBps ?? 0);
      if (Number.isInteger(bps) && bps > 0 && bps <= 10_000) observed.set(bps, "factures enregistrées");
    }
    for (const document of documents) {
      const extraction = readExtraction(document);
      const fields = asRecord(extraction.fields);
      const rate = Number(fields.vatRate ?? fields.tvaRate ?? NaN);
      if (Number.isFinite(rate) && rate > 0 && rate <= 100) observed.set(Math.round(rate * 100), "pièces reconnues");
    }

    const STATUTORY = [2000, 1400, 1000, 700];
    const rates = observed.size ? [...observed.keys()].sort((left, right) => right - left) : STATUTORY;
    detected.push({
      label: "Taux retenus",
      value: rates.map((bps) => `${bps / 100} %`).join(", "),
    });
    detected.push({
      label: "Origine",
      value: observed.size
        ? `lus sur les ${[...new Set(observed.values())].join(" et les ")} du dossier`
        : "taux légaux marocains, faute de pièce dans le dossier",
    });
    detected.push({ label: "Rythme déclaré", value: frequency === "MONTHLY" ? "mensuel" : "trimestriel" });
    if (!observed.size) {
      findings.push({
        severity: "WARNING",
        message: "Aucune pièce n'a encore été importée : Wheat propose les taux légaux (20, 14, 10 et 7 %). Importez les factures avant d'activer si la société n'en pratique qu'une partie.",
      });
    }

    const chart = accounts as ChartAccount[];
    const collected = resolveAccountRole("VAT_COLLECTED", chart);
    const deductible = resolveAccountRole("VAT_DEDUCTIBLE", chart);
    const missing = [collected, deductible].filter((role) => !role.account);
    if (missing.length) {
      return proposal("vat-configuration", "Configuration de TVA", "Le plan comptable du dossier ne porte pas encore les comptes de TVA.", detected, [], [
        { severity: "BLOCKER", message: missingAccountMessage(missing) },
      ], "");
    }
    detected.push({ label: "TVA facturée", value: `${collected.account!.code} — ${collected.account!.label}` });
    detected.push({ label: "TVA récupérable", value: `${deductible.account!.code} — ${deductible.account!.label}` });

    // The effect date must start a period, and a quarterly configuration must
    // start a calendar quarter: the tax service refuses anything else, so the
    // proposal is aligned here rather than failing on approval.
    const today = now();
    const year = fiscalYears.find((item: any) => item.status === "OPEN") ?? fiscalYears[0] ?? null;
    const anchor = year ? new Date(year.startsOn) : new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    const month = frequency === "QUARTERLY" ? Math.floor(anchor.getUTCMonth() / 3) * 3 : anchor.getUTCMonth();
    const effectiveFrom = new Date(Date.UTC(anchor.getUTCFullYear(), month, 1));
    detected.push({ label: "Prise d'effet", value: isoDay(effectiveFrom) });

    const definitions = rates.flatMap((bps) => [
      { code: `TVA-COL-${bps}`, label: `TVA facturée ${bps / 100} %`, rateBps: bps, direction: "COLLECTED", accountId: collected.account!.id },
      { code: `TVA-DED-${bps}`, label: `TVA récupérable ${bps / 100} %`, rateBps: bps, direction: "DEDUCTIBLE", accountId: deductible.account!.id, deductibilityBps: 10_000 },
    ]);

    const operation: GuidedOperation = {
      id: `vat-configuration:${isoDay(effectiveFrom)}`,
      kind: "ACTIVATE_TAX_CONFIGURATION",
      label: `Configuration TVA ${frequency === "MONTHLY" ? "mensuelle" : "trimestrielle"} au ${isoDay(effectiveFrom)}`,
      detail: `${definitions.length} taux (${rates.map((bps) => `${bps / 100} %`).join(", ")}), TVA facturée sur ${collected.account!.code}, TVA récupérable sur ${deductible.account!.code}.`,
      status: observed.size ? "READY" : "REVIEW",
      confidence: observed.size ? 88 : 62,
      reasons: observed.size
        ? ["Les taux proviennent des pièces et factures du dossier lui-même."]
        : ["Aucune pièce ne permet encore de confirmer les taux réellement pratiqués."],
      attention: observed.size ? [] : ["rates"],
      edits: [],
      suggestion: null,
      target: { page: "vat", recordId: null },
      payload: {
        companyId: company.id,
        name: `Régime TVA ${company.name}`.slice(0, 120),
        accountingBasis: "COLLECTION",
        filingFrequency: frequency,
        effectiveFrom: isoDay(effectiveFrom),
        sourceReference: observed.size
          ? "Taux relevés sur les pièces du dossier ; comptes issus du plan comptable du dossier (PCGE)."
          : "Taux légaux marocains (CGI, TVA) ; comptes issus du plan comptable du dossier (PCGE).",
        rates: definitions,
      },
    };

    return proposal(
      "vat-configuration",
      "Configuration de TVA",
      `Wheat propose une configuration ${frequency === "MONTHLY" ? "mensuelle" : "trimestrielle"} à ${rates.length} taux, prenant effet le ${isoDay(effectiveFrom)}.`,
      detected,
      [operation],
      findings,
      "Activer la configuration",
    );
  }

  /**
   * A whole batch of recognised documents turned into invoice drafts.
   *
   * This is the step the rework exists for. Every unlinked document is planned
   * with `planInvoiceDraftFromDocument` — the same function the documents screen
   * uses, so the direction, the counterparty, the accounts and the amounts are
   * decided in exactly one place — and the result becomes one reviewable
   * operation. A document the planner refuses becomes a `BLOCKED` operation
   * carrying the planner's own sentence, and the other twenty-nine proceed.
   */
  async function prepareInvoiceDrafts(prisma: PrismaLike, company: any, corrections: Map<string, Record<string, string>>): Promise<GuidedProposal> {
    const [documents, accounts, counterparties] = await Promise.all([
      prisma.document.findMany({
        where: { companyId: company.id, invoiceId: null, entryId: null, paymentId: null },
        orderBy: { createdAt: "asc" },
        take: 300,
      }),
      prisma.account.findMany({ where: { companyId: company.id, active: true }, select: { id: true, code: true, label: true, active: true, postable: true } }),
      prisma.counterparty.findMany({
        where: { companyId: company.id },
        select: { id: true, displayName: true, legalName: true, ice: true, taxId: true, kind: true, active: true, paymentTermsDays: true },
        take: 2000,
      }),
    ]);

    const chart = accounts as ChartAccount[];
    // The dossier's own third parties, so a supplier already known to it does
    // not have to be re-identified on every invoice it sends.
    const roster: KnownCounterparty[] = counterparties
      .filter((item: any) => item.active !== false && (item.kind === "CUSTOMER" || item.kind === "SUPPLIER"))
      .map((item: any) => ({
        kind: item.kind, displayName: text(item.displayName), legalName: item.legalName ?? null,
        // A third party is held by its ICE, its IF and its names; Wheat does
        // not record its RC, so RC-based matching simply never fires here.
        ice: item.ice ?? null, taxId: item.taxId ?? null, rc: null,
      }));

    const operations: GuidedOperation[] = [];
    const findings: GuidedFinding[] = [];
    let newCounterparties = 0;
    let duplicates = 0;
    let directionsToConfirm = 0;
    const plannedCounterpartyKeys = new Set<string>();

    for (const document of documents) {
      const stored = readExtraction(document);
      const documentType = text(stored.documentType) || "UNKNOWN";
      // Bank statements, payslips and contracts are documents Wheat files but
      // does not turn into an invoice; saying so is better than a blocked row.
      if (documentType !== "INVOICE" && documentType !== "CREDIT_NOTE") continue;

      const operationId = `document:${document.id}`;
      const correction = corrections.get(operationId) ?? {};
      // A reviewer's correction is folded into the reading before anything is
      // planned, so what follows — the status, the confidence, every derived
      // amount — is produced by exactly the code that produced the original.
      const extraction = applyExtractionCorrection(stored, correction);
      const forcedKind = readKindCorrection(correction.kind);

      const base = {
        id: operationId,
        kind: "CREATE_INVOICE_DRAFT",
        target: { page: "documents", recordId: document.id },
      };
      const confidence = Number(extraction.confidence ?? 0) || 0;
      const uncertain: string[] = Array.isArray(extraction.uncertainFields) ? extraction.uncertainFields.map(String) : [];
      const duplicateIds: string[] = Array.isArray(extraction.duplicateIds) ? extraction.duplicateIds.map(String) : [];
      const correctedFields = Object.keys(correction).filter((key) => text(correction[key]));

      let plan: InvoiceDraftPlan;
      try {
        plan = planInvoiceDraftFromDocument({
          extracted: extraction,
          documentTitle: document.title,
          company: { name: company.name, ice: company.ice, taxId: company.taxId, city: company.city, baseCurrency: company.baseCurrency },
          paymentTermsDays: null,
          forcedKind,
          knownCounterparties: roster,
          // Preparation describes; it never writes. A document whose ledger side
          // is unknown is still fully read and shown, with that one decision put
          // to the reviewer — refusing here would discard a correct reading of
          // the number, the date, the third party, the lines and the totals
          // because one field could not be settled.
          allowProvisionalDirection: true,
        });
      } catch (error) {
        const planError = error instanceof InvoiceDraftPlanError ? error : null;
        operations.push({
          ...base,
          label: document.title,
          detail: "Wheat n'a pas pu établir le brouillon depuis cette pièce.",
          status: "BLOCKED",
          confidence,
          reasons: [
            error instanceof Error ? error.message : String(error),
            ...(planError?.suggestion ? [planError.suggestion.explanation] : []),
          ],
          attention: planError?.missingFields ?? [],
          // A refusal Wheat can explain is a refusal it can offer to resolve:
          // the fields it named become editable here rather than in another
          // screen, pre-filled with the reading its own arithmetic determined.
          edits: editsForBlockedPlan(planError, extraction, correction),
          suggestion: planError?.suggestion ?? null,
          payload: { companyId: company.id, documentId: document.id },
        });
        continue;
      }

      // The third party, resolved exactly as execution will resolve it.
      const match = findKnownCounterparty(counterparties, plan.counterparty);
      const counterpartyLabel = match
        ? `${plan.counterparty.kind === "CUSTOMER" ? "Client" : "Fournisseur"} existant : ${match.displayName}`
        : `Nouveau ${plan.counterparty.kind === "CUSTOMER" ? "client" : "fournisseur"} : ${plan.counterparty.displayName}${plan.counterparty.ice ? ` (ICE ${plan.counterparty.ice})` : ""}`;
      if (!match) {
        const key = plan.counterparty.ice || plan.counterparty.taxId || normalizeCompanyName(plan.counterparty.displayName);
        if (key && !plannedCounterpartyKeys.has(key)) {
          plannedCounterpartyKeys.add(key);
          newCounterparties += 1;
        }
      }

      // Accounts the plan needs must exist in this dossier's own chart.
      const unresolved = requiredRolesForPlan(plan)
        .map((role) => resolveAccountRole(role as any, chart))
        .filter((resolved) => !resolved.account);

      const reasons: string[] = [];
      const attention: string[] = [];
      let status: GuidedOperationStatus = "READY";

      if (unresolved.length) {
        status = "BLOCKED";
        reasons.push(missingAccountMessage(unresolved));
      }
      if (duplicateIds.length) {
        duplicates += 1;
        status = status === "BLOCKED" ? status : "REVIEW";
        reasons.push(`Pièce déjà présente dans le dossier (${duplicateIds.length} correspondance(s)) : vérifiez avant de créer un second brouillon.`);
      }
      // The ledger side is the one thing Wheat must never settle by itself. A
      // provisional plan is complete in every other respect and is offered for
      // confirmation; approval refuses it until the reviewer has chosen.
      if (plan.directionProvisional) {
        directionsToConfirm += 1;
        status = status === "BLOCKED" ? status : "REVIEW";
        attention.push("kind");
      } else if (plan.directionStatus !== "RESOLVED") {
        status = status === "BLOCKED" ? status : "REVIEW";
        reasons.push(plan.directionStatus === "IMPLIED"
          ? "Le sens achat/vente est déduit et non lu sur la pièce."
          : "Le sens achat/vente n'a pas pu être établi avec certitude.");
        attention.push("kind");
      }
      if (uncertain.length) {
        status = status === "BLOCKED" ? status : "REVIEW";
        reasons.push(`Champs lus avec réserve : ${uncertain.join(", ")}.`);
        attention.push(...uncertain);
      }
      if (confidence > 0 && confidence < 78) {
        status = status === "BLOCKED" ? status : "REVIEW";
        reasons.push(`Confiance de reconnaissance ${confidence} %.`);
      }
      for (const warning of plan.warnings) reasons.push(warning);
      if (correctedFields.length) reasons.push(`Corrigé ici avant approbation : ${correctedFields.join(", ")}.`);
      if (status === "READY") reasons.push("Montants cohérents, tiers résolu, comptes trouvés dans le plan du dossier.");

      operations.push({
        ...base,
        // A row whose side Wheat assumed must not announce that side as a fact.
        // "Achat F-2026-1" on a document Wheat could not attribute reads as a
        // decision already taken, and the reviewer's choice below then looks
        // like a formality rather than the thing that settles it.
        label: plan.directionProvisional
          ? `Pièce ${plan.invoiceNo} — sens à confirmer (${plan.counterparty.displayName} / ${plan.directionAlternative?.counterpartyName ?? "autre partie"})`
          : `${plan.kind === "SALE" ? "Vente" : "Achat"} ${plan.invoiceNo} — ${plan.counterparty.displayName}`,
        detail: [
          `Pièce du ${plan.invoiceDate}`,
          `HT ${centsToText(plan.htCents)} ${plan.currency}`,
          `TVA ${centsToText(plan.vatCents)}`,
          ...(BigInt(plan.deboursCents) > 0n ? [`Débours ${centsToText(plan.deboursCents)}`] : []),
          `TTC ${centsToText(plan.ttcCents)}`,
          `${plan.lines.length} ligne(s)`,
          counterpartyLabel,
        ].join(" · "),
        status,
        confidence,
        reasons,
        attention: [...new Set(attention)],
        edits: editsForPlan(plan, extraction, correction),
        suggestion: null,
        payload: {
          companyId: company.id,
          documentId: document.id,
          kind: plan.kind,
          // Execution reads this, not the operation's status: a plan Wheat
          // assumed the side of may not be written until a person settles it.
          directionProvisional: plan.directionProvisional,
        },
      });
    }

    const detected: Array<{ label: string; value: string }> = [
      { label: "Pièces à traiter", value: String(operations.length) },
      { label: "Achats", value: String(operations.filter((operation) => operation.label.startsWith("Achat")).length) },
      { label: "Ventes", value: String(operations.filter((operation) => operation.label.startsWith("Vente")).length) },
      // Counted apart, because a row whose side is unsettled belongs to neither.
      { label: "Tiers à créer", value: String(newCounterparties) },
      { label: "Doublons signalés", value: String(duplicates) },
      { label: "Sens à confirmer", value: String(directionsToConfirm) },
    ];
    if (duplicates) {
      findings.push({ severity: "WARNING", message: `${duplicates} doublon(s) possible(s) : ces pièces ressemblent à des documents déjà présents dans le dossier. Elles sont proposées à relire et ne sont pas cochées d'office.` });
    }
    if (directionsToConfirm) {
      findings.push({
        severity: "WARNING",
        message: `${directionsToConfirm} pièce(s) ne nomment ni l'ICE ni la raison sociale du dossier : Wheat les a lues entièrement mais ne peut pas dire seul s'il s'agit d'un achat ou d'une vente. Choisissez le sens sur la ligne, Wheat prépare le reste.`,
      });
    }
    const blocked = operations.filter((operation) => operation.status === "BLOCKED").length;
    if (blocked) {
      findings.push({ severity: "WARNING", message: `${blocked} pièce(s) demandent une correction avant de pouvoir devenir un brouillon. Les autres peuvent être approuvées sans les attendre.` });
    }

    const actionable = operations.filter((operation) => operation.status !== "BLOCKED").length;
    return proposal(
      "documents",
      "Factures à créer depuis les pièces",
      operations.length
        ? `${operations.length} pièce(s) analysée(s) : ${operations.filter((operation) => operation.status === "READY").length} prête(s), ${operations.filter((operation) => operation.status === "REVIEW").length} à relire, ${blocked} à corriger.`
        : "Aucune pièce reconnue n'attend d'être transformée en facture.",
      detected,
      operations,
      findings,
      actionable ? `Créer ${actionable} brouillon(s)` : "",
    );
  }

  /**
   * Posting the drafts that are demonstrably clean.
   *
   * Posting is the highest-impact operation guided work performs, so the bar to
   * `READY` is the strictest: the arithmetic has to close, the lines have to sum
   * to the totals, the third party has to be active, the date has to fall in an
   * open, unlocked period, and the draft must not be flagged for review. Every
   * one of those is re-checked by the subledger inside its own transaction —
   * this only decides what to *offer*.
   */
  async function prepareInvoicePosting(prisma: PrismaLike, company: any): Promise<GuidedProposal> {
    const [drafts, fiscalYears] = await Promise.all([
      prisma.invoice.findMany({
        where: { companyId: company.id, lifecycleStatus: "DRAFT" },
        include: { lines: true, counterpartyModel: true },
        orderBy: { invoiceDate: "asc" },
        take: 300,
      }),
      prisma.fiscalYear.findMany({ where: { companyId: company.id } }),
    ]);

    const operations: GuidedOperation[] = [];
    for (const invoice of drafts) {
      const reasons: string[] = [];
      const attention: string[] = [];
      let status: GuidedOperationStatus = "READY";
      const block = (message: string, field?: string) => {
        status = "BLOCKED";
        reasons.push(message);
        if (field) attention.push(field);
      };
      const flag = (message: string, field?: string) => {
        if (status !== "BLOCKED") status = "REVIEW";
        reasons.push(message);
        if (field) attention.push(field);
      };

      if ((invoice.documentType ?? "INVOICE") !== "INVOICE") continue;
      if (!invoice.lines.length) block("La facture ne contient aucune ligne.", "lines");
      if (!invoice.counterpartyModel) block("Le tiers de la facture est introuvable.", "counterparty");
      else if (!invoice.counterpartyModel.active) block(`Le tiers « ${invoice.counterpartyModel.displayName} » est archivé.`, "counterparty");

      const lineHt = invoice.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.htCents), 0n);
      const lineVat = invoice.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.vatCents), 0n);
      const lineTtc = invoice.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.ttcCents), 0n);
      if (BigInt(invoice.htCents) + BigInt(invoice.vatCents) !== BigInt(invoice.ttcCents)) {
        block(`HT + TVA n'égale pas TTC (${centsToText(invoice.htCents)} + ${centsToText(invoice.vatCents)} ≠ ${centsToText(invoice.ttcCents)}).`, "totals");
      }
      if (lineHt !== BigInt(invoice.htCents) || lineVat !== BigInt(invoice.vatCents) || lineTtc !== BigInt(invoice.ttcCents)) {
        block("Les lignes ne totalisent plus les montants de l'en-tête.", "lines");
      }
      if (invoice.lines.some((line: any) => !line.accountId)) block("Une ligne au moins n'a pas de compte comptable.", "lines");

      const date = new Date(invoice.invoiceDate);
      const year = fiscalYears.find((item: any) => new Date(item.startsOn) <= date && new Date(item.endsOn) >= date);
      if (!year) block(`La date ${isoDay(date)} n'appartient à aucun exercice du dossier.`, "invoiceDate");
      else if (year.status !== "OPEN") block(`L'exercice ${year.label} est ${String(year.status).toLowerCase()}.`, "invoiceDate");
      else if (year.lockedTo && new Date(year.lockedTo) >= date) block(`La période est verrouillée jusqu'au ${isoDay(new Date(year.lockedTo))}.`, "invoiceDate");

      if (invoice.needsReview) flag(text(invoice.reviewNote) || "Ce brouillon est marqué à relire.", "reviewNote");
      if (status === "READY") reasons.push("Équilibre, lignes, tiers, comptes et période contrôlés.");

      operations.push({
        id: `invoice:${invoice.id}`,
        kind: "POST_INVOICE",
        label: `${invoice.kind === "SALE" ? "Vente" : "Achat"} ${invoice.invoiceNo} — ${invoice.counterparty}`,
        detail: `Pièce du ${isoDay(date)} · HT ${centsToText(invoice.htCents)} · TVA ${centsToText(invoice.vatCents)} · TTC ${centsToText(invoice.ttcCents)} ${invoice.currency ?? "MAD"}`,
        status,
        confidence: status === "READY" ? 94 : status === "REVIEW" ? 70 : 0,
        reasons,
        attention: [...new Set(attention)],
        edits: [],
        suggestion: null,
        target: { page: "billing", recordId: invoice.id },
        payload: { companyId: company.id, invoiceId: invoice.id, expectedVersion: Number(invoice.version ?? 1) },
      });
    }

    const ready = operations.filter((operation) => operation.status === "READY").length;
    const actionable = operations.filter((operation) => operation.status !== "BLOCKED").length;
    return proposal(
      "invoices",
      "Factures à comptabiliser",
      operations.length
        ? `${operations.length} brouillon(s) : ${ready} contrôlé(s) et prêt(s), ${operations.filter((operation) => operation.status === "REVIEW").length} à relire, ${operations.filter((operation) => operation.status === "BLOCKED").length} à corriger.`
        : "Aucun brouillon de facture n'attend d'être comptabilisé.",
      [
        { label: "Brouillons", value: String(operations.length) },
        { label: "Prêts", value: String(ready) },
      ],
      operations,
      operations.some((operation) => operation.status === "BLOCKED")
        ? [{ severity: "WARNING", message: "Une comptabilisation est définitive : elle se corrige par extourne, jamais par modification. Les brouillons bloqués restent en l'état." }]
        : [],
      actionable ? `Comptabiliser ${actionable} facture(s)` : "",
    );
  }

  /* ---------------------------------------------------------------- */
  /* APPROVE + EXECUTE                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Performs exactly the operations the user approved, and nothing else.
   *
   * The proposal is rebuilt from the dossier before anything runs, so an
   * operation id that no longer corresponds to a real, still-valid operation is
   * refused rather than replayed: between preparation and approval a document
   * may have been linked elsewhere, a draft posted in another window, or an
   * account archived. Each operation then runs in its own transaction, so the
   * twenty-eight that succeed are kept when two fail.
   */
  async function approve(payloadValue: unknown): Promise<GuidedExecution> {
    const payload = asRecord(payloadValue);
    const companyId = requireCompanyId(payload);
    const stepId = text(payload.stepId);
    const requested = Array.isArray(payload.operationIds) ? payload.operationIds.map(text).filter(Boolean) : [];
    if (!requested.length) throw new Error("Aucune opération n'a été approuvée.");
    const corrections = readCorrections(payload.corrections);

    // Preparation runs again with the reviewer's corrections applied, so what
    // is about to be executed is what they were shown *and* what the planner
    // still accepts. A correction is never trusted on its own: it changes the
    // reading the planner works from, and the planner decides again.
    const current = await prepare({ companyId, stepId, corrections: payload.corrections });
    const byId = new Map(current.operations.map((operation) => [operation.id, operation]));

    const executed: GuidedExecution["executed"] = [];
    const failed: GuidedExecution["failed"] = [];

    for (const operationId of requested) {
      const operation = byId.get(operationId);
      if (!operation) {
        failed.push({ operationId, label: operationId, reason: "Cette opération n'existe plus dans le dossier : actualisez l'étape avant d'approuver." });
        continue;
      }
      if (operation.status === "BLOCKED") {
        failed.push({ operationId, label: operation.label, reason: operation.reasons[0] ?? "Opération bloquée." });
        continue;
      }
      // An edit Wheat marked as one it must not make itself has to have been
      // made. This is the guard that keeps a provisional direction from ever
      // reaching the ledger: preparation may assume a side in order to show the
      // document, execution may not.
      const unanswered = operation.edits.filter((edit) => edit.required && !text(edit.value));
      if (unanswered.length) {
        failed.push({
          operationId,
          label: operation.label,
          reason: `Wheat ne peut pas décider à votre place : renseignez ${unanswered.map((edit) => `« ${edit.label} »`).join(", ")} sur cette ligne avant de l'approuver.`,
        });
        continue;
      }
      try {
        const recordId = await execute(operation, corrections.get(operationId) ?? {});
        executed.push({ operationId, label: operation.label, recordId });
      } catch (error) {
        // One failure is one failure. The rest of the batch is already written.
        failed.push({ operationId, label: operation.label, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      stepId,
      executed,
      failed,
      message: failed.length
        ? `${executed.length} opération(s) effectuée(s), ${failed.length} en échec. Corrigez les échecs puis relancez : rien n'est rejoué deux fois.`
        : `${executed.length} opération(s) effectuée(s).`,
    };
  }

  async function execute(operation: GuidedOperation, correction: Record<string, string>): Promise<string | null> {
    const payload = operation.payload;
    switch (operation.kind) {
      case "CREATE_FISCAL_YEAR": {
        const result = await options.services.saveFiscalYear(payload);
        return text(asRecord(result).id) || null;
      }
      case "ACTIVATE_TAX_CONFIGURATION": {
        // Two calls, because the tax service deliberately separates writing a
        // draft from making it immutable. Guided work does not shortcut that:
        // it performs the same two steps the compliance screen performs.
        const draft = asRecord(await options.services.saveTaxConfigDraft(payload));
        const id = text(draft.id);
        if (!id) throw new Error("La configuration de TVA n'a pas pu être enregistrée.");
        await options.services.activateTaxConfig({
          companyId: payload.companyId,
          id,
          expectedVersion: Number(draft.version ?? 1),
        });
        return id;
      }
      case "CREATE_INVOICE_DRAFT": {
        const companyId = text(payload.companyId);
        const documentId = text(payload.documentId);
        // An amount the reviewer corrected is written to the document first,
        // through the same service the OCR review screen uses. It has to be a
        // real correction of the piece rather than an argument to this one
        // call: the draft builder reads the stored extraction, and a value that
        // lived only in this batch would vanish the moment anybody reclassified
        // or rebuilt the draft from its source.
        const fields = Object.fromEntries(
          Object.entries(correction)
            .filter(([field]) => field !== "kind")
            .map(([field, raw]) => [field, AMOUNT_FIELDS.has(field)
              ? Number(documentAmountToCents(raw) ?? 0n) / 100
              : field === "vatRate" ? Math.round(Number(raw)) : raw]),
        );
        if (Object.keys(fields).length) {
          await options.services.updateDocumentExtraction({ companyId, documentId, fields });
        }
        const result = asRecord(await options.services.createInvoiceDraftFromDocument({
          companyId,
          documentId,
          // The reviewer's answer, or the direction the page itself settled.
          // Never the provisional one: `approve` refused that above.
          forcedKind: readKindCorrection(correction.kind),
        }));
        return text(asRecord(result.invoiceDraft).id) || null;
      }
      case "POST_INVOICE": {
        const result = asRecord(await options.services.postInvoice({
          companyId: text(payload.companyId),
          id: text(payload.invoiceId),
          expectedVersion: Number(payload.expectedVersion ?? 1),
        }));
        return text(asRecord(result.invoice).id) || text(result.id) || null;
      }
      default:
        throw new Error(`Opération inconnue : ${operation.kind}.`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Human decisions                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Records that a person postponed a step or declared it inapplicable.
   *
   * This is the whole of guided work's persisted state, and it is deliberately
   * the whole: a postponed step is not a step Wheat believes is done, so the
   * status still comes from the ledger and the step is still shown with what it
   * would do. `RESUMED` clears the decision and puts the step back in the queue.
   */
  async function decide(payloadValue: unknown) {
    const payload = asRecord(payloadValue);
    const companyId = requireCompanyId(payload);
    const stepId = text(payload.stepId);
    if (!stepId) throw new Error("L'étape est obligatoire.");
    const kind = text(payload.decision).toUpperCase() as GuidedDecisionKind;
    if (kind !== "POSTPONED" && kind !== "NOT_APPLICABLE" && kind !== "RESUMED") {
      throw new Error("La décision doit être POSTPONED, NOT_APPLICABLE ou RESUMED.");
    }
    const note = text(payload.note).slice(0, 500) || null;
    const prisma = await options.getPrisma();
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new Error("Le dossier actif n'existe plus.");

    if (kind === "RESUMED") {
      await prisma.guidedStepDecision.deleteMany({ where: { companyId, stepId } });
      return { ok: true, companyId, stepId, decision: kind };
    }

    const actorUserId = (await options.getActorUserId?.()) ?? null;
    await prisma.guidedStepDecision.upsert({
      where: { companyId_stepId: { companyId, stepId } },
      update: { decision: kind, note, actorUserId, decidedAt: now() },
      create: { companyId, stepId, decision: kind, note, actorUserId },
    });
    return { ok: true, companyId, stepId, decision: kind };
  }

  return { state, prepare, approve, decide };
}

/* ------------------------------------------------------------------ */
/* Shared construction helpers                                         */
/* ------------------------------------------------------------------ */

function proposal(
  stepId: string,
  title: string,
  summary: string,
  detected: Array<{ label: string; value: string }>,
  operations: GuidedOperation[],
  findings: GuidedFinding[],
  approveLabel: string,
): GuidedProposal {
  const readyCount = operations.filter((operation) => operation.status === "READY").length;
  const reviewCount = operations.filter((operation) => operation.status === "REVIEW").length;
  const blockedCount = operations.filter((operation) => operation.status === "BLOCKED").length;
  return {
    stepId,
    title,
    summary,
    detected,
    operations,
    findings,
    readyCount,
    reviewCount,
    blockedCount,
    approveLabel,
    approvable: Boolean(approveLabel) && readyCount + reviewCount > 0,
    preparedAt: new Date().toISOString(),
  };
}

/**
 * The dossier's existing third party for a planned one, or `null`.
 *
 * Deliberately the same rules as the execution path: identifiers decide, a name
 * may confirm one but never overrule it. Preparation resolving a counterparty
 * differently from execution is how "STE ABC SARL" and "SOCIETE ABC S.A.R.L."
 * become two suppliers, so both sides go through `matchPartyIdentity`.
 */
function findKnownCounterparty(
  counterparties: Array<Record<string, any>>,
  planned: InvoiceDraftPlan["counterparty"],
): Record<string, any> | null {
  const matches = counterparties
    .map((candidate) => {
      const verdicts = [candidate.displayName, candidate.legalName]
        .filter(Boolean)
        .map((name: string) => matchPartyIdentity(
          { name: planned.displayName, ice: planned.ice, taxId: planned.taxId, rc: planned.rc },
          { name, ice: candidate.ice, taxId: candidate.taxId },
        ))
        .sort((left, right) => right.confidence - left.confidence);
      return { candidate, match: verdicts[0] ?? null };
    })
    .filter((item) => item.match?.verdict === "SAME")
    .sort((left, right) => (right.match?.confidence ?? 0) - (left.match?.confidence ?? 0));
  return matches[0]?.candidate ?? null;
}

export function registerWheatGuidedWorkIpc(options: GuidedWorkOptions & { ipcMain: IpcLike }) {
  const service = createWheatGuidedWorkService(options);
  const serialize = options.serialize ?? ((value: any) => value);
  options.ipcMain.handle(WHEAT_GUIDED_CHANNELS.state, async (_event, payload) => serialize(await service.state(payload)));
  options.ipcMain.handle(WHEAT_GUIDED_CHANNELS.prepare, async (_event, payload) => serialize(await service.prepare(payload)));
  options.ipcMain.handle(WHEAT_GUIDED_CHANNELS.approve, async (_event, payload) => serialize(await service.approve(payload)));
  options.ipcMain.handle(WHEAT_GUIDED_CHANNELS.decide, async (_event, payload) => serialize(await service.decide(payload)));
  return service;
}
