export type FiscalCalculationMode = "AUTOMATIC" | "HYBRID" | "MANUAL";
export type FiscalFieldType = "TEXT" | "DATE" | "MONEY" | "RATE" | "INTEGER";

export type FiscalColumn = {
  key: string;
  label: string;
  type: FiscalFieldType;
  required?: boolean;
};

export type FiscalTableDefinition = {
  id: string;
  number: number;
  label: string;
  mode: FiscalCalculationMode;
  views: Array<{ id: string; label: string }>;
  manualColumns: FiscalColumn[];
  accountPrefixes?: string[];
};

export const FISCAL_CATALOG_VERSION = "MOROCCO-NORMAL-PREPARATION-1";
export const FISCAL_SOURCE_CITATION = "CNC Maroc · CGNC; préparation Wheat non statutaire";

const sourceColumns: FiscalColumn[] = [
  { key: "sourceRef", label: "Source / référence", type: "TEXT", required: true },
  { key: "note", label: "Note", type: "TEXT" },
];

const adjustmentColumns: FiscalColumn[] = [
  { key: "label", label: "Ajustement documenté", type: "TEXT", required: true },
  { key: "amountCents", label: "Montant", type: "MONEY", required: true },
  ...sourceColumns,
];

function table(
  number: number,
  label: string,
  mode: FiscalCalculationMode,
  manualColumns: FiscalColumn[],
  options: Partial<Pick<FiscalTableDefinition, "views" | "accountPrefixes">> = {},
): FiscalTableDefinition {
  const id = `T${String(number).padStart(2, "0")}`;
  return {
    id,
    number,
    label,
    mode,
    views: options.views ?? [{ id, label: `${number} - ${label}` }],
    manualColumns,
    accountPrefixes: options.accountPrefixes,
  };
}

