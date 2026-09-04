/**
 * Getting a dossier ready before it is opened for work.
 *
 * Guided work already prepares, validates and executes; what it could not do
 * was insist. A new dossier dropped the accountant into the full application
 * with no fiscal year, no chart and no journals, and left them to discover in
 * what order those had to be built — which is exactly the
 * knowledge the application is supposed to hold on their behalf. Guidance that
 * can be walked past is a suggestion, and a dossier that is worked in before it
 * is coherent produces entries that have to be unpicked later.
 *
 * So initial preparation is a gate, and everything after it is not. Until the
 * foundation exists and the accountant has approved it, Wheat keeps them in
 * guided work; from the moment they approve, the gate is gone for good and
 * guidance becomes a queue they may ignore entirely. The lock is not a
 * restriction on what the accountant is allowed to do. It is Wheat refusing to
 * pretend a dossier is ready when it is not.
 *
 * What is stored, and what is not.
 *
 * Progress is derived, exactly as `wheatJourney.ts` derives it: whether a
 * fiscal year exists is a question the fiscal year table answers, and storing a
 * duplicate answer beside it is how the two come to disagree. Only two facts
 * about setup cannot be read from any record — which situation the dossier is
 * starting from, and whether a person has approved the foundation — and both
 * are decisions rather than data, so both live in `GuidedStepDecision`, the
 * table that already exists for precisely that.
 *
 * The escape hatch is deliberate and narrow. A dossier whose company name is
 * TEST is somebody trying the application out, not a fiduciaire opening a
 * client file, and making them configure VAT before they can look around would
 * be an obstacle with nothing behind it. Such a dossier is unlocked from the
 * start and says so.
 */

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const WHEAT_SETUP_CHANNELS = {
  state: "wheat:setup:state",
  situation: "wheat:setup:situation",
  unlock: "wheat:setup:unlock",
} as const;

/** Where the dossier's accounting is starting from. */
export type DossierSituation = "NEW" | "EXISTING" | "DOCUMENTS";

const SITUATION_STEP = "setup:situation";
const UNLOCK_STEP = "setup:unlocked";

const SITUATIONS: Record<DossierSituation, { title: string; detail: string }> = {
  NEW: {
    title: "Cette société commence sa comptabilité de zéro.",
    detail: "Aucun historique à reprendre. Wheat prépare l'exercice, le plan comptable, les journaux et la TVA.",
  },
  EXISTING: {
    title: "J'ai déjà des données comptables et Wheat doit les reprendre.",
    detail: "Balance, grand livre, journaux, export d'un autre logiciel : Wheat les analyse et en déduit ce qu'il peut.",
  },
  DOCUMENTS: {
    title: "J'ai surtout des factures, des relevés et des pièces.",
    detail: "Wheat reconstruit l'environnement comptable à partir des pièces que vous lui donnez.",
  },
};

/**
 * A dossier named TEST is somebody trying Wheat, not opening a client file.
 *
 * Matched on the whole name rather than as a substring, so a real company
 * called "TEST INDUSTRIES SARL" is a real dossier and is gated like one.
 */
export function isTestDossier(name: unknown): boolean {
  return typeof name === "string" && name.trim().toUpperCase() === "TEST";
}

export type SetupStage = {
  id: string;
  title: string;
  /** Why this matters before the dossier is worked in. */
  why: string;
  done: boolean;
  /**
   * Whether the dossier cannot be opened without it.
   *
   * Only what makes an entry impossible blocks. Everything else is prepared,
   * tracked and raised by guided work, which is the right way to raise it —
   * a requirement that some legitimate dossiers can never satisfy is not a
   * requirement, it is a trap.
   */
  blocking: boolean;
};

