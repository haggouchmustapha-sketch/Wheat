/**
 * Every renderer-initiated Wheat workflow, and what review it must receive.
 *
 * Wheat's renderer can only reach the main process through the channels
 * `electron/preload.ts` exposes, so that list is the complete inventory of what
 * a person can make this application do. This registry classifies each one, and
 * `tests/wheat-workflow-coverage.spec.cjs` fails if the two ever drift apart —
 * a new channel without a classification is a workflow nobody decided about.
 *
 * The three classifications answer one question: what has to happen before the
 * mutation is allowed to run?
 *
 *  - `REVIEW_REQUIRED` — accounting or dossier content. The shared pipeline in
 *    `wheatReview.ts` runs a deterministic domain preflight and, when a model is
 *    genuinely available and privacy permits, a bounded contextual review.
 *  - `DETERMINISTIC_ONLY` — a mutation where a language model adds nothing a
 *    rule cannot state better (archiving a journal, locking a period). The
 *    deterministic preflight still runs and can still block.
 *  - `EXEMPT` — reads, navigation, lifecycle and credential operations. Every
 *    exemption carries the reason it is one.
 *
 * The classification governs the *interface*: it never replaces the validation
 * each domain service performs inside its own transaction. A review that says
 * "pass" authorises nothing; the owning service re-validates company, version,
 * status and period at execution exactly as it did before.
 */

export type WheatWorkflowClassification = "REVIEW_REQUIRED" | "DETERMINISTIC_ONLY" | "EXEMPT";

/**
 * Which deterministic preflight applies. Several workflows share one kind: a
 * sale draft and a purchase draft are checked by the same arithmetic.
 */
export type WheatReviewKind =
  | "COMPANY_IDENTITY"
  | "FISCAL_YEAR"
  | "PERIOD_LOCK"
  | "ACCOUNT"
  | "JOURNAL"
  | "ENTRY_DRAFT"
  | "DRAFT_DELETION"
  | "ENTRY_POST"
  | "ENTRY_REVERSE"
  | "INVOICE_DRAFT"
  | "INVOICE_POST"
  | "INVOICE_VOID"
  | "CREDIT_NOTE"
  | "PAYMENT_DRAFT"
  | "PAYMENT_POST"
  | "PAYMENT_ALLOCATE"
  | "PAYMENT_VOID"
  | "COUNTERPARTY"
  | "DOCUMENT_EXTRACTION"
  | "DOCUMENT_INVOICE_DRAFT"
  | "BANK_ACCOUNT"
  | "BANK_IMPORT"
  | "RECONCILIATION"
  | "BANK_EXCLUSION"
  | "TAX_CONFIGURATION"
  | "VAT_WORKPAPER"
  | "VAT_REVIEW"
  | "FISCAL_PACKAGE"
  | "FISCAL_TABLE"
  | "LEDGER_IMPORT"
  | "EMPLOYEE"
  | "PAYROLL_POST"
  | "PAYROLL_VOID"
  | "OPENING_BALANCE"
  | "FISCAL_CLOSE"
  | "EXPORT_PREPARATION"
  | "GUIDED_APPROVAL";

export type WheatWorkflowDefinition = {
  /** Stable identifier the renderer passes to the review pipeline. */
  id: string;
  /** The IPC channel that actually performs the workflow. */
  channel: string;
  /** Plain French, shown in the review surface header. */
  label: string;
  entity: string;
  mutating: boolean;
  classification: WheatWorkflowClassification;
  /** Why this classification. Mandatory for every workflow, exemptions included. */
  reason: string;
  reviewKind?: WheatReviewKind;
  /** The typed Wheat AI capability that mirrors this workflow, when one exists. */
  capabilityId?: string;
  /** Same scale as the capability registry: 0 read, 1 safe edit, 2 accounting, 3 high impact. */
  riskLevel: 0 | 1 | 2 | 3;
};

const READ_ONLY = "Lecture seule : ne modifie aucune donnée du dossier.";
const LIFECYCLE = "Opération de cycle de vie de l'application, sans contenu comptable à relire.";
const NATIVE_PICKER = "Sélection de fichier native : le contenu est relu au moment de l'import.";
const CREDENTIALS = "Gestion des identifiants et des modèles Wheat AI : aucune donnée comptable en jeu.";
const PREFERENCE = "Préférence locale d'affichage ou d'export, sans effet comptable.";
const REVIEW_REASON = "Contenu comptable ou de dossier : contrôle déterministe, puis relecture contextuelle si un modèle est disponible.";

function review(
  id: string,
  channel: string,
  label: string,
  entity: string,
  reviewKind: WheatReviewKind,
  riskLevel: 1 | 2 | 3,
  capabilityId?: string,
): WheatWorkflowDefinition {
  return { id, channel, label, entity, mutating: true, classification: "REVIEW_REQUIRED", reason: REVIEW_REASON, reviewKind, capabilityId, riskLevel };
}

function deterministic(
  id: string,
  channel: string,
  label: string,
  entity: string,
  reason: string,
  riskLevel: 1 | 2 | 3,
  reviewKind?: WheatReviewKind,
  capabilityId?: string,
): WheatWorkflowDefinition {
  return { id, channel, label, entity, mutating: true, classification: "DETERMINISTIC_ONLY", reason, reviewKind, capabilityId, riskLevel };
}

