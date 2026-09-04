export type WheatAiRiskLevel = 0 | 1 | 2 | 3;
export type WheatAiCapabilityMode = "READ" | "SAFE_EDIT" | "ACCOUNTING_MUTATION" | "HIGH_IMPACT" | "NAVIGATION";
export type WheatAiIntent = "INFORMATION" | "PLANNING" | "PREVIEW" | "EXECUTION";

export type WheatAiJsonSchema = {
  type: "object" | "array" | "string" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, WheatAiJsonSchema>;
  required?: string[];
  items?: WheatAiJsonSchema;
  enum?: Array<string | number | boolean>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
};

export type WheatAiCapabilityDefinition = {
  id: string;
  description: string;
  category: string;
  mode: WheatAiCapabilityMode;
  riskLevel: WheatAiRiskLevel;
  requiredRoles: readonly string[];
  companyScoped: true;
  confirmation: "NEVER" | "BY_PERMISSION_MODE" | "ALWAYS";
  supportsDryRun: boolean;
  reversible: boolean;
  auditCategory: string;
  inputSchema: WheatAiJsonSchema;
  outputSchema: WheatAiJsonSchema;
  navigationTarget?: string;
  keywords: readonly string[];
};

const viewer = ["ADMIN", "ACCOUNTANT", "VIEWER"] as const;
const editor = ["ADMIN", "ACCOUNTANT"] as const;
const admin = ["ADMIN"] as const;
const emptyObject: WheatAiJsonSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
const objectOutput: WheatAiJsonSchema = { type: "object", additionalProperties: true };
const arrayOutput: WheatAiJsonSchema = { type: "array", items: objectOutput, maxItems: 250 };
const stringId: WheatAiJsonSchema = { type: "string", minLength: 1, maxLength: 200 };
const shortText: WheatAiJsonSchema = { type: "string", minLength: 1, maxLength: 180 };
const longText: WheatAiJsonSchema = { type: "string", minLength: 1, maxLength: 1000 };
const isoDay: WheatAiJsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const centString: WheatAiJsonSchema = { type: "string", pattern: "^-?\\d+$", maxLength: 30 };
const version: WheatAiJsonSchema = { type: "integer", minimum: 0, maximum: 2_147_483_647 };

function schema(properties: Record<string, WheatAiJsonSchema>, required: string[] = []): WheatAiJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function capability(input: Omit<WheatAiCapabilityDefinition, "companyScoped" | "outputSchema" | "keywords"> & { keywords?: readonly string[]; outputSchema?: WheatAiJsonSchema }): WheatAiCapabilityDefinition {
  return { ...input, companyScoped: true, outputSchema: input.outputSchema ?? objectOutput, keywords: input.keywords ?? [] };
}

const arrayReadIds = new Set(["accounts.search", "journals.list", "fiscal_years.list", "documents.search", "vat.workpapers", "payroll.runs", "audit.events"]);
const read = (id: string, category: string, description: string, inputSchema = emptyObject, keywords: readonly string[] = []): WheatAiCapabilityDefinition => capability({
  id, category, description, inputSchema, keywords, outputSchema: arrayReadIds.has(id) ? arrayOutput : objectOutput, mode: "READ", riskLevel: 0, requiredRoles: viewer, confirmation: "NEVER", supportsDryRun: false, reversible: true, auditCategory: `WHEAT_AI_READ_${category.toUpperCase()}`,
});

const mutate = (
  id: string,
  category: string,
  description: string,
  riskLevel: 1 | 2 | 3,
  inputSchema: WheatAiJsonSchema,
  options: { roles?: readonly string[]; reversible?: boolean; keywords?: readonly string[] } = {},
): WheatAiCapabilityDefinition => capability({
  id, category, description, inputSchema, keywords: options.keywords,
  mode: riskLevel === 1 ? "SAFE_EDIT" : riskLevel === 2 ? "ACCOUNTING_MUTATION" : "HIGH_IMPACT",
  riskLevel, requiredRoles: options.roles ?? editor, confirmation: riskLevel === 3 ? "ALWAYS" : "BY_PERMISSION_MODE", supportsDryRun: true,
  reversible: options.reversible ?? riskLevel < 3, auditCategory: `WHEAT_AI_${category.toUpperCase()}_MUTATION`,
});

const entryLineSchema: WheatAiJsonSchema = schema({
  accountId: stringId,
  label: { type: "string", minLength: 1, maxLength: 250 },
  debitCents: centString,
  creditCents: centString,
  thirdParty: { type: "string", maxLength: 200 },
  counterpartyId: stringId,
}, ["accountId", "label", "debitCents", "creditCents"]);

const invoiceLineSchema: WheatAiJsonSchema = schema({
  description: shortText,
  quantity: { type: "string", pattern: "^\\d+(?:\\.\\d{1,6})?$" },
  unitPriceCents: centString,
  discountCents: centString,
  htCents: centString,
  vatCents: centString,
  ttcCents: centString,
  vatRateBps: { type: "integer", minimum: 0, maximum: 10000 },
  taxRateDefinitionId: stringId,
  accountId: stringId,
}, ["description", "quantity", "htCents", "vatCents", "ttcCents", "accountId"]);

const reportRange = schema({ from: isoDay, to: isoDay, asOf: isoDay, pageSize: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 }, search: { type: "string", maxLength: 160 }, journalId: stringId, accountId: stringId, source: { type: "string", maxLength: 80 } });

