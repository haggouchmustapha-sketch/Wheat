/**
 * The guided dossier journey, derived from the dossier itself.
 *
 * A person who has never kept books should not have to discover Wheat's
 * internal configuration order. This module answers one question — *what is the
 * single best next thing to do in this dossier?* — by reading the records that
 * already exist rather than by keeping a parallel checklist that could drift
 * away from reality.
 *
 * Nothing here is stored. Every stage status is recomputed from counts and
 * statuses, so restoring a backup, importing a batch or deleting a draft all
 * move the journey immediately and correctly. That is also why there is no
 * migration: a task table would be a second source of truth for facts the
 * ledger already holds.
 *
 * A stage is `BLOCKED` when an earlier stage it genuinely depends on is not
 * done, `NEEDS_ANSWER` when Wheat has hit something it must not guess (VAT
 * frequency, the bank-to-ledger mapping, the direction of a document), `READY`
 * when it can be started now, and `DONE` when the dossier shows it happened.
 */

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const WHEAT_JOURNEY_CHANNEL = "wheat:journey:state";

export type WheatJourneyStatus = "DONE" | "READY" | "BLOCKED" | "NEEDS_ANSWER";

export type WheatJourneyStage = {
  /** Stable id, usable as a test selector and as a resume point. */
  id: string;
  order: number;
  title: string;
  status: WheatJourneyStatus;
  /** Why this step matters, in one plain sentence. */
  why: string;
  /** What the dossier currently shows, in one line. */
  state: string;
  /** The single best next action, and the screen that performs it. */
  action: { label: string; target: string } | null;
  /** Set when `status` is `NEEDS_ANSWER`: the one focused question. */
  question: { prompt: string; why: string; whereToFind: string } | null;
  /** Set when `status` is `BLOCKED`: which stage has to happen first. */
  blockedBy: string | null;
};

export type WheatJourneyState = {
  version: "WHEAT_JOURNEY_1";
  companyId: string | null;
  companyName: string | null;
  stages: WheatJourneyStage[];
  completed: number;
  total: number;
  /** The one stage the Home page puts in front of the user. */
  next: WheatJourneyStage | null;
  /** Defaults Wheat applied on its own, so the user can see what it decided. */
  inferred: string[];
  computedAt: string;
};