function exempt(id: string, channel: string, label: string, entity: string, reason: string, mutating = false): WheatWorkflowDefinition {
  return { id, channel, label, entity, mutating, classification: "EXEMPT", reason, riskLevel: mutating ? 1 : 0 };
}

export const WHEAT_WORKFLOW_REGISTRY: readonly WheatWorkflowDefinition[] = Object.freeze([
  // ------------------------------------------------------------- dossier
  review("company.create", "wheat:company:create", "Créer le dossier", "Company", "COMPANY_IDENTITY", 2),
  review("company.update", "wheat:settings:company:update", "Modifier l'identité du dossier", "Company", "COMPANY_IDENTITY", 2, "company.update"),
  review("fiscal_year.save", "wheat:settings:fiscal-year:save", "Créer ou modifier un exercice", "FiscalYear", "FISCAL_YEAR", 2, "fiscal_years.save"),
  deterministic("fiscal_period.lock", "wheat:fiscal-period:lock", "Verrouiller une période", "FiscalYear",
    "Le verrouillage est une règle de date, entièrement décidable sans modèle.", 2, "PERIOD_LOCK"),
  deterministic("fiscal_period.unlock", "wheat:fiscal-period:unlock", "Déverrouiller une période", "FiscalYear",
    "Le déverrouillage est une décision humaine motivée ; le contrôle porte sur le statut de l'exercice.", 3, "PERIOD_LOCK"),
  deterministic("company.delete", "wheat:company:delete", "Supprimer un dossier", "Company",
    "Suppression de dossier : décision humaine confirmée par l'interface, sans contenu comptable à interpréter.", 3),
  exempt("workspace.reset", "wheat:workspace:reset", "Réinitialiser l'espace de travail", "Workspace",
    "Opération destructive de cycle de vie local, confirmée explicitement : elle remplace la base, elle ne la corrige pas.", true),
  exempt("user.update", "wheat:user:update", "Modifier son nom d'utilisateur", "User", PREFERENCE, true),

  // ---------------------------------------------------- comptes & journaux
  review("account.save", "wheat:settings:account:save", "Créer ou modifier un compte", "Account", "ACCOUNT", 1, "accounts.save"),
  deterministic("account.archive", "wheat:settings:account:archive", "Archiver ou restaurer un compte", "Account",
    "Archivage réversible soumis aux règles du plan comptable ; un modèle n'ajoute rien à ces règles.", 3, undefined, "accounts.set_active"),
  review("journal.save", "wheat:settings:journal:save", "Créer ou modifier un journal", "Journal", "JOURNAL", 2, "journals.save"),
  deterministic("journal.archive", "wheat:settings:journal:archive", "Archiver ou restaurer un journal", "Journal",
    "Archivage réversible soumis aux règles de numérotation ; décidable sans modèle.", 3, undefined, "journals.set_active"),

  // ------------------------------------------------------------- écritures
  review("entry.create", "wheat:entry:create", "Créer une écriture", "Entry", "ENTRY_DRAFT", 2, "entries.create_draft"),
  review("entry.update_draft", "wheat:entry:update-draft", "Modifier un brouillon d'écriture", "Entry", "ENTRY_DRAFT", 2, "entries.update_draft"),
  review("entry.post", "wheat:entry:post", "Comptabiliser une écriture", "Entry", "ENTRY_POST", 3, "entries.post"),
  review("entry.reverse", "wheat:entry:reverse", "Extourner une écriture", "Entry", "ENTRY_REVERSE", 3, "entries.reverse"),
  deterministic("entry.duplicate", "wheat:entry:duplicate", "Dupliquer une écriture", "Entry",
    "La copie reprend une écriture déjà relue ; le nouveau brouillon est relu à son enregistrement.", 1, undefined, "entries.duplicate"),
  deterministic("entry.delete_draft", "wheat:entry:delete", "Supprimer un brouillon d'écriture", "Entry",
    "Seul un brouillon peut être supprimé : la règle est un contrôle de statut, pas une lecture de contenu.", 3, "DRAFT_DELETION", "entries.delete_draft"),
  review("opening.post", "wheat:opening:post", "Comptabiliser les à-nouveaux", "Entry", "OPENING_BALANCE", 3),

  // -------------------------------------------------- préparation initiale
  exempt("setup.state", "wheat:setup:state", "Lire l'état de préparation du dossier", "Company",
    "Lecture de l'avancement de la préparation initiale, déduit des enregistrements du dossier ; rien n'est modifié.", false),
  exempt("setup.situation", "wheat:setup:situation", "Indiquer d'où part le dossier", "Company",
    "Enregistre la réponse de la personne à une question que Wheat ne peut pas déduire ; aucune donnée comptable n'est créée ni modifiée.", true),
  exempt("setup.unlock", "wheat:setup:unlock", "Ouvrir le dossier au travail courant", "Company",
    "Approbation par le comptable d'une fondation que Wheat a déjà vérifiée poste par poste ; l'opération lève une restriction d'interface et n'écrit aucune donnée comptable.", true),

  // --------------------------------------------------- travail non terminé
  // A draft is what somebody has typed and not yet submitted. It carries no
  // accounting consequence — nothing is posted, nothing is numbered, no balance
  // moves — and reviewing a half-filled form would mean interrupting a person
  // mid-sentence to discuss a document they have not finished writing. The
  // review happens where it belongs: when the draft is submitted, through the
  // domain workflow that owns the write, unchanged.
  exempt("draft.save", "wheat:draft:save", "Conserver un formulaire en cours", "FormDraft",
    "Contenu d'un formulaire non soumis, conservé tel quel : aucune écriture, aucune numérotation, aucun solde n'en dépend. La relecture a lieu à la soumission.", true),
  exempt("draft.load", "wheat:draft:load", "Reprendre un formulaire en cours", "FormDraft",
    "Lecture du formulaire que la personne avait laissé en cours ; aucune donnée comptable n'est modifiée.", false),
  exempt("draft.list", "wheat:draft:list", "Lister les travaux non terminés", "FormDraft",
    "Lecture de la liste des formulaires non terminés du dossier ; aucune donnée comptable n'est modifiée.", false),
  exempt("draft.discard", "wheat:draft:discard", "Abandonner un formulaire en cours", "FormDraft",
    "Suppression d'une saisie non soumise, sur décision explicite de la personne ou après une soumission confirmée : aucune pièce comptable n'est détruite.", true),

  // ---------------------------------------------------- documents & OCR
  review("document.update_extraction", "wheat:document:update-extraction", "Corriger l'extraction d'un document", "Document", "DOCUMENT_EXTRACTION", 1, "documents.update_extraction"),
  review("document.create_invoice_draft", "wheat:document:create-invoice-draft", "Créer la facture brouillon d'un document", "Document", "DOCUMENT_INVOICE_DRAFT", 2, "documents.create_invoice_draft"),
  review("document.import", "wheat:documents:upload", "Importer et reconnaître des pièces", "Document", "DOCUMENT_EXTRACTION", 2),
  review("document.rerun_ocr", "wheat:smart-ocr:process", "Relancer la reconnaissance", "Document", "DOCUMENT_EXTRACTION", 1, "documents.rerun_ocr"),
  exempt("document.select_files", "wheat:documents:select-files", "Choisir plusieurs pièces", "Document", NATIVE_PICKER),
  exempt("document.select_folder", "wheat:documents:select-folder", "Choisir un dossier de pièces", "Document", NATIVE_PICKER),
  exempt("document.import_progress", "wheat:smart-ocr:progress", "Suivre un import par lot", "Document", READ_ONLY),
  exempt("document.page_preview", "wheat:document:page-preview", "Afficher une page du document d'origine", "Document", READ_ONLY),
  deterministic("document.delete", "wheat:document:delete", "Supprimer un document", "Document",
    "Refusée dès qu'une pièce est rattachée à une écriture ou une facture : contrôle de liens, pas de contenu.", 3),

  // ------------------------------------------------------ factures & avoirs
  review("invoice.create_draft", "wheat:invoice:create", "Créer une facture brouillon", "Invoice", "INVOICE_DRAFT", 1, "invoices.create_draft"),
  review("invoice.update_draft", "wheat:invoice:update", "Modifier une facture brouillon", "Invoice", "INVOICE_DRAFT", 1, "invoices.update_draft"),
  review("invoice.post", "wheat:invoice:post", "Comptabiliser une facture", "Invoice", "INVOICE_POST", 3, "invoices.post"),
  review("invoice.void", "wheat:invoice:void", "Annuler une facture comptabilisée", "Invoice", "INVOICE_VOID", 3, "invoices.void"),
  review("invoice.credit_create", "wheat:invoice:credit:create", "Créer un avoir", "Invoice", "CREDIT_NOTE", 1),
  review("invoice.credit_update", "wheat:invoice:credit:update", "Modifier un avoir brouillon", "Invoice", "CREDIT_NOTE", 1),
  review("invoice.credit_post", "wheat:invoice:credit:post", "Comptabiliser un avoir", "Invoice", "INVOICE_POST", 3),
  review("invoice.reclassify_draft", "wheat:invoice:reclassify-draft", "Reclasser un brouillon achat/vente", "Invoice", "DOCUMENT_INVOICE_DRAFT", 3, "invoices.reclassify_draft"),
  deterministic("invoice.delete_draft", "wheat:invoice:delete-draft", "Supprimer une facture brouillon", "Invoice",
    "Seul un brouillon sans imputation peut être supprimé : contrôle de statut.", 3, "DRAFT_DELETION", "invoices.delete_draft"),
  deterministic("invoice.artifact_export", "wheat:invoice:artifact:export", "Exporter un artefact de facture", "InvoiceArtifact",
    "Réexport d'un PDF déjà scellé : le contenu est figé et vérifié par son empreinte.", 1),

  // ------------------------------------------------------------ règlements
  review("payment.create_draft", "wheat:payment:create", "Créer un règlement brouillon", "Payment", "PAYMENT_DRAFT", 1, "payments.create_draft"),
  review("payment.update_draft", "wheat:payment:update", "Modifier un règlement brouillon", "Payment", "PAYMENT_DRAFT", 1, "payments.update_draft"),
  review("payment.post", "wheat:payment:post", "Comptabiliser un règlement", "Payment", "PAYMENT_POST", 3, "payments.post"),
  review("payment.allocate", "wheat:payment:allocate", "Imputer un règlement", "Payment", "PAYMENT_ALLOCATE", 2, "payments.allocate"),
  review("payment.void", "wheat:payment:void", "Annuler un règlement comptabilisé", "Payment", "PAYMENT_VOID", 3, "payments.void"),
  review("payment.reverse_allocation", "wheat:payment:reverse-allocation", "Annuler une imputation", "Payment", "PAYMENT_ALLOCATE", 3, "payments.reverse_allocation"),
  deterministic("payment.delete_draft", "wheat:payment:delete-draft", "Supprimer un règlement brouillon", "Payment",
    "Seul un brouillon sans imputation peut être supprimé : contrôle de statut.", 3, "DRAFT_DELETION", "payments.delete_draft"),

  // ----------------------------------------------------------------- tiers
  review("counterparty.create", "wheat:counterparty:create", "Créer un tiers", "Counterparty", "COUNTERPARTY", 1, "counterparties.create"),
  review("counterparty.update", "wheat:counterparty:update", "Modifier un tiers", "Counterparty", "COUNTERPARTY", 1, "counterparties.update"),
  deterministic("counterparty.archive", "wheat:counterparty:archive", "Archiver un tiers", "Counterparty",
    "Archivage refusé tant qu'un encours existe : contrôle de solde, pas d'interprétation.", 3, undefined, "counterparties.archive"),
  deterministic("counterparty.restore", "wheat:counterparty:restore", "Restaurer un tiers", "Counterparty",
    "Restauration d'un tiers déjà validé : rien de nouveau à relire.", 1, undefined, "counterparties.restore"),

  // -------------------------------------------------------- paie & salariés
  review("employee.save", "wheat:employee:save", "Créer ou modifier un salarié", "Employee", "EMPLOYEE", 1),
  review("payroll.post", "wheat:payroll:post", "Comptabiliser la paie", "PayrollRun", "PAYROLL_POST", 3),
  review("payroll.void", "wheat:payroll:void", "Annuler une paie comptabilisée", "PayrollRun", "PAYROLL_VOID", 3, "payroll.void"),
  deterministic("employee.delete", "wheat:employee:delete", "Supprimer un salarié", "Employee",
    "Refusée dès qu'une paie comptabilisée référence le salarié : contrôle de liens.", 3),

  // ------------------------------------------------ banque & rapprochement
  review("bank.statement_import", "wheat:bank:statement:import", "Importer un relevé bancaire", "BankStatementImport", "BANK_IMPORT", 2),
  review("bank.reconciliation_confirm", "wheat:bank:reconciliation:confirm", "Confirmer un rapprochement", "BankReconciliation", "RECONCILIATION", 2, "banking.confirm_reconciliation"),
  review("bank.movement_exclude", "wheat:bank:movement:exclude", "Exclure un mouvement bancaire", "BankMovement", "BANK_EXCLUSION", 2, "banking.exclude_movement"),
  review("bank.account_save", "wheat:settings:bank-account:save", "Créer ou modifier un compte bancaire", "BankAccount", "BANK_ACCOUNT", 2, "banking.save_account"),
  review("bank.account_set_ledger", "wheat:bank:account:set-ledger", "Associer le compte comptable bancaire", "BankAccount", "BANK_ACCOUNT", 2),
  review("bank.account_create_ledger", "wheat:bank:account:create-ledger", "Créer le sous-compte bancaire", "BankAccount", "BANK_ACCOUNT", 2),
  deterministic("bank.reconciliation_void", "wheat:bank:reconciliation:void", "Annuler un rapprochement", "BankReconciliation",
    "Annulation motivée d'un rapprochement actif ; l'historique est conservé par révision.", 3, undefined, "banking.void_reconciliation"),
  deterministic("bank.movement_restore", "wheat:bank:movement:restore", "Restaurer un mouvement exclu", "BankMovement",
    "Retour à l'état antérieur d'un mouvement déjà importé.", 1, undefined, "banking.restore_movement"),
  deterministic("bank.account_archive", "wheat:settings:bank-account:archive", "Archiver un compte bancaire", "BankAccount",
    "Archivage réversible d'un compte bancaire ; contrôle des mouvements en cours.", 3, undefined, "banking.set_account_active"),
  deterministic("bank.statement_prepare", "wheat:bank:statement:prepare", "Préparer l'import du relevé", "BankStatementImport",
    "Étape de préparation en mémoire : rien n'est écrit avant l'import lui-même, qui est relu.", 1),

  // ---------------------------------------------------- imports d'écritures
  review("ledger_import.stage", "wheat:ledger-import:stage", "Préparer un import d'écritures", "LedgerImportBatch", "LEDGER_IMPORT", 2),
  review("ledger_import.confirm", "wheat:ledger-import:confirm", "Confirmer un import d'écritures", "LedgerImportBatch", "LEDGER_IMPORT", 3, "imports.confirm"),
  deterministic("ledger_import.cancel", "wheat:ledger-import:cancel", "Annuler un import préparé", "LedgerImportBatch",
    "Abandon d'un lot encore en attente : rien n'a été comptabilisé.", 3, undefined, "imports.cancel"),

  // ----------------------------------------------------------- TVA & fiscal
  review("tax_config.save_draft", "wheat:tax:config:save-draft", "Enregistrer une configuration TVA", "TaxConfigurationVersion", "TAX_CONFIGURATION", 2),
  review("tax_config.activate", "wheat:tax:config:activate", "Activer une configuration TVA", "TaxConfigurationVersion", "TAX_CONFIGURATION", 3),
  deterministic("tax_config.clone", "wheat:tax:config:clone", "Cloner une configuration TVA", "TaxConfigurationVersion",
    "Copie fidèle d'une configuration existante ; le brouillon obtenu est relu à son enregistrement.", 1),
  review("vat.generate", "wheat:vat-workpaper:generate", "Préparer un dossier de travail TVA", "VatWorkpaper", "VAT_WORKPAPER", 2, "vat.generate"),
  review("vat.regenerate", "wheat:vat-workpaper:regenerate", "Régénérer un dossier de travail TVA", "VatWorkpaper", "VAT_WORKPAPER", 2, "vat.regenerate"),
  review("vat.add_adjustment", "wheat:vat-workpaper:add-adjustment", "Ajouter un ajustement TVA", "VatWorkpaper", "VAT_WORKPAPER", 2, "vat.add_adjustment"),
  review("vat.review", "wheat:vat-workpaper:review", "Revoir et verrouiller un dossier TVA", "VatWorkpaper", "VAT_REVIEW", 3, "vat.review"),
  deterministic("vat.attach_evidence", "wheat:vat-workpaper:attach-evidence", "Joindre une preuve TVA", "VatWorkpaper",
    "Rattachement d'un document déjà géré et empreinté par Wheat.", 2, undefined, "vat.attach_evidence"),
  deterministic("vat.remove_evidence", "wheat:vat-workpaper:remove-evidence", "Retirer une preuve TVA", "VatWorkpaper",
    "Retrait tracé d'une preuve ; la décision appartient au préparateur.", 3, undefined, "vat.remove_evidence"),
  deterministic("vat.return_to_draft", "wheat:vat-workpaper:return-to-draft", "Remettre un dossier TVA en brouillon", "VatWorkpaper",
    "Retour motivé au brouillon : contrôle de statut et de motif.", 3, undefined, "vat.return_to_draft"),
  deterministic("vat.reopen", "wheat:vat-workpaper:reopen", "Rouvrir un dossier TVA", "VatWorkpaper",
    "Réouverture réservée à un administrateur avec motif : règle de rôle et de statut.", 3, undefined, "vat.reopen"),
  deterministic("vat.record_filed", "wheat:vat-workpaper:record-filed", "Consigner un dépôt effectué", "VatWorkpaper",
    "Wheat ne dépose rien auprès de la DGI : l'utilisateur consigne un fait extérieur qu'il est seul à connaître.", 3),
  review("fiscal.generate_package", "wheat:fiscal-package:generate", "Préparer la liasse fiscale", "FiscalPackage", "FISCAL_PACKAGE", 2, "fiscal.generate_package"),
  review("fiscal.add_adjustment", "wheat:fiscal-package:adjustment", "Ajouter un retraitement fiscal", "FiscalAdjustment", "FISCAL_PACKAGE", 2, "fiscal.add_adjustment"),
  review("fiscal.save_table", "wheat:fiscal-table:save", "Enregistrer un tableau fiscal", "FiscalTableWorkpaper", "FISCAL_TABLE", 2, "fiscal.save_table"),
  review("fiscal.review_table", "wheat:fiscal-table:review", "Revoir et verrouiller un tableau fiscal", "FiscalTableWorkpaper", "FISCAL_TABLE", 3, "fiscal.review_table"),
  deterministic("fiscal.verify_adjustment", "wheat:fiscal-package:adjustment:verify", "Marquer un retraitement vérifié", "FiscalAdjustment",
    "Attestation humaine de vérification : c'est précisément la décision qu'un modèle ne peut pas prendre.", 3, undefined, "fiscal.verify_adjustment"),
  deterministic("fiscal.refresh_table", "wheat:fiscal-table:refresh", "Recalculer un tableau fiscal", "FiscalTableWorkpaper",
    "Recalcul déterministe depuis les écritures comptabilisées.", 2, undefined, "fiscal.refresh_table"),
  deterministic("fiscal.mark_not_applicable", "wheat:fiscal-table:not-applicable", "Marquer un tableau non applicable", "FiscalTableWorkpaper",
    "Décision de périmètre motivée par l'utilisateur : contrôle de statut et de motif.", 2, undefined, "fiscal.mark_not_applicable"),
  deterministic("fiscal.clear_not_applicable", "wheat:fiscal-table:not-applicable:clear", "Rendre un tableau à nouveau applicable", "FiscalTableWorkpaper",
    "Retour motivé à l'état applicable : contrôle de statut.", 3, undefined, "fiscal.clear_not_applicable"),
  deterministic("fiscal.reopen_table", "wheat:fiscal-table:reopen", "Rouvrir un tableau fiscal revu", "FiscalTableWorkpaper",
    "Réouverture motivée et tracée d'un tableau verrouillé.", 3, undefined, "fiscal.reopen_table"),
  deterministic("fiscal.attach_evidence", "wheat:fiscal-table:evidence:attach", "Joindre une preuve fiscale", "FiscalTableEvidence",
    "Rattachement d'un document déjà géré et empreinté par Wheat.", 2, undefined, "fiscal.attach_evidence"),
  deterministic("fiscal.remove_evidence", "wheat:fiscal-table:evidence:remove", "Retirer une preuve fiscale", "FiscalTableEvidence",
    "Retrait tracé d'une preuve ; la décision appartient au préparateur.", 3, undefined, "fiscal.remove_evidence"),
  review("fiscal.close", "wheat:fiscal-close:close", "Clôturer l'exercice", "FiscalYear", "FISCAL_CLOSE", 3),
  deterministic("fiscal.reopen_year", "wheat:fiscal-close:reopen", "Rouvrir un exercice clôturé", "FiscalYear",
    "Réouverture motivée et tracée : règle de rôle et de statut, pas d'interprétation comptable.", 3),

  // ------------------------------------------------------------ scellés
  deterministic("audit_seal.create", "wheat:audit-seal:create", "Sceller la chaîne d'audit", "AuditSeal",
    "Scellement cryptographique d'un état déjà écrit : rien à interpréter.", 2),

  // ------------------------------------------------------------- exports
  review("sage.export_profile_save", "wheat:sage-profile:save", "Enregistrer le profil d'export Sage/FEC", "SageExportProfile", "EXPORT_PREPARATION", 1),

  // ============================================================== EXEMPT ====
  exempt("bootstrap.read", "wheat:bootstrap", "Charger le dossier actif", "Company", READ_ONLY),
  exempt("settings.read", "wheat:settings:workspace", "Lire les paramètres", "Company", READ_ONLY),
  exempt("sage.export_set", "wheat:entry:sage-export-set", "Lire le jeu d'écritures exportable", "Entry", READ_ONLY),
  exempt("sage.export_profile_read", "wheat:sage-profile:get", "Lire le profil d'export Sage", "SageExportProfile", READ_ONLY),
  exempt("piece_number.preview", "wheat:piece-number:preview", "Prévisualiser un numéro de pièce", "Journal", READ_ONLY),
  exempt("counterparty.list", "wheat:counterparty:list", "Lister les tiers", "Counterparty", READ_ONLY),
  exempt("invoice.list", "wheat:invoice:list", "Lister les factures", "Invoice", READ_ONLY),
  exempt("invoice.settlement", "wheat:invoice:settlement", "Lire le règlement d'une facture", "Invoice", READ_ONLY),
  exempt("invoice.artifact_list", "wheat:invoice:artifact:list", "Lister les artefacts de facture", "InvoiceArtifact", READ_ONLY),
  exempt("invoice.artifact_verify", "wheat:invoice:artifact:verify", "Vérifier un artefact de facture", "InvoiceArtifact", READ_ONLY),
  exempt("payment.list", "wheat:payment:list", "Lister les règlements", "Payment", READ_ONLY),
  exempt("payroll.runs", "wheat:payroll:runs", "Lister les paies", "PayrollRun", READ_ONLY),
  exempt("ledger_import.list", "wheat:ledger-import:list", "Lister les imports d'écritures", "LedgerImportBatch", READ_ONLY),
  exempt("bank.reconciliation_workspace", "wheat:bank:reconciliation:workspace", "Ouvrir le rapprochement", "BankMovement", READ_ONLY),
  exempt("bank.reconciliation_candidates", "wheat:bank:reconciliation:candidates", "Calculer les candidats de rapprochement", "BankMovement", READ_ONLY),
  exempt("bank.statement_parse", "wheat:bank:statement:parse", "Analyser un relevé", "BankStatementImport", READ_ONLY),
  exempt("bank.statement_review", "wheat:bank:statement:review", "Contrôler un relevé avant import", "BankStatementImport", READ_ONLY),
  exempt("reporting.entries", "wheat:reporting:entries", "Rechercher des écritures", "Entry", READ_ONLY),
  exempt("reporting.entry_detail", "wheat:reporting:entry-detail", "Lire le détail d'une écriture", "Entry", READ_ONLY),
  exempt("reporting.trial_balance", "wheat:reporting:trial-balance", "Calculer la balance", "Report", READ_ONLY),
  exempt("reporting.general_ledger", "wheat:reporting:general-ledger", "Calculer le grand livre", "Report", READ_ONLY),
  exempt("reporting.journal", "wheat:reporting:journal", "Calculer le journal", "Report", READ_ONLY),
  exempt("reporting.aged_receivables", "wheat:reporting:aged-receivables", "Calculer l'ancienneté clients", "Report", READ_ONLY),
  exempt("reporting.aged_payables", "wheat:reporting:aged-payables", "Calculer l'ancienneté fournisseurs", "Report", READ_ONLY),
  exempt("reporting.counterparty_statement", "wheat:reporting:counterparty-statement", "Calculer un relevé de tiers", "Report", READ_ONLY),
  exempt("reporting.integrity", "wheat:reporting:integrity-checks", "Exécuter les contrôles d'intégrité", "Report", READ_ONLY),
  exempt("reporting.balance_family", "wheat:balance-family", "Calculer une vue de balance", "Report", READ_ONLY),
  exempt("reporting.bank_total", "wheat:bank-total", "Calculer la position bancaire", "Report", READ_ONLY),
  exempt("reporting.bilan", "wheat:bilan", "Calculer le bilan", "Report", READ_ONLY),
  exempt("opening.preview", "wheat:opening:preview", "Prévisualiser les à-nouveaux", "Entry", READ_ONLY),
  exempt("fiscal.validate_package", "wheat:fiscal-package:validate", "Valider la liasse", "FiscalPackage", READ_ONLY),
  exempt("fiscal.table_catalog", "wheat:fiscal-table:catalog", "Lire le catalogue des tableaux", "FiscalTableWorkpaper", READ_ONLY),
  exempt("fiscal.table_list", "wheat:fiscal-table:list", "Lister les tableaux fiscaux", "FiscalTableWorkpaper", READ_ONLY),
  exempt("fiscal.table_get", "wheat:fiscal-table:get", "Lire un tableau fiscal", "FiscalTableWorkpaper", READ_ONLY),
  exempt("fiscal.control", "wheat:fiscal-table:control", "Lire l'avancement de la liasse", "FiscalPackage", READ_ONLY),
  exempt("fiscal.close_preview", "wheat:fiscal-close:preview", "Prévisualiser la clôture", "FiscalYear", READ_ONLY),
  exempt("fiscal.close_runs", "wheat:fiscal-close:runs", "Lister les clôtures", "FiscalCloseRun", READ_ONLY),
  exempt("tax.workspace", "wheat:tax:workspace", "Ouvrir l'espace TVA", "TaxConfigurationVersion", READ_ONLY),
  exempt("vat.list", "wheat:vat-workpaper:list", "Lister les dossiers de travail TVA", "VatWorkpaper", READ_ONLY),
  exempt("vat.get", "wheat:vat-workpaper:get", "Lire un dossier de travail TVA", "VatWorkpaper", READ_ONLY),
  exempt("audit.events", "wheat:audit:events", "Lire l'historique d'audit", "AuditEvent", READ_ONLY),
  exempt("audit.verify", "wheat:audit:verify", "Vérifier la chaîne d'audit", "AuditChain", READ_ONLY),
  exempt("audit_seal.list", "wheat:audit-seal:list", "Lister les scellés d'audit", "AuditSeal", READ_ONLY),
  exempt("audit_seal.verify", "wheat:audit-seal:verify", "Vérifier un scellé d'audit", "AuditSeal", READ_ONLY),
  exempt("paddle.status", "wheat:paddle-ocr:status", "Lire l'état du moteur OCR local", "Ocr", READ_ONLY),
  exempt("database.path", "wheat:database:path", "Lire l'emplacement de la base", "Database", READ_ONLY),

  exempt("documents.select_file", "wheat:documents:select-file", "Choisir un document", "Document", NATIVE_PICKER),
  exempt("bank.statement_select_file", "wheat:bank:statement:select-file", "Choisir un relevé", "BankStatementImport", NATIVE_PICKER),
  exempt("import.select_file", "wheat:import:file", "Choisir un fichier à importer", "Import", NATIVE_PICKER),
  exempt("export.write_file", "wheat:export:file", "Écrire un fichier exporté", "Export",
    "Écriture d'octets déjà produits et relus par l'écran qui les a générés.", true),
  exempt("open_path", "wheat:open-path", "Ouvrir une pièce gérée", "Document",
    "Ouverture d'un fichier géré dans l'application système : aucune donnée modifiée."),

  exempt("backup.create", "wheat:backup:create", "Créer une sauvegarde", "Backup", LIFECYCLE, true),
  exempt("backup.restore", "wheat:backup:restore", "Restaurer une sauvegarde", "Backup", LIFECYCLE, true),
  exempt("window.control", "wheat:window:control", "Contrôler la fenêtre", "Window", LIFECYCLE),
  exempt("app.restart", "wheat:app:restart", "Redémarrer l'application", "App", LIFECYCLE, true),
  exempt("app.will_restart", "wheat:app:will-restart", "Signal de redémarrage imminent", "App", LIFECYCLE),
  exempt("update.status", "wheat:update:status", "Lire l'état de mise à jour", "Update", LIFECYCLE),
  exempt("update.check", "wheat:update:check", "Rechercher une mise à jour", "Update", LIFECYCLE, true),
  exempt("update.download", "wheat:update:download", "Télécharger la mise à jour proposée", "Update", LIFECYCLE, true),
  exempt("update.install", "wheat:update:install", "Installer la mise à jour vérifiée", "Update", LIFECYCLE, true),
  exempt("update.postpone", "wheat:update:postpone", "Reporter la mise à jour proposée", "Update", LIFECYCLE, true),
  exempt("update.confirm_startup", "wheat:update:confirm-startup", "Confirmer une mise à jour au démarrage", "Update", LIFECYCLE, true),
  exempt("update.acknowledge", "wheat:update:acknowledge", "Accuser réception d'une mise à jour", "Update", LIFECYCLE, true),

  exempt("security.status", "wheat:security:status", "Lire l'état du verrou local", "LocalSecurity", LIFECYCLE),
  exempt("security.setup", "wheat:security:setup", "Activer le verrou local", "LocalSecurity", LIFECYCLE, true),
  exempt("security.disable", "wheat:security:disable", "Désactiver le verrou local", "LocalSecurity", LIFECYCLE, true),
  exempt("security.unlock", "wheat:security:unlock", "Déverrouiller l'application", "LocalSecurity", LIFECYCLE, true),
  exempt("security.lock", "wheat:security:lock", "Verrouiller l'application", "LocalSecurity", LIFECYCLE, true),
  exempt("security.touch", "wheat:security:touch", "Prolonger la session déverrouillée", "LocalSecurity", LIFECYCLE, true),

  exempt("ai.status", "wheat:ai:status", "Lire l'état de Wheat AI", "WheatAi", CREDENTIALS),
  exempt("ai.benchmark", "wheat:ai:benchmark", "Mesurer le modèle local", "WheatAi", CREDENTIALS, true),
  exempt("ai.install", "wheat:ai:install", "Installer un modèle local", "WheatAi", CREDENTIALS, true),
  exempt("ai.uninstall", "wheat:ai:uninstall", "Désinstaller un modèle local", "WheatAi", CREDENTIALS, true),
  exempt("ai.select", "wheat:ai:select", "Choisir le modèle Wheat AI", "WheatAi", CREDENTIALS, true),
  exempt("ai.configure", "wheat:ai:configure", "Choisir le mode de permission Wheat AI", "WheatAi", CREDENTIALS, true),
  exempt("ai.ollama_start", "wheat:ai:ollama:start", "Démarrer le service Ollama", "WheatAi", CREDENTIALS, true),
  exempt("ai.tools", "wheat:ai:tools", "Lister les capacités typées", "WheatAi", READ_ONLY),
  exempt("ai.execute_tool", "wheat:ai:execute-tool", "Exécuter une capacité typée", "WheatAi",
    "Passe par le registre de capacités et la passerelle de domaine, qui appliquent déjà autorisation, portée société, version et confirmation.", true),
  exempt("ai.execute_plan", "wheat:ai:execute-plan", "Exécuter un plan de capacités", "WheatAi",
    "Chaque étape retraverse la passerelle de domaine et ses contrôles.", true),
  exempt("ai.chat", "wheat:ai:chat", "Poser une question à Wheat AI", "WheatAi",
    "Conversation : aucune écriture n'a lieu sans passer par une capacité typée confirmée.", true),
  exempt("ai.confirm_action", "wheat:ai:confirm-action", "Confirmer une action proposée", "WheatAi",
    "Confirmation humaine d'une proposition déjà prévisualisée par la passerelle.", true),
  exempt("ai.cancel_action", "wheat:ai:cancel-action", "Annuler une action proposée", "WheatAi", LIFECYCLE, true),
  exempt("ai.progress", "wheat:ai:progress", "Suivre la progression Wheat AI", "WheatAi", READ_ONLY),
  exempt("ai.provider_status", "wheat:ai:provider:status", "Lire l'état des fournisseurs", "WheatAi", CREDENTIALS),
  exempt("ai.provider_set_key", "wheat:ai:provider:set-key", "Enregistrer une clé de fournisseur", "WheatAi", CREDENTIALS, true),
  exempt("ai.provider_delete_key", "wheat:ai:provider:delete-key", "Supprimer une clé de fournisseur", "WheatAi", CREDENTIALS, true),
  exempt("ai.provider_test", "wheat:ai:provider:test", "Tester un fournisseur", "WheatAi", CREDENTIALS, true),
  exempt("ai.provider_preferences", "wheat:ai:provider:preferences", "Régler les préférences de fournisseur", "WheatAi", CREDENTIALS, true),
  exempt("ai.provider_models", "wheat:ai:provider:models", "Lister les modèles disponibles", "WheatAi", CREDENTIALS),

  exempt("review.run", "wheat:review:run", "Exécuter la relecture partagée", "Review",
    "La relecture ne modifie rien : elle lit le dossier et rend un avis."),
  exempt("review.coverage", "wheat:review:coverage", "Lire la matrice de couverture des relectures", "Review", READ_ONLY),
  exempt("review.model", "wheat:review:model", "Lire le modèle qui effectuera la relecture", "Review", READ_ONLY),
  exempt("journey.state", "wheat:journey:state", "Lire l'avancement du parcours guidé", "Journey", READ_ONLY),
  exempt("guided.state", "wheat:guided:state", "Lire l'état du travail guidé", "Journey", READ_ONLY),
  exempt("guided.prepare", "wheat:guided:prepare", "Préparer une étape guidée", "Journey",
    "La préparation lit le dossier et décrit ce qui serait fait ; elle ne modifie rien."),
  review("guided.approve", "wheat:guided:approve", "Approuver et exécuter une étape guidée", "Journey", "GUIDED_APPROVAL", 3),
  deterministic("guided.decide", "wheat:guided:decide", "Reporter ou écarter une étape guidée", "Journey",
    "Enregistre une décision humaine sur le parcours ; aucune écriture comptable n'en découle.", 1),
]);