export const WHEAT_AI_CAPABILITY_REGISTRY: readonly WheatAiCapabilityDefinition[] = Object.freeze([
  read("company.get", "company", "Lire l'identité et le contexte borné du dossier actif.", emptyObject, ["company", "société", "dossier"]),
  read("settings.get", "settings", "Lire les paramètres, exercices, comptes, journaux et banques du dossier actif.", emptyObject, ["settings", "paramètres", "configuration"]),
  mutate("company.update", "company", "Mettre à jour les informations de la société avec verrouillage optimiste.", 1, schema({ expectedVersion: version, name: shortText, legalForm: { type: "string", minLength: 1, maxLength: 80 }, ice: { type: "string", pattern: "^\\d{15}$" }, taxId: { type: "string", maxLength: 40 }, city: { type: "string", minLength: 1, maxLength: 120 }, vatFrequency: { type: "string", enum: ["MONTHLY", "QUARTERLY"] } }, ["name", "legalForm", "city", "vatFrequency"]), { keywords: ["company", "société", "dossier", "update"] }),

  read("accounts.search", "accounts", "Rechercher des comptes PCGE et subdivisions sans exposer la base.", schema({ query: { type: "string", maxLength: 200 }, classNo: { type: "integer", minimum: 0, maximum: 9 }, active: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 200 } }), ["account", "compte", "pcge"]),
  read("accounts.get", "accounts", "Lire un compte précis du dossier actif.", schema({ accountId: stringId, code: { type: "string", maxLength: 20 } }), ["account", "compte", "pcge"]),
  mutate("accounts.save", "accounts", "Créer une subdivision PCGE ou modifier un compte personnalisé.", 1, schema({ id: stringId, expectedVersion: version, parentCode: { type: "string", maxLength: 20 }, code: { type: "string", pattern: "^[0-9][0-9A-Z._-]{1,19}$" }, label: shortText, classNo: { type: "integer", minimum: 0, maximum: 9 }, type: { type: "string", enum: ["ASSET", "LIABILITY", "EQUITY", "EXPENSE", "REVENUE", "MEMO"] } }, ["code", "label", "type"]), { keywords: ["account", "compte", "pcge", "create", "rename"] }),
  mutate("accounts.set_active", "accounts", "Archiver ou restaurer un compte selon les règles Wheat.", 3, schema({ id: stringId, expectedVersion: version, active: { type: "boolean" } }, ["id", "active"]), { keywords: ["account", "compte", "archive", "restore"] }),

  read("journals.list", "journals", "Lister les journaux du dossier actif.", emptyObject, ["journal", "journaux"]),
  mutate("journals.save", "journals", "Créer ou modifier un journal et sa numérotation de pièces.", 2, schema({ id: stringId, expectedVersion: version, code: { type: "string", minLength: 1, maxLength: 20 }, label: shortText, locked: { type: "boolean" }, piecePrefix: { type: "string", maxLength: 20 }, piecePattern: { type: "string", maxLength: 80 }, pieceYearFormat: { type: "string", enum: ["YYYY", "YY", "NONE"] }, piecePadding: { type: "integer", minimum: 1, maximum: 12 }, pieceSeparator: { type: "string", maxLength: 3 }, allowManualPieceOverride: { type: "boolean" } }, ["code", "label"]), { keywords: ["journal", "journaux", "create"] }),
  mutate("journals.set_active", "journals", "Archiver ou restaurer un journal.", 3, schema({ id: stringId, expectedVersion: version, active: { type: "boolean" } }, ["id", "active"]), { keywords: ["journal", "archive", "restore"] }),

  read("fiscal_years.list", "fiscal-years", "Lister les exercices fiscaux du dossier.", emptyObject, ["fiscal year", "exercice"]),
  mutate("fiscal_years.save", "fiscal-years", "Créer ou modifier un exercice sans chevauchement.", 2, schema({ id: stringId, expectedVersion: version, label: shortText, startsOn: isoDay, endsOn: isoDay }, ["label", "startsOn", "endsOn"]), { keywords: ["fiscal year", "exercice", "create"] }),

  read("entries.search", "entries", "Rechercher des écritures avec les filtres et la pagination du moteur de reporting.", reportRange, ["entry", "écriture", "journal", "piece"]),
  read("entries.get", "entries", "Lire le détail d'une écriture du dossier actif.", schema({ entryId: stringId }, ["entryId"]), ["entry", "écriture", "piece"]),
  read("entries.preview_post", "entries", "Valider un brouillon et prévisualiser sa comptabilisation sans l'exécuter.", schema({ entryId: stringId }, ["entryId"]), ["post", "comptabiliser", "preview"]),
  mutate("entries.create_draft", "entries", "Créer une écriture brouillon exacte en centimes via le service comptable partagé.", 2, schema({ journalId: stringId, date: isoDay, pieceNumber: { type: "string", maxLength: 80 }, label: { type: "string", minLength: 1, maxLength: 300 }, lines: { type: "array", items: entryLineSchema, minItems: 1, maxItems: 500 } }, ["journalId", "date", "label", "lines"]), { keywords: ["entry", "écriture", "purchase", "achat", "create"] }),
  mutate("entries.update_draft", "entries", "Modifier une écriture brouillon avec contrôle de version.", 2, schema({ entryId: stringId, expectedVersion: version, journalId: stringId, date: isoDay, pieceNumber: { type: "string", maxLength: 80 }, label: { type: "string", minLength: 1, maxLength: 250 }, lines: { type: "array", items: entryLineSchema, minItems: 1, maxItems: 500 } }, ["entryId", "journalId", "date", "label", "lines"]), { keywords: ["entry", "écriture", "correct", "label"] }),
  mutate("entries.duplicate", "entries", "Dupliquer une écriture en nouveau brouillon.", 1, schema({ entryId: stringId, date: isoDay }, ["entryId"]), { keywords: ["entry", "écriture", "duplicate", "same"] }),
  mutate("entries.delete_draft", "entries", "Supprimer uniquement une écriture encore en brouillon; les documents liés sont conservés.", 3, schema({ entryId: stringId }, ["entryId"]), { reversible: false, keywords: ["entry", "écriture", "delete", "supprimer"] }),
  mutate("entries.post", "entries", "Comptabiliser un brouillon après validation complète et confirmation.", 3, schema({ entryId: stringId }, ["entryId"]), { reversible: false, keywords: ["entry", "écriture", "post", "comptabiliser"] }),
  mutate("entries.reverse", "entries", "Extourner une écriture comptabilisée via une écriture opposée.", 3, schema({ entryId: stringId, date: isoDay }, ["entryId", "date"]), { reversible: false, keywords: ["entry", "écriture", "reverse", "extourne"] }),

  read("reports.trial_balance", "reports", "Calculer la balance générale exacte.", reportRange, ["balance", "report", "rapport"]),
  read("reports.general_ledger", "reports", "Calculer le grand livre paginé.", reportRange, ["grand livre", "ledger", "report"]),
  read("reports.journal", "reports", "Calculer le journal comptable paginé.", reportRange, ["journal report", "journal comptable"]),
  read("reports.aged_receivables", "reports", "Calculer l'ancienneté clients.", reportRange, ["receivable", "clients", "age"]),
  read("reports.aged_payables", "reports", "Calculer l'ancienneté fournisseurs.", reportRange, ["payable", "fournisseurs", "age"]),
  read("reports.integrity", "reports", "Exécuter les contrôles d'intégrité comptable.", reportRange, ["integrity", "validation", "issues", "erreurs"]),
  read("reports.balance", "reports", "Calculer une vue de balance Wheat.", schema({ view: { type: "string", enum: ["GENERAL", "AUXILIARY", "OPENING", "MOVEMENT", "CLOSING"] }, from: isoDay, to: isoDay }, ["view", "to"]), ["balance", "soldes"]),
  read("reports.bilan", "reports", "Calculer le Bilan normal ou simplifié.", schema({ asOf: isoDay, variant: { type: "string", enum: ["NORMAL", "SIMPLIFIED"] }, view: { type: "string", enum: ["INTERIM", "CLOSING", "COMPARATIVE"] } }, ["asOf", "variant"]), ["bilan", "actif", "passif"]),
  read("reports.cpc", "reports", "Calculer le CPC/ESG comparatif.", schema({ fiscalYearId: stringId }), ["cpc", "esg", "résultat"]),

  read("counterparties.list", "subledger", "Lister les tiers clients et fournisseurs.", schema({ includeArchived: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 } }), ["supplier", "fournisseur", "client", "tiers"]),
  mutate("counterparties.create", "subledger", "Créer un tiers en brouillon métier validé.", 1, schema({ kind: { type: "string", enum: ["CUSTOMER", "SUPPLIER", "BOTH"] }, displayName: shortText, legalName: shortText, ice: { type: "string", maxLength: 40 }, taxId: { type: "string", maxLength: 40 }, email: { type: "string", maxLength: 200 }, phone: { type: "string", maxLength: 80 }, address: { type: "string", maxLength: 500 }, city: { type: "string", maxLength: 120 }, defaultReceivableAccountId: stringId, defaultPayableAccountId: stringId, paymentTermsDays: { type: "integer", minimum: 0, maximum: 3650 } }, ["kind", "displayName"]), { keywords: ["supplier", "fournisseur", "client", "tiers", "create"] }),
  mutate("counterparties.update", "subledger", "Modifier un tiers avec contrôle de version.", 1, schema({ id: stringId, expectedVersion: version, kind: { type: "string", enum: ["CUSTOMER", "SUPPLIER", "BOTH"] }, displayName: shortText, legalName: shortText, ice: { type: "string", maxLength: 40 }, taxId: { type: "string", maxLength: 40 }, email: { type: "string", maxLength: 200 }, phone: { type: "string", maxLength: 80 }, address: { type: "string", maxLength: 500 }, city: { type: "string", maxLength: 120 }, defaultReceivableAccountId: stringId, defaultPayableAccountId: stringId, paymentTermsDays: { type: "integer", minimum: 0, maximum: 3650 } }, ["id", "kind", "displayName"]), { keywords: ["supplier", "fournisseur", "client", "tiers", "update"] }),
  mutate("counterparties.archive", "subledger", "Archiver un tiers selon les contraintes du sous-livre.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { keywords: ["supplier", "client", "archive"] }),
  mutate("counterparties.restore", "subledger", "Restaurer un tiers archivé.", 1, schema({ id: stringId, expectedVersion: version }, ["id"]), { keywords: ["supplier", "client", "restore"] }),
  read("counterparties.resolve", "subledger", "Identifier un tiers existant du dossier à partir d'un nom, d'un ICE, d'un IF ou d'un RC, avant d'en créer un. Retourne la correspondance certaine, les candidats proches, et signale le cas où l'identité fournie est celle du dossier actif lui-même.", schema({ name: { type: "string", maxLength: 200 }, ice: { type: "string", maxLength: 40 }, taxId: { type: "string", maxLength: 60 }, rc: { type: "string", maxLength: 40 }, kind: { type: "string", enum: ["CUSTOMER", "SUPPLIER", "BOTH"] }, limit: { type: "integer", minimum: 1, maximum: 25 } }), ["tiers", "client", "customer", "supplier", "fournisseur", "ice", "identifiant", "existe", "retrouver", "identify", "resolve"]),
  read("counterparties.get", "subledger", "Lire un tiers du dossier avec ses comptes par défaut, ses encours et ses conditions de règlement.", schema({ id: stringId }, ["id"]), ["tiers", "client", "supplier", "fournisseur", "detail"]),

  read("invoices.list", "invoices", "Lister et rechercher les factures et avoirs du dossier.", schema({ kind: { type: "string", enum: ["SALE", "PURCHASE"] }, lifecycleStatus: { type: "string", maxLength: 30 }, from: isoDay, to: isoDay, search: { type: "string", maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 } }), ["invoice", "facture", "avoir"]),
  read("invoices.get", "invoices", "Lire une facture du dossier avec ses lignes, ses totaux exacts et le contrôle HT + TVA = TTC.", schema({ id: stringId }, ["id"]), ["invoice", "facture", "detail", "controle", "tva"]),
  mutate("invoices.create_draft", "invoices", "Créer une facture brouillon via le sous-livre partagé.", 1, schema({ kind: { type: "string", enum: ["SALE", "PURCHASE"] }, counterpartyId: stringId, invoiceNo: { type: "string", maxLength: 100 }, invoiceDate: isoDay, dueDate: isoDay, currency: { type: "string", enum: ["MAD"] }, notes: { type: "string", maxLength: 1000 }, controlAccountId: stringId, vatAccountId: stringId, lines: { type: "array", items: invoiceLineSchema, minItems: 1, maxItems: 500 } }, ["kind", "counterpartyId", "invoiceDate", "dueDate", "lines"]), { keywords: ["invoice", "facture", "purchase", "achat", "create"] }),
  mutate("invoices.update_draft", "invoices", "Modifier une facture brouillon avec contrôle de version.", 1, schema({ id: stringId, expectedVersion: version, kind: { type: "string", enum: ["SALE", "PURCHASE"] }, counterpartyId: stringId, invoiceNo: { type: "string", maxLength: 100 }, invoiceDate: isoDay, dueDate: isoDay, currency: { type: "string", enum: ["MAD"] }, notes: { type: "string", maxLength: 1000 }, controlAccountId: stringId, vatAccountId: stringId, lines: { type: "array", items: invoiceLineSchema, minItems: 1, maxItems: 500 } }, ["id", "kind", "counterpartyId", "invoiceDate", "dueDate", "lines"]), { keywords: ["invoice", "facture", "update"] }),
  mutate("invoices.delete_draft", "invoices", "Supprimer une facture encore en brouillon.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { reversible: false, keywords: ["invoice", "facture", "delete"] }),
  mutate("invoices.post", "invoices", "Comptabiliser une facture via le sous-livre.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { reversible: false, keywords: ["invoice", "facture", "post"] }),
  mutate("invoices.reclassify_draft", "invoices", "Reclasser un brouillon du mauvais sens (achat ↔ vente) : Wheat supprime le brouillon incorrect et le reconstruit depuis son document source, en conservant la pièce et son extraction OCR. Réservé aux brouillons non comptabilisés et sans imputation.", 3, schema({ invoiceId: stringId, documentId: stringId, kind: { type: "string", enum: ["SALE", "PURCHASE"] } }, ["kind"]), { reversible: false, keywords: ["invoice", "facture", "achat", "vente", "sens", "reclasser", "reclassify", "inverse", "mauvais sens", "purchase", "sale"] }),
  mutate("invoices.void", "invoices", "Annuler une facture comptabilisée via son workflow de contrepassation.", 3, schema({ id: stringId, expectedVersion: version, reason: longText, date: isoDay }, ["id", "reason", "date"]), { reversible: false, keywords: ["invoice", "facture", "void", "annuler"] }),

  read("payments.list", "payments", "Lister les règlements du dossier.", schema({ kind: { type: "string", enum: ["RECEIPT", "DISBURSEMENT"] }, status: { type: "string", maxLength: 30 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 } }), ["payment", "paiement", "règlement"]),
  read("payments.get", "payments", "Lire un règlement du dossier avec ses imputations et son solde restant à affecter.", schema({ id: stringId }, ["id"]), ["payment", "reglement", "paiement", "detail", "imputation"]),
  mutate("payments.create_draft", "payments", "Créer un règlement brouillon exact en centimes.", 1, schema({ kind: { type: "string", enum: ["RECEIPT", "DISBURSEMENT"] }, counterpartyId: stringId, paymentDate: isoDay, amountCents: centString, currency: { type: "string", enum: ["MAD"] }, method: { type: "string", minLength: 1, maxLength: 80 }, reference: { type: "string", maxLength: 160 }, notes: { type: "string", maxLength: 1000 }, bankAccountId: stringId, controlAccountId: stringId, settlementAccountId: stringId }, ["kind", "counterpartyId", "paymentDate", "amountCents", "method"]), { keywords: ["payment", "paiement", "règlement", "create"] }),
  mutate("payments.update_draft", "payments", "Modifier un règlement brouillon.", 1, schema({ id: stringId, expectedVersion: version, kind: { type: "string", enum: ["RECEIPT", "DISBURSEMENT"] }, counterpartyId: stringId, paymentDate: isoDay, amountCents: centString, currency: { type: "string", enum: ["MAD"] }, method: { type: "string", minLength: 1, maxLength: 80 }, reference: { type: "string", maxLength: 160 }, notes: { type: "string", maxLength: 1000 }, bankAccountId: stringId, controlAccountId: stringId, settlementAccountId: stringId }, ["id", "kind", "counterpartyId", "paymentDate", "amountCents", "method"]), { keywords: ["payment", "paiement", "update"] }),
  mutate("payments.delete_draft", "payments", "Supprimer un règlement encore en brouillon.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { reversible: false, keywords: ["payment", "paiement", "delete"] }),
  mutate("payments.post", "payments", "Comptabiliser un règlement.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { reversible: false, keywords: ["payment", "paiement", "post"] }),
  mutate("payments.void", "payments", "Annuler un règlement comptabilisé via contrepassation.", 3, schema({ id: stringId, expectedVersion: version, reason: longText, date: isoDay }, ["id", "reason", "date"]), { reversible: false, keywords: ["payment", "paiement", "void"] }),
  mutate("payments.allocate", "payments", "Imputer un règlement à une facture en centimes exacts.", 2, schema({ paymentId: stringId, invoiceId: stringId, expectedVersion: version, amountCents: centString }, ["paymentId", "invoiceId", "amountCents"]), { keywords: ["payment", "invoice", "imputer"] }),
  mutate("payments.reverse_allocation", "payments", "Annuler une imputation de règlement selon les règles du sous-livre.", 3, schema({ allocationId: stringId, expectedPaymentVersion: version, reason: longText, date: isoDay }, ["allocationId", "reason", "date"]), { keywords: ["payment", "allocation", "reverse"] }),

  read("banking.position", "banking", "Lire la position bancaire par devise.", schema({ asOf: isoDay }), ["bank", "banque", "cash", "trésorerie"]),
  read("banking.reconciliation_workspace", "banking", "Lire l'espace de rapprochement bancaire.", schema({ bankAccountId: stringId }), ["bank", "banque", "reconciliation", "rapprochement"]),
  read("banking.reconciliation_candidates", "banking", "Calculer les candidats de rapprochement d'un mouvement.", schema({ movementId: stringId }, ["movementId"]), ["reconciliation", "rapprochement", "match"]),
  mutate("banking.confirm_reconciliation", "banking", "Confirmer un rapprochement bancaire après validation des allocations.", 2, schema({ movementId: stringId, expectedRevision: version, allocations: { type: "array", items: schema({ entryLineId: stringId, amountCents: centString }, ["entryLineId", "amountCents"]), minItems: 1, maxItems: 500 }, paymentEvidence: { type: "array", items: schema({ paymentId: stringId, amountCents: centString }, ["paymentId", "amountCents"]), maxItems: 500 }, note: { type: "string", maxLength: 500 } }, ["movementId", "allocations"]), { keywords: ["reconciliation", "rapprochement", "confirm"] }),
  mutate("banking.void_reconciliation", "banking", "Annuler un rapprochement bancaire actif.", 3, schema({ reconciliationId: stringId, expectedRevision: version, reason: longText }, ["reconciliationId", "reason"]), { keywords: ["reconciliation", "rapprochement", "unreconcile"] }),
  mutate("banking.exclude_movement", "banking", "Exclure un mouvement bancaire avec motif.", 2, schema({ movementId: stringId, expectedRevision: version, reason: longText }, ["movementId", "reason"]), { keywords: ["bank", "movement", "exclude"] }),
  mutate("banking.restore_movement", "banking", "Restaurer un mouvement bancaire exclu.", 1, schema({ movementId: stringId, expectedRevision: version }, ["movementId"]), { keywords: ["bank", "movement", "restore"] }),
  mutate("banking.save_account", "banking", "Créer ou modifier un compte bancaire relié à un compte comptable du dossier.", 2, schema({ id: stringId, expectedVersion: version, bankName: shortText, iban: { type: "string", minLength: 1, maxLength: 100 }, ledgerAccountId: stringId, currency: { type: "string", enum: ["MAD"] } }, ["bankName", "iban", "ledgerAccountId"]), { keywords: ["bank", "banque", "compte bancaire", "create"] }),
  mutate("banking.set_account_active", "banking", "Archiver ou restaurer un compte bancaire.", 3, schema({ id: stringId, expectedVersion: version, active: { type: "boolean" } }, ["id", "active"]), { keywords: ["bank", "banque", "archive", "restore"] }),
  read("documents.search", "documents", "Rechercher les métadonnées de documents du dossier, sans chemin ni contenu libre.", schema({ query: { type: "string", maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 100 } }), ["document", "pièce", "attachment", "invoice"]),
  read("documents.get", "documents", "Lire l'extraction OCR d'un document : champs, confiance, contrôles comptables et raisons d'incertitude.", schema({ documentId: stringId }, ["documentId"]), ["document", "pièce", "ocr", "extraction", "facture"]),
  mutate("documents.update_extraction", "documents", "Corriger les champs extraits d'un document OCR non encore rattaché à un brouillon.", 1, schema({ documentId: stringId, type: { type: "string", maxLength: 40 }, fields: { type: "object", additionalProperties: true } }, ["documentId", "fields"]), { keywords: ["ocr", "extraction", "corriger", "champ", "document"] }),
  mutate("documents.rerun_ocr", "documents", "Relancer la reconnaissance sur un document déjà importé et remplacer son extraction.", 1, schema({ documentId: stringId }, ["documentId"]), { keywords: ["ocr", "relancer", "reconnaissance", "document"] }),
  mutate("documents.create_invoice_draft", "documents", "Créer la facture brouillon (vente ou achat) liée à un document OCR via le sous-livre partagé. Le sens est déduit du document ; ne fournir « kind » que si l'utilisateur l'a explicitement tranché.", 2, schema({ documentId: stringId, kind: { type: "string", enum: ["SALE", "PURCHASE"] } }, ["documentId"]), { keywords: ["ocr", "document", "facture", "brouillon", "achat", "vente"] }),

  read("accounts.suggest", "accounts", "Proposer les comptes du dossier adaptés à un rôle comptable donné (produits de services, ventes de marchandises, charges externes, achats, TVA facturée, TVA récupérable, clients, fournisseurs, débours), en cherchant dans le plan du dossier plutôt qu'en supposant un code. Ne crée aucun compte.", schema({ role: { type: "string", enum: ["REVENUE_SERVICE", "REVENUE_GOODS", "EXPENSE_SERVICE", "EXPENSE_GOODS", "DISBURSEMENT", "RECEIVABLE", "PAYABLE", "VAT_COLLECTED", "VAT_DEDUCTIBLE"] }, context: { type: "string", maxLength: 250 } }, ["role"]), ["compte", "account", "imputation", "suggerer", "suggest", "pcge", "produit", "charge", "debours"]),
  read("vat.workspace", "vat", "Lire l'espace TVA et ses configurations bornées.", emptyObject, ["vat", "tva", "taxe"]),
  read("vat.workpapers", "vat", "Lister les workpapers TVA.", schema({ fiscalYearId: stringId, limit: { type: "integer", minimum: 1, maximum: 100 } }), ["vat", "tva", "workpaper"]),
  read("vat.workpaper", "vat", "Lire un workpaper TVA précis.", schema({ id: stringId }, ["id"]), ["vat", "tva", "workpaper"]),
  mutate("vat.generate", "vat", "Préparer une période TVA via le moteur de conformité.", 2, schema({ taxConfigurationVersionId: stringId, periodStart: isoDay, periodEnd: isoDay }, ["taxConfigurationVersionId", "periodStart", "periodEnd"]), { keywords: ["vat", "tva", "prepare", "generate"] }),
  mutate("vat.regenerate", "vat", "Régénérer un workpaper TVA encore modifiable.", 2, schema({ id: stringId, expectedVersion: version }, ["id"]), { keywords: ["vat", "tva", "refresh"] }),
  mutate("vat.add_adjustment", "vat", "Ajouter un ajustement TVA documenté en centimes exacts.", 2, schema({ id: stringId, expectedVersion: version, direction: { type: "string", enum: ["COLLECTED", "DEDUCTIBLE"] }, taxableCents: centString, vatCents: centString, reason: longText, evidenceDocumentId: stringId }, ["id", "direction", "vatCents", "reason"]), { keywords: ["vat", "tva", "adjustment"] }),
  mutate("vat.attach_evidence", "vat", "Joindre un document existant du dossier comme preuve TVA.", 2, schema({ id: stringId, expectedVersion: version, documentId: stringId, role: { type: "string", maxLength: 80 }, note: { type: "string", maxLength: 500 } }, ["id", "documentId", "role"]), { keywords: ["vat", "tva", "attach", "evidence"] }),
  mutate("vat.remove_evidence", "vat", "Retirer une preuve d'un workpaper TVA.", 3, schema({ id: stringId, expectedVersion: version, evidenceId: stringId }, ["id", "evidenceId"]), { keywords: ["vat", "tva", "remove", "evidence"] }),
  mutate("vat.review", "vat", "Revoir et verrouiller un workpaper TVA.", 3, schema({ id: stringId, expectedVersion: version }, ["id"]), { reversible: false, keywords: ["vat", "tva", "review"] }),
  mutate("vat.return_to_draft", "vat", "Renvoyer un workpaper TVA revu en brouillon.", 3, schema({ id: stringId, expectedVersion: version, reason: longText }, ["id", "reason"]), { keywords: ["vat", "tva", "draft"] }),
  mutate("vat.reopen", "vat", "Rouvrir un workpaper TVA selon les règles de conformité.", 3, schema({ id: stringId, expectedVersion: version, reason: longText }, ["id", "reason"]), { roles: admin, keywords: ["vat", "tva", "reopen"] }),

  read("fiscal.control", "fiscal", "Lire l'avancement et les contrôles de la liasse normale.", schema({ fiscalPackageId: stringId }), ["fiscal", "liasse", "control"]),
  read("fiscal.tables", "fiscal", "Lister les 25 tableaux fiscaux et leurs états.", schema({ fiscalPackageId: stringId }), ["fiscal", "liasse", "table"]),
  read("fiscal.table", "fiscal", "Lire un tableau fiscal précis.", schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" } }, ["fiscalPackageId", "tableId"]), ["fiscal", "liasse", "table"]),
  read("fiscal.validate_package", "fiscal", "Valider la liasse et retourner ses bloqueurs sans la déposer.", schema({ fiscalPackageId: stringId }, ["fiscalPackageId"]), ["fiscal", "liasse", "validate"]),
  mutate("fiscal.generate_package", "fiscal", "Créer ou rafraîchir une liasse fiscale normale en brouillon.", 2, schema({ fiscalYearId: stringId, variant: { type: "string", enum: ["NORMAL", "SIMPLIFIED"] } }, ["fiscalYearId"]), { keywords: ["fiscal", "liasse", "generate"] }),
  mutate("fiscal.add_adjustment", "fiscal", "Ajouter une réintégration ou déduction fiscale documentée.", 2, schema({ fiscalPackageId: stringId, kind: { type: "string", enum: ["REINTEGRATION", "DEDUCTION"] }, label: { type: "string", minLength: 1, maxLength: 250 }, amountCents: centString, legalReference: { type: "string", minLength: 1, maxLength: 500 }, evidence: { type: "array", items: stringId, maxItems: 50 } }, ["fiscalPackageId", "kind", "label", "amountCents", "legalReference"]), { keywords: ["fiscal", "liasse", "adjustment"] }),
  mutate("fiscal.verify_adjustment", "fiscal", "Marquer un ajustement fiscal comme vérifié par l'utilisateur.", 3, schema({ fiscalPackageId: stringId, adjustmentId: stringId }, ["fiscalPackageId", "adjustmentId"]), { keywords: ["fiscal", "adjustment", "verify"] }),
  mutate("fiscal.refresh_table", "fiscal", "Recalculer les sources comptables d'un tableau fiscal brouillon.", 2, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version }, ["fiscalPackageId", "tableId"]), { keywords: ["fiscal", "table", "refresh"] }),
  mutate("fiscal.save_table", "fiscal", "Enregistrer les lignes manuelles d'un tableau fiscal.", 2, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, manualRows: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 1000 } }, ["fiscalPackageId", "tableId", "manualRows"]), { keywords: ["fiscal", "table", "save"] }),
  mutate("fiscal.mark_not_applicable", "fiscal", "Marquer un tableau fiscal brouillon non applicable avec motif.", 2, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, reason: longText }, ["fiscalPackageId", "tableId", "reason"]), { keywords: ["fiscal", "table", "not applicable", "n/a"] }),
  mutate("fiscal.attach_evidence", "fiscal", "Joindre un document existant du dossier à un tableau fiscal.", 2, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, documentId: stringId, role: { type: "string", maxLength: 40 }, note: { type: "string", maxLength: 500 } }, ["fiscalPackageId", "tableId", "documentId"]), { keywords: ["fiscal", "table", "attach", "evidence"] }),
  mutate("fiscal.review_table", "fiscal", "Revoir et verrouiller un tableau fiscal.", 3, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version }, ["fiscalPackageId", "tableId"]), { reversible: false, keywords: ["fiscal", "table", "review"] }),
  mutate("fiscal.reopen_table", "fiscal", "Rouvrir un tableau fiscal revu avec motif.", 3, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, reason: longText }, ["fiscalPackageId", "tableId", "reason"]), { keywords: ["fiscal", "table", "reopen"] }),
  mutate("fiscal.clear_not_applicable", "fiscal", "Retirer le statut non applicable d'un tableau fiscal.", 3, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, reason: longText }, ["fiscalPackageId", "tableId", "reason"]), { keywords: ["fiscal", "table", "applicable"] }),
  mutate("fiscal.remove_evidence", "fiscal", "Retirer une preuve d'un tableau fiscal.", 3, schema({ fiscalPackageId: stringId, tableId: { type: "string", pattern: "^T(?:0[1-9]|1[0-9]|2[0-5])$" }, expectedRevision: version, evidenceId: stringId }, ["fiscalPackageId", "tableId", "evidenceId"]), { keywords: ["fiscal", "table", "remove", "evidence"] }),

  read("imports.list", "imports", "Lister les imports d'écritures préparés pour le dossier.", schema({ limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 2048 } }), ["import", "ledger import"]),
  mutate("imports.confirm", "imports", "Confirmer un lot d'import préalablement préparé et validé.", 3, schema({ batchId: stringId, expectedRevision: version }, ["batchId"]), { reversible: true, keywords: ["import", "confirm"] }),
  mutate("imports.cancel", "imports", "Annuler un lot d'import encore en attente.", 3, schema({ batchId: stringId, expectedRevision: version, reason: { type: "string", maxLength: 1000 } }, ["batchId"]), { keywords: ["import", "cancel"] }),

  read("payroll.runs", "payroll", "Lister les traitements de paie sans exposer les identifiants personnels salariés au modèle.", schema({ take: { type: "integer", minimum: 1, maximum: 250 } }), ["payroll", "paie", "salaire"]),
  mutate("payroll.void", "payroll", "Annuler une paie comptabilisée par une écriture d'extourne.", 3, schema({ payrollRunId: stringId, expectedVersion: version, date: isoDay, reason: longText }, ["payrollRunId", "date", "reason"]), { reversible: false, keywords: ["payroll", "paie", "annuler", "extourne"] }),
  read("audit.events", "audit", "Lire l'historique d'audit borné.", schema({ take: { type: "integer", minimum: 1, maximum: 250 }, cursor: { type: "string", maxLength: 2048 } }), ["audit", "history", "historique"]),
  read("audit.verify", "audit", "Vérifier la chaîne d'audit du dossier.", emptyObject, ["audit", "verify", "integrity"]),
  read("knowledge.retrieve", "knowledge", "Retrouver les règles locales du dossier avec preuve et confiance.", schema({ kind: { type: "string", maxLength: 60 }, limit: { type: "integer", minimum: 1, maximum: 100 } }), ["knowledge", "règle", "habitude"]),
  mutate("knowledge.remember", "knowledge", "Mémoriser une règle propre au dossier avec preuve et confiance.", 1, schema({ kind: { type: "string", minLength: 1, maxLength: 60 }, key: { type: "string", minLength: 1, maxLength: 160 }, value: { type: "object", additionalProperties: true }, evidence: { type: "array", items: objectOutput, maxItems: 50 }, confidenceBps: { type: "integer", minimum: 0, maximum: 10000 } }, ["kind", "key", "value"]), { keywords: ["knowledge", "règle", "remember"] }),

  capability({ id: "navigation.open", category: "navigation", description: "Ouvrir un module Wheat sûr dans l'interface.", mode: "NAVIGATION", riskLevel: 0, requiredRoles: viewer, confirmation: "NEVER", supportsDryRun: false, reversible: true, auditCategory: "WHEAT_AI_NAVIGATION", inputSchema: schema({ target: { type: "string", enum: ["dashboard", "entries", "documents", "invoices", "banking", "reports", "bilan", "fiscal", "vat", "settings", "wheat-ai"] }, entityId: stringId }, ["target"]), navigationTarget: "dynamic", keywords: ["open", "ouvrir", "show", "navigate", "aller"] }),
]);

