/**
 * Wheat's shared pre-submission review layer.
 *
 * Every meaningful dossier mutation passes through here before the domain
 * service that performs it is called. The pipeline is always the same:
 *
 *   1. the person fills a form and presses the primary action;
 *   2. `review()` runs the deterministic domain preflight for that workflow;
 *   3. if a model is genuinely available and privacy permits, it adds a bounded
 *      contextual reading of the same draft;
 *   4. the renderer shows one shared surface and the person decides;
 *   5. the existing risk confirmation happens immediately before execution;
 *   6. the owning domain service runs, re-validating company, version, status
 *      and period inside its own transaction, exactly as it always did.
 *
 * Three rules hold everywhere in this file:
 *
 *  - **The review never mutates.** It reads the dossier and returns an opinion.
 *    A proposed correction travels back to the form as a proposal; applying it
 *    is a click, and only ever on a draft or a form value.
 *  - **The model is never an authority.** It cannot emit a blocker, its
 *    confidence is capped, and a finding whose evidence is not corroborated in
 *    the context it was given is dropped. Deterministic rules block; models
 *    raise questions.
 *  - **Unavailability is stated, never faked.** With no model reachable the
 *    deterministic review still runs and the result says so in words.
 */

import { appendActivityAndAudit } from "./audit13";
import { parseReviewJson } from "./ocrAiReview";
import { isPlausibleIce, matchPartyIdentity, normalizeCompanyName } from "./partyIdentity";
import {
  WHEAT_WORKFLOW_REGISTRY,
  getWheatWorkflow,
  wheatWorkflowCoverage,
  type WheatReviewKind,
  type WheatWorkflowDefinition,
} from "./wheatWorkflowRegistry";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const WHEAT_REVIEW_CHANNELS = {
  run: "wheat:review:run",
  coverage: "wheat:review:coverage",
  /**
   * Who would review, asked before asking for a review.
   *
   * The surface needs a model name to show while it waits. Without one it can
   * only say "please wait", which is what made a slow provider look like a
   * frozen application.
   */
  model: "wheat:review:model",
} as const;

export type WheatReviewSeverity = "INFO" | "WARNING" | "BLOCKER";
export type WheatReviewOutcome = "PASS" | "WARNING" | "ATTENTION_REQUIRED";

export type WheatReviewFinding = {
  /** Stable code, safe to match on in tests and in the interface. */
  code: string;
  severity: WheatReviewSeverity;
  origin: "DETERMINISTIC" | "MODEL";
  /** Plain French, one line. */
  title: string;
  explanation: string;
  /** Form field or entity the finding is about. */
  target: string | null;
  /** What the finding was derived from. */
  evidence: string[];
  currentValue: string | null;
  proposedValue: string | null;
  /** 0–100. `null` for a deterministic rule, which is not a guess. */
  confidence: number | null;
  /** Why it matters, in accounting terms. */
  accountingReason: string;
  /** True only for a reversible draft or form value with a shown before/after. */
  safeAutofix: boolean;
  requiresAcknowledgement: boolean;
};

export type WheatReviewModelRun = {
  ran: boolean;
  status: "LOCAL" | "REMOTE" | "UNAVAILABLE" | "NOT_APPLICABLE" | "DECLINED" | "FAILED" | "NOT_NEEDED";
  provider: string | null;
  modelId: string | null;
  locality: "LOCAL" | "REMOTE" | "NONE";
  /**
   * Honest one-line explanation, shown to the user as-is.
   *
   * Deliberately free of provider and model identifiers. A person saving an
   * invoice is not asking which build of which model answered, and putting
   * "remote:openrouter:google/gemma-4-26b-a4b-it:free" in front of them during
   * ordinary bookkeeping tells them nothing they can act on while implying the
   * accounting depends on it. What does belong here is whether a reading
   * happened and whether the dossier left the machine.
   */
  message: string;
  /**
   * The identifiers themselves, for the places that genuinely need them:
   * settings, diagnostics, and the optional details view on the result. Never
   * part of the normal reading path.
   */
  detail: string | null;
};

export type WheatReviewResult = {
  version: "WHEAT_REVIEW_1";
  workflowId: string;
  workflowLabel: string;
  entity: string;
  classification: WheatWorkflowDefinition["classification"];
  riskLevel: 0 | 1 | 2 | 3;
  outcome: WheatReviewOutcome;
  /** A deterministic blocker: the interface must not call the domain service. */
  blocked: boolean;
  /** "Qu'est-ce qui a été vérifié ?" */
  checked: string[];
  /** "Qu'est-ce qui semble correct ?" */
  confirmed: string[];
  findings: WheatReviewFinding[];
  /** One focused question when Wheat genuinely cannot infer the answer. */
  question: { prompt: string; why: string; whereToFind: string } | null;
  /** "Que dois-je faire ensuite ?" */
  nextAction: string;
  model: WheatReviewModelRun;
  acknowledgementRequired: boolean;
  reviewedAt: string;
};

/**
 * How the caller reaches a model, when one is reachable at all.
 *
 * Supplied by `main.ts`, which owns the provider service and the local model
 * discovery. Returning `null` is the honest "no model" answer and produces an
 * `UNAVAILABLE` review rather than a silent skip.
 */
export type WheatReviewModelChannel = {
  locality: "LOCAL" | "REMOTE";
  provider: string;
  modelId: string;
  run: (request: { system: string; user: string }) => Promise<string>;
};

export type WheatReviewModelResolution =
  | { channel: WheatReviewModelChannel }
  | { channel: null; status: WheatReviewModelRun["status"]; message: string; detail?: string | null };

export type WheatReviewServiceOptions = {
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  /** Resolves the model to use, applying the local-first fallback order. */
  resolveModel?: () => Promise<WheatReviewModelResolution>;
  /**
   * The same choice as `resolveModel`, described without running anything, so
   * the waiting surface can name the model it is waiting for.
   */
  describeModel?: () => Promise<{
    available: boolean;
    locality: "LOCAL" | "REMOTE" | "NONE";
    provider: string | null;
    modelId: string | null;
    selection: "EXPLICIT" | "AUTOMATIC" | "NONE";
    message: string;
  }>;
};

/* ------------------------------------------------------------------ helpers */

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function text(value: unknown, max = 400) {
  return String(value ?? "").trim().slice(0, max);
}

/** Exact centimes from a decimal string, a centime string or a BigInt. */
function cents(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "bigint") return value;
  const raw = String(value).trim().replace(/\s/g, "").replace(",", ".");
  if (/^-?\d+$/.test(raw)) return BigInt(raw);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return sign * (BigInt(match[2]) * 100n + BigInt(fraction));
}

function money(value: bigint | null | undefined) {
  if (value === null || value === undefined) return "—";
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / 100n},${String(magnitude % 100n).padStart(2, "0")} MAD`;
}

function day(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDay(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

type FindingInput = Partial<WheatReviewFinding> & { code: string; title: string; severity: WheatReviewSeverity };

function finding(input: FindingInput): WheatReviewFinding {
  return {
    code: input.code,
    severity: input.severity,
    origin: input.origin ?? "DETERMINISTIC",
    title: input.title,
    explanation: input.explanation ?? input.title,
    target: input.target ?? null,
    evidence: input.evidence ?? [],
    currentValue: input.currentValue ?? null,
    proposedValue: input.proposedValue ?? null,
    confidence: input.confidence ?? null,
    accountingReason: input.accountingReason ?? "",
    safeAutofix: input.safeAutofix ?? false,
    requiresAcknowledgement: input.requiresAcknowledgement ?? input.severity !== "INFO",
  };
}

type ReviewContext = {
  prisma: PrismaLike;
  companyId: string;
  workflow: WheatWorkflowDefinition;
  draft: Record<string, any>;
};

type DeterministicReview = {
  findings: WheatReviewFinding[];
  checked: string[];
  confirmed: string[];
  question?: WheatReviewResult["question"];
  /** Extra context handed to the model, already bounded and company-scoped. */
  modelContext?: Record<string, unknown>;
};

/* --------------------------------------------------------- shared sub-checks */

async function openFiscalYearFor(ctx: ReviewContext, date: Date | null) {
  if (!date) return { year: null as any, locked: false };
  const year = await ctx.prisma.fiscalYear.findFirst({
    where: { companyId: ctx.companyId, startsOn: { lte: date }, endsOn: { gte: date } },
  });
  if (!year) return { year: null as any, locked: false };
  const locked = year.status !== "OPEN" || Boolean(year.lockedTo && new Date(year.lockedTo) >= date);
  return { year, locked };
}

async function periodFindings(ctx: ReviewContext, date: Date | null, label: string) {
  const out: WheatReviewFinding[] = [];
  if (!date) {
    out.push(finding({
      code: "PERIOD.DATE_MISSING", severity: "BLOCKER", target: "date",
      title: `${label} : aucune date exploitable.`,
      explanation: "Wheat range chaque opération dans un exercice ; sans date il n'y a pas d'exercice.",
      accountingReason: "Une écriture sans date ne peut être rattachée ni à un exercice ni à une période de TVA.",
    }));
    return out;
  }
  const { year, locked } = await openFiscalYearFor(ctx, date);
  if (!year) {
    out.push(finding({
      code: "PERIOD.NO_FISCAL_YEAR", severity: "BLOCKER", target: "date",
      title: `Aucun exercice ne couvre le ${isoDay(date)}.`,
      explanation: "Créez l'exercice correspondant, ou corrigez la date de l'opération.",
      currentValue: isoDay(date),
      accountingReason: "Toute écriture appartient à un exercice comptable ouvert ; sans exercice, ni balance ni liasse ne peuvent l'intégrer.",
    }));
    return out;
  }
  if (locked) {
    out.push(finding({
      code: "PERIOD.LOCKED", severity: "BLOCKER", target: "date",
      title: `La période du ${isoDay(date)} est verrouillée.`,
      explanation: year.status !== "OPEN"
        ? `L'exercice ${year.label} est ${year.status === "CLOSED" ? "clôturé" : year.status.toLowerCase()}. Sa réouverture suit le workflow motivé et audité de Wheat.`
        : `L'exercice ${year.label} est verrouillé jusqu'au ${isoDay(new Date(year.lockedTo))}. Déverrouillez la période ou choisissez une date postérieure.`,
      currentValue: isoDay(date),
      accountingReason: "Un verrou de période empêche toute écriture postérieure à un état déjà communiqué ou déclaré.",
    }));
  }
  return out;
}

/**
 * Both sides of a double entry, in exact centimes.
 *
 * A blank amount box is a zero, not an unreadable value: the entry form
 * leaves the unused side of every line empty, and reading that as invalid
 * flagged perfectly ordinary lines as malformed.
 */
function entryTotals(lines: any[]) {
  let debit = 0n;
  let credit = 0n;
  const malformed: number[] = [];
  const side = (value: unknown) => (value === undefined || value === null || String(value).trim() === "" ? 0n : cents(value));
  lines.forEach((line, index) => {
    const d = side(line?.debitCents ?? line?.debit);
    const c = side(line?.creditCents ?? line?.credit);
    if (d === null || c === null) { malformed.push(index + 1); return; }
    if (d !== 0n && c !== 0n) malformed.push(index + 1);
    debit += d;
    credit += c;
  });
  return { debit, credit, malformed };
}

/* ---------------------------------------------------- deterministic reviewers */