const BY_CHANNEL = new Map(WHEAT_WORKFLOW_REGISTRY.map((item) => [item.channel, item]));
const BY_ID = new Map(WHEAT_WORKFLOW_REGISTRY.map((item) => [item.id, item]));

export function getWheatWorkflow(value: unknown): WheatWorkflowDefinition | null {
  const key = String(value ?? "").trim();
  return BY_ID.get(key) ?? BY_CHANNEL.get(key) ?? null;
}

/** The matrix the coverage test and the settings screen both read. */
export function wheatWorkflowCoverage() {
  const workflows = WHEAT_WORKFLOW_REGISTRY.map((item) => ({
    id: item.id,
    channel: item.channel,
    label: item.label,
    entity: item.entity,
    mutating: item.mutating,
    classification: item.classification,
    reason: item.reason,
    reviewKind: item.reviewKind ?? null,
    capabilityId: item.capabilityId ?? null,
    riskLevel: item.riskLevel,
  }));
  const count = (value: WheatWorkflowClassification) => workflows.filter((item) => item.classification === value).length;
  return {
    version: "WHEAT_WORKFLOW_COVERAGE_1",
    total: workflows.length,
    mutating: workflows.filter((item) => item.mutating).length,
    byClassification: {
      REVIEW_REQUIRED: count("REVIEW_REQUIRED"),
      DETERMINISTIC_ONLY: count("DETERMINISTIC_ONLY"),
      EXEMPT: count("EXEMPT"),
    },
    workflows,
  };
}