const CAPABILITY_BY_ID = new Map(WHEAT_AI_CAPABILITY_REGISTRY.map((item) => [item.id, item]));

const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  search_accounts: "accounts.search",
  get_entries: "entries.search",
  get_balance: "reports.balance",
  get_bilan: "reports.bilan",
  get_cpc: "reports.cpc",
  get_bank_position: "banking.position",
  get_invoices: "invoices.list",
  get_documents: "documents.search",
  get_vat_status: "vat.workspace",
  get_payroll_summary: "payroll.runs",
  get_fiscal_package: "fiscal.control",
  retrieve_company_knowledge: "knowledge.retrieve",
  create_account_subdivision: "accounts.save",
  update_company_profile: "company.update",
  rename_custom_account: "accounts.save",
  add_fiscal_table_row: "fiscal.save_table",
  mark_fiscal_table_not_applicable: "fiscal.mark_not_applicable",
  add_fiscal_adjustment: "fiscal.add_adjustment",
  remember_company_knowledge: "knowledge.remember",
  post_entry: "entries.post",
});

export function canonicalWheatAiCapabilityId(value: unknown) {
  const id = String(value ?? "").trim();
  return LEGACY_TOOL_ALIASES[id] ?? id;
}

export function getWheatAiCapability(value: unknown) {
  return CAPABILITY_BY_ID.get(canonicalWheatAiCapabilityId(value)) ?? null;
}