export function createWheatJourneyService(options: { getPrisma: GetPrisma }) {
  async function state(payloadValue: unknown): Promise<WheatJourneyState> {
    const payload = payloadValue && typeof payloadValue === "object" ? payloadValue as Record<string, any> : {};
    const companyId = String(payload.companyId ?? "").trim();
    const computedAt = new Date().toISOString();

    if (!companyId) {
      const stage: WheatJourneyStage = {
        id: "dossier", order: 1, title: "Créer le dossier", status: "READY",
        why: "Un dossier porte une société : son plan comptable, ses journaux, ses exercices et ses pièces.",
        state: "Aucun dossier n'est ouvert.",
        action: { label: "Créer un dossier", target: "companies" },
        question: null, blockedBy: null,
      };
      return { version: "WHEAT_JOURNEY_1", companyId: null, companyName: null, stages: [stage], completed: 0, total: 1, next: stage, inferred: [], computedAt };
    }

    const prisma = await options.getPrisma();
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, ice: true, taxId: true, city: true, legalForm: true, vatFrequency: true },
    });
    if (!company) throw new Error("Le dossier actif n'existe plus.");

    const now = new Date();
    const [
      fiscalYears, accountCount, journalCount, taxConfigurations, bankAccounts,
      documentCount, unlinkedDocuments, invoiceCount, postedInvoices, draftInvoices,
      draftEntries, postedEntries, paymentCount, unallocatedPayments,
      movementCount, unreconciledMovements, vatWorkpapers, fiscalPackages, importBatches, openingRuns,
    ] = await Promise.all([
      prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { startsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true, status: true, lockedTo: true } }),
      prisma.account.count({ where: { companyId, active: true } }),
      prisma.journal.count({ where: { companyId, active: true } }),
      prisma.taxConfigurationVersion.findMany({ where: { companyId }, select: { id: true, status: true, filingFrequency: true, effectiveFrom: true }, orderBy: { effectiveFrom: "desc" }, take: 10 }),
      prisma.bankAccount.findMany({ where: { companyId, active: true }, select: { id: true, bankName: true, ledgerAccountId: true } }),
      prisma.document.count({ where: { companyId } }),
      prisma.document.count({ where: { companyId, invoiceId: null, entryId: null } }),
      prisma.invoice.count({ where: { companyId } }),
      prisma.invoice.count({ where: { companyId, lifecycleStatus: "POSTED" } }),
      prisma.invoice.count({ where: { companyId, lifecycleStatus: "DRAFT" } }),
      prisma.entry.count({ where: { companyId, status: "DRAFT" } }),
      prisma.entry.count({ where: { companyId, status: "POSTED" } }),
      prisma.payment.count({ where: { companyId } }),
      prisma.payment.count({ where: { companyId, lifecycleStatus: "POSTED", allocations: { none: { status: "ACTIVE" } } } }),
      prisma.bankMovement.count({ where: { bankAccount: { companyId } } }),
      prisma.bankMovement.count({ where: { bankAccount: { companyId }, status: { notIn: ["RECONCILED", "EXCLUDED"] } } }),
      prisma.vatWorkpaper.findMany({ where: { companyId }, select: { id: true, status: true, periodStart: true, periodEnd: true }, orderBy: { periodStart: "desc" }, take: 10 }),
      prisma.fiscalPackage.count({ where: { companyId } }),
      prisma.ledgerImportBatch.count({ where: { companyId, status: "STAGED" } }),
      prisma.openingBalanceRun.count({ where: { companyId } }),
    ]);

    const inferred: string[] = [];
    const activeYear = fiscalYears.find((year: any) => year.status === "OPEN" && new Date(year.startsOn) <= now && new Date(year.endsOn) >= now)
      ?? fiscalYears.find((year: any) => year.status === "OPEN")
      ?? null;
    if (activeYear) inferred.push(`Exercice retenu automatiquement : ${activeYear.label}.`);
    if (accountCount > 0) inferred.push(`Plan comptable installé : ${accountCount} comptes actifs.`);
    if (journalCount > 0) inferred.push(`${journalCount} journaux actifs disponibles.`);

    const identityComplete = Boolean(company.name && company.legalForm && company.city && company.ice && company.taxId);
    const activeTaxConfiguration = taxConfigurations.find((item: any) => item.status === "ACTIVE") ?? null;
    const mappedBank = bankAccounts.filter((item: any) => item.ledgerAccountId);
    const reviewedVat = vatWorkpapers.filter((item: any) => item.status === "REVIEWED").length;

    const stages: WheatJourneyStage[] = [];
    const add = (stage: WheatJourneyStage) => { stages.push(stage); return stage; };

    add({
      id: "dossier", order: 1, title: "Créer le dossier", status: "DONE",
      why: "Un dossier porte une société : son plan comptable, ses journaux, ses exercices et ses pièces.",
      state: `Dossier ouvert : ${company.name}.`,
      action: { label: "Voir les dossiers", target: "companies" }, question: null, blockedBy: null,
    });

    add({
      id: "identity", order: 2, title: "Compléter l'identité de la société", status: identityComplete ? "DONE" : "READY",
      why: "L'ICE, l'identifiant fiscal et l'adresse sont des mentions obligatoires des factures marocaines.",
      state: identityComplete
        ? `Identité complète (ICE ${company.ice}).`
        : `Manquant : ${[!company.ice && "ICE", !company.taxId && "identifiant fiscal", !company.city && "ville", !company.legalForm && "forme juridique"].filter(Boolean).join(", ")}.`,
      // `dossier-identity` is the identity editor itself, not a screen to go
       // hunting in. Sending this step to the generic settings tab left the
       // person to find the right panel on their own, having lost the guided
       // context they were working in.
      action: { label: identityComplete ? "Vérifier l'identité" : "Compléter l'identité", target: "dossier-identity" },
      question: null, blockedBy: null,
    });

    add({
      id: "fiscal-year", order: 3, title: "Créer l'exercice comptable", status: activeYear ? "DONE" : "READY",
      why: "Chaque écriture se rattache à un exercice ; sans exercice ouvert, rien ne peut être comptabilisé.",
      state: activeYear ? `Exercice ouvert : ${activeYear.label}.` : "Aucun exercice ouvert.",
      action: { label: activeYear ? "Voir les exercices" : "Créer l'exercice", target: "settings" },
      question: null, blockedBy: null,
    });

    const chartReady = accountCount > 0 && journalCount > 0;
    add({
      id: "chart", order: 4, title: "Installer le plan comptable et les journaux", status: chartReady ? "DONE" : "READY",
      why: "Le PCGE marocain et les journaux normaux (ventes, achats, banque, caisse, OD) donnent leur imputation à toutes les écritures.",
      state: chartReady ? `${accountCount} comptes et ${journalCount} journaux actifs.` : "Le plan comptable de départ n'est pas encore installé.",
      action: { label: chartReady ? "Ouvrir le plan comptable" : "Installer le plan de départ", target: "settings" },
      question: null, blockedBy: null,
    });

    add({
      id: "vat-configuration", order: 5, title: "Vérifier le régime et la configuration de TVA",
      status: activeTaxConfiguration ? "DONE" : company.vatFrequency ? "READY" : "NEEDS_ANSWER",
      why: "Les taux et les comptes de TVA sont datés : Wheat applique ceux en vigueur à la date de chaque pièce.",
      state: activeTaxConfiguration
        ? `Configuration active depuis le ${new Date(activeTaxConfiguration.effectiveFrom).toISOString().slice(0, 10)} (${activeTaxConfiguration.filingFrequency}).`
        : `Aucune configuration active. Rythme déclaré : ${company.vatFrequency ?? "inconnu"}.`,
      action: { label: activeTaxConfiguration ? "Ouvrir l'espace TVA" : "Configurer la TVA", target: "vat" },
      question: company.vatFrequency ? null : {
        prompt: "La société déclare-t-elle la TVA tous les mois ou tous les trimestres ?",
        why: "Le rythme découpe les périodes de TVA. Wheat ne peut pas le déduire des pièces et ne le suppose jamais.",
        whereToFind: "Il figure sur l'attestation fiscale de la société ou sur la dernière déclaration déposée.",
      },
      blockedBy: null,
    });

    add({
      id: "bank-account", order: 6, title: "Ajouter la banque et la relier au plan comptable",
      status: mappedBank.length ? "DONE" : bankAccounts.length ? "NEEDS_ANSWER" : "READY",
      why: "Le rapprochement relie les mouvements du relevé aux lignes du compte de banque du grand livre : sans cette association, il n'a rien à comparer.",
      state: mappedBank.length
        ? `${mappedBank.length} compte(s) bancaire(s) reliés au plan comptable.`
        : bankAccounts.length
          ? `${bankAccounts.length} compte(s) bancaire(s) sans compte comptable associé.`
          : "Aucun compte bancaire enregistré.",
      action: { label: bankAccounts.length ? "Associer le compte comptable" : "Ajouter un compte bancaire", target: "settings" },
      question: mappedBank.length || !bankAccounts.length ? null : {
        prompt: `Quel compte du plan comptable correspond au compte ${bankAccounts[0]?.bankName ?? "bancaire"} ?`,
        why: "Wheat n'attribue jamais un compte de trésorerie de sa propre initiative : une association erronée fausserait à la fois la position de trésorerie et le rapprochement.",
        whereToFind: "C'est une subdivision de la classe 5 (comptes de trésorerie) ; Wheat peut la créer sous le compte 5141 si elle n'existe pas.",
      },
      blockedBy: null,
    });

    add({
      id: "opening", order: 7, title: "Reprendre les soldes d'ouverture",
      status: openingRuns > 0 || postedEntries > 0 ? "DONE" : activeYear ? "READY" : "BLOCKED",
      why: "Les à-nouveaux reportent la situation arrêtée à la clôture précédente ; sans eux le bilan démarre à zéro.",
      state: openingRuns > 0 ? `${openingRuns} reprise(s) d'à-nouveaux enregistrée(s).` : postedEntries > 0 ? `${postedEntries} écritures comptabilisées.` : "Aucune reprise ni écriture comptabilisée.",
      action: { label: "Ouvrir la reprise des à-nouveaux", target: "books" },
      question: null, blockedBy: activeYear ? null : "fiscal-year",
    });

    add({
      id: "documents", order: 8, title: "Importer et relire les pièces",
      status: documentCount === 0 ? "READY" : unlinkedDocuments > 0 ? "READY" : "DONE",
      why: "La pièce justificative est ce qui rend l'écriture défendable ; sa reconnaissance n'est qu'une proposition à confirmer.",
      state: documentCount === 0 ? "Aucune pièce importée." : `${documentCount} pièce(s), dont ${unlinkedDocuments} encore à traiter.`,
      action: { label: documentCount === 0 ? "Importer des pièces" : "Traiter les pièces", target: "documents" },
      question: null, blockedBy: null,
    });

    add({
      id: "invoices", order: 9, title: "Créer et relire les brouillons de factures",
      status: invoiceCount === 0 ? (documentCount > 0 ? "READY" : "BLOCKED") : draftInvoices > 0 ? "READY" : "DONE",
      why: "La facture crée la créance client ou la dette fournisseur, et sépare le HT, la TVA et le TTC.",
      state: invoiceCount === 0 ? "Aucune facture enregistrée." : `${invoiceCount} facture(s), dont ${draftInvoices} en brouillon et ${postedInvoices} comptabilisées.`,
      action: { label: draftInvoices > 0 ? "Relire les brouillons" : "Ouvrir la facturation", target: "billing" },
      question: null, blockedBy: invoiceCount === 0 && documentCount === 0 ? "documents" : null,
    });

    add({
      id: "entries", order: 10, title: "Comptabiliser les brouillons d'écritures",
      status: draftEntries > 0 ? "READY" : postedEntries > 0 ? "DONE" : "READY",
      why: "Un brouillon n'a aucun effet comptable : il ne compte ni dans la balance, ni dans la TVA, ni dans la liasse.",
      state: draftEntries > 0 ? `${draftEntries} brouillon(s) à contrôler.` : `${postedEntries} écriture(s) comptabilisées.`,
      action: { label: draftEntries > 0 ? "Contrôler les brouillons" : "Ouvrir les écritures", target: "entries" },
      question: null, blockedBy: null,
    });

    add({
      id: "payments", order: 11, title: "Enregistrer et imputer les règlements",
      status: paymentCount === 0 ? (postedInvoices > 0 ? "READY" : "BLOCKED") : unallocatedPayments > 0 ? "READY" : "DONE",
      why: "La facture et son règlement sont deux événements distincts : l'imputation solde la créance ou la dette.",
      state: paymentCount === 0 ? "Aucun règlement enregistré." : `${paymentCount} règlement(s), dont ${unallocatedPayments} sans imputation.`,
      action: { label: unallocatedPayments > 0 ? "Imputer les règlements" : "Ouvrir les règlements", target: "billing" },
      question: null, blockedBy: paymentCount === 0 && postedInvoices === 0 ? "invoices" : null,
    });

    add({
      id: "reconciliation", order: 12, title: "Importer le relevé et rapprocher la banque",
      status: movementCount === 0 ? (mappedBank.length ? "READY" : "BLOCKED") : unreconciledMovements > 0 ? "READY" : "DONE",
      why: "Le rapprochement confronte la preuve bancaire aux écritures : c'est le contrôle qui révèle les oublis et les doublons.",
      state: movementCount === 0 ? "Aucun mouvement bancaire importé." : `${movementCount} mouvement(s), dont ${unreconciledMovements} à rapprocher.`,
      action: { label: movementCount === 0 ? "Importer un relevé" : "Ouvrir le rapprochement", target: "reconciliation" },
      question: null, blockedBy: movementCount === 0 && !mappedBank.length ? "bank-account" : null,
    });

    add({
      id: "vat-workpaper", order: 13, title: "Préparer et relire le dossier de travail TVA",
      status: reviewedVat > 0 ? "DONE" : vatWorkpapers.length ? "READY" : activeTaxConfiguration ? "READY" : "BLOCKED",
      why: "Le dossier de travail rassemble la TVA facturée, la TVA récupérable et leurs preuves. Il reste interne : Wheat ne télédéclare rien.",
      state: vatWorkpapers.length ? `${vatWorkpapers.length} période(s) préparée(s), dont ${reviewedVat} revue(s).` : "Aucune période de TVA préparée.",
      action: { label: "Ouvrir la TVA", target: "vat" },
      question: null, blockedBy: activeTaxConfiguration ? null : "vat-configuration",
    });

    add({
      id: "reports", order: 14, title: "Produire les états et les exports",
      status: postedEntries > 0 ? "READY" : "BLOCKED",
      why: "Balance, grand livre, bilan et CPC ne se calculent que sur des écritures comptabilisées, au centime exact.",
      state: postedEntries > 0 ? `${postedEntries} écriture(s) comptabilisées disponibles.` : "Aucune écriture comptabilisée à restituer.",
      action: { label: "Ouvrir les rapports", target: "books" },
      question: null, blockedBy: postedEntries > 0 ? null : "entries",
    });

    add({
      id: "closing", order: 15, title: "Contrôler la clôture et sauvegarder",
      status: draftEntries === 0 && importBatches === 0 && postedEntries > 0 ? "READY" : "BLOCKED",
      why: "La clôture arrête le résultat de l'exercice. Une sauvegarde prise avant est le seul retour en arrière possible.",
      state: [
        draftEntries > 0 ? `${draftEntries} brouillon(s) restants` : "aucun brouillon",
        importBatches > 0 ? `${importBatches} import(s) non confirmés` : "aucun import en attente",
        fiscalPackages > 0 ? `${fiscalPackages} liasse(s) préparée(s)` : "aucune liasse préparée",
      ].join(", ") + ".",
      action: { label: "Ouvrir la liasse et la clôture", target: "fiscal" },
      question: null,
      blockedBy: draftEntries > 0 ? "entries" : importBatches > 0 ? "documents" : postedEntries === 0 ? "entries" : null,
    });

    const completed = stages.filter((stage) => stage.status === "DONE").length;
    // The one thing to do now: an unanswered question first — Wheat is stuck
    // without it — then the earliest stage that can actually be started.
    const next = stages.find((stage) => stage.status === "NEEDS_ANSWER")
      ?? stages.find((stage) => stage.status === "READY")
      ?? stages.find((stage) => stage.status === "BLOCKED")
      ?? null;

    return {
      version: "WHEAT_JOURNEY_1",
      companyId: company.id,
      companyName: company.name,
      stages,
      completed,
      total: stages.length,
      next,
      inferred,
      computedAt,
    };
  }

  return { state };
}

export function registerWheatJourneyIpc(options: { ipcMain: IpcLike; getPrisma: GetPrisma; serialize?: <T>(value: T) => T }) {
  const service = createWheatJourneyService(options);
  const serialize = options.serialize ?? ((value: any) => value);
  options.ipcMain.handle(WHEAT_JOURNEY_CHANNEL, async (_event, payload) => serialize(await service.state(payload)));
  return service;
}