const REVIEWERS: Record<WheatReviewKind, (ctx: ReviewContext) => Promise<DeterministicReview>> = {
  async COMPANY_IDENTITY(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const draft = ctx.draft;
    const name = text(draft.name);
    const ice = text(draft.ice, 40);
    const vatFrequency = text(draft.vatFrequency, 20).toUpperCase();

    if (!name) {
      findings.push(finding({ code: "COMPANY.NAME_MISSING", severity: "BLOCKER", target: "name", title: "La raison sociale est obligatoire.", explanation: "Elle figure sur chaque facture et sur la liasse.", accountingReason: "L'identité du redevable doit être portée sur toute pièce émise." }));
    } else confirmed.push(`Raison sociale renseignée : ${name}.`);

    if (!text(draft.city, 120)) {
      findings.push(finding({ code: "COMPANY.CITY_MISSING", severity: "WARNING", target: "city", title: "La ville du siège n'est pas renseignée.", explanation: "Elle est attendue sur les factures marocaines.", accountingReason: "Les mentions obligatoires d'une facture incluent l'adresse du siège." }));
    }

    if (!ice) {
      findings.push(finding({
        code: "COMPANY.ICE_MISSING", severity: "WARNING", target: "ice",
        title: "L'ICE n'est pas renseigné.",
        explanation: "Wheat n'invente jamais un identifiant légal. Vous pourrez le saisir plus tard, mais aucune facture conforme ne peut être émise sans lui.",
        accountingReason: "L'Identifiant Commun de l'Entreprise est une mention obligatoire des factures marocaines.",
      }));
    } else if (!isPlausibleIce(ice)) {
      findings.push(finding({
        code: "COMPANY.ICE_FORMAT", severity: "BLOCKER", target: "ice",
        title: "L'ICE saisi n'a pas le format attendu.",
        explanation: "Un ICE marocain est une suite de 15 chiffres. Vérifiez-le sur le modèle J ou l'attestation fiscale plutôt que de le corriger de mémoire.",
        currentValue: ice,
        accountingReason: "Un ICE erroné rend les factures émises non conformes et fausse le rapprochement des tiers.",
      }));
    } else confirmed.push("Format de l'ICE conforme (15 chiffres).");

    if (vatFrequency && !["MONTHLY", "QUARTERLY"].includes(vatFrequency)) {
      findings.push(finding({ code: "COMPANY.VAT_FREQUENCY_INVALID", severity: "BLOCKER", target: "vatFrequency", title: "Le rythme de TVA est invalide.", currentValue: vatFrequency, explanation: "Wheat gère la déclaration mensuelle et la déclaration trimestrielle.", accountingReason: "Le rythme détermine le découpage des périodes de TVA et donc les dossiers de travail produits." }));
    } else if (vatFrequency) confirmed.push(`Rythme de TVA retenu : ${vatFrequency === "MONTHLY" ? "mensuel" : "trimestriel"}.`);

    const start = day(draft.fiscalYearStart);
    const end = day(draft.fiscalYearEnd);
    if (start && end && start >= end) {
      findings.push(finding({ code: "COMPANY.FISCAL_RANGE", severity: "BLOCKER", target: "fiscalYearEnd", title: "L'exercice se termine avant de commencer.", currentValue: `${isoDay(start)} → ${isoDay(end)}`, explanation: "Vérifiez les deux dates de l'exercice.", accountingReason: "Un exercice comptable est un intervalle non vide ; toute écriture s'y rattache par sa date." }));
    }

    const question = vatFrequency ? null : {
      prompt: "La société déclare-t-elle la TVA tous les mois ou tous les trimestres ?",
      why: "Le rythme découpe les périodes de TVA ; Wheat ne peut pas le déduire des pièces du dossier.",
      whereToFind: "Il figure sur l'attestation fiscale de la société ou sur la dernière déclaration déposée.",
    };

    return {
      findings,
      checked: ["Raison sociale, ville et forme juridique", "Format de l'ICE", "Rythme de déclaration de TVA", "Cohérence des dates d'exercice"],
      confirmed,
      question,
      modelContext: { name, city: text(draft.city, 120), legalForm: text(draft.legalForm, 80), vatFrequency },
    };
  },

  async FISCAL_YEAR(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const start = day(ctx.draft.startsOn);
    const end = day(ctx.draft.endsOn);
    if (!start || !end) {
      findings.push(finding({ code: "FISCAL_YEAR.DATES_MISSING", severity: "BLOCKER", target: "startsOn", title: "Les deux bornes de l'exercice sont obligatoires.", explanation: "Un exercice est défini par sa date d'ouverture et sa date de clôture.", accountingReason: "Sans bornes, aucune écriture ne peut être rattachée à cet exercice." }));
    } else {
      if (start >= end) {
        findings.push(finding({ code: "FISCAL_YEAR.INVERTED", severity: "BLOCKER", target: "endsOn", title: "La clôture précède l'ouverture.", currentValue: `${isoDay(start)} → ${isoDay(end)}`, explanation: "Inversez les deux dates.", accountingReason: "Un exercice comptable est un intervalle chronologique." }));
      } else {
        const months = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
        if (months > 24) {
          findings.push(finding({ code: "FISCAL_YEAR.TOO_LONG", severity: "WARNING", target: "endsOn", title: "L'exercice dépasse 24 mois.", currentValue: `${Math.round(months)} mois`, explanation: "Un premier exercice peut être long, mais vérifiez que ces bornes sont bien celles des statuts.", accountingReason: "La durée de l'exercice détermine la période couverte par la liasse fiscale." }));
        } else confirmed.push(`Durée de l'exercice : environ ${Math.round(months)} mois.`);

        const overlapping = await ctx.prisma.fiscalYear.findMany({
          where: { companyId: ctx.companyId, ...(ctx.draft.id ? { id: { not: String(ctx.draft.id) } } : {}), startsOn: { lte: end }, endsOn: { gte: start } },
          select: { id: true, label: true, startsOn: true, endsOn: true },
          take: 5,
        });
        if (overlapping.length) {
          findings.push(finding({
            code: "FISCAL_YEAR.OVERLAP", severity: "BLOCKER", target: "startsOn",
            title: "Cet exercice chevauche un exercice existant.",
            explanation: `Chevauchement avec ${overlapping.map((item: any) => `${item.label} (${isoDay(new Date(item.startsOn))} → ${isoDay(new Date(item.endsOn))})`).join(", ")}.`,
            evidence: overlapping.map((item: any) => `${item.label} : ${isoDay(new Date(item.startsOn))} → ${isoDay(new Date(item.endsOn))}`),
            accountingReason: "Deux exercices qui se recouvrent rendraient l'imputation d'une écriture ambiguë.",
          }));
        } else confirmed.push("Aucun chevauchement avec les exercices existants.");
      }
    }
    return { findings, checked: ["Ordre et durée des bornes", "Chevauchement avec les exercices déjà créés"], confirmed };
  },

  async PERIOD_LOCK(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const lockedTo = day(ctx.draft.lockedTo);
    const fiscalYearId = text(ctx.draft.fiscalYearId, 200);
    const year = fiscalYearId ? await ctx.prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId: ctx.companyId } }) : null;
    if (fiscalYearId && !year) {
      findings.push(finding({ code: "PERIOD.YEAR_MISSING", severity: "BLOCKER", target: "fiscalYearId", title: "L'exercice visé n'existe pas dans ce dossier.", explanation: "Rechargez l'écran des exercices.", accountingReason: "Le verrou de période appartient à un exercice précis." }));
    }
    if (year && lockedTo) {
      if (lockedTo < new Date(year.startsOn) || lockedTo > new Date(year.endsOn)) {
        findings.push(finding({ code: "PERIOD.LOCK_OUTSIDE", severity: "BLOCKER", target: "lockedTo", title: "La date de verrou sort de l'exercice.", currentValue: isoDay(lockedTo), explanation: `L'exercice ${year.label} va du ${isoDay(new Date(year.startsOn))} au ${isoDay(new Date(year.endsOn))}.`, accountingReason: "Un verrou ne peut protéger qu'une portion de son propre exercice." }));
      }
      const drafts = await ctx.prisma.entry.count({ where: { companyId: ctx.companyId, status: "DRAFT", date: { lte: lockedTo } } });
      if (drafts > 0) {
        findings.push(finding({
          code: "PERIOD.DRAFTS_BEFORE_LOCK", severity: "WARNING", target: "lockedTo",
          title: `${drafts} brouillon(s) sont datés avant le verrou.`,
          explanation: "Ils ne pourront plus être comptabilisés à leur date une fois la période verrouillée.",
          evidence: [`${drafts} écriture(s) au statut DRAFT au ${isoDay(lockedTo)} ou avant`],
          accountingReason: "Verrouiller une période fige les écritures qu'elle contient ; un brouillon oublié devient inutilisable à sa date.",
        }));
      } else confirmed.push("Aucun brouillon antérieur au verrou.");
    }
    return { findings, checked: ["Appartenance de la date de verrou à l'exercice", "Brouillons antérieurs au verrou"], confirmed };
  },

  async ACCOUNT(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const code = text(ctx.draft.code, 20).toUpperCase();
    const id = text(ctx.draft.id, 200);
    if (code && !/^[0-9][0-9A-Z._-]{1,19}$/.test(code)) {
      findings.push(finding({ code: "ACCOUNT.CODE_FORMAT", severity: "BLOCKER", target: "code", title: "Le code de compte n'a pas un format PCGE valide.", currentValue: code, explanation: "Un compte commence par le chiffre de sa classe.", accountingReason: "La classe du compte détermine sa place au bilan ou au CPC." }));
    }
    if (code) {
      const existing = await ctx.prisma.account.findFirst({ where: { companyId: ctx.companyId, code, ...(id ? { id: { not: id } } : {}) }, select: { id: true, label: true, isStandard: true } });
      if (existing) {
        findings.push(finding({ code: "ACCOUNT.DUPLICATE_CODE", severity: "BLOCKER", target: "code", title: `Le compte ${code} existe déjà.`, currentValue: `${code} — ${existing.label}`, explanation: "Choisissez une autre subdivision, ou modifiez le compte existant.", accountingReason: "Deux comptes de même code rendraient la balance illisible." }));
      } else confirmed.push(`Le code ${code} est libre dans ce plan.`);
    }
    if (id) {
      const current = await ctx.prisma.account.findFirst({ where: { id, companyId: ctx.companyId }, select: { isStandard: true, code: true } });
      if (current?.isStandard) {
        findings.push(finding({ code: "ACCOUNT.STANDARD_IMMUTABLE", severity: "BLOCKER", target: "code", title: `${current.code} est un compte PCGE officiel.`, explanation: "Les comptes du plan officiel ne sont pas modifiables : créez une subdivision sous ce compte.", accountingReason: "Le plan comptable général marocain est normalisé ; le personnaliser rendrait les états incomparables." }));
      }
    }
    const parentCode = text(ctx.draft.parentCode, 20);
    if (parentCode) {
      const parent = await ctx.prisma.account.findFirst({ where: { companyId: ctx.companyId, code: parentCode }, select: { id: true, label: true } });
      if (!parent) {
        findings.push(finding({ code: "ACCOUNT.PARENT_MISSING", severity: "BLOCKER", target: "parentCode", title: `Le compte parent ${parentCode} n'existe pas.`, explanation: "Choisissez un compte du plan de ce dossier.", accountingReason: "Une subdivision hérite de la nature de son compte parent." }));
      } else confirmed.push(`Compte parent trouvé : ${parentCode} — ${parent.label}.`);
    }
    return { findings, checked: ["Format et unicité du code", "Immutabilité des comptes PCGE officiels", "Existence du compte parent"], confirmed };
  },

  async JOURNAL(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const code = text(ctx.draft.code, 20).toUpperCase();
    const id = text(ctx.draft.id, 200);
    if (!code) {
      findings.push(finding({ code: "JOURNAL.CODE_MISSING", severity: "BLOCKER", target: "code", title: "Le code du journal est obligatoire.", explanation: "Il apparaît sur chaque numéro de pièce.", accountingReason: "Le journal identifie la nature de l'opération dans le livre-journal." }));
    } else {
      const existing = await ctx.prisma.journal.findFirst({ where: { companyId: ctx.companyId, code, ...(id ? { id: { not: id } } : {}) }, select: { id: true, label: true } });
      if (existing) {
        findings.push(finding({ code: "JOURNAL.DUPLICATE_CODE", severity: "BLOCKER", target: "code", title: `Le journal ${code} existe déjà.`, currentValue: `${code} — ${existing.label}`, explanation: "Modifiez le journal existant plutôt que d'en créer un second.", accountingReason: "Deux journaux de même code partageraient une numérotation de pièces." }));
      } else confirmed.push(`Le code de journal ${code} est libre.`);
    }
    const pattern = text(ctx.draft.piecePattern, 80);
    if (pattern && !pattern.includes("{sequence}")) {
      findings.push(finding({ code: "JOURNAL.PATTERN_NO_SEQUENCE", severity: "BLOCKER", target: "piecePattern", title: "Le modèle de numéro ne contient pas {sequence}.", currentValue: pattern, explanation: "Sans compteur, toutes les pièces du journal porteraient le même numéro.", accountingReason: "La numérotation des pièces doit être continue et sans doublon." }));
    }
    return { findings, checked: ["Unicité du code de journal", "Modèle de numérotation des pièces"], confirmed };
  },

  ENTRY_DRAFT: reviewEntryPayload,

  /**
   * Deleting a draft asks one question — is it still a draft, and is
   * anything hanging off it? The arithmetic of a draft about to be thrown
   * away is nobody's concern.
   */
  async DRAFT_DELETION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.entryId ?? ctx.draft.paymentId ?? ctx.draft.invoiceId ?? ctx.draft.id, 200);
    const model = ctx.workflow.entity === "Entry" ? "entry" : ctx.workflow.entity === "Invoice" ? "invoice" : "payment";
    const record = id ? await ctx.prisma[model].findFirst({ where: { id, companyId: ctx.companyId } }) : null;
    if (!record) {
      findings.push(finding({ code: "DRAFT.NOT_FOUND", severity: "BLOCKER", target: "id", title: "Cet enregistrement n'appartient pas au dossier actif.", explanation: "Rechargez l'écran.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société de l'enregistrement"], confirmed };
    }
    const status = String(record.status ?? record.lifecycleStatus ?? "").toUpperCase();
    if (status !== "DRAFT") {
      findings.push(finding({
        code: "DRAFT.NOT_DRAFT", severity: "BLOCKER", target: "status", currentValue: status,
        title: "Cet enregistrement n'est plus un brouillon.",
        explanation: "Une pièce comptabilisée se corrige par une extourne, un avoir ou une annulation motivée — jamais par une suppression.",
        accountingReason: "L'historique comptabilisé est en ajout seul : supprimer une pièce effacerait la piste d'audit qui la justifie.",
      }));
    } else confirmed.push("L'enregistrement est encore au brouillon et peut être supprimé.");
    if (model !== "entry") {
      const allocations = await ctx.prisma.paymentAllocation.count({
        where: { status: "ACTIVE", ...(model === "invoice" ? { invoiceId: record.id } : { paymentId: record.id }) },
      });
      if (allocations > 0) {
        findings.push(finding({ code: "DRAFT.HAS_ALLOCATIONS", severity: "BLOCKER", target: "allocations", title: `${allocations} imputation(s) référencent encore cet enregistrement.`, explanation: "Annulez les imputations avant de supprimer le brouillon.", accountingReason: "Une imputation orpheline laisserait une facture ou un règlement soldé sans contrepartie." }));
      } else confirmed.push("Aucune imputation ne référence cet enregistrement.");
    }
    return { findings, checked: ["Portée société", "Statut brouillon", "Imputations liées"], confirmed };
  },
  async ENTRY_POST(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const entryId = text(ctx.draft.entryId ?? ctx.draft.id, 200);
    const entry = entryId ? await ctx.prisma.entry.findFirst({ where: { id: entryId, companyId: ctx.companyId }, include: { lines: true, journal: true } }) : null;
    if (!entry) {
      findings.push(finding({ code: "ENTRY.NOT_FOUND", severity: "BLOCKER", target: "entryId", title: "Cette écriture n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des écritures.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence de l'écriture"], confirmed };
    }
    if (entry.status !== "DRAFT") {
      findings.push(finding({
        code: "ENTRY.NOT_DRAFT", severity: "BLOCKER", target: "status",
        title: `L'écriture ${entry.pieceNumber} est déjà ${entry.status === "POSTED" ? "comptabilisée" : entry.status.toLowerCase()}.`,
        explanation: "Une écriture comptabilisée se corrige par une extourne, jamais par une nouvelle comptabilisation.",
        currentValue: entry.status,
        accountingReason: "L'historique comptabilisé est en ajout seul : la correction passe par une écriture opposée liée.",
      }));
    } else confirmed.push(`L'écriture ${entry.pieceNumber} est encore au brouillon.`);

    const totals = entryTotals(entry.lines ?? []);
    if (totals.debit !== totals.credit) {
      findings.push(finding({
        code: "ENTRY.UNBALANCED", severity: "BLOCKER", target: "lines",
        title: "L'écriture n'est pas équilibrée.",
        explanation: `Débit ${money(totals.debit)} contre crédit ${money(totals.credit)} : écart de ${money(totals.debit - totals.credit)}.`,
        currentValue: `${money(totals.debit)} / ${money(totals.credit)}`,
        accountingReason: "En partie double, le total des débits d'une écriture égale le total de ses crédits.",
      }));
    } else confirmed.push(`Écriture équilibrée : ${money(totals.debit)} au débit comme au crédit.`);

    findings.push(...await periodFindings(ctx, new Date(entry.date), "Comptabilisation"));
    if (entry.journal?.active === false) {
      findings.push(finding({ code: "ENTRY.JOURNAL_ARCHIVED", severity: "BLOCKER", target: "journalId", title: `Le journal ${entry.journal.code} est archivé.`, explanation: "Restaurez le journal ou déplacez l'écriture.", accountingReason: "Un journal archivé n'accepte plus de nouvelles pièces." }));
    }
    return {
      findings,
      checked: ["Statut de l'écriture", "Équilibre débit/crédit en centimes exacts", "Exercice et verrou de période", "État du journal"],
      confirmed,
      modelContext: { pieceNumber: entry.pieceNumber, label: entry.label, date: isoDay(new Date(entry.date)), journal: entry.journal?.code, lines: (entry.lines ?? []).map((line: any) => ({ account: line.accountCodeSnapshot, label: line.label, debit: money(BigInt(line.debitCents ?? 0n)), credit: money(BigInt(line.creditCents ?? 0n)) })) },
    };
  },

  async ENTRY_REVERSE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const entryId = text(ctx.draft.entryId ?? ctx.draft.id, 200);
    const entry = entryId ? await ctx.prisma.entry.findFirst({ where: { id: entryId, companyId: ctx.companyId }, include: { reversals: { select: { id: true, pieceNumber: true } } } }) : null;
    if (!entry) {
      findings.push(finding({ code: "ENTRY.NOT_FOUND", severity: "BLOCKER", target: "entryId", title: "Cette écriture n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des écritures.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence de l'écriture"], confirmed };
    }
    if (entry.status !== "POSTED") {
      findings.push(finding({ code: "ENTRY.REVERSE_NOT_POSTED", severity: "BLOCKER", target: "status", currentValue: entry.status, title: "Seule une écriture comptabilisée peut être extournée.", explanation: "Un brouillon se modifie ou se supprime directement.", accountingReason: "L'extourne annule un effet comptable existant ; un brouillon n'en a aucun." }));
    }
    if (entry.reversals?.length) {
      findings.push(finding({ code: "ENTRY.ALREADY_REVERSED", severity: "WARNING", target: "entryId", title: "Cette écriture a déjà une extourne.", evidence: entry.reversals.map((item: any) => `Extourne ${item.pieceNumber}`), explanation: "Une seconde extourne recréerait l'effet initial.", accountingReason: "Extourner deux fois revient à réenregistrer l'opération d'origine." }));
    } else confirmed.push("Aucune extourne n'existe encore pour cette pièce.");
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? new Date(), "Extourne"));
    return { findings, checked: ["Statut comptabilisé", "Extourne déjà existante", "Verrou de période à la date d'extourne"], confirmed };
  },

  INVOICE_DRAFT: reviewInvoicePayload,
  CREDIT_NOTE: reviewInvoicePayload,

  async INVOICE_POST(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.invoiceId ?? ctx.draft.id, 200);
    const invoice = id ? await ctx.prisma.invoice.findFirst({ where: { id, companyId: ctx.companyId }, include: { lines: true } }) : null;
    if (!invoice) {
      findings.push(finding({ code: "INVOICE.NOT_FOUND", severity: "BLOCKER", target: "id", title: "Cette facture n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des factures.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence de la facture"], confirmed };
    }
    if (invoice.lifecycleStatus !== "DRAFT") {
      findings.push(finding({
        code: "INVOICE.NOT_DRAFT", severity: "BLOCKER", target: "lifecycleStatus", currentValue: invoice.lifecycleStatus,
        title: "Cette facture n'est plus un brouillon.",
        explanation: "Une facture comptabilisée se corrige par un avoir ou par son annulation motivée, jamais par une réécriture.",
        accountingReason: "La facture comptabilisée a déjà créé la créance ou la dette et la TVA correspondante.",
      }));
    } else confirmed.push("La facture est encore au brouillon.");

    const ht = BigInt(invoice.htCents ?? 0n);
    const vat = BigInt(invoice.vatCents ?? 0n);
    const ttc = BigInt(invoice.ttcCents ?? 0n);
    if (ht + vat !== ttc) {
      findings.push(finding({
        code: "INVOICE.TOTALS_INCONSISTENT", severity: "BLOCKER", target: "ttcCents",
        title: "HT + TVA ne fait pas le TTC.",
        explanation: `${money(ht)} + ${money(vat)} = ${money(ht + vat)}, alors que le TTC enregistré est ${money(ttc)}.`,
        currentValue: money(ttc), proposedValue: money(ht + vat),
        accountingReason: "La vente enregistre la créance client au TTC, le produit au HT et la TVA facturée séparément : les trois doivent se recouper au centime.",
      }));
    } else confirmed.push(`Contrôle HT + TVA = TTC vérifié : ${money(ht)} + ${money(vat)} = ${money(ttc)}.`);

    if (!invoice.counterpartyId) {
      findings.push(finding({ code: "INVOICE.NO_COUNTERPARTY", severity: "BLOCKER", target: "counterpartyId", title: "Aucun tiers n'est rattaché à la facture.", explanation: "Le compte collectif client ou fournisseur ne peut pas être déterminé sans tiers.", accountingReason: "La créance ou la dette est portée par un compte auxiliaire rattaché au tiers." }));
    }
    findings.push(...await periodFindings(ctx, new Date(invoice.invoiceDate), "Comptabilisation de la facture"));
    return {
      findings,
      checked: ["Statut brouillon", "Contrôle HT + TVA = TTC en centimes exacts", "Tiers rattaché", "Exercice et verrou de période"],
      confirmed,
      modelContext: { kind: invoice.kind, invoiceNo: invoice.invoiceNo, date: isoDay(new Date(invoice.invoiceDate)), ht: money(ht), vat: money(vat), ttc: money(ttc), counterparty: invoice.counterparty, lineCount: invoice.lines?.length ?? 0 },
    };
  },

  async INVOICE_VOID(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.invoiceId ?? ctx.draft.id, 200);
    const invoice = id ? await ctx.prisma.invoice.findFirst({ where: { id, companyId: ctx.companyId }, include: { allocations: { where: { status: "ACTIVE" } } } }) : null;
    if (!invoice) {
      findings.push(finding({ code: "INVOICE.NOT_FOUND", severity: "BLOCKER", target: "id", title: "Cette facture n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des factures.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence de la facture"], confirmed };
    }
    if (!text(ctx.draft.reason, 1000)) {
      findings.push(finding({ code: "INVOICE.VOID_REASON_MISSING", severity: "BLOCKER", target: "reason", title: "Un motif d'annulation est obligatoire.", explanation: "Il est conservé dans la chaîne d'audit et lu par le réviseur.", accountingReason: "Une contrepassation non motivée est indéfendable lors d'un contrôle." }));
    } else confirmed.push("Motif d'annulation renseigné.");
    if (invoice.allocations?.length) {
      findings.push(finding({
        code: "INVOICE.ACTIVE_ALLOCATIONS", severity: "WARNING", target: "allocations",
        title: `${invoice.allocations.length} imputation(s) de règlement sont encore actives.`,
        explanation: "Annulez d'abord ces imputations : sinon un règlement resterait rattaché à une facture annulée.",
        evidence: invoice.allocations.map((item: any) => `Imputation de ${money(BigInt(item.amountCents ?? 0n))}`),
        accountingReason: "Une facture et son règlement sont deux événements distincts ; annuler l'un laisse l'autre à traiter.",
      }));
    } else confirmed.push("Aucune imputation active sur cette facture.");
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? new Date(), "Contrepassation"));
    return { findings, checked: ["Motif d'annulation", "Imputations de règlement actives", "Verrou de période à la date de contrepassation"], confirmed };
  },

  PAYMENT_DRAFT: reviewPaymentPayload,
  async PAYMENT_POST(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.paymentId ?? ctx.draft.id, 200);
    const payment = id ? await ctx.prisma.payment.findFirst({ where: { id, companyId: ctx.companyId } }) : null;
    if (!payment) {
      findings.push(finding({ code: "PAYMENT.NOT_FOUND", severity: "BLOCKER", target: "id", title: "Ce règlement n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des règlements.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence du règlement"], confirmed };
    }
    if (payment.lifecycleStatus !== "DRAFT") {
      findings.push(finding({ code: "PAYMENT.NOT_DRAFT", severity: "BLOCKER", target: "lifecycleStatus", currentValue: payment.lifecycleStatus, title: "Ce règlement n'est plus un brouillon.", explanation: "Un règlement comptabilisé s'annule par contrepassation.", accountingReason: "Le règlement comptabilisé a déjà mouvementé la trésorerie et le compte de tiers." }));
    } else confirmed.push("Le règlement est encore au brouillon.");
    if (!payment.settlementAccountId && !payment.bankAccountId) {
      findings.push(finding({ code: "PAYMENT.NO_SETTLEMENT", severity: "BLOCKER", target: "settlementAccountId", title: "Aucun compte de trésorerie n'est associé.", explanation: "Indiquez la banque ou la caisse par laquelle le règlement transite.", accountingReason: "La contrepartie d'un encaissement est un compte de trésorerie ; sans lui l'écriture ne peut être équilibrée." }));
    } else confirmed.push("Compte de trésorerie renseigné.");
    findings.push(...await periodFindings(ctx, new Date(payment.paymentDate), "Comptabilisation du règlement"));
    return { findings, checked: ["Statut brouillon", "Compte de trésorerie", "Exercice et verrou de période"], confirmed };
  },

  async PAYMENT_ALLOCATE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const allocationId = text(ctx.draft.allocationId, 200);
    if (allocationId) {
      const allocation = await ctx.prisma.paymentAllocation.findFirst({ where: { id: allocationId, payment: { companyId: ctx.companyId } }, include: { payment: true, invoice: true } });
      if (!allocation) {
        findings.push(finding({ code: "ALLOCATION.NOT_FOUND", severity: "BLOCKER", target: "allocationId", title: "Cette imputation n'existe pas dans le dossier actif.", explanation: "Rechargez le règlement.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      } else {
        if (allocation.status !== "ACTIVE") {
          findings.push(finding({ code: "ALLOCATION.NOT_ACTIVE", severity: "BLOCKER", target: "allocationId", currentValue: allocation.status, title: "Cette imputation est déjà annulée.", explanation: "L'historique conserve l'imputation d'origine et son annulation.", accountingReason: "Les imputations sont en ajout seul : une annulation est un nouvel enregistrement lié." }));
        } else confirmed.push(`Imputation active de ${money(BigInt(allocation.amountCents ?? 0n))} sur ${allocation.invoice?.invoiceNo ?? "la facture"}.`);
        if (!text(ctx.draft.reason, 1000)) {
          findings.push(finding({ code: "ALLOCATION.REASON_MISSING", severity: "BLOCKER", target: "reason", title: "Un motif est obligatoire pour annuler une imputation.", explanation: "Il est conservé dans l'audit.", accountingReason: "Le lettrage d'une facture est une affirmation comptable : la défaire doit être justifié." }));
        }
      }
      return { findings, checked: ["Statut de l'imputation", "Motif d'annulation"], confirmed };
    }

    const paymentId = text(ctx.draft.paymentId, 200);
    const invoiceId = text(ctx.draft.invoiceId, 200);
    const amount = cents(ctx.draft.amountCents ?? ctx.draft.amount);
    const [payment, invoice] = await Promise.all([
      paymentId ? ctx.prisma.payment.findFirst({ where: { id: paymentId, companyId: ctx.companyId }, include: { allocations: { where: { status: "ACTIVE" } } } }) : null,
      invoiceId ? ctx.prisma.invoice.findFirst({ where: { id: invoiceId, companyId: ctx.companyId }, include: { allocations: { where: { status: "ACTIVE" } } } }) : null,
    ]);
    if (!payment) findings.push(finding({ code: "PAYMENT.NOT_FOUND", severity: "BLOCKER", target: "paymentId", title: "Ce règlement n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des règlements.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
    if (!invoice) findings.push(finding({ code: "INVOICE.NOT_FOUND", severity: "BLOCKER", target: "invoiceId", title: "Cette facture n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des factures.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
    if (amount === null || amount <= 0n) {
      findings.push(finding({ code: "ALLOCATION.AMOUNT_INVALID", severity: "BLOCKER", target: "amountCents", title: "Le montant imputé doit être strictement positif.", currentValue: String(ctx.draft.amountCents ?? ctx.draft.amount ?? ""), explanation: "Saisissez un montant en dirhams avec au plus deux décimales.", accountingReason: "Une imputation nulle ou négative ne solde rien et fausserait le lettrage." }));
    }

    if (payment && invoice && amount !== null && amount > 0n) {
      const allocated = (payment.allocations ?? []).reduce((total: bigint, item: any) => total + BigInt(item.amountCents ?? 0n), 0n);
      const unallocated = BigInt(payment.amountCents ?? 0n) - allocated;
      const settled = (invoice.allocations ?? []).reduce((total: bigint, item: any) => total + BigInt(item.amountCents ?? 0n), 0n);
      const remaining = BigInt(invoice.ttcCents ?? 0n) - settled;

      if (amount > unallocated) {
        findings.push(finding({
          code: "ALLOCATION.OVER_PAYMENT", severity: "BLOCKER", target: "amountCents",
          title: "Le montant dépasse le disponible du règlement.",
          explanation: `Ce règlement de ${money(BigInt(payment.amountCents ?? 0n))} a déjà ${money(allocated)} d'imputé : il reste ${money(unallocated)}.`,
          currentValue: money(amount), proposedValue: money(unallocated),
          evidence: [`Règlement ${money(BigInt(payment.amountCents ?? 0n))}`, `Déjà imputé ${money(allocated)}`],
          accountingReason: "Un règlement ne peut solder plus que son propre montant encaissé ou décaissé.",
        }));
      }
      if (amount > remaining) {
        findings.push(finding({
          code: "ALLOCATION.OVER_INVOICE", severity: "BLOCKER", target: "amountCents",
          title: "Le montant dépasse le reste dû de la facture.",
          explanation: `La facture ${invoice.invoiceNo} de ${money(BigInt(invoice.ttcCents ?? 0n))} a un reste dû de ${money(remaining)}.`,
          currentValue: money(amount), proposedValue: money(remaining),
          evidence: [`Facture ${money(BigInt(invoice.ttcCents ?? 0n))}`, `Déjà réglé ${money(settled)}`],
          accountingReason: "Le lettrage ne peut solder plus que la créance ou la dette qui existe.",
        }));
      }
      if (amount <= unallocated && amount <= remaining) {
        confirmed.push(`Montant compatible : ${money(amount)} sur ${money(unallocated)} disponibles et ${money(remaining)} restant dus.`);
      }
      if (payment.counterpartyId && invoice.counterpartyId && payment.counterpartyId !== invoice.counterpartyId) {
        findings.push(finding({
          code: "ALLOCATION.COUNTERPARTY_MISMATCH", severity: "BLOCKER", target: "invoiceId",
          title: "Le règlement et la facture ne concernent pas le même tiers.",
          explanation: "Imputer un encaissement d'un client sur la facture d'un autre fausserait les deux comptes auxiliaires.",
          accountingReason: "Le lettrage rapproche une créance et son règlement à l'intérieur d'un même compte de tiers.",
        }));
      }
      if (payment.currency !== invoice.currency) {
        findings.push(finding({ code: "ALLOCATION.CURRENCY_MISMATCH", severity: "BLOCKER", target: "amountCents", title: "Le règlement et la facture n'ont pas la même devise.", currentValue: `${payment.currency} / ${invoice.currency}`, explanation: "Wheat n'applique aucun cours de change implicite.", accountingReason: "Solder une créance dans une autre devise créerait un écart de change non enregistré." }));
      }
      if (invoice.lifecycleStatus === "DRAFT") {
        findings.push(finding({ code: "ALLOCATION.INVOICE_DRAFT", severity: "BLOCKER", target: "invoiceId", currentValue: invoice.lifecycleStatus, title: "La facture est encore un brouillon.", explanation: "Comptabilisez-la d'abord : un brouillon ne porte aucune créance à solder.", accountingReason: "Le règlement solde une créance née de la comptabilisation de la facture." }));
      }
      if (payment.lifecycleStatus === "DRAFT") {
        findings.push(finding({ code: "ALLOCATION.PAYMENT_DRAFT", severity: "WARNING", target: "paymentId", currentValue: payment.lifecycleStatus, title: "Le règlement est encore un brouillon.", explanation: "L'imputation deviendra effective à sa comptabilisation.", accountingReason: "Un règlement brouillon n'a pas encore mouvementé la trésorerie." }));
      }
    }
    return {
      findings,
      checked: ["Existence et portée société du règlement et de la facture", "Solde disponible du règlement", "Reste dû de la facture", "Tiers et devise identiques", "Statut comptabilisé"],
      confirmed,
      modelContext: payment && invoice ? { paymentAmount: money(BigInt(payment.amountCents ?? 0n)), invoiceNo: invoice.invoiceNo, invoiceTtc: money(BigInt(invoice.ttcCents ?? 0n)), requested: money(amount ?? 0n) } : {},
    };
  },

  async PAYMENT_VOID(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.paymentId ?? ctx.draft.id, 200);
    const payment = id ? await ctx.prisma.payment.findFirst({ where: { id, companyId: ctx.companyId }, include: { allocations: { where: { status: "ACTIVE" } } } }) : null;
    if (!payment) {
      findings.push(finding({ code: "PAYMENT.NOT_FOUND", severity: "BLOCKER", target: "id", title: "Ce règlement n'existe pas dans le dossier actif.", explanation: "Rechargez la liste des règlements.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Existence du règlement"], confirmed };
    }
    if (payment.lifecycleStatus !== "POSTED") {
      findings.push(finding({ code: "PAYMENT.VOID_NOT_POSTED", severity: "BLOCKER", target: "lifecycleStatus", currentValue: payment.lifecycleStatus, title: "Seul un règlement comptabilisé peut être annulé.", explanation: "Un brouillon se supprime.", accountingReason: "L'annulation contrepasse un effet comptable existant." }));
    }
    if (!text(ctx.draft.reason, 1000)) {
      findings.push(finding({ code: "PAYMENT.VOID_REASON_MISSING", severity: "BLOCKER", target: "reason", title: "Un motif d'annulation est obligatoire.", explanation: "Il est conservé dans la chaîne d'audit.", accountingReason: "Une contrepassation non motivée est indéfendable lors d'un contrôle." }));
    } else confirmed.push("Motif d'annulation renseigné.");
    if (payment.allocations?.length) {
      findings.push(finding({
        code: "PAYMENT.ACTIVE_ALLOCATIONS", severity: "WARNING", target: "allocations",
        title: `${payment.allocations.length} imputation(s) sont encore actives.`,
        explanation: "Annulez-les d'abord, sinon des factures resteraient marquées comme réglées par un règlement annulé.",
        accountingReason: "Le lettrage survit à l'annulation s'il n'est pas défait, et les factures concernées paraîtraient soldées à tort.",
      }));
    }
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? new Date(), "Contrepassation"));
    return { findings, checked: ["Statut comptabilisé", "Motif d'annulation", "Imputations actives", "Verrou de période"], confirmed };
  },

  async COUNTERPARTY(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const displayName = text(ctx.draft.displayName, 180);
    const ice = text(ctx.draft.ice, 40);
    const id = text(ctx.draft.id, 200);
    if (!displayName) {
      findings.push(finding({ code: "COUNTERPARTY.NAME_MISSING", severity: "BLOCKER", target: "displayName", title: "Le nom du tiers est obligatoire.", explanation: "Il identifie le compte auxiliaire.", accountingReason: "Le compte de tiers porte le nom sous lequel la créance ou la dette est suivie." }));
    } else confirmed.push(`Nom du tiers : ${displayName}.`);
    if (ice && !isPlausibleIce(ice)) {
      findings.push(finding({ code: "COUNTERPARTY.ICE_FORMAT", severity: "WARNING", target: "ice", currentValue: ice, title: "L'ICE du tiers n'a pas le format attendu.", explanation: "Un ICE marocain compte 15 chiffres. Recopiez-le depuis la facture plutôt que de le corriger de mémoire.", accountingReason: "L'ICE est la clé de rapprochement la plus fiable entre un tiers et ses pièces." }));
    }

    const company = await ctx.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true, ice: true, taxId: true } });
    if (company) {
      const match = matchPartyIdentity(
        { name: displayName, ice, taxId: text(ctx.draft.taxId, 60) },
        { name: company.name, ice: company.ice, taxId: company.taxId },
      );
      if (match.verdict === "SAME") {
        findings.push(finding({
          code: "COUNTERPARTY.IS_DOSSIER", severity: "BLOCKER", target: "displayName",
          title: "Cette identité est celle du dossier lui-même.",
          explanation: "Vous êtes sur le point de créer votre propre société comme client ou fournisseur. C'est presque toujours le signe que le sens de la pièce a été inversé.",
          evidence: [`Correspondance par ${match.basis}`, `Dossier : ${company.name}`],
          accountingReason: "Une société ne peut pas être son propre tiers : la créance et la dette se compenseraient sur le même compte.",
        }));
      }
    }

    if (displayName || ice) {
      const candidates = await ctx.prisma.counterparty.findMany({
        where: { companyId: ctx.companyId, ...(id ? { id: { not: id } } : {}) },
        select: { id: true, displayName: true, ice: true, taxId: true, kind: true },
        take: 400,
      });
      const duplicate = candidates.find((item: any) => matchPartyIdentity(
        { name: displayName, ice, taxId: text(ctx.draft.taxId, 60) },
        { name: item.displayName, ice: item.ice, taxId: item.taxId },
      ).verdict === "SAME");
      if (duplicate) {
        findings.push(finding({
          code: "COUNTERPARTY.DUPLICATE", severity: "WARNING", target: "displayName",
          title: `Un tiers très proche existe déjà : ${duplicate.displayName}.`,
          explanation: "Réutilisez-le plutôt que d'en créer un second, sinon l'encours du même partenaire sera réparti sur deux comptes auxiliaires.",
          evidence: [`Tiers existant : ${duplicate.displayName}${duplicate.ice ? ` (ICE ${duplicate.ice})` : ""}`],
          accountingReason: "Un doublon de tiers casse le relevé de compte et l'ancienneté des créances.",
        }));
      } else if (displayName) confirmed.push("Aucun tiers existant ne correspond à cette identité.");
    }

    const normalized = normalizeCompanyName(displayName);
    return {
      findings,
      checked: ["Nom du tiers", "Format de l'ICE", "Identité identique au dossier", "Doublon parmi les tiers existants"],
      confirmed,
      modelContext: { displayName, normalized, ice, kind: text(ctx.draft.kind, 20) },
    };
  },

  async DOCUMENT_EXTRACTION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const fields = record(ctx.draft.fields);
    const documentId = text(ctx.draft.documentId, 200);
    const document = documentId ? await ctx.prisma.document.findFirst({ where: { id: documentId, companyId: ctx.companyId }, select: { id: true, title: true, type: true, invoiceId: true, entryId: true, ocrText: true } }) : null;
    if (documentId && !document) {
      findings.push(finding({ code: "DOCUMENT.NOT_FOUND", severity: "BLOCKER", target: "documentId", title: "Ce document n'appartient pas au dossier actif.", explanation: "Rechargez la liste des pièces.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société du document"], confirmed };
    }
    if (document?.invoiceId || document?.entryId) {
      findings.push(finding({
        code: "DOCUMENT.ALREADY_LINKED", severity: "BLOCKER", target: "fields",
        title: "Ce document est déjà rattaché à une pièce comptable.",
        explanation: "Corrigez la facture ou l'écriture qui en est issue : modifier l'extraction ne changerait plus rien à la comptabilité.",
        accountingReason: "La pièce justificative doit rester le reflet de ce qui a été comptabilisé.",
      }));
    }

    const hasFields = Object.keys(fields).length > 0;
    if (!hasFields) {
      // Re-running recognition replaces the extraction wholesale: there are
      // no typed values to check yet, only whether the pièce may still move.
      confirmed.push("La pièce n'est rattachée à aucune écriture : sa reconnaissance peut être relancée.");
      return { findings, checked: ["Rattachement du document"], confirmed, modelContext: { title: document?.title, type: document?.type } };
    }

    const value = (key: string) => {
      const raw = fields[key];
      return raw && typeof raw === "object" ? (raw as any).value : raw;
    };
    const ht = cents(value("ht"));
    const vat = cents(value("tva"));
    const ttc = cents(value("ttc"));
    if (ht !== null && vat !== null && ttc !== null) {
      if (ht + vat !== ttc) {
        findings.push(finding({
          code: "DOCUMENT.TOTALS_INCONSISTENT", severity: "WARNING", target: "ttc",
          title: "HT + TVA ne fait pas le TTC lu sur la pièce.",
          explanation: `${money(ht)} + ${money(vat)} = ${money(ht + vat)}, alors que le TTC saisi est ${money(ttc)}. Relisez la pièce : c'est le document qui tranche, pas Wheat.`,
          currentValue: money(ttc), proposedValue: money(ht + vat),
          evidence: [`HT lu ${money(ht)}`, `TVA lue ${money(vat)}`],
          accountingReason: "Les trois montants d'une facture sont liés : toute divergence vient d'une lecture erronée ou d'une remise non reprise.",
        }));
      } else confirmed.push(`Contrôle HT + TVA = TTC vérifié : ${money(ht)} + ${money(vat)} = ${money(ttc)}.`);
    } else if (ttc === null) {
      findings.push(finding({ code: "DOCUMENT.TTC_MISSING", severity: "WARNING", target: "ttc", title: "Le montant TTC n'a pas été lu.", explanation: "Saisissez-le d'après la pièce ; Wheat ne l'invente pas.", accountingReason: "Le TTC est le montant porté au compte de tiers." }));
    }

    const ice = text(value("ice"), 40);
    if (ice && !isPlausibleIce(ice)) {
      findings.push(finding({ code: "DOCUMENT.ICE_FORMAT", severity: "INFO", target: "ice", currentValue: ice, title: "L'ICE lu n'a pas 15 chiffres.", explanation: "La reconnaissance a pu couper le numéro. Vérifiez-le sur la pièce.", accountingReason: "L'ICE relie la pièce au bon tiers." }));
    }
    if (!day(value("date"))) {
      findings.push(finding({ code: "DOCUMENT.DATE_MISSING", severity: "WARNING", target: "date", title: "La date de la pièce n'a pas été lue.", explanation: "Elle détermine l'exercice et la période de TVA.", accountingReason: "Sans date, la pièce ne peut être rattachée à aucune période." }));
    } else confirmed.push("Date de pièce lue.");

    return {
      findings,
      checked: ["Rattachement du document", "Contrôle HT + TVA = TTC", "Format de l'ICE lu", "Présence de la date"],
      confirmed,
      modelContext: { title: document?.title, type: document?.type ?? text(ctx.draft.type, 40), fields: Object.fromEntries(Object.keys(fields).slice(0, 20).map((key) => [key, text(value(key), 120)])), ocrExcerpt: text(document?.ocrText, 4000) },
    };
  },

  async DOCUMENT_INVOICE_DRAFT(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const documentId = text(ctx.draft.documentId, 200);
    const document = documentId ? await ctx.prisma.document.findFirst({ where: { id: documentId, companyId: ctx.companyId } }) : null;
    if (!document) {
      findings.push(finding({ code: "DOCUMENT.NOT_FOUND", severity: "BLOCKER", target: "documentId", title: "Ce document n'appartient pas au dossier actif.", explanation: "Rechargez la liste des pièces.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société du document"], confirmed };
    }
    if (document.invoiceId) {
      findings.push(finding({ code: "DOCUMENT.DRAFT_EXISTS", severity: "BLOCKER", target: "documentId", title: "Une facture a déjà été créée depuis cette pièce.", explanation: "Ouvrez la facture existante plutôt que d'en créer une seconde.", accountingReason: "Deux factures issues d'une même pièce comptabiliseraient l'opération deux fois." }));
    } else confirmed.push("Aucune facture n'a encore été créée depuis cette pièce.");

    let extracted: Record<string, any> = {};
    try {
      extracted = JSON.parse(document.extracted || "{}");
    } catch {
      // An unreadable extraction simply carries no direction hint.
    }
    const kind = text(ctx.draft.kind, 20).toUpperCase();
    const detected = text(extracted?.direction?.kind ?? extracted?.kind, 20).toUpperCase();
    let question: WheatReviewResult["question"] = undefined as any;
    if (!kind && !["SALE", "PURCHASE"].includes(detected)) {
      findings.push(finding({
        code: "DOCUMENT.DIRECTION_UNKNOWN", severity: "WARNING", target: "kind",
        title: "Le sens de la pièce n'a pas pu être établi.",
        explanation: "Wheat compare l'identité du dossier à l'émetteur et au destinataire de la pièce. Ici la comparaison n'a rien donné de sûr.",
        accountingReason: "Une facture de vente crée une créance client et de la TVA facturée ; une facture d'achat crée une dette fournisseur et de la TVA récupérable. Se tromper de sens inverse les deux.",
      }));
      question = {
        prompt: "Cette pièce est-elle une facture que vous avez émise (vente) ou reçue (achat) ?",
        why: "Wheat n'a pas retrouvé l'identité du dossier du côté émetteur ni du côté destinataire de la pièce, et n'a pas le droit de deviner le sens.",
        whereToFind: "Regardez l'en-tête de la facture : si votre société y figure comme émetteur, c'est une vente.",
      };
    } else confirmed.push(`Sens retenu : ${(kind || detected) === "SALE" ? "vente" : "achat"}.`);

    return { findings, checked: ["Facture déjà créée depuis la pièce", "Sens achat/vente déductible de la pièce"], confirmed, question, modelContext: { type: document.type, title: document.title, detected, requested: kind, ocrExcerpt: text(document.ocrText, 4000) } };
  },

  async BANK_ACCOUNT(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const ledgerAccountId = text(ctx.draft.ledgerAccountId, 200);
    if (ledgerAccountId) {
      const account = await ctx.prisma.account.findFirst({ where: { id: ledgerAccountId, companyId: ctx.companyId }, select: { id: true, code: true, label: true, classNo: true, postable: true, active: true } });
      if (!account) {
        findings.push(finding({ code: "BANK.LEDGER_MISSING", severity: "BLOCKER", target: "ledgerAccountId", title: "Le compte comptable choisi n'existe pas dans ce dossier.", explanation: "Choisissez un compte du plan de ce dossier.", accountingReason: "Le compte bancaire du relevé doit pointer vers un compte du plan comptable pour que le rapprochement ait un sens." }));
      } else {
        if (account.classNo !== 5) {
          findings.push(finding({ code: "BANK.LEDGER_NOT_TREASURY", severity: "WARNING", target: "ledgerAccountId", currentValue: `${account.code} — ${account.label}`, title: "Le compte associé n'est pas un compte de trésorerie.", explanation: "Les comptes bancaires appartiennent à la classe 5 du PCGE.", accountingReason: "Rattacher un relevé bancaire à un compte hors trésorerie fausserait la position de trésorerie et le rapprochement." }));
        } else confirmed.push(`Compte de trésorerie retenu : ${account.code} — ${account.label}.`);
        if (!account.postable || !account.active) {
          findings.push(finding({ code: "BANK.LEDGER_NOT_POSTABLE", severity: "BLOCKER", target: "ledgerAccountId", currentValue: account.code, title: "Ce compte n'accepte pas d'écriture.", explanation: "Choisissez une subdivision active et mouvementable.", accountingReason: "Un compte de regroupement ne reçoit pas d'écriture directe." }));
        }
        const taken = await ctx.prisma.bankAccount.findFirst({ where: { companyId: ctx.companyId, ledgerAccountId, ...(text(ctx.draft.id, 200) ? { id: { not: text(ctx.draft.id, 200) } } : {}) }, select: { bankName: true } });
        if (taken) {
          findings.push(finding({ code: "BANK.LEDGER_TAKEN", severity: "BLOCKER", target: "ledgerAccountId", title: `Ce compte est déjà associé à ${taken.bankName}.`, explanation: "Créez une subdivision dédiée à ce second compte bancaire.", accountingReason: "Deux relevés partageant un compte comptable rendraient le rapprochement impossible à justifier." }));
        }
      }
    } else {
      findings.push(finding({
        code: "BANK.LEDGER_UNSET", severity: "WARNING", target: "ledgerAccountId",
        title: "Aucun compte comptable n'est associé à ce compte bancaire.",
        explanation: "Le rapprochement ne pourra proposer aucune ligne comptabilisée tant que l'association manque.",
        accountingReason: "Le rapprochement relie les mouvements du relevé aux lignes du compte de banque du grand livre.",
      }));
    }
    if (!text(ctx.draft.iban, 100) && !text(ctx.draft.bankName, 180)) {
      findings.push(finding({ code: "BANK.IDENTITY_MISSING", severity: "WARNING", target: "bankName", title: "La banque et le RIB/IBAN ne sont pas renseignés.", explanation: "Ils permettent de reconnaître le relevé importé.", accountingReason: "L'identification du compte est nécessaire pour rattacher un relevé au bon compte." }));
    }
    return { findings, checked: ["Existence et classe du compte comptable", "Compte mouvementable et libre", "Identification bancaire"], confirmed };
  },

  async BANK_IMPORT(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const mapping = record(ctx.draft.mapping);
    const rows = Array.isArray(ctx.draft.rows) ? ctx.draft.rows : [];
    for (const key of ["date", "label", "amount"]) {
      if (!text(mapping[key], 120)) {
        findings.push(finding({ code: `BANK_IMPORT.MAPPING_${key.toUpperCase()}`, severity: "BLOCKER", target: `mapping.${key}`, title: `La colonne « ${key} » du relevé n'est pas associée.`, explanation: "Associez chaque colonne obligatoire avant d'importer.", accountingReason: "Sans date, libellé et montant, un mouvement bancaire n'est pas exploitable pour le rapprochement." }));
      }
    }
    if (!rows.length) {
      findings.push(finding({ code: "BANK_IMPORT.NO_ROWS", severity: "BLOCKER", target: "rows", title: "Le relevé ne contient aucune ligne exploitable.", explanation: "Vérifiez le fichier choisi.", accountingReason: "Un import vide n'apporte aucune preuve bancaire." }));
    } else confirmed.push(`${rows.length} ligne(s) prêtes à être contrôlées.`);

    const sha = text(ctx.draft.sourceSha256, 80);
    const bankAccountId = text(ctx.draft.bankAccountId, 200);
    if (sha && bankAccountId) {
      const duplicate = await ctx.prisma.bankStatementImport.findFirst({ where: { bankAccountId, sourceSha256: sha }, select: { id: true, sourceName: true, rowCount: true } });
      if (duplicate) {
        findings.push(finding({
          code: "BANK_IMPORT.DUPLICATE_FILE", severity: "WARNING", target: "sourceSha256",
          title: "Ce relevé exact a déjà été importé.",
          explanation: `Fichier identique à « ${duplicate.sourceName} » (${duplicate.rowCount} lignes). Réimporter créerait des mouvements en double.`,
          evidence: [`Empreinte SHA-256 déjà connue pour ce compte`],
          accountingReason: "Des mouvements bancaires dupliqués fausseraient la position de trésorerie et le rapprochement.",
        }));
      } else confirmed.push("Ce fichier n'a pas déjà été importé sur ce compte.");
    }
    return { findings, checked: ["Association des colonnes obligatoires", "Présence de lignes", "Doublon de relevé par empreinte"], confirmed };
  },

  async RECONCILIATION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const movementId = text(ctx.draft.movementId, 200);
    const allocations = Array.isArray(ctx.draft.allocations) ? ctx.draft.allocations : [];
    const movement = movementId ? await ctx.prisma.bankMovement.findFirst({ where: { id: movementId, bankAccount: { companyId: ctx.companyId } }, select: { id: true, amountCents: true, label: true, status: true, date: true } }) : null;
    if (!movement) {
      findings.push(finding({ code: "RECONCILIATION.MOVEMENT_MISSING", severity: "BLOCKER", target: "movementId", title: "Ce mouvement bancaire n'appartient pas au dossier actif.", explanation: "Rechargez le rapprochement.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société du mouvement"], confirmed };
    }
    if (!allocations.length) {
      findings.push(finding({ code: "RECONCILIATION.NO_ALLOCATION", severity: "BLOCKER", target: "allocations", title: "Aucune ligne comptable n'est rapprochée.", explanation: "Choisissez au moins une ligne d'écriture comptabilisée.", accountingReason: "Le rapprochement relie une preuve bancaire à une écriture ; sans écriture il n'y a pas de rapprochement." }));
    }
    const total = allocations.reduce((sum: bigint, item: any) => sum + (cents(item?.amountCents) ?? 0n), 0n);
    const amount = BigInt(movement.amountCents ?? 0n);
    const magnitude = amount < 0n ? -amount : amount;
    const allocated = total < 0n ? -total : total;
    if (allocated > magnitude) {
      findings.push(finding({
        code: "RECONCILIATION.OVER_ALLOCATED", severity: "BLOCKER", target: "allocations",
        title: "Les lignes rapprochées dépassent le montant du mouvement.",
        explanation: `Mouvement de ${money(amount)} pour ${money(total)} rapprochés.`,
        currentValue: money(total), proposedValue: money(amount),
        accountingReason: "Un mouvement bancaire ne peut justifier plus que son propre montant.",
      }));
    } else if (allocated < magnitude) {
      findings.push(finding({
        code: "RECONCILIATION.PARTIAL", severity: "INFO", target: "allocations",
        title: "Rapprochement partiel.",
        explanation: `${money(total)} rapprochés sur ${money(amount)} : le reste demeure à justifier.`,
        accountingReason: "Un rapprochement partiel est légitime, mais le solde non rapproché reste un écart à expliquer.",
        requiresAcknowledgement: false,
      }));
    } else confirmed.push(`Mouvement intégralement rapproché : ${money(amount)}.`);
    if (movement.status === "RECONCILED") {
      findings.push(finding({ code: "RECONCILIATION.ALREADY", severity: "BLOCKER", target: "movementId", currentValue: movement.status, title: "Ce mouvement est déjà rapproché.", explanation: "Annulez le rapprochement actif avant d'en créer un autre.", accountingReason: "Un même mouvement justifié deux fois compterait double." }));
    }
    return { findings, checked: ["Portée société du mouvement", "Somme des lignes rapprochées", "Statut du mouvement"], confirmed, modelContext: { label: movement.label, amount: money(amount), date: isoDay(new Date(movement.date)), allocationCount: allocations.length } };
  },

  async BANK_EXCLUSION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const reason = text(ctx.draft.reason, 1000);
    if (reason.length < 10) {
      findings.push(finding({ code: "BANK_EXCLUSION.REASON_TOO_SHORT", severity: "BLOCKER", target: "reason", currentValue: reason, title: "Le motif d'exclusion est trop court.", explanation: "Expliquez pourquoi ce mouvement n'a pas de contrepartie comptable dans ce dossier.", accountingReason: "Une exclusion n'est pas une preuve comptable : seule sa justification permet de la défendre." }));
    } else confirmed.push("Motif d'exclusion renseigné.");
    findings.push(finding({
      code: "BANK_EXCLUSION.NOT_EVIDENCE", severity: "INFO", target: "reason", requiresAcknowledgement: false,
      title: "L'exclusion conserve le mouvement dans l'historique.",
      explanation: "Le mouvement reste visible et restaurable ; il cesse simplement d'être proposé au rapprochement.",
      accountingReason: "Exclure n'efface rien : la piste d'audit bancaire reste complète.",
    }));
    return { findings, checked: ["Longueur et présence du motif"], confirmed };
  },

  async TAX_CONFIGURATION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const effectiveFrom = day(ctx.draft.effectiveFrom);
    if (!effectiveFrom) {
      findings.push(finding({ code: "TAX_CONFIG.EFFECTIVE_FROM_MISSING", severity: "BLOCKER", target: "effectiveFrom", title: "La date d'entrée en vigueur est obligatoire.", explanation: "Les configurations de TVA sont datées : Wheat applique celle qui était en vigueur à la date de la pièce.", accountingReason: "Un taux appliqué hors de sa période de validité fausserait la TVA de la période." }));
    } else confirmed.push(`Entrée en vigueur au ${isoDay(effectiveFrom)}.`);

    const rates = Array.isArray(ctx.draft.rates) ? ctx.draft.rates : [];
    rates.forEach((rate: any, index: number) => {
      const direction = text(rate?.direction, 20).toUpperCase();
      if (!["COLLECTED", "DEDUCTIBLE"].includes(direction)) {
        findings.push(finding({ code: "TAX_CONFIG.DIRECTION", severity: "BLOCKER", target: `rates[${index}].direction`, currentValue: direction, title: `Le sens du taux ${index + 1} n'est pas précisé.`, explanation: "Chaque taux est soit collecté sur les ventes, soit déductible sur les achats.", accountingReason: "La TVA facturée et la TVA récupérable sont deux masses distinctes qui ne se compensent qu'au moment de la déclaration." }));
      }
      if (rate?.rateBps === undefined || rate?.rateBps === null || rate?.rateBps === "") {
        findings.push(finding({ code: "TAX_CONFIG.RATE_MISSING", severity: "BLOCKER", target: `rates[${index}].rateBps`, title: `Le taux ${index + 1} n'a pas de valeur.`, explanation: "Wheat n'affecte jamais un taux par défaut : recopiez celui qui s'applique à l'activité.", accountingReason: "Un taux inventé produirait une déclaration fausse." }));
      }
    });
    if (rates.length && !findings.some((item) => item.code.startsWith("TAX_CONFIG.RATE") || item.code === "TAX_CONFIG.DIRECTION")) {
      confirmed.push(`${rates.length} taux définis avec un sens et une valeur explicites.`);
    }
    findings.push(finding({
      code: "TAX_CONFIG.VERIFY_SOURCE", severity: "INFO", target: "rates", requiresAcknowledgement: false,
      title: "Les taux et échéances marocains ne sont pas fournis par Wheat.",
      explanation: "Wheat applique la configuration que vous saisissez et la date. La valeur des taux et les échéances doivent être vérifiées auprès d'une source officielle ou d'un professionnel.",
      accountingReason: "Wheat n'est pas certifié par la DGI et ne remplace pas la revue d'un comptable ou d'un fiscaliste qualifié.",
    }));
    return { findings, checked: ["Date d'entrée en vigueur", "Sens et valeur de chaque taux"], confirmed };
  },

  async VAT_WORKPAPER(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const start = day(ctx.draft.periodStart);
    const end = day(ctx.draft.periodEnd);
    const configurationId = text(ctx.draft.taxConfigurationVersionId, 200);
    if (start && end && start > end) {
      findings.push(finding({ code: "VAT.PERIOD_INVERTED", severity: "BLOCKER", target: "periodEnd", currentValue: `${isoDay(start)} → ${isoDay(end)}`, title: "La période de TVA se termine avant de commencer.", explanation: "Inversez les deux bornes.", accountingReason: "Une période de déclaration est un intervalle chronologique." }));
    }
    if (configurationId) {
      const configuration = await ctx.prisma.taxConfigurationVersion.findFirst({ where: { id: configurationId, companyId: ctx.companyId }, select: { id: true, status: true, name: true, effectiveFrom: true, effectiveTo: true, filingFrequency: true } });
      if (!configuration) {
        findings.push(finding({ code: "VAT.CONFIG_MISSING", severity: "BLOCKER", target: "taxConfigurationVersionId", title: "La configuration de TVA choisie n'existe pas dans ce dossier.", explanation: "Ouvrez l'espace TVA et sélectionnez une configuration active.", accountingReason: "Le dossier de travail est calculé à partir des taux et comptes de la configuration en vigueur." }));
      } else {
        if (configuration.status !== "ACTIVE") {
          findings.push(finding({ code: "VAT.CONFIG_NOT_ACTIVE", severity: "BLOCKER", target: "taxConfigurationVersionId", currentValue: configuration.status, title: "Cette configuration de TVA n'est pas active.", explanation: "Activez-la, ou choisissez la configuration en vigueur sur la période.", accountingReason: "Une configuration en brouillon n'a jamais servi à comptabiliser une pièce." }));
        } else confirmed.push(`Configuration active : ${configuration.name}.`);
        if (start && new Date(configuration.effectiveFrom) > start) {
          findings.push(finding({
            code: "VAT.CONFIG_STARTS_LATE", severity: "WARNING", target: "periodStart",
            title: "La configuration entre en vigueur après le début de la période.",
            explanation: `Entrée en vigueur au ${isoDay(new Date(configuration.effectiveFrom))} pour une période démarrant le ${isoDay(start)}.`,
            accountingReason: "Une configuration datée ne peut pas régir des pièces antérieures à son entrée en vigueur.",
          }));
        }
      }
    }
    findings.push(finding({
      code: "VAT.NOT_A_FILING", severity: "INFO", target: null, requiresAcknowledgement: false,
      title: "Ce dossier de travail n'est pas une déclaration déposée.",
      explanation: "Wheat prépare et verrouille un dossier de travail interne. Il ne télédéclare rien auprès de la DGI.",
      accountingReason: "Le dépôt reste une démarche que vous effectuez auprès de l'administration.",
    }));
    return { findings, checked: ["Bornes de la période", "Configuration de TVA active et datée"], confirmed };
  },

  async VAT_REVIEW(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.id, 200);
    const workpaper = id ? await ctx.prisma.vatWorkpaper.findFirst({ where: { id, companyId: ctx.companyId }, include: { evidence: true } }) : null;
    if (!workpaper) {
      findings.push(finding({ code: "VAT.WORKPAPER_MISSING", severity: "BLOCKER", target: "id", title: "Ce dossier de travail TVA n'appartient pas au dossier actif.", explanation: "Rechargez l'espace TVA.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société du dossier de travail"], confirmed };
    }
    if (workpaper.status === "REVIEWED") {
      findings.push(finding({ code: "VAT.ALREADY_REVIEWED", severity: "BLOCKER", target: "status", currentValue: workpaper.status, title: "Ce dossier est déjà revu et verrouillé.", explanation: "Sa réouverture suit le workflow motivé et audité de Wheat.", accountingReason: "Un dossier de travail verrouillé fige les preuves sur lesquelles la déclaration a été fondée." }));
    }
    const collected = BigInt(workpaper.collectedVatCents ?? 0n);
    const deductible = BigInt(workpaper.deductibleVatCents ?? 0n);
    confirmed.push(`TVA facturée ${money(collected)} et TVA récupérable ${money(deductible)} suivies séparément.`);
    if (!(workpaper.evidence?.length)) {
      findings.push(finding({
        code: "VAT.NO_EVIDENCE", severity: "WARNING", target: "evidence",
        title: "Aucune preuve n'est attachée à ce dossier de travail.",
        explanation: "Joignez au moins les pièces qui justifient les ajustements avant de verrouiller.",
        accountingReason: "Un dossier de travail sans preuve ne peut pas être défendu lors d'un contrôle.",
      }));
    } else confirmed.push(`${workpaper.evidence.length} preuve(s) attachées.`);
    findings.push(finding({
      code: "VAT.NOT_A_FILING", severity: "INFO", target: null, requiresAcknowledgement: false,
      title: "Verrouiller n'est pas déposer.",
      explanation: "Wheat verrouille un dossier de travail interne ; le dépôt auprès de la DGI reste votre démarche.",
      accountingReason: "Wheat n'est pas certifié par la DGI et ne transmet rien à l'administration.",
    }));
    return { findings, checked: ["Statut du dossier de travail", "Séparation TVA facturée / récupérable", "Preuves attachées"], confirmed };
  },

  async FISCAL_PACKAGE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const fiscalYearId = text(ctx.draft.fiscalYearId, 200);
    if (fiscalYearId) {
      const year = await ctx.prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId: ctx.companyId }, select: { id: true, label: true, status: true } });
      if (!year) {
        findings.push(finding({ code: "FISCAL.YEAR_MISSING", severity: "BLOCKER", target: "fiscalYearId", title: "L'exercice visé n'existe pas dans ce dossier.", explanation: "Rechargez l'écran des exercices.", accountingReason: "La liasse porte sur un exercice précis." }));
      } else {
        confirmed.push(`Liasse rattachée à l'exercice ${year.label}.`);
        const drafts = await ctx.prisma.entry.count({ where: { companyId: ctx.companyId, status: "DRAFT" } });
        if (drafts > 0) {
          findings.push(finding({
            code: "FISCAL.DRAFTS_PENDING", severity: "WARNING", target: "fiscalYearId",
            title: `${drafts} brouillon(s) ne sont pas comptabilisés.`,
            explanation: "La liasse ne reprend que les écritures comptabilisées : ces brouillons n'y figureront pas.",
            accountingReason: "Les états financiers ne peuvent être fondés que sur des écritures définitives.",
          }));
        } else confirmed.push("Aucun brouillon en attente.");
      }
    }
    const amount = cents(ctx.draft.amountCents);
    if (ctx.draft.amountCents !== undefined && (amount === null || amount === 0n)) {
      findings.push(finding({ code: "FISCAL.ADJUSTMENT_AMOUNT", severity: "BLOCKER", target: "amountCents", title: "Le montant du retraitement est invalide.", explanation: "Saisissez un montant non nul en dirhams.", accountingReason: "Une réintégration ou une déduction nulle n'a pas d'effet fiscal à justifier." }));
    }
    if (ctx.draft.legalReference !== undefined && !text(ctx.draft.legalReference, 500)) {
      findings.push(finding({
        code: "FISCAL.LEGAL_REFERENCE_MISSING", severity: "BLOCKER", target: "legalReference",
        title: "La référence légale du retraitement est obligatoire.",
        explanation: "Indiquez l'article ou la note qui fonde le retraitement. Wheat n'en propose aucune de sa propre initiative.",
        accountingReason: "Un retraitement fiscal sans base légale citée ne peut pas être défendu lors d'un contrôle.",
      }));
    }
    return { findings, checked: ["Exercice de rattachement", "Brouillons non comptabilisés", "Montant et référence légale du retraitement"], confirmed };
  },

  async FISCAL_TABLE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const fiscalPackageId = text(ctx.draft.fiscalPackageId, 200);
    const tableId = text(ctx.draft.tableId, 10);
    if (fiscalPackageId && tableId) {
      const table = await ctx.prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId, tableId, fiscalPackage: { companyId: ctx.companyId } }, select: { id: true, status: true, revision: true } });
      if (!table) {
        findings.push(finding({ code: "FISCAL.TABLE_MISSING", severity: "BLOCKER", target: "tableId", title: "Ce tableau fiscal n'existe pas dans cette liasse.", explanation: "Régénérez la liasse.", accountingReason: "Chaque tableau appartient à une liasse d'un exercice." }));
      } else {
        if (table.status === "REVIEWED") {
          findings.push(finding({ code: "FISCAL.TABLE_REVIEWED", severity: "BLOCKER", target: "status", currentValue: table.status, title: "Ce tableau est revu et verrouillé.", explanation: "Sa réouverture suit le workflow motivé et audité de Wheat.", accountingReason: "Un tableau verrouillé fige l'état sur lequel la liasse est fondée." }));
        } else confirmed.push(`Tableau ${tableId} modifiable (révision ${table.revision}).`);
      }
    }
    findings.push(finding({
      code: "FISCAL.NOT_A_FILING", severity: "INFO", target: null, requiresAcknowledgement: false,
      title: "La liasse préparée dans Wheat n'est pas une liasse déposée.",
      explanation: "Wheat prépare des tableaux de travail ; le dépôt reste votre démarche auprès de la DGI.",
      accountingReason: "Wheat n'est pas certifié par la DGI et ne remplace pas la revue d'un professionnel qualifié.",
    }));
    return { findings, checked: ["Existence et statut du tableau"], confirmed };
  },

  async LEDGER_IMPORT(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const batchId = text(ctx.draft.batchId, 200);
    if (batchId) {
      const batch = await ctx.prisma.ledgerImportBatch.findFirst({ where: { id: batchId, companyId: ctx.companyId }, include: { rows: { select: { status: true } } } });
      if (!batch) {
        findings.push(finding({ code: "IMPORT.BATCH_MISSING", severity: "BLOCKER", target: "batchId", title: "Ce lot d'import n'appartient pas au dossier actif.", explanation: "Rechargez la liste des imports.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      } else {
        if (batch.status !== "STAGED") {
          findings.push(finding({ code: "IMPORT.NOT_STAGED", severity: "BLOCKER", target: "status", currentValue: batch.status, title: "Ce lot n'est plus en attente de confirmation.", explanation: "Un lot déjà confirmé ou annulé ne peut pas être rejoué.", accountingReason: "Rejouer un import déjà confirmé comptabiliserait les mêmes écritures deux fois." }));
        } else confirmed.push(`Lot en attente : ${batch.rows?.length ?? 0} ligne(s).`);
        const errors = (batch.rows ?? []).filter((row: any) => String(row.status).toUpperCase() === "ERROR").length;
        if (errors > 0) {
          findings.push(finding({ code: "IMPORT.ROWS_IN_ERROR", severity: "BLOCKER", target: "rows", title: `${errors} ligne(s) du lot sont en erreur.`, explanation: "Corrigez le fichier source et représentez-le ; Wheat n'importe pas un lot partiellement invalide.", accountingReason: "Un import doit être atomique : une moitié comptabilisée serait impossible à rapprocher de sa source." }));
        } else if (batch.status === "STAGED") confirmed.push("Aucune ligne en erreur.");
      }
    }
    findings.push(finding({
      code: "IMPORT.STAGED_AND_REVERSIBLE", severity: "INFO", target: null, requiresAcknowledgement: false,
      title: "L'import reste vérifiable avant d'être confirmé.",
      explanation: "Le lot est visible, ses lignes sont contrôlées et sa confirmation est atomique.",
      accountingReason: "Un import comptable doit être revu, déduplicué et confirmé explicitement.",
    }));
    return { findings, checked: ["Statut du lot", "Lignes en erreur"], confirmed };
  },

  async EMPLOYEE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    if (!text(ctx.draft.fullName, 180)) {
      findings.push(finding({ code: "EMPLOYEE.NAME_MISSING", severity: "BLOCKER", target: "fullName", title: "Le nom du salarié est obligatoire.", explanation: "Il identifie la ligne de paie.", accountingReason: "Le journal de paie doit désigner nominativement chaque salarié." }));
    } else confirmed.push("Nom du salarié renseigné.");
    for (const [field, label] of [["grossSalary", "salaire brut"], ["netSalary", "salaire net"]] as const) {
      if (ctx.draft[field] !== undefined && ctx.draft[field] !== "" && cents(ctx.draft[field]) === null) {
        findings.push(finding({ code: `EMPLOYEE.${field.toUpperCase()}_INVALID`, severity: "BLOCKER", target: field, currentValue: String(ctx.draft[field]), title: `Le ${label} n'est pas un montant exact.`, explanation: "Saisissez un montant en dirhams avec au plus deux décimales.", accountingReason: "Wheat n'utilise que des centimes entiers : un arrondi flottant fausserait le journal de paie." }));
      }
    }
    const gross = cents(ctx.draft.grossSalary);
    const net = cents(ctx.draft.netSalary);
    if (gross !== null && net !== null && net > gross) {
      findings.push(finding({ code: "EMPLOYEE.NET_ABOVE_GROSS", severity: "WARNING", target: "netSalary", currentValue: money(net), title: "Le net dépasse le brut.", explanation: `Brut ${money(gross)} pour un net ${money(net)}.`, accountingReason: "Le net est le brut diminué des retenues : il ne peut normalement pas le dépasser." }));
    } else if (gross !== null && net !== null) confirmed.push(`Brut ${money(gross)} et net ${money(net)} cohérents.`);
    return { findings, checked: ["Identité du salarié", "Exactitude des montants en centimes", "Cohérence brut/net"], confirmed };
  },

  async PAYROLL_POST(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const period = text(ctx.draft.period, 20);
    const employees = await ctx.prisma.employee.count({ where: { companyId: ctx.companyId } });
    if (!employees) {
      findings.push(finding({ code: "PAYROLL.NO_EMPLOYEE", severity: "BLOCKER", target: "period", title: "Aucun salarié n'est enregistré.", explanation: "Ajoutez les salariés avant de comptabiliser une paie.", accountingReason: "Une écriture de paie sans salarié n'a rien à enregistrer." }));
    } else confirmed.push(`${employees} salarié(s) dans le dossier.`);
    if (period) {
      const existing = await ctx.prisma.payrollRun.findFirst({ where: { companyId: ctx.companyId, period }, select: { id: true, status: true } });
      if (existing && existing.status === "POSTED") {
        findings.push(finding({ code: "PAYROLL.ALREADY_POSTED", severity: "BLOCKER", target: "period", currentValue: period, title: `La paie de ${period} est déjà comptabilisée.`, explanation: "Annulez-la par extourne avant de la recomptabiliser.", accountingReason: "Comptabiliser deux fois la même paie doublerait la charge et les dettes sociales." }));
      } else confirmed.push(`Aucune paie comptabilisée pour ${period}.`);
    }
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? new Date(), "Comptabilisation de la paie"));
    return { findings, checked: ["Présence de salariés", "Paie déjà comptabilisée pour la période", "Verrou de période"], confirmed };
  },

  async PAYROLL_VOID(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const id = text(ctx.draft.payrollRunId ?? ctx.draft.id, 200);
    const run = id ? await ctx.prisma.payrollRun.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, status: true, period: true } }) : null;
    if (!run) {
      findings.push(finding({ code: "PAYROLL.NOT_FOUND", severity: "BLOCKER", target: "payrollRunId", title: "Cette paie n'appartient pas au dossier actif.", explanation: "Rechargez la liste des paies.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
      return { findings, checked: ["Portée société de la paie"], confirmed };
    }
    if (run.status !== "POSTED") {
      findings.push(finding({ code: "PAYROLL.VOID_NOT_POSTED", severity: "BLOCKER", target: "status", currentValue: run.status, title: "Seule une paie comptabilisée peut être annulée.", explanation: "Un brouillon de paie se recalcule.", accountingReason: "L'annulation contrepasse une écriture existante." }));
    } else confirmed.push(`Paie ${run.period} comptabilisée et annulable par extourne.`);
    if (!text(ctx.draft.reason, 1000)) {
      findings.push(finding({ code: "PAYROLL.VOID_REASON_MISSING", severity: "BLOCKER", target: "reason", title: "Un motif d'annulation est obligatoire.", explanation: "Il est conservé dans la chaîne d'audit.", accountingReason: "Une contrepassation non motivée est indéfendable lors d'un contrôle." }));
    }
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? new Date(), "Extourne de paie"));
    return { findings, checked: ["Statut comptabilisé", "Motif d'annulation", "Verrou de période"], confirmed };
  },

  async OPENING_BALANCE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const lines = Array.isArray(ctx.draft.lines) ? ctx.draft.lines : [];
    if (lines.length) {
      const totals = entryTotals(lines);
      if (totals.debit !== totals.credit) {
        findings.push(finding({
          code: "OPENING.UNBALANCED", severity: "BLOCKER", target: "lines",
          title: "Les à-nouveaux ne sont pas équilibrés.",
          explanation: `Débit ${money(totals.debit)} contre crédit ${money(totals.credit)}.`,
          currentValue: `${money(totals.debit)} / ${money(totals.credit)}`,
          accountingReason: "Une balance d'ouverture déséquilibrée rendrait tout l'exercice incohérent dès sa première écriture.",
        }));
      } else confirmed.push(`À-nouveaux équilibrés : ${money(totals.debit)}.`);
    }
    findings.push(finding({
      code: "OPENING.SOURCE_REQUIRED", severity: "WARNING", target: "lines",
      title: "Les soldes d'ouverture doivent venir d'une balance de clôture validée.",
      explanation: "Wheat ne devine aucun solde d'ouverture : reprenez la balance du bilan de l'exercice précédent ou celle remise par le cabinet sortant.",
      accountingReason: "Les à-nouveaux reportent une situation déjà arrêtée ; les inventer fausserait durablement le bilan.",
    }));
    findings.push(...await periodFindings(ctx, day(ctx.draft.date) ?? null, "À-nouveaux"));
    return { findings, checked: ["Équilibre des à-nouveaux", "Exercice de rattachement", "Origine des soldes"], confirmed };
  },

  async FISCAL_CLOSE(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const fiscalYearId = text(ctx.draft.fiscalYearId, 200);
    const year = fiscalYearId ? await ctx.prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId: ctx.companyId } }) : null;
    if (!year) {
      findings.push(finding({ code: "CLOSE.YEAR_MISSING", severity: "BLOCKER", target: "fiscalYearId", title: "L'exercice à clôturer n'existe pas dans ce dossier.", explanation: "Rechargez l'écran des exercices.", accountingReason: "La clôture porte sur un exercice précis." }));
      return { findings, checked: ["Existence de l'exercice"], confirmed };
    }
    if (year.status !== "OPEN") {
      findings.push(finding({ code: "CLOSE.NOT_OPEN", severity: "BLOCKER", target: "status", currentValue: year.status, title: `L'exercice ${year.label} n'est pas ouvert.`, explanation: "Seul un exercice ouvert peut être clôturé.", accountingReason: "Une seconde clôture recréerait des à-nouveaux déjà reportés." }));
    }
    const drafts = await ctx.prisma.entry.count({ where: { companyId: ctx.companyId, status: "DRAFT", date: { gte: year.startsOn, lte: year.endsOn } } });
    if (drafts > 0) {
      findings.push(finding({
        code: "CLOSE.DRAFTS_PENDING", severity: "BLOCKER", target: "fiscalYearId",
        title: `${drafts} brouillon(s) restent dans l'exercice.`,
        explanation: "Comptabilisez-les ou supprimez-les : après la clôture ils ne pourront plus être comptabilisés à leur date.",
        accountingReason: "La clôture arrête définitivement le résultat de l'exercice : un brouillon oublié serait perdu pour cet exercice.",
      }));
    } else confirmed.push("Aucun brouillon dans l'exercice.");
    return { findings, checked: ["Statut de l'exercice", "Brouillons restants"], confirmed };
  },

  async EXPORT_PREPARATION(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const drafts = await ctx.prisma.entry.count({ where: { companyId: ctx.companyId, status: "DRAFT" } });
    if (drafts > 0) {
      findings.push(finding({
        code: "EXPORT.DRAFTS_EXCLUDED", severity: "INFO", target: null, requiresAcknowledgement: false,
        title: `${drafts} brouillon(s) ne seront pas exportés.`,
        explanation: "L'export ne reprend que les écritures comptabilisées.",
        accountingReason: "Un export destiné à un tiers ne doit contenir que des écritures définitives.",
      }));
    }
    confirmed.push("L'export reprend uniquement des écritures comptabilisées, en centimes exacts.");
    return { findings, checked: ["Périmètre des écritures exportées"], confirmed };
  },

  /**
   * Approving a batch of prepared guided operations.
   *
   * The operations themselves were already validated one by one when they were
   * prepared, and each will be validated again by the service that performs it.
   * What this adds is the view of the batch *as a batch*: how much is about to
   * happen at once, and whether any of it was only offered for review rather
   * than found clean. Both are things a person approving thirty operations in
   * one click should be told before they click.
   */
  async GUIDED_APPROVAL(ctx) {
    const findings: WheatReviewFinding[] = [];
    const confirmed: string[] = [];
    const draft = ctx.draft;
    const operationIds = Array.isArray(draft.operationIds) ? draft.operationIds.map((value: unknown) => String(value ?? "")).filter(Boolean) : [];
    const stepId = text(draft.stepId) ?? "";

    if (!operationIds.length) {
      findings.push(finding({
        code: "GUIDED.NOTHING_SELECTED", severity: "BLOCKER", target: "operationIds", requiresAcknowledgement: false,
        title: "Aucune opération n'est sélectionnée.",
        explanation: "Wheat n'exécute que les opérations explicitement cochées.",
        accountingReason: "Une approbation vide ne peut engager aucune écriture.",
      }));
    }
    if (operationIds.length > 25) {
      findings.push(finding({
        code: "GUIDED.LARGE_BATCH", severity: "WARNING", target: "operationIds", requiresAcknowledgement: true,
        title: `${operationIds.length} opérations seront exécutées d'un seul geste.`,
        explanation: "Chacune s'exécute dans sa propre transaction : celles qui réussissent sont conservées, celles qui échouent sont listées et rien n'est rejoué deux fois.",
        accountingReason: "Un traitement de masse reste sous la responsabilité de la personne qui l'approuve ; il doit être annoncé avant d'être lancé.",
      }));
    }
    if (stepId === "invoices") {
      findings.push(finding({
        code: "GUIDED.POSTING_IS_FINAL", severity: "WARNING", target: null, requiresAcknowledgement: true,
        title: "La comptabilisation est définitive.",
        explanation: "Une facture comptabilisée se corrige par extourne ou par avoir, jamais par modification.",
        accountingReason: "Le grand livre est en ajout seul : l'historique n'est pas réécrit.",
      }));
    }
    confirmed.push("Seules les opérations cochées seront exécutées ; chacune est revalidée par le service qui la réalise.");
    return { findings, checked: ["Périmètre du lot approuvé", "Caractère définitif des opérations"], confirmed };
  },
};