function validateValue(value: unknown, definition: WheatAiJsonSchema, path: string): unknown {
  if (value === undefined) return undefined;
  if (definition.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} doit être un objet.`);
    const source = value as Record<string, unknown>;
    const properties = definition.properties ?? {};
    if (definition.additionalProperties !== true) {
      const unknown = Object.keys(source).filter((key) => !(key in properties));
      if (unknown.length) throw new Error(`${path} contient des champs non autorisés : ${unknown.join(", ")}.`);
    }
    for (const required of definition.required ?? []) {
      if (source[required] === undefined || source[required] === null || source[required] === "") throw new Error(`${path}.${required} est obligatoire.`);
    }
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, properties[key] ? validateValue(item, properties[key], `${path}.${key}`) : item]));
  }
  if (definition.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} doit être une liste.`);
    if (definition.minItems !== undefined && value.length < definition.minItems) throw new Error(`${path} contient trop peu d'éléments.`);
    if (definition.maxItems !== undefined && value.length > definition.maxItems) throw new Error(`${path} contient trop d'éléments.`);
    return value.map((item, index) => definition.items ? validateValue(item, definition.items, `${path}[${index}]`) : item);
  }
  if (definition.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} doit être une chaîne.`);
    const result = value.trim();
    if (definition.minLength !== undefined && result.length < definition.minLength) throw new Error(`${path} est trop court.`);
    if (definition.maxLength !== undefined && result.length > definition.maxLength) throw new Error(`${path} est trop long.`);
    if (definition.pattern && !new RegExp(definition.pattern).test(result)) throw new Error(`${path} a un format invalide.`);
    if (definition.enum && !definition.enum.includes(result)) throw new Error(`${path} doit valoir ${definition.enum.join(", ")}.`);
    return result;
  }
  if (definition.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} doit être un entier.`);
    const result = Number(value);
    if (definition.minimum !== undefined && result < definition.minimum) throw new Error(`${path} est inférieur au minimum autorisé.`);
    if (definition.maximum !== undefined && result > definition.maximum) throw new Error(`${path} dépasse le maximum autorisé.`);
    if (definition.enum && !definition.enum.includes(result)) throw new Error(`${path} est invalide.`);
    return result;
  }
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} doit être vrai ou faux.`);
    return value;
  }
  throw new Error(`${path} utilise un schéma non pris en charge.`);
}

export function validateWheatAiCapabilityInput(definition: WheatAiCapabilityDefinition, value: unknown) {
  return validateValue(value ?? {}, definition.inputSchema, definition.id) as Record<string, any>;
}

export function publicWheatAiCapabilities() {
  return WHEAT_AI_CAPABILITY_REGISTRY.map((definition) => Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "keywords")));
}

export function classifyWheatAiIntent(value: unknown, dryRun = false): WheatAiIntent {
  const text = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (dryRun || /\b(show|montre|preview|previsualis|what would|que se passerait|avant de|dry[- ]?run|planifie|planifier)\b/.test(text)) return "PREVIEW";
  if (/^(what|why|how|when|where|which|can|could|would|should|is|are|do|does|explain|quel|quelle|quels|quelles|pourquoi|comment|peut|pourrait|est-ce|explique)\b/.test(text) || text.endsWith("?")) return "INFORMATION";
  if (/\b(create|add|update|change|rename|archive|restore|delete|remove|post|reverse|duplicate|save|mark|attach|reconcile|confirm|cancel|prepare|refresh|review|reopen|open|navigate|fix|resolve|execute|do|cree|creer|ajoute|ajouter|modifie|modifier|change|renomme|renommer|archive|restaure|supprime|supprimer|comptabilise|comptabiliser|extourne|duplique|enregistre|marque|attache|rapproche|confirme|annule|prepare|rafraichis|revois|rouvre|ouvre|corrige|corriger|resous|executer|fais|effectue|relance|relancer|refais|refaire|applique|appliquer|importe|importer|remplace|remplacer|rerun|rescan)\b/.test(text)) return "EXECUTION";
  return "PLANNING";
}

/**
 * The tools every turn gets, whatever the wording.
 *
 * Without them the assistant answered "je n'ai pas d'outil typ\u00e9 pour cette
 * action" to requests it was perfectly equipped for: the old selection scored
 * on keywords alone, and a prompt that matched fewer than four fell back to a
 * five-tool read-only set. Orientation \u2014 which dossier, which third party,
 * which document, which account, and how to open the screen being discussed \u2014
 * is what almost every request needs first, so it is never selected away.
 */
const ALWAYS_AVAILABLE = Object.freeze([
  "company.get",
  "settings.get",
  "navigation.open",
  "accounts.search",
  "counterparties.resolve",
  "invoices.list",
  "invoices.get",
  "documents.search",
  "documents.get",
  "entries.search",
]);

export function selectWheatAiCapabilities(promptValue: unknown, moduleValue?: unknown, limit = 34) {
  const normalized = `${String(promptValue ?? "")} ${String(moduleValue ?? "")}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const scored = WHEAT_AI_CAPABILITY_REGISTRY.map((definition, index) => {
    let score = ALWAYS_AVAILABLE.includes(definition.id) ? 2 : 0;
    for (const keyword of definition.keywords) if (normalized.includes(keyword.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())) score += 5;
    if (normalized.includes(definition.category)) score += 3;
    return { definition, index, score };
  });

  // A category the request touched is offered whole. Asking to "corriger cette
  // facture" used to surface `invoices.list` and nothing that could change it,
  // which is the shape of the complaint: the assistant could see the invoice
  // and had no typed way to act on it.
  const engaged = new Set(scored.filter((item) => item.score >= 5).map((item) => item.definition.category));
  const ranked = scored
    .map((item) => ({ ...item, score: item.score + (engaged.has(item.definition.category) ? 4 : 0) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const bounded = Math.max(ALWAYS_AVAILABLE.length, Math.min(limit, 40));
  const selected = ranked.slice(0, bounded).map((item) => item.definition);
  // The floor is a guarantee, not a fallback: whatever the scoring did, the
  // orientation tools are in the list.
  for (const id of ALWAYS_AVAILABLE) {
    const definition = CAPABILITY_BY_ID.get(id);
    if (definition && !selected.includes(definition)) selected.push(definition);
  }
  return selected;
}