export type DossierSetupState = {
  companyId: string;
  mode: "SETUP" | "UNLOCKED";
  isTestDossier: boolean;
  situation: DossierSituation | null;
  situationOptions: Array<{ value: DossierSituation; title: string; detail: string }>;
  /** The one thing Wheat needs answered right now, or null when nothing blocks. */
  question: { prompt: string; why: string; whereToFind: string } | null;
  stages: SetupStage[];
  readyToUnlock: boolean;
  /** Plain sentence naming what is still in the way, when something is. */
  blockingReason: string | null;
  /** Stage ids not yet done, blocking or not. */
  outstanding: string[];
  /** What the accountant is approving, summarised, when they are ready to. */
  summary: string[];
};

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} est requis.`);
  return value.trim();
}

export function createWheatDossierSetupService(getPrisma: GetPrisma) {
  async function decisions(prisma: PrismaLike, companyId: string) {
    const rows = await prisma.guidedStepDecision.findMany({
      where: { companyId, stepId: { in: [SITUATION_STEP, UNLOCK_STEP] } },
      select: { stepId: true, decision: true },
    });
    const byStep = new Map<string, string>(rows.map((row: any) => [row.stepId, row.decision]));
    return {
      situation: (byStep.get(SITUATION_STEP) ?? null) as DossierSituation | null,
      unlocked: byStep.get(UNLOCK_STEP) === "APPROVED",
    };
  }

  async function state(payloadValue: unknown): Promise<DossierSetupState> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = requiredId(input.companyId, "Le dossier");
    const prisma = await getPrisma();
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true },
    });
    if (!company) throw new Error("Le dossier actif n'existe plus.");

    const testDossier = isTestDossier(company.name);
    const { situation, unlocked } = await decisions(prisma, companyId);

    const [fiscalYears, accounts, journals, taxConfigurations, entries, invoices, documents] = await Promise.all([
      prisma.fiscalYear.count({ where: { companyId } }),
      prisma.account.count({ where: { companyId } }),
      prisma.journal.count({ where: { companyId } }),
      prisma.taxConfigurationVersion.count({ where: { companyId } }),
      prisma.entry.count({ where: { companyId } }),
      prisma.invoice.count({ where: { companyId } }),
      prisma.document.count({ where: { companyId } }),
    ]);

    /**
     * A dossier that is already being worked in has passed initial preparation,
     * whatever its configuration looks like.
     *
     * This is the difference between a gate and a trap. "Initial preparation"
     * means before there is any work — and a dossier holding entries, invoices
     * or documents plainly has some. Gating on configuration alone would lock
     * every dossier that predates this feature the moment Wheat updated:
     * a fiduciaire with fifty live client files, none of which happens to carry
     * a TaxConfigurationVersion row, would open Wheat one morning and find
     * every one of them shut. Nothing about those dossiers changed; only
     * Wheat's opinion of them would have.
     *
     * So the gate applies where it can help — a dossier with nothing in it yet —
     * and never retroactively to work already under way. Whatever is genuinely
     * missing from an in-use dossier still shows up in guided work, which
     * prepares it and asks, which is the right way to raise it.
     */
    const alreadyInUse = entries > 0 || invoices > 0 || documents > 0;

    /**
     * Having been in use is remembered, not merely observed.
     *
     * Observation alone is not stable: a dossier whose only entry is deleted
     * would stop looking "in use" and close again behind somebody who was
     * working in it a moment earlier. Passing initial preparation is a thing
     * that happened, so it is recorded the first time it is seen, and the
     * dossier stays open regardless of what is later deleted — which is the
     * same guarantee an explicit approval gives.
     */
    if (alreadyInUse && !unlocked && !testDossier) {
      await prisma.guidedStepDecision.upsert({
        where: { companyId_stepId: { companyId, stepId: UNLOCK_STEP } },
        create: { companyId, stepId: UNLOCK_STEP, decision: "APPROVED", note: "Dossier déjà en cours d'utilisation : préparation initiale dépassée." },
        update: {},
      });
    }

    // Derived from the records themselves, never from a stored checklist: a
    // duplicate answer beside the tables is how the two come to disagree.
    const stages: SetupStage[] = [
      {
        id: "situation",
        blocking: true,
        title: "Savoir d'où part ce dossier",
        why: "Une reprise de comptabilité et un dossier créé de zéro ne se préparent pas de la même façon ; Wheat ne peut pas le deviner.",
        done: situation !== null,
      },
      {
        id: "fiscal-year",
        blocking: true,
        title: "Un exercice comptable ouvert",
        why: "Sans exercice, aucune écriture n'a de période d'appartenance et aucun état ne peut être arrêté.",
        done: fiscalYears > 0,
      },
      {
        id: "chart",
        blocking: true,
        title: "Un plan comptable",
        why: "Une écriture s'impute sur des comptes ; sans plan, il n'y a rien sur quoi imputer.",
        done: accounts > 0,
      },
      {
        id: "journals",
        blocking: true,
        title: "Des journaux",
        why: "Chaque écriture appartient à un journal, qui porte sa numérotation continue.",
        done: journals > 0,
      },
      {
        id: "vat-configuration",
        blocking: false,
        title: "Un régime de TVA",
        why: "Le régime détermine les taux, les comptes de TVA et le rythme des déclarations. Le poser après coup oblige à reprendre les pièces déjà saisies.",
        done: taxConfigurations > 0,
      },
    ];

    // Only the blocking requirements decide whether the dossier can open. A VAT
    // regime is prepared and tracked like the rest, but a company that is not
    // VAT-registered — an auto-entrepreneur, an exempt activity — has none to
    // configure, and gating on it would shut such a dossier permanently.
    const missing = stages.filter((stage) => !stage.done && stage.blocking);
    const outstanding = stages.filter((stage) => !stage.done);
    const readyToUnlock = missing.length === 0;

    const question = situation === null && !unlocked && !testDossier && !alreadyInUse
      ? {
        prompt: "Comment démarrons-nous ce dossier ?",
        why: "Wheat prépare la suite différemment selon que la société commence sa comptabilité, qu'elle en a déjà une à reprendre, ou qu'elle n'a que des pièces à traiter.",
        whereToFind: "Si vous reprenez un dossier existant, la réponse est dans ce que le client vous a remis : une balance et un grand livre, ou seulement des factures et des relevés.",
      }
      : null;

    return {
      companyId,
      mode: unlocked || testDossier || alreadyInUse ? "UNLOCKED" : "SETUP",
      isTestDossier: testDossier,
      situation,
      situationOptions: (Object.keys(SITUATIONS) as DossierSituation[]).map((value) => ({ value, ...SITUATIONS[value] })),
      question,
      stages,
      readyToUnlock,
      blockingReason: readyToUnlock
        ? null
        : `Il manque encore : ${missing.map((stage) => stage.title.toLowerCase()).join(", ")}.`,
      // What is not yet done but does not stand in the way, so the interface can
      // say so rather than implying the dossier is finished.
      outstanding: outstanding.map((stage) => stage.id),
      summary: [
        `Dossier : ${company.name}`,
        situation ? `Point de départ : ${SITUATIONS[situation].title}` : "Point de départ : à préciser",
        `Exercices : ${fiscalYears}`,
        `Comptes : ${accounts}`,
        `Journaux : ${journals}`,
        `Configurations de TVA : ${taxConfigurations}`,
      ],
    };
  }

  /** Records which situation the dossier starts from. Changeable until unlock. */
  async function setSituation(payloadValue: unknown): Promise<DossierSetupState> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = requiredId(input.companyId, "Le dossier");
    const situation = String(input.situation ?? "") as DossierSituation;
    if (!SITUATIONS[situation]) throw new Error("Cette situation de départ n'est pas reconnue.");
    const prisma = await getPrisma();
    await prisma.guidedStepDecision.upsert({
      where: { companyId_stepId: { companyId, stepId: SITUATION_STEP } },
      create: { companyId, stepId: SITUATION_STEP, decision: situation, note: SITUATIONS[situation].title },
      update: { decision: situation, note: SITUATIONS[situation].title, decidedAt: new Date() },
    });
    return state({ companyId });
  }

  /**
   * Opens the dossier for ordinary work.
   *
   * Refused while the foundation is incomplete — not to withhold anything, but
   * because unlocking would be Wheat asserting that the dossier is ready when
   * its own records say otherwise. Once granted it is permanent: this is the
   * end of the gate, not a setting that can swing back and lock somebody out of
   * a dossier they are working in.
   */
  async function unlock(payloadValue: unknown): Promise<DossierSetupState> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = requiredId(input.companyId, "Le dossier");
    const current = await state({ companyId });
    if (current.mode === "UNLOCKED") return current;
    if (!current.readyToUnlock) {
      throw new Error(`Ce dossier n'est pas encore prêt à être ouvert. ${current.blockingReason ?? ""}`.trim());
    }
    const prisma = await getPrisma();
    await prisma.guidedStepDecision.upsert({
      where: { companyId_stepId: { companyId, stepId: UNLOCK_STEP } },
      create: { companyId, stepId: UNLOCK_STEP, decision: "APPROVED", note: "Fondation comptable approuvée par le comptable." },
      update: { decision: "APPROVED", note: "Fondation comptable approuvée par le comptable.", decidedAt: new Date() },
    });
    return state({ companyId });
  }

  return { state, setSituation, unlock };
}

export function registerWheatDossierSetupIpc(
  ipcMain: IpcLike,
  service: ReturnType<typeof createWheatDossierSetupService>,
) {
  ipcMain.handle(WHEAT_SETUP_CHANNELS.state, async (_event, payload) => service.state(payload));
  ipcMain.handle(WHEAT_SETUP_CHANNELS.situation, async (_event, payload) => service.setSituation(payload));
  ipcMain.handle(WHEAT_SETUP_CHANNELS.unlock, async (_event, payload) => service.unlock(payload));
}