/* ------------------------------------ payload reviewers shared by several kinds */

async function reviewEntryPayload(ctx: ReviewContext): Promise<DeterministicReview> {
  const findings: WheatReviewFinding[] = [];
  const confirmed: string[] = [];
  const lines = Array.isArray(ctx.draft.lines) ? ctx.draft.lines : [];

  if (lines.length < 2) {
    findings.push(finding({ code: "ENTRY.TOO_FEW_LINES", severity: "BLOCKER", target: "lines", currentValue: String(lines.length), title: "Une écriture comporte au moins deux lignes.", explanation: "Une opération se traduit toujours par au moins un débit et un crédit.", accountingReason: "La partie double impose une contrepartie à chaque mouvement." }));
  }
  const totals = entryTotals(lines);
  if (totals.malformed.length) {
    findings.push(finding({
      code: "ENTRY.LINE_MALFORMED", severity: "BLOCKER", target: `lines[${totals.malformed[0] - 1}]`,
      title: `Ligne ${totals.malformed.join(", ")} : montant invalide ou débit et crédit simultanés.`,
      explanation: "Chaque ligne porte un montant exact, au débit ou au crédit, jamais les deux.",
      accountingReason: "Une ligne qui débite et crédite à la fois ne représente aucune opération identifiable.",
    }));
  }
  if (lines.length && totals.debit !== totals.credit) {
    findings.push(finding({
      code: "ENTRY.UNBALANCED", severity: "BLOCKER", target: "lines",
      title: "L'écriture n'est pas équilibrée.",
      explanation: `Débit ${money(totals.debit)} contre crédit ${money(totals.credit)} : écart de ${money(totals.debit - totals.credit)}.`,
      currentValue: `${money(totals.debit)} / ${money(totals.credit)}`,
      evidence: [`Total débit ${money(totals.debit)}`, `Total crédit ${money(totals.credit)}`],
      accountingReason: "En partie double, le total des débits d'une écriture égale exactement le total de ses crédits. Les actifs et les charges augmentent au débit ; les passifs, les capitaux propres et les produits augmentent au crédit.",
    }));
  } else if (lines.length && !totals.malformed.length) {
    confirmed.push(`Écriture équilibrée : ${money(totals.debit)} au débit comme au crédit.`);
  }

  const accountIds = [...new Set(lines.map((line: any) => text(line?.accountId, 200)).filter(Boolean))];
  if (accountIds.length) {
    const accounts = await ctx.prisma.account.findMany({ where: { id: { in: accountIds }, companyId: ctx.companyId }, select: { id: true, code: true, label: true, active: true, postable: true } });
    const byId = new Map<string, any>(accounts.map((item: any) => [item.id, item]));
    for (const id of accountIds) {
      const account = byId.get(id);
      if (!account) {
        findings.push(finding({ code: "ENTRY.ACCOUNT_FOREIGN", severity: "BLOCKER", target: "lines", title: "Une ligne utilise un compte qui n'appartient pas à ce dossier.", explanation: "Choisissez un compte du plan comptable de ce dossier.", accountingReason: "Les dossiers sont étanches : une écriture ne peut pas mouvementer le plan d'une autre société." }));
      } else if (!account.active) {
        findings.push(finding({ code: "ENTRY.ACCOUNT_ARCHIVED", severity: "BLOCKER", target: "lines", currentValue: `${account.code} — ${account.label}`, title: `Le compte ${account.code} est archivé.`, explanation: "Restaurez-le, ou choisissez un compte actif du plan de ce dossier.", accountingReason: "Un compte archivé n'est plus censé recevoir de mouvement, et le service comptable refusera l'écriture." }));
      } else if (account.postable === false) {
        // A warning, not a blocker: Wheat's own entry service accepts this,
        // and the review must not refuse what the application allows. It says
        // why the account is the wrong one and leaves the decision in place.
        findings.push(finding({ code: "ENTRY.ACCOUNT_NOT_POSTABLE", severity: "WARNING", target: "lines", currentValue: `${account.code} — ${account.label}`, title: `Le compte ${account.code} est un compte de regroupement.`, explanation: "Choisissez plutôt une subdivision mouvementable : c'est elle qui doit porter le mouvement.", accountingReason: "Un compte de regroupement additionne ses subdivisions ; le mouvementer directement rend la balance difficile à lire et à justifier." }));
      }
    }
    if (!findings.some((item) => item.code.startsWith("ENTRY.ACCOUNT"))) confirmed.push(`${accountIds.length} compte(s) du dossier, actifs et mouvementables.`);
  }

  const journalId = text(ctx.draft.journalId, 200);
  if (journalId) {
    const journal = await ctx.prisma.journal.findFirst({ where: { id: journalId, companyId: ctx.companyId }, select: { code: true, active: true, locked: true } });
    if (!journal) {
      findings.push(finding({ code: "ENTRY.JOURNAL_FOREIGN", severity: "BLOCKER", target: "journalId", title: "Le journal choisi n'appartient pas à ce dossier.", explanation: "Rechargez la liste des journaux.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
    } else if (!journal.active) {
      findings.push(finding({ code: "ENTRY.JOURNAL_ARCHIVED", severity: "BLOCKER", target: "journalId", currentValue: journal.code, title: `Le journal ${journal.code} est archivé.`, explanation: "Restaurez-le ou choisissez-en un autre.", accountingReason: "Un journal archivé n'accepte plus de nouvelles pièces." }));
    } else confirmed.push(`Journal ${journal.code} actif.`);
  }
  if (!text(ctx.draft.label, 300)) {
    findings.push(finding({ code: "ENTRY.LABEL_MISSING", severity: "BLOCKER", target: "label", title: "Le libellé de l'écriture est obligatoire.", explanation: "Il explique l'opération à qui relira le journal.", accountingReason: "Le libellé est la première justification d'une écriture dans le livre-journal." }));
  }
  findings.push(...await periodFindings(ctx, day(ctx.draft.date), "Écriture"));

  return {
    findings,
    checked: ["Nombre et forme des lignes", "Équilibre débit/crédit en centimes exacts", "Comptes du dossier, actifs et mouvementables", "Journal actif", "Libellé", "Exercice et verrou de période"],
    confirmed,
    modelContext: {
      label: text(ctx.draft.label, 300),
      date: text(ctx.draft.date, 40),
      totalDebit: money(totals.debit),
      totalCredit: money(totals.credit),
      lines: lines.slice(0, 40).map((line: any) => ({ label: text(line?.label, 120), debit: money(cents(line?.debitCents ?? line?.debit ?? 0)), credit: money(cents(line?.creditCents ?? line?.credit ?? 0)) })),
    },
  };
}

async function reviewInvoicePayload(ctx: ReviewContext): Promise<DeterministicReview> {
  const findings: WheatReviewFinding[] = [];
  const confirmed: string[] = [];
  const lines = Array.isArray(ctx.draft.lines) ? ctx.draft.lines : [];
  const kind = text(ctx.draft.kind, 20).toUpperCase();

  let ht = 0n;
  let vat = 0n;
  let ttc = 0n;
  lines.forEach((line: any, index: number) => {
    const lineHt = cents(line?.htCents ?? line?.ht);
    const lineVat = cents(line?.vatCents ?? line?.vat);
    const lineTtc = cents(line?.ttcCents ?? line?.ttc);
    if (lineHt === null || lineVat === null || lineTtc === null) {
      findings.push(finding({ code: "INVOICE.LINE_AMOUNT_INVALID", severity: "BLOCKER", target: `lines[${index}]`, title: `Ligne ${index + 1} : un montant n'est pas exact.`, explanation: "Saisissez des montants en dirhams avec au plus deux décimales.", accountingReason: "Wheat n'utilise que des centimes entiers : un arrondi flottant ferait dériver le total." }));
      return;
    }
    if (lineHt + lineVat !== lineTtc) {
      findings.push(finding({
        code: "INVOICE.LINE_TOTALS", severity: "BLOCKER", target: `lines[${index}].ttcCents`,
        title: `Ligne ${index + 1} : HT + TVA ne fait pas le TTC.`,
        explanation: `${money(lineHt)} + ${money(lineVat)} = ${money(lineHt + lineVat)} au lieu de ${money(lineTtc)}.`,
        currentValue: money(lineTtc), proposedValue: money(lineHt + lineVat),
        accountingReason: "Chaque ligne d'une facture doit se recouper au centime : le HT alimente le produit ou la charge, la TVA son compte dédié, le TTC le compte de tiers.",
      }));
    }
    ht += lineHt;
    vat += lineVat;
    ttc += lineTtc;
  });
  if (lines.length && !findings.some((item) => item.code.startsWith("INVOICE.LINE"))) {
    confirmed.push(`Contrôle HT + TVA = TTC vérifié sur ${lines.length} ligne(s) : ${money(ht)} + ${money(vat)} = ${money(ttc)}.`);
  }
  if (!lines.length) {
    findings.push(finding({ code: "INVOICE.NO_LINE", severity: "BLOCKER", target: "lines", title: "La facture n'a aucune ligne.", explanation: "Ajoutez au moins une ligne de prestation ou de marchandise.", accountingReason: "Une facture sans ligne n'enregistre ni produit ni charge." }));
  }

  const invoiceDate = day(ctx.draft.invoiceDate);
  const dueDate = day(ctx.draft.dueDate);
  if (invoiceDate && dueDate && dueDate < invoiceDate) {
    findings.push(finding({ code: "INVOICE.DUE_BEFORE_DATE", severity: "WARNING", target: "dueDate", currentValue: isoDay(dueDate), title: "L'échéance précède la date de facture.", explanation: `Facture du ${isoDay(invoiceDate)} échue le ${isoDay(dueDate)}.`, accountingReason: "L'échéance conditionne l'ancienneté de la créance et les relances." }));
  }

  const counterpartyId = text(ctx.draft.counterpartyId, 200);
  if (counterpartyId) {
    const counterparty = await ctx.prisma.counterparty.findFirst({ where: { id: counterpartyId, companyId: ctx.companyId }, select: { id: true, displayName: true, kind: true, active: true } });
    if (!counterparty) {
      findings.push(finding({ code: "INVOICE.COUNTERPARTY_FOREIGN", severity: "BLOCKER", target: "counterpartyId", title: "Le tiers choisi n'appartient pas à ce dossier.", explanation: "Rechargez la liste des tiers.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
    } else {
      if (!counterparty.active) {
        findings.push(finding({ code: "INVOICE.COUNTERPARTY_ARCHIVED", severity: "BLOCKER", target: "counterpartyId", currentValue: counterparty.displayName, title: `${counterparty.displayName} est archivé.`, explanation: "Restaurez le tiers avant de lui adresser une facture.", accountingReason: "Un tiers archivé n'est plus censé recevoir de nouveaux mouvements." }));
      }
      const expected = kind === "SALE" ? "CUSTOMER" : "SUPPLIER";
      if (kind && counterparty.kind !== "BOTH" && counterparty.kind !== expected) {
        findings.push(finding({
          code: "INVOICE.COUNTERPARTY_DIRECTION", severity: "WARNING", target: "counterpartyId",
          currentValue: `${counterparty.displayName} (${counterparty.kind})`,
          title: `${counterparty.displayName} est enregistré comme ${counterparty.kind === "CUSTOMER" ? "client" : "fournisseur"}.`,
          explanation: kind === "SALE"
            ? "Vous créez une facture de vente pour un tiers connu comme fournisseur. Vérifiez le sens de la pièce."
            : "Vous créez une facture d'achat pour un tiers connu comme client. Vérifiez le sens de la pièce.",
          accountingReason: "Une vente crée une créance client et de la TVA facturée ; un achat crée une dette fournisseur et de la TVA récupérable. Le sens détermine les deux.",
        }));
      } else if (counterparty.active) confirmed.push(`Tiers ${counterparty.displayName} cohérent avec le sens de la pièce.`);
    }
  } else {
    findings.push(finding({ code: "INVOICE.COUNTERPARTY_MISSING", severity: "BLOCKER", target: "counterpartyId", title: "Aucun tiers n'est choisi.", explanation: "Sélectionnez le client ou le fournisseur concerné.", accountingReason: "La créance ou la dette est portée par un compte auxiliaire rattaché au tiers." }));
  }

  const invoiceNo = text(ctx.draft.invoiceNo, 100);
  if (invoiceNo && counterpartyId) {
    const duplicate = await ctx.prisma.invoice.findFirst({
      where: { companyId: ctx.companyId, counterpartyId, invoiceNo, ...(text(ctx.draft.id, 200) ? { id: { not: text(ctx.draft.id, 200) } } : {}) },
      select: { id: true, invoiceNo: true, ttcCents: true, lifecycleStatus: true },
    });
    if (duplicate) {
      findings.push(finding({
        code: "INVOICE.DUPLICATE_NUMBER", severity: "WARNING", target: "invoiceNo", currentValue: invoiceNo,
        title: `Le numéro ${invoiceNo} existe déjà pour ce tiers.`,
        explanation: `Facture existante de ${money(BigInt(duplicate.ttcCents ?? 0n))} (${duplicate.lifecycleStatus}). Vérifiez qu'il ne s'agit pas de la même pièce saisie deux fois.`,
        evidence: [`Facture ${duplicate.invoiceNo} déjà enregistrée pour ce tiers`],
        accountingReason: "Une pièce comptabilisée deux fois double la créance et la TVA de la période.",
      }));
    } else confirmed.push(`Numéro ${invoiceNo} inédit pour ce tiers.`);
  }
  findings.push(...await periodFindings(ctx, invoiceDate, "Facture"));

  return {
    findings,
    checked: ["Contrôle HT + TVA = TTC par ligne et au total", "Tiers du dossier, actif et du bon sens", "Doublon de numéro pour le même tiers", "Ordre des dates", "Exercice et verrou de période"],
    confirmed,
    modelContext: { kind, invoiceNo, invoiceDate: isoDay(invoiceDate), ht: money(ht), vat: money(vat), ttc: money(ttc), lines: lines.slice(0, 40).map((line: any) => ({ description: text(line?.description, 120), ht: money(cents(line?.htCents ?? line?.ht)), vat: money(cents(line?.vatCents ?? line?.vat)), ttc: money(cents(line?.ttcCents ?? line?.ttc)) })) },
  };
}

async function reviewPaymentPayload(ctx: ReviewContext): Promise<DeterministicReview> {
  const findings: WheatReviewFinding[] = [];
  const confirmed: string[] = [];
  const amount = cents(ctx.draft.amountCents ?? ctx.draft.amount);
  const kind = text(ctx.draft.kind, 20).toUpperCase();
  if (amount === null) {
    findings.push(finding({ code: "PAYMENT.AMOUNT_INVALID", severity: "BLOCKER", target: "amountCents", currentValue: String(ctx.draft.amountCents ?? ctx.draft.amount ?? ""), title: "Le montant du règlement n'est pas exact.", explanation: "Saisissez un montant en dirhams avec au plus deux décimales.", accountingReason: "Wheat n'utilise que des centimes entiers." }));
  } else if (amount <= 0n) {
    findings.push(finding({ code: "PAYMENT.AMOUNT_NOT_POSITIVE", severity: "BLOCKER", target: "amountCents", currentValue: money(amount), title: "Le montant doit être strictement positif.", explanation: "Le sens du règlement est porté par son type, pas par le signe du montant.", accountingReason: "Un encaissement négatif serait en réalité un décaissement : le type de règlement l'exprime déjà." }));
  } else confirmed.push(`Montant du règlement : ${money(amount)}.`);

  const counterpartyId = text(ctx.draft.counterpartyId, 200);
  if (counterpartyId) {
    const counterparty = await ctx.prisma.counterparty.findFirst({ where: { id: counterpartyId, companyId: ctx.companyId }, select: { displayName: true, kind: true, active: true } });
    if (!counterparty) {
      findings.push(finding({ code: "PAYMENT.COUNTERPARTY_FOREIGN", severity: "BLOCKER", target: "counterpartyId", title: "Le tiers choisi n'appartient pas à ce dossier.", explanation: "Rechargez la liste des tiers.", accountingReason: "Chaque opération est bornée au dossier ouvert." }));
    } else {
      const expected = kind === "RECEIPT" ? "CUSTOMER" : "SUPPLIER";
      if (kind && counterparty.kind !== "BOTH" && counterparty.kind !== expected) {
        findings.push(finding({
          code: "PAYMENT.COUNTERPARTY_DIRECTION", severity: "WARNING", target: "counterpartyId",
          currentValue: `${counterparty.displayName} (${counterparty.kind})`,
          title: `Le sens du règlement ne correspond pas au type du tiers.`,
          explanation: kind === "RECEIPT" ? "Un encaissement se reçoit d'un client." : "Un décaissement se verse à un fournisseur.",
          accountingReason: "L'encaissement solde une créance client ; le décaissement solde une dette fournisseur.",
        }));
      } else confirmed.push(`Tiers ${counterparty.displayName} cohérent avec le type de règlement.`);
    }
  } else {
    findings.push(finding({ code: "PAYMENT.COUNTERPARTY_MISSING", severity: "BLOCKER", target: "counterpartyId", title: "Aucun tiers n'est choisi.", explanation: "Sélectionnez le client ou le fournisseur concerné.", accountingReason: "Le règlement solde le compte auxiliaire d'un tiers précis." }));
  }
  if (!text(ctx.draft.method, 80)) {
    findings.push(finding({ code: "PAYMENT.METHOD_MISSING", severity: "BLOCKER", target: "method", title: "Le mode de règlement est obligatoire.", explanation: "Virement, chèque, espèces, effet : il figure sur la preuve de règlement.", accountingReason: "Le mode de règlement détermine le compte de trésorerie mouvementé et la preuve attendue." }));
  }
  findings.push(...await periodFindings(ctx, day(ctx.draft.paymentDate), "Règlement"));
  return {
    findings,
    checked: ["Exactitude et signe du montant", "Tiers du dossier et sens du règlement", "Mode de règlement", "Exercice et verrou de période"],
    confirmed,
    modelContext: { kind, amount: money(amount), method: text(ctx.draft.method, 80), reference: text(ctx.draft.reference, 160) },
  };
}

/* -------------------------------------------------------------- model review */

const MODEL_SYSTEM_PROMPT = [
  "Tu relis une saisie comptable marocaine avant son enregistrement dans Wheat.",
  "Tu es un relecteur : la personne reste l'auteur et décide seule.",
  "Réponds uniquement par un objet JSON : {\"findings\":[...]}, sans texte autour ni bloc de code.",
  "Chaque constat est {\"code\":\"MODEL.<MOT_CLE>\",\"severity\":\"INFO\"|\"WARNING\",\"title\":\"...\",\"explanation\":\"...\",\"target\":\"<champ>\",\"evidence\":\"extrait exact du contexte fourni\",\"proposedValue\":\"...\",\"confidence\":0-100,\"accountingReason\":\"...\"}.",
  "N'invente jamais un taux de TVA, une échéance, un identifiant légal, un compte comptable ni un solde : si l'information n'est pas dans le contexte, dis qu'elle doit être vérifiée.",
  "Ne propose « proposedValue » que pour une valeur de formulaire manifestement recopiée de travers, jamais pour une date, un taux, un compte ou un identifiant.",
  "Si tout paraît cohérent, réponds {\"findings\":[]}.",
  "Écris en français simple, sans jargon inutile.",
].join(" ");

/** Fields a model proposal may never rewrite, whatever it claims. */
const NEVER_AUTOFIX = /(date|rate|taux|vat|tva|account|compte|ice|taxid|identif|journal|amount|montant|cents|currency|devise|version)/i;

function normalizeForEvidence(value: string) {
  return value.toLocaleLowerCase("fr-FR").normalize("NFD").replace(new RegExp("[\u0300-\u036f]", "g"), "").replace(/[^a-z0-9]/g, "");
}

/**
 * Keeps only what the model can actually point at in the context it was given.
 *
 * Same gate as the OCR review: a model may re-read what Wheat showed it, not
 * compose something new. A finding whose evidence is absent from the context is
 * dropped rather than shown with a caveat.
 */
function corroboratedInContext(contextText: string, evidence: string) {
  const needle = normalizeForEvidence(evidence);
  if (needle.length < 4) return false;
  return normalizeForEvidence(contextText).includes(needle);
}

function parseModelFindings(reply: string, contextText: string, autofixAllowed: boolean): { findings: WheatReviewFinding[]; dropped: number } {
  const parsed = parseReviewJson(reply);
  const raw = Array.isArray(parsed?.findings) ? parsed!.findings : Array.isArray(parsed) ? parsed : [];
  const findings: WheatReviewFinding[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, 12)) {
    const entry = record(item);
    const title = text(entry.title, 180);
    if (!title) { dropped += 1; continue; }
    const evidence = text(entry.evidence, 400);
    if (!corroboratedInContext(contextText, evidence)) { dropped += 1; continue; }
    const target = text(entry.target, 80) || null;
    const proposed = text(entry.proposedValue, 200);
    const safeAutofix = Boolean(proposed) && autofixAllowed && Boolean(target) && !NEVER_AUTOFIX.test(target!);
    // A model never blocks. The strongest thing it can do is require an
    // acknowledgement or a reasoned override from the person.
    const severity: WheatReviewSeverity = text(entry.severity, 20).toUpperCase() === "WARNING" ? "WARNING" : "INFO";
    findings.push(finding({
      code: `MODEL.${text(entry.code, 60).replace(/^MODEL\./i, "").replace(/[^A-Za-z0-9_.]/g, "_").toUpperCase() || "OBSERVATION"}`,
      severity,
      origin: "MODEL",
      title,
      explanation: text(entry.explanation, 600) || title,
      target,
      evidence: [evidence],
      proposedValue: proposed || null,
      // Capped: a re-reading is never more certain than the dossier's own data.
      confidence: Math.max(10, Math.min(70, Number(entry.confidence) || 40)),
      accountingReason: text(entry.accountingReason, 400),
      safeAutofix,
      requiresAcknowledgement: severity === "WARNING",
    }));
  }
  return { findings, dropped };
}

/* ---------------------------------------------------------------- the service */

export function createWheatReviewService(options: WheatReviewServiceOptions) {
  async function review(payloadValue: unknown): Promise<WheatReviewResult> {
    const payload = record(payloadValue);
    const companyId = text(payload.companyId, 200);
    if (!companyId) throw new Error("La société active est requise pour la relecture.");
    const workflow = getWheatWorkflow(payload.workflowId ?? payload.channel);
    if (!workflow) throw new Error("Ce workflow n'est pas enregistré dans la matrice de relecture Wheat.");

    const prisma = await options.getPrisma();
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new Error("Le dossier actif n'existe plus.");

    const ctx: ReviewContext = { prisma, companyId, workflow, draft: record(payload.draft) };
    const reviewedAt = new Date().toISOString();

    if (workflow.classification === "EXEMPT") {
      return {
        version: "WHEAT_REVIEW_1", workflowId: workflow.id, workflowLabel: workflow.label, entity: workflow.entity,
        classification: workflow.classification, riskLevel: workflow.riskLevel,
        outcome: "PASS", blocked: false,
        checked: [], confirmed: [], findings: [], question: null,
        nextAction: workflow.reason,
        model: { ran: false, status: "NOT_APPLICABLE", provider: null, modelId: null, locality: "NONE", message: "Aucune relecture n'est requise pour cette opération.", detail: null },
        acknowledgementRequired: false, reviewedAt,
      };
    }

    let deterministic: DeterministicReview = { findings: [], checked: [], confirmed: [] };
    if (workflow.reviewKind) {
      try {
        deterministic = await REVIEWERS[workflow.reviewKind](ctx);
      } catch (error) {
        deterministic = {
          findings: [finding({
            code: "REVIEW.PREFLIGHT_FAILED", severity: "WARNING", target: null,
            title: "Le contrôle préalable n'a pas pu aller au bout.",
            explanation: `Wheat n'a pas pu lire tout le contexte nécessaire : ${error instanceof Error ? error.message : String(error)}. Les validations du service comptable restent appliquées à l'exécution.`,
            accountingReason: "Un contrôle incomplet est signalé plutôt que présenté comme réussi.",
          })],
          checked: [], confirmed: [],
        };
      }
    }

    // The model reads only what the deterministic pass already assembled and
    // bounded. It never receives the dossier at large.
    const modelContext = { workflow: workflow.label, entity: workflow.entity, ...(deterministic.modelContext ?? {}) };
    const contextText = JSON.stringify(modelContext);
    const autofixAllowed = workflow.riskLevel === 1 || workflow.reviewKind === "ENTRY_DRAFT" || workflow.reviewKind === "INVOICE_DRAFT" || workflow.reviewKind === "DOCUMENT_EXTRACTION";

    /**
     * Whether this operation warrants a model reading at all.
     *
     * The review used to call a model on every reviewed save, which meant that
     * correcting one field on one document — the most ordinary act in the
     * application, repeated dozens of times an hour — waited on a model in
     * order to be told that nothing was wrong. Routine work should not have to
     * pass an interview.
     *
     * A reading is warranted in three cases, and they are the three where a
     * second opinion can change what a person does:
     *
     *   - Wheat's own checks already found something. There is a concrete
     *     anomaly to interpret, and the model reads it in context.
     *   - The operation carries real accounting consequence — posting,
     *     voiding, reversing, reclassifying, anything at risk level 2 or 3.
     *     These are the writes that are expensive to undo.
     *   - The person asked for a review explicitly, rather than merely saving.
     *
     * Everything else — editing a draft, correcting an extraction, creating a
     * counterparty, all of them risk level 1 and all of them passing Wheat's
     * deterministic checks — is saved without a model, and says so. Note what
     * this does *not* weaken: the deterministic pass runs every time, and the
     * owning domain service still re-validates inside its own transaction. The
     * checks that can refuse an operation are untouched; only the optional
     * second reading is skipped, and only when there is nothing to read.
     */
    const requestedByUser = payload.requested === true;
    /*
     * Risk level 3 is where the ledger itself changes - posting, extourne,
     * voiding, confirming an import, activating a VAT configuration. Level 2
     * covers preparing and configuring: a draft entry, an uploaded document, a
     * bank account's settings. Those are saved dozens of times an hour and a
     * model has nothing to add to a draft that Wheat's own checks already
     * accepted, so asking one turned ordinary bookkeeping into a queue of
     * review dialogs. The threshold is the accounting effect, not the button.
     */
    const modelReadingSkipped = workflow.classification === "REVIEW_REQUIRED"
      && !requestedByUser
      && workflow.riskLevel < 3
      && deterministic.findings.length === 0;

    let model: WheatReviewModelRun = {
      ran: false, status: "UNAVAILABLE", provider: null, modelId: null, locality: "NONE",
      message: "Relecture IA indisponible : seuls les contrôles déterministes de Wheat ont été exécutés.",
      detail: null,
    };
    const modelFindings: WheatReviewFinding[] = [];
    if (modelReadingSkipped) {
      model = {
        ran: false, status: "NOT_NEEDED", provider: null, modelId: null, locality: "NONE",
        message: "Contrôles Wheat passés sans anomalie : aucune relecture par un modèle n'était nécessaire.",
        detail: null,
      };
    }

    if (workflow.classification === "REVIEW_REQUIRED" && options.resolveModel && !modelReadingSkipped) {
      let resolution: WheatReviewModelResolution;
      try {
        resolution = await options.resolveModel();
      } catch (error) {
        resolution = { channel: null, status: "FAILED", message: `Relecture IA indisponible : ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!resolution.channel) {
        model = { ...model, status: resolution.status, message: resolution.message, detail: resolution.detail ?? null };
      } else {
        const channel = resolution.channel;
        try {
          const reply = await channel.run({
            system: MODEL_SYSTEM_PROMPT,
            user: [
              `Opération : ${workflow.label}.`,
              `Contrôles déterministes déjà passés : ${deterministic.checked.join(" ; ") || "aucun"}.`,
              `Anomalies déjà détectées par Wheat : ${deterministic.findings.map((item) => item.title).join(" ; ") || "aucune"}.`,
              `Contexte (n'utilise rien d'autre) :\n${contextText.slice(0, 12_000)}`,
            ].join("\n\n"),
          });
          const parsed = parseModelFindings(reply, contextText, autofixAllowed);
          modelFindings.push(...parsed.findings);
          model = {
            ran: true,
            status: channel.locality === "LOCAL" ? "LOCAL" : "REMOTE",
            provider: channel.provider, modelId: channel.modelId, locality: channel.locality,
            // The provenance line and the discard count belong together: a
            // model that said three things Wheat threw away is part of what
            // the reader needs in order to judge the reading.
            message: [
              channel.locality === "LOCAL"
                ? "Relecture exécutée localement : aucune donnée n'a quitté cet ordinateur."
                : "Relecture exécutée à distance, avec votre consentement.",
              parsed.dropped ? `${parsed.dropped} observation(s) écartée(s), faute d'appui dans le dossier.` : "",
            ].filter(Boolean).join(" "),
            detail: `${channel.provider} · ${channel.modelId}`,
          };
        } catch (error) {
          // The sentence stays free of identifiers and of the provider's own
          // error text: both belong in the details disclosure, and a raw
          // transport error in front of somebody saving an invoice reads as a
          // failure of the accounting rather than of an optional second reading.
          model = {
            ran: false, status: "FAILED", provider: channel.provider, modelId: channel.modelId, locality: channel.locality,
            message: "La relecture par Wheat AI n'a pas abouti. Les contrôles comptables de Wheat, eux, ont bien été exécutés.",
            detail: `${channel.provider} · ${channel.modelId} · ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    } else if (workflow.classification === "DETERMINISTIC_ONLY") {
      model = { ran: false, status: "NOT_APPLICABLE", provider: null, modelId: null, locality: "NONE", message: workflow.reason, detail: null };
    }

    const findings = [...deterministic.findings, ...modelFindings];
    const blocked = findings.some((item) => item.severity === "BLOCKER");
    const acknowledgementRequired = findings.some((item) => item.severity === "WARNING" && item.requiresAcknowledgement);
    const outcome: WheatReviewOutcome = blocked ? "ATTENTION_REQUIRED" : acknowledgementRequired ? "WARNING" : "PASS";

    const firstBlocker = findings.find((item) => item.severity === "BLOCKER");
    const nextAction = blocked
      ? `Corrigez d'abord : ${firstBlocker?.title ?? "l'anomalie signalée"}`
      : acknowledgementRequired
        ? "Relisez les points signalés, puis confirmez pour continuer ou revenez au formulaire."
        : deterministic.question
          ? "Répondez à la question ci-dessus pour que Wheat puisse continuer sans supposer."
          : "Rien ne s'oppose à l'enregistrement. La confirmation habituelle reste demandée avant exécution.";

    const result: WheatReviewResult = {
      version: "WHEAT_REVIEW_1",
      workflowId: workflow.id,
      workflowLabel: workflow.label,
      entity: workflow.entity,
      classification: workflow.classification,
      riskLevel: workflow.riskLevel,
      outcome, blocked,
      checked: deterministic.checked,
      confirmed: deterministic.confirmed,
      findings,
      question: deterministic.question ?? null,
      nextAction,
      model,
      acknowledgementRequired,
      reviewedAt,
    };

    // A review that found nothing and ran no model leaves no trace: the audit
    // chain records decisions, not every keystroke. Anything else is recorded,
    // so a later reader can see what was raised before the mutation.
    if (outcome !== "PASS" || model.ran) {
      const actorUserId = (await options.getActorUserId?.()) ?? null;
      try {
        await prisma.$transaction(async (tx: any) => {
          await appendActivityAndAudit(tx, {
            companyId,
            actorUserId,
            action: "WHEAT_REVIEW_COMPLETED",
            entityType: workflow.entity,
            entityId: text(ctx.draft.id ?? ctx.draft.entryId ?? ctx.draft.documentId ?? ctx.draft.paymentId ?? ctx.draft.invoiceId, 200) || null,
            description: `Relecture ${workflow.label} : ${outcome}`,
            payload: {
              workflowId: workflow.id,
              classification: workflow.classification,
              outcome,
              blocked,
              findingCodes: findings.map((item) => item.code),
              model: { ran: model.ran, status: model.status, locality: model.locality, provider: model.provider, modelId: model.modelId },
            },
          });
        });
      } catch {
        // The audit append must never prevent the person from seeing the review.
      }
    }

    return result;
  }

  function coverage() {
    const base = wheatWorkflowCoverage();
    return {
      ...base,
      reviewKinds: [...new Set(WHEAT_WORKFLOW_REGISTRY.map((item) => item.reviewKind).filter(Boolean))].sort(),
      implementedReviewKinds: Object.keys(REVIEWERS).sort(),
    };
  }

  return { review, coverage };
}

export type WheatReviewService = ReturnType<typeof createWheatReviewService>;

export function registerWheatReviewIpc(options: WheatReviewServiceOptions & { ipcMain: IpcLike; serialize?: <T>(value: T) => T }) {
  const service = createWheatReviewService(options);
  const serialize = options.serialize ?? ((value: any) => value);
  options.ipcMain.handle(WHEAT_REVIEW_CHANNELS.run, async (_event, payload) => serialize(await service.review(payload)));
  options.ipcMain.handle(WHEAT_REVIEW_CHANNELS.coverage, async () => serialize(service.coverage()));
  options.ipcMain.handle(WHEAT_REVIEW_CHANNELS.model, async () => serialize(
    options.describeModel
      ? await options.describeModel()
      : { available: false, locality: "NONE", provider: null, modelId: null, selection: "NONE", message: "Aucune relecture IA n'est configurée." },
  ));
  return service;
}