export const FISCAL_TABLE_CATALOG: readonly FiscalTableDefinition[] = [
  table(1, "Bilan", "AUTOMATIC", adjustmentColumns, { views: [
    { id: "T01_ACTIF", label: "1 - Bilan Actif" },
    { id: "T01_PASSIF", label: "1 - Bilan Passif" },
  ] }),
  table(2, "CPC", "AUTOMATIC", adjustmentColumns, { views: [
    { id: "T02_CPC", label: "2 - CPC" },
    { id: "T02_SUITE", label: "2 - CPC (Suite)" },
  ] }),
  table(3, "Passage du résultat net comptable au résultat net fiscal", "AUTOMATIC", adjustmentColumns),
  table(4, "Tableau des immobilisations non financières", "HYBRID", [
    { key: "category", label: "Catégorie / compte", type: "TEXT", required: true },
    { key: "openingCents", label: "Ouverture", type: "MONEY" },
    { key: "acquisitionsCents", label: "Acquisitions", type: "MONEY" },
    { key: "disposalsCents", label: "Cessions / retraits", type: "MONEY" },
    { key: "closingCents", label: "Clôture", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["21", "22", "23", "24"] }),
  table(5, "État des soldes de gestion (E.S.G.)", "AUTOMATIC", adjustmentColumns),
  table(6, "Détail des rubriques du CPC", "AUTOMATIC", adjustmentColumns),
  table(7, "Tableau des immobilisations en crédit-bail", "MANUAL", [
    { key: "lessor", label: "Bailleur", type: "TEXT", required: true },
    { key: "asset", label: "Immobilisation", type: "TEXT", required: true },
    { key: "startsOn", label: "Début", type: "DATE" },
    { key: "endsOn", label: "Fin", type: "DATE" },
    { key: "annualRentCents", label: "Redevance annuelle", type: "MONEY", required: true },
    { key: "purchaseOptionCents", label: "Option d'achat", type: "MONEY" },
    ...sourceColumns,
  ]),
  table(8, "Tableau des amortissements", "HYBRID", [
    { key: "category", label: "Immobilisation / compte", type: "TEXT", required: true },
    { key: "openingCents", label: "Ouverture", type: "MONEY" },
    { key: "additionsCents", label: "Dotations", type: "MONEY" },
    { key: "reversalsCents", label: "Reprises / sorties", type: "MONEY" },
    { key: "closingCents", label: "Clôture", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["28"] }),
  table(9, "Tableau des provisions", "HYBRID", [
    { key: "provision", label: "Provision / compte", type: "TEXT", required: true },
    { key: "openingCents", label: "Ouverture", type: "MONEY" },
    { key: "additionsCents", label: "Dotations", type: "MONEY" },
    { key: "usesCents", label: "Utilisations", type: "MONEY" },
    { key: "reversalsCents", label: "Reprises", type: "MONEY" },
    { key: "closingCents", label: "Clôture", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["15", "29", "39", "49", "59"] }),
  table(10, "Plus ou moins-values sur cessions ou retraits d'immobilisations", "HYBRID", [
    { key: "asset", label: "Immobilisation", type: "TEXT", required: true },
    { key: "acquiredOn", label: "Date d'acquisition", type: "DATE" },
    { key: "grossCents", label: "Valeur brute", type: "MONEY" },
    { key: "depreciationCents", label: "Amortissements", type: "MONEY" },
    { key: "saleCents", label: "Prix de cession", type: "MONEY", required: true },
    { key: "gainLossCents", label: "Plus / moins-value", type: "MONEY" },
    ...sourceColumns,
  ], { accountPrefixes: ["651", "751"] }),
  table(11, "Tableau des titres de participation", "HYBRID", [
    { key: "issuer", label: "Société émettrice", type: "TEXT", required: true },
    { key: "sector", label: "Secteur", type: "TEXT" },
    { key: "ownershipBps", label: "Participation", type: "RATE" },
    { key: "acquisitionCents", label: "Coût d'acquisition", type: "MONEY", required: true },
    { key: "bookValueCents", label: "Valeur comptable", type: "MONEY" },
    { key: "incomeCents", label: "Produits", type: "MONEY" },
    ...sourceColumns,
  ], { accountPrefixes: ["251"] }),
  table(12, "Détail de la TVA", "AUTOMATIC", adjustmentColumns),
  table(13, "État de répartition du capital social", "MANUAL", [
    { key: "shareholder", label: "Associé / actionnaire", type: "TEXT", required: true },
    { key: "identifier", label: "Identifiant / ICE", type: "TEXT" },
    { key: "address", label: "Adresse", type: "TEXT" },
    { key: "shares", label: "Titres", type: "INTEGER", required: true },
    { key: "nominalCents", label: "Valeur nominale", type: "MONEY" },
    { key: "ownershipBps", label: "Participation", type: "RATE", required: true },
    ...sourceColumns,
  ]),
  table(14, "État d'affectation des résultats", "HYBRID", [
    { key: "destination", label: "Affectation", type: "TEXT", required: true },
    { key: "amountCents", label: "Montant", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["11", "115", "116", "118"] }),
  table(15, "Détermination de l'IS pour les entreprises bénéficiant de mesures d'incitation à l'investissement", "MANUAL", [
    { key: "measure", label: "Mesure d'incitation", type: "TEXT", required: true },
    { key: "eligibleBaseCents", label: "Base éligible", type: "MONEY", required: true },
    { key: "rateBps", label: "Taux vérifié", type: "RATE" },
    { key: "taxImpactCents", label: "Impact IS", type: "MONEY" },
    { key: "legalReference", label: "Référence légale vérifiée", type: "TEXT", required: true },
    ...sourceColumns,
  ]),
  table(16, "Dotations aux amortissements relatives aux immobilisations", "HYBRID", [
    { key: "asset", label: "Immobilisation", type: "TEXT", required: true },
    { key: "acquiredOn", label: "Date d'acquisition", type: "DATE" },
    { key: "basisCents", label: "Base amortissable", type: "MONEY", required: true },
    { key: "method", label: "Méthode", type: "TEXT" },
    { key: "rateBps", label: "Taux", type: "RATE" },
    { key: "currentChargeCents", label: "Dotation exercice", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["619", "639", "659", "28"] }),
  table(17, "Plus-values constatées en cas de fusion d'entreprises", "MANUAL", [
    { key: "mergedEntity", label: "Société fusionnée", type: "TEXT", required: true },
    { key: "operationOn", label: "Date d'opération", type: "DATE", required: true },
    { key: "asset", label: "Élément concerné", type: "TEXT", required: true },
    { key: "gainCents", label: "Plus-value", type: "MONEY", required: true },
    { key: "treatment", label: "Traitement", type: "TEXT" },
    ...sourceColumns,
  ]),
  table(18, "État des intérêts sur emprunts auprès des associés et des tiers", "HYBRID", [
    { key: "lender", label: "Prêteur", type: "TEXT", required: true },
    { key: "relationship", label: "Lien", type: "TEXT" },
    { key: "openingPrincipalCents", label: "Principal ouverture", type: "MONEY" },
    { key: "closingPrincipalCents", label: "Principal clôture", type: "MONEY", required: true },
    { key: "rateBps", label: "Taux", type: "RATE" },
    { key: "interestCents", label: "Intérêts", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["148", "448", "631"] }),
  table(19, "Tableau des locations et loyers (hors crédit-bail)", "HYBRID", [
    { key: "lessor", label: "Bailleur", type: "TEXT", required: true },
    { key: "asset", label: "Bien loué", type: "TEXT", required: true },
    { key: "address", label: "Adresse", type: "TEXT" },
    { key: "startsOn", label: "Début", type: "DATE" },
    { key: "endsOn", label: "Fin", type: "DATE" },
    { key: "rentCents", label: "Loyers exercice", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["6131"] }),
  table(20, "État détaillé des stocks", "HYBRID", [
    { key: "category", label: "Catégorie / compte", type: "TEXT", required: true },
    { key: "openingCents", label: "Stock initial", type: "MONEY" },
    { key: "entriesCents", label: "Entrées", type: "MONEY" },
    { key: "exitsCents", label: "Sorties", type: "MONEY" },
    { key: "impairmentCents", label: "Dépréciation", type: "MONEY" },
    { key: "closingCents", label: "Stock final", type: "MONEY", required: true },
    ...sourceColumns,
  ], { accountPrefixes: ["31", "32", "33", "34", "35", "39"] }),
  table(21, "Opérations en devises enregistrées au cours de l'exercice", "MANUAL", [
    { key: "operationOn", label: "Date", type: "DATE", required: true },
    { key: "currency", label: "Devise", type: "TEXT", required: true },
    { key: "operation", label: "Opération / tiers", type: "TEXT", required: true },
    { key: "foreignAmount", label: "Montant devise", type: "TEXT", required: true },
    { key: "exchangeRate", label: "Cours", type: "TEXT", required: true },
    { key: "madAmountCents", label: "Contre-valeur MAD", type: "MONEY", required: true },
    { key: "gainLossCents", label: "Écart de change", type: "MONEY" },
    ...sourceColumns,
  ]),
  table(22, "État des changements de méthodes", "MANUAL", [
    { key: "area", label: "Domaine", type: "TEXT", required: true },
    { key: "oldMethod", label: "Ancienne méthode", type: "TEXT", required: true },
    { key: "newMethod", label: "Nouvelle méthode", type: "TEXT", required: true },
    { key: "reason", label: "Motif", type: "TEXT", required: true },
    { key: "financialEffectCents", label: "Effet financier", type: "MONEY" },
    ...sourceColumns,
  ]),
  table(23, "État des dérogations", "MANUAL", [
    { key: "rule", label: "Principe / règle", type: "TEXT", required: true },
    { key: "reason", label: "Motif de la dérogation", type: "TEXT", required: true },
    { key: "assetEffectCents", label: "Effet sur patrimoine", type: "MONEY" },
    { key: "resultEffectCents", label: "Effet sur résultat", type: "MONEY" },
    { key: "approval", label: "Approbation / référence", type: "TEXT" },
    ...sourceColumns,
  ]),
  table(24, "Tableau de financement de l'exercice", "HYBRID", [
    { key: "item", label: "Ressource / emploi", type: "TEXT", required: true },
    { key: "currentCents", label: "Exercice", type: "MONEY", required: true },
    { key: "priorCents", label: "Exercice précédent", type: "MONEY" },
    { key: "flowCents", label: "Flux / variation", type: "MONEY" },
    ...sourceColumns,
  ], { accountPrefixes: ["1", "2", "3", "4", "5"] }),
  table(25, "Principales méthodes d'évaluation spécifiques à l'entreprise", "MANUAL", [
    { key: "section", label: "Nature", type: "TEXT", required: true },
    { key: "method", label: "Description de la méthode", type: "TEXT", required: true },
    ...sourceColumns,
  ]),
] as const;

export const FISCAL_TABLE_VIEWS = FISCAL_TABLE_CATALOG.flatMap((definition) =>
  definition.views.map((view) => ({ ...view, tableId: definition.id, number: definition.number })),
);

export function fiscalTableDefinition(tableId: string) {
  return FISCAL_TABLE_CATALOG.find((item) => item.id === tableId);
}

export function fiscalCatalogForRenderer() {
  return {
    regime: "NORMAL",
    version: FISCAL_CATALOG_VERSION,
    sourceCitation: FISCAL_SOURCE_CITATION,
    tables: FISCAL_TABLE_CATALOG,
    views: FISCAL_TABLE_VIEWS,
  };
}
