/**
 * The stock module's service and its renderer surface.
 *
 * Reads, catalogue maintenance, document drafting, and the two operations that
 * actually move stock — validation and contrepassation, both of which live in
 * `stockValidation.ts` and run inside one transaction each.
 *
 * Two rules govern every handler below:
 *
 *  - **Every channel checks permission and dossier membership in the main
 *    process.** What the renderer chose to show is a convenience; a renderer
 *    that invokes a channel with another dossier's id gets nothing, which
 *    `tests/wheat-stock-domain-unit.spec.cjs` and the IPC tests both check.
 *  - **Quantities and values cross to the renderer as exact decimal strings.**
 *    A BigInt cannot survive structured cloning, and a float would undo the
 *    whole point of the arithmetic, so each payload carries the scaled value
 *    (serialised as a string) alongside a display decimal produced by
 *    `qtyToDisplay`/`moneyToDisplay`.
 */

import { optionalText, parseAccountingDate, requireId, requireText } from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { STOCK_ACCOUNT_SUGGESTIONS, STOCK_IMPAIRMENT_SUGGESTIONS, mappingScopeKey } from "./stockAccounting";
import {
  STOCK_DOCUMENT_STATUS,
  STOCK_DOCUMENT_TYPES,
  STOCK_DOCUMENT_TYPE_IDS,
  StockError,
  optionalStockDirection,
  provisionalStockReference,
  requireStockDocumentType,
  requireStockQuantity,
  stockCardColumn,
} from "./stockDomain";
import { derivedUnitCost, moneyFromDecimal, moneyToDisplay, qtyToDisplay } from "./stockUnits";
import { VALUATION_METHODS, isValuationMethod } from "./stockValuation";
import { reverseStockDocumentInTransaction, validateStockDocumentInTransaction } from "./stockValidation";

type PrismaLike = Record<string, any> & {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

export type StockServiceOptions = {
  getPrisma: () => PrismaLike | Promise<PrismaLike>;
  getActorUserId?: () => string | null | Promise<string | null>;
  serialize?: <T>(value: T) => T;
};

/**
 * What a role may do with stock.
 *
 * Expressed against the roles Wheat already has rather than a permission table
 * of its own: a dossier that decided who its accountant is has already decided
 * who may validate a bon de sortie.
 */
export const STOCK_PERMISSIONS = {
  view: ["ADMIN", "ACCOUNTANT", "VIEWER"],
  viewValuation: ["ADMIN", "ACCOUNTANT", "VIEWER"],
  manageCatalogue: ["ADMIN", "ACCOUNTANT"],
  createDocuments: ["ADMIN", "ACCOUNTANT"],
  validateDocuments: ["ADMIN", "ACCOUNTANT"],
  reverseDocuments: ["ADMIN", "ACCOUNTANT"],
  performInventory: ["ADMIN", "ACCOUNTANT"],
  importData: ["ADMIN", "ACCOUNTANT"],
  configureAccounting: ["ADMIN"],
} as const;

export type StockPermission = keyof typeof STOCK_PERMISSIONS;

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StockError(`${label} est invalide.`);
  return value as Record<string, any>;
}

/**
 * Confirms the caller may do this, in this dossier, before anything is read.
 *
 * The companyId arrives from the renderer and is never trusted on its own: the
 * membership row is what grants access, so a forged id resolves to no
 * membership and the call stops here.
 */
async function authorize(
  prisma: PrismaLike,
  actorUserId: string | null,
  companyIdValue: unknown,
  permission: StockPermission,
): Promise<{ companyId: string; actorUserId: string | null; role: string }> {
  const companyId = requireId(companyIdValue, "La société");
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) throw new StockError("Le dossier actif n'existe plus.");
  if (!actorUserId) throw new StockError("Une session utilisateur identifiée est requise.");

  const [actor, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, role: true } }),
    prisma.companyUser.findFirst({ where: { companyId, userId: actorUserId }, select: { role: true } }),
  ]);
  if (!actor || !membership) throw new StockError("Vous n'avez pas accès à ce dossier.");
  const role = actor.role === "ADMIN" ? "ADMIN" : String(membership.role || actor.role || "VIEWER").toUpperCase();
  if (!(STOCK_PERMISSIONS[permission] as readonly string[]).includes(role)) {
    throw new StockError(`Le rôle ${role} ne permet pas cette action sur le stock.`);
  }
  return { companyId, actorUserId, role };
}

const quantity = (value: bigint) => ({ raw: value.toString(), display: qtyToDisplay(value) });
const amount = (value: bigint) => ({ raw: value.toString(), display: moneyToDisplay(value) });

/** Display-only, and rounded by the one rule that owns that decision. */
function unitCostOf(value: bigint, quantity: bigint) {
  const cost = derivedUnitCost(value, quantity);
  return cost === null ? null : amount(cost);
}

/**
 * Ensures the dossier has the one settings row stock depends on.
 *
 * Created empty rather than pre-filled: the journal and the account mapping are
 * decisions the accountant makes, and a row that guessed them would look like
 * a configured dossier.
 */
async function ensureSettings(prisma: PrismaLike, companyId: string) {
  const existing = await prisma.stockSettings.findUnique({ where: { companyId } });
  if (existing) return existing;
  return prisma.stockSettings.create({ data: { companyId } });
}

export function createStockService(options: StockServiceOptions) {
  const serialize = options.serialize ?? (<T>(value: T) => value);
  const actor = async () => (await options.getActorUserId?.()) ?? null;

  async function context(companyIdValue: unknown, permission: StockPermission) {
    const prisma = await options.getPrisma();
    const authorized = await authorize(prisma, await actor(), companyIdValue, permission);
    return { prisma, ...authorized };
  }

  return {
    /** Everything the workspace needs to render its shell in one round trip. */
    async getWorkspace(payloadValue: unknown) {
      const payload = record(payloadValue, "La consultation du stock");
      const { prisma, companyId, role } = await context(payload.companyId, "view");
      const settings = await ensureSettings(prisma, companyId);

      const [articles, families, units, warehouses, balances, drafts, mappings, journals] = await Promise.all([
        prisma.stockArticle.findMany({
          where: { companyId },
          orderBy: { designation: "asc" },
          include: { family: { select: { id: true, code: true, designation: true } }, unit: { select: { id: true, code: true, label: true } } },
        }),
        prisma.stockArticleFamily.findMany({ where: { companyId }, orderBy: { code: "asc" } }),
        prisma.stockUnit.findMany({ where: { companyId }, orderBy: { code: "asc" } }),
        prisma.stockWarehouse.findMany({ where: { companyId }, orderBy: { code: "asc" }, include: { locations: { orderBy: { code: "asc" } } } }),
        prisma.stockBalance.findMany({ where: { companyId }, include: { article: { select: { id: true, sku: true, designation: true, minQuantity: true } } } }),
        prisma.stockDocument.count({ where: { companyId, status: STOCK_DOCUMENT_STATUS.draft } }),
        prisma.stockAccountMapping.findMany({
          where: { companyId },
          include: {
            stockAccount: { select: { id: true, code: true, label: true } },
            variationAccount: { select: { id: true, code: true, label: true } },
            family: { select: { id: true, code: true, designation: true } },
            article: { select: { id: true, sku: true, designation: true } },
          },
        }),
        prisma.journal.findMany({ where: { companyId, active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, label: true } }),
      ]);

      const totalValue = balances.reduce((sum: bigint, balance: any) => sum + balance.value, 0n);
      const totalQuantity = balances.reduce((sum: bigint, balance: any) => sum + balance.quantity, 0n);
      const byArticle = new Map<string, { quantity: bigint; minQuantity: bigint }>();
      for (const balance of balances) {
        const held = byArticle.get(balance.articleId) ?? { quantity: 0n, minQuantity: balance.article.minQuantity };
        held.quantity += balance.quantity;
        byArticle.set(balance.articleId, held);
      }
      const belowMinimum = [...byArticle.values()].filter((entry) => entry.minQuantity > 0n && entry.quantity < entry.minQuantity).length;
      const outOfStock = [...byArticle.values()].filter((entry) => entry.quantity <= 0n).length;

      const soon = new Date();
      soon.setUTCDate(soon.getUTCDate() + 90);
      const expiringLots = await prisma.stockLot.count({
        where: { companyId, expiresOn: { not: null, lte: soon } },
      });

      return serialize({
        role,
        settings: {
          id: settings.id,
          allowNegativeStock: settings.allowNegativeStock,
          stockJournalId: settings.stockJournalId,
          impairmentAccountId: settings.impairmentAccountId,
          impairmentChargeAccountId: settings.impairmentChargeAccountId,
          impairmentReversalAccountId: settings.impairmentReversalAccountId,
          configured: Boolean(settings.stockJournalId) && mappings.length > 0,
        },
        overview: {
          totalValue: amount(totalValue),
          totalQuantity: quantity(totalQuantity),
          activeArticles: articles.filter((article: any) => article.active).length,
          belowMinimum,
          outOfStock,
          expiringLots,
          draftDocuments: drafts,
        },
        articles: articles.map((article: any) => ({
          ...article,
          minQuantity: quantity(article.minQuantity),
          maxQuantity: article.maxQuantity === null ? null : quantity(article.maxQuantity),
        })),
        families,
        units,
        warehouses,
        journals,
        mappings,
        valuationMethods: VALUATION_METHODS,
        documentTypes: STOCK_DOCUMENT_TYPE_IDS.map((id) => ({ id, ...STOCK_DOCUMENT_TYPES[id] })),
        accountSuggestions: STOCK_ACCOUNT_SUGGESTIONS,
        impairmentSuggestions: STOCK_IMPAIRMENT_SUGGESTIONS,
      });
    },

    /** État du stock: the current position of every article, per warehouse. */
    async getStockState(payloadValue: unknown) {
      const payload = record(payloadValue, "L'état du stock");
      const { prisma, companyId } = await context(payload.companyId, "view");
      const warehouseId = optionalText(payload.warehouseId, 200);
      const familyId = optionalText(payload.familyId, 200);

      const balances = await prisma.stockBalance.findMany({
        where: {
          companyId,
          ...(warehouseId ? { warehouseId } : {}),
          ...(familyId ? { article: { familyId } } : {}),
        },
        include: {
          article: { select: { id: true, sku: true, designation: true, minQuantity: true, maxQuantity: true, valuationMethod: true, familyId: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          lot: { select: { id: true, code: true, expiresOn: true } },
        },
        orderBy: [{ articleId: "asc" }],
      });

      return serialize({
        rows: balances.map((balance: any) => ({
          id: balance.id,
          article: balance.article,
          warehouse: balance.warehouse,
          lot: balance.lot,
          quantity: quantity(balance.quantity),
          value: amount(balance.value),
          // Derived for display only. The position is (quantity, value); this
          // figure is never fed back into it.
          unitCost: unitCostOf(balance.value, balance.quantity),
          belowMinimum: balance.article.minQuantity > 0n && balance.quantity < balance.article.minQuantity,
        })),
        totals: {
          quantity: quantity(balances.reduce((sum: bigint, balance: any) => sum + balance.quantity, 0n)),
          value: amount(balances.reduce((sum: bigint, balance: any) => sum + balance.value, 0n)),
        },
      });
    },

    /**
     * The stock card: one row per movement, with the running position after it.
     *
     * The running balance is accumulated over the filtered set rather than read
     * from each movement's stored result, because a card filtered to one
     * warehouse, one lot or one date range is a different series from the one
     * the register recorded — and the opening line below is what makes the
     * first row of a filtered card mean something.
     */
    async getStockCard(payloadValue: unknown) {
      const payload = record(payloadValue, "La fiche de stock");
      const { prisma, companyId } = await context(payload.companyId, "viewValuation");
      const articleId = requireId(payload.articleId, "L'article");
      const warehouseId = optionalText(payload.warehouseId, 200);
      const lotId = optionalText(payload.lotId, 200);
      const counterpartyId = optionalText(payload.counterpartyId, 200);
      const documentType = payload.documentType ? requireStockDocumentType(payload.documentType) : null;
      const direction = optionalStockDirection(payload.direction);
      const from = payload.from ? parseAccountingDate(payload.from, "La date de début") : null;
      const to = payload.to ? parseAccountingDate(payload.to, "La date de fin") : null;

      const article = await prisma.stockArticle.findFirst({
        where: { id: articleId, companyId },
        include: {
          family: { select: { id: true, code: true, designation: true } },
          unit: { select: { id: true, code: true, label: true } },
        },
      });
      if (!article) throw new StockError("Cet article n'existe plus ou n'appartient pas à ce dossier.");

      const scope = {
        companyId,
        articleId,
        ...(warehouseId ? { warehouseId } : {}),
        ...(lotId ? { lotId } : {}),
        ...(counterpartyId ? { counterpartyId } : {}),
        ...(documentType ? { documentType } : {}),
        ...(direction ? { direction } : {}),
      };

      // What the position already was when the visible window opens.
      const opening = from
        ? await prisma.stockMovement.findMany({ where: { ...scope, documentDate: { lt: from } }, select: { direction: true, quantity: true, value: true } })
        : [];
      let runningQuantity = opening.reduce((sum: bigint, movement: any) => sum + (movement.direction === "IN" ? movement.quantity : -movement.quantity), 0n);
      let runningValue = opening.reduce((sum: bigint, movement: any) => sum + (movement.direction === "IN" ? movement.value : -movement.value), 0n);
      const openingQuantity = runningQuantity;
      const openingValue = runningValue;

      const movements = await prisma.stockMovement.findMany({
        where: {
          ...scope,
          ...(from || to ? { documentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
        include: {
          document: {
            select: {
              id: true, reference: true, type: true, status: true, accountingEntryId: true,
              warehouse: { select: { id: true, name: true } },
              targetWarehouse: { select: { id: true, name: true } },
            },
          },
          warehouse: { select: { id: true, code: true, name: true } },
          lot: { select: { id: true, code: true, expiresOn: true } },
        },
      });

      const rows = movements.map((movement: any) => {
        runningQuantity += movement.direction === "IN" ? movement.quantity : -movement.quantity;
        runningValue += movement.direction === "IN" ? movement.value : -movement.value;
        const column = stockCardColumn(movement.documentType, movement.direction);
        return {
          id: movement.id,
          date: movement.documentDate,
          designation: describeMovement(movement),
          column,
          documentType: movement.documentType,
          direction: movement.direction,
          reference: movement.document?.reference ?? null,
          documentId: movement.documentId,
          documentStatus: movement.document?.status ?? null,
          accountingEntryId: movement.document?.accountingEntryId ?? null,
          warehouse: movement.warehouse,
          lot: movement.lot,
          quantity: quantity(movement.quantity),
          value: amount(movement.value),
          runningQuantity: quantity(runningQuantity),
          runningValue: amount(runningValue),
        };
      });

      const balances = await prisma.stockBalance.findMany({
        where: { companyId, articleId, ...(warehouseId ? { warehouseId } : {}) },
      });
      const currentQuantity = balances.reduce((sum: bigint, balance: any) => sum + balance.quantity, 0n);
      const currentValue = balances.reduce((sum: bigint, balance: any) => sum + balance.value, 0n);

      return serialize({
        article: {
          ...article,
          minQuantity: quantity(article.minQuantity),
          maxQuantity: article.maxQuantity === null ? null : quantity(article.maxQuantity),
        },
        header: {
          currentQuantity: quantity(currentQuantity),
          currentValue: amount(currentValue),
          unitCost: unitCostOf(currentValue, currentQuantity),
          valuationMethod: article.valuationMethod,
        },
        opening: { quantity: quantity(openingQuantity), value: amount(openingValue) },
        rows,
      });
    },

    /** Everything behind one row of the card, for the details panel. */
    async getMovementDetail(payloadValue: unknown) {
      const payload = record(payloadValue, "Le détail du mouvement");
      const { prisma, companyId } = await context(payload.companyId, "viewValuation");
      const movementId = requireId(payload.movementId, "Le mouvement");
      const movement = await prisma.stockMovement.findFirst({
        where: { id: movementId, companyId },
        include: {
          article: { select: { id: true, sku: true, designation: true, valuationMethod: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          location: { select: { id: true, code: true, label: true } },
          lot: { select: { id: true, code: true, expiresOn: true } },
          documentLine: { include: { costAllocations: { include: { landedCost: true } } } },
          document: {
            include: {
              counterparty: { select: { id: true, displayName: true, kind: true } },
              createdBy: { select: { id: true, name: true } },
              validatedBy: { select: { id: true, name: true } },
              accountingEntry: { select: { id: true, number: true, pieceNumber: true, status: true } },
              reversalOf: { select: { id: true, reference: true } },
              reversals: { select: { id: true, reference: true } },
              // Both dépôts, so `describeMovement` can name the counterpart one.
              warehouse: { select: { id: true, name: true } },
              targetWarehouse: { select: { id: true, name: true } },
            },
          },
          consumptions: { include: { layer: { include: { document: { select: { id: true, reference: true, documentDate: true } } } } } },
        },
      });
      if (!movement) throw new StockError("Ce mouvement n'existe plus ou n'appartient pas à ce dossier.");

      const beforeQuantity = movement.direction === "IN"
        ? movement.resultingQuantity - movement.quantity
        : movement.resultingQuantity + movement.quantity;
      const beforeValue = movement.direction === "IN"
        ? movement.resultingValue - movement.value
        : movement.resultingValue + movement.value;

      return serialize({
        movement: {
          id: movement.id,
          date: movement.documentDate,
          designation: describeMovement(movement),
          direction: movement.direction,
          documentType: movement.documentType,
          quantity: quantity(movement.quantity),
          value: amount(movement.value),
          unitValue: unitCostOf(movement.value, movement.quantity),
          beforeQuantity: quantity(beforeQuantity),
          afterQuantity: quantity(movement.resultingQuantity),
          beforeValue: amount(beforeValue),
          afterValue: amount(movement.resultingValue),
          warehouse: movement.warehouse,
          location: movement.location,
          lot: movement.lot,
          createdAt: movement.createdAt,
        },
        document: movement.document,
        landedCosts: movement.documentLine?.costAllocations?.map((allocation: any) => ({
          label: allocation.landedCost.label,
          kind: allocation.landedCost.kind,
          method: allocation.landedCost.allocationMethod,
          amount: amount(allocation.amount),
        })) ?? [],
        fifo: movement.consumptions.map((consumption: any) => ({
          id: consumption.id,
          kind: consumption.kind,
          layerId: consumption.layerId,
          layerReference: consumption.layer?.document?.reference ?? null,
          layerDate: consumption.layer?.document?.documentDate ?? null,
          quantity: quantity(consumption.quantity),
          value: amount(consumption.value),
          exhausted: consumption.exhausted,
        })),
      });
    },

    async listDocuments(payloadValue: unknown) {
      const payload = record(payloadValue, "La liste des documents de stock");
      const { prisma, companyId } = await context(payload.companyId, "view");
      const status = optionalText(payload.status, 40);
      const type = payload.type ? requireStockDocumentType(payload.type) : null;
      const documents = await prisma.stockDocument.findMany({
        where: { companyId, ...(status ? { status } : {}), ...(type ? { type } : {}) },
        orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
        take: 500,
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          targetWarehouse: { select: { id: true, code: true, name: true } },
          counterparty: { select: { id: true, displayName: true } },
          accountingEntry: { select: { id: true, number: true, status: true } },
          _count: { select: { lines: true } },
        },
      });
      return serialize(documents);
    },

    async getDocument(payloadValue: unknown) {
      const payload = record(payloadValue, "Le document de stock");
      const { prisma, companyId } = await context(payload.companyId, "view");
      const documentId = requireId(payload.documentId, "Le document");
      const document = await prisma.stockDocument.findFirst({
        where: { id: documentId, companyId },
        include: {
          lines: {
            orderBy: { position: "asc" },
            include: {
              article: { select: { id: true, sku: true, designation: true, valuationMethod: true, lotTracking: true } },
              unit: true, warehouse: true, location: true, lot: true,
            },
          },
          landedCosts: { orderBy: { position: "asc" }, include: { allocations: true } },
          warehouse: true,
          targetWarehouse: true,
          counterparty: { select: { id: true, displayName: true, kind: true } },
          accountingEntry: { select: { id: true, number: true, pieceNumber: true, status: true } },
          movements: { orderBy: { sequence: "asc" } },
          reversalOf: { select: { id: true, reference: true } },
          reversals: { select: { id: true, reference: true, documentDate: true } },
        },
      });
      if (!document) throw new StockError("Ce document n'existe plus ou n'appartient pas à ce dossier.");
      return serialize({
        ...document,
        lines: document.lines.map((line: any) => ({
          ...line,
          quantity: quantity(line.quantity),
          unitValue: line.unitValue === null ? null : amount(line.unitValue),
          grossValue: amount(line.grossValue),
          allocatedChargeValue: amount(line.allocatedChargeValue),
          stockValue: line.stockValue === null ? null : amount(line.stockValue),
        })),
      });
    },

    /**
     * Creates or replaces a draft. Drafts never move stock, so this is an
     * ordinary edit right up to the moment someone validates it.
     */
    async saveDocument(payloadValue: unknown) {
      const payload = record(payloadValue, "Le document de stock");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "createDocuments");
      const type = requireStockDocumentType(payload.type);
      const definition = STOCK_DOCUMENT_TYPES[type];
      const documentDate = parseAccountingDate(payload.documentDate, "La date du document");
      const warehouseId = requireId(payload.warehouseId, "Le dépôt");
      const documentId = optionalText(payload.documentId, 200);
      const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
      if (rawLines.length === 0) throw new StockError("Un document de stock doit comporter au moins une ligne.");

      const fiscalYear = await prisma.fiscalYear.findFirst({
        where: { companyId, startsOn: { lte: documentDate }, endsOn: { gte: documentDate } },
        orderBy: { startsOn: "desc" },
      });
      if (!fiscalYear) throw new StockError("La date du document ne correspond à aucun exercice comptable.");

      const warehouse = await prisma.stockWarehouse.findFirst({ where: { id: warehouseId, companyId } });
      if (!warehouse) throw new StockError("Ce dépôt n'appartient pas à ce dossier.");
      const targetWarehouseId = optionalText(payload.targetWarehouseId, 200);
      if (definition.flow === "TRANSFER") {
        if (!targetWarehouseId) throw new StockError("Un transfert doit désigner un dépôt de destination.");
        const target = await prisma.stockWarehouse.findFirst({ where: { id: targetWarehouseId, companyId } });
        if (!target) throw new StockError("Le dépôt de destination n'appartient pas à ce dossier.");
      }
      const counterpartyId = optionalText(payload.counterpartyId, 200);
      if (definition.requiresCounterparty && !counterpartyId) {
        throw new StockError(`Un ${definition.label.toLowerCase()} doit désigner un tiers.`);
      }

      const articleIds = [...new Set(rawLines.map((line: any) => requireId(line?.articleId, "L'article de la ligne")))];
      const articles = await prisma.stockArticle.findMany({ where: { id: { in: articleIds }, companyId } });
      if (articles.length !== articleIds.length) throw new StockError("Une ligne référence un article d'un autre dossier.");
      const articleById = new Map<string, any>(articles.map((article: any) => [article.id, article]));

      const lines = rawLines.map((rawLine: any, index: number) => {
        const line = record(rawLine, `La ligne ${index + 1}`);
        const article = articleById.get(String(line.articleId));
        return {
          position: index + 1,
          articleId: article.id,
          quantity: requireStockQuantity(line.quantity, `La quantité de la ligne ${index + 1}`),
          unitId: optionalText(line.unitId, 200) ?? article.unitId,
          warehouseId: optionalText(line.warehouseId, 200) ?? warehouseId,
          locationId: optionalText(line.locationId, 200),
          lotId: optionalText(line.lotId, 200),
          direction: definition.flow === "LINE" ? optionalStockDirection(line.direction) : null,
          unitValue: line.unitValue === undefined || line.unitValue === null || line.unitValue === ""
            ? null
            : moneyFromDecimal(line.unitValue, `La valeur unitaire de la ligne ${index + 1}`),
          grossValue: line.grossValue === undefined || line.grossValue === null || line.grossValue === ""
            ? 0n
            : moneyFromDecimal(line.grossValue, `La valeur de la ligne ${index + 1}`),
          description: optionalText(line.description, 250),
        };
      });

      const landedCosts = Array.isArray(payload.landedCosts) ? payload.landedCosts.map((rawCharge: any, index: number) => {
        const charge = record(rawCharge, `Le frais ${index + 1}`);
        return {
          companyId,
          position: index + 1,
          kind: requireText(charge.kind ?? "AUTRE", `La nature du frais ${index + 1}`, 40),
          label: requireText(charge.label, `Le libellé du frais ${index + 1}`, 120),
          amount: moneyFromDecimal(charge.amount, `Le montant du frais ${index + 1}`),
          allocationMethod: ["QUANTITY", "VALUE", "MANUAL"].includes(String(charge.allocationMethod))
            ? String(charge.allocationMethod)
            : "VALUE",
        };
      }) : [];
      if (landedCosts.length > 0 && !definition.acceptsLandedCosts) {
        throw new StockError(`Un ${definition.label.toLowerCase()} ne peut pas porter de frais d'acquisition.`);
      }

      return prisma.$transaction(async (tx: any) => {
        if (documentId) {
          const existing = await tx.stockDocument.findFirst({ where: { id: documentId, companyId } });
          if (!existing) throw new StockError("Ce document n'existe plus ou n'appartient pas à ce dossier.");
          if (existing.status !== STOCK_DOCUMENT_STATUS.draft) {
            throw new StockError("Un document validé ne peut plus être modifié ; corrigez-le par contrepassation.");
          }
          if (payload.expectedVersion !== undefined && existing.version !== payload.expectedVersion) {
            throw new StockError("Ce document a changé depuis son affichage. Rechargez-le.");
          }
          await tx.stockLandedCost.deleteMany({ where: { documentId } });
          await tx.stockDocumentLine.deleteMany({ where: { documentId } });
          const updated = await tx.stockDocument.update({
            where: { id: documentId },
            data: {
              type, documentDate, warehouseId,
              targetWarehouseId: definition.flow === "TRANSFER" ? targetWarehouseId : null,
              counterpartyId,
              fiscalYearId: fiscalYear.id,
              note: optionalText(payload.note, 500),
              version: { increment: 1 },
              lines: { create: lines },
            },
          });
          for (const charge of landedCosts) {
            await tx.stockLandedCost.create({ data: { ...charge, documentId } });
          }
          await appendActivityAndAudit(tx, {
            companyId, actorUserId, action: "STOCK_DOCUMENT_UPDATED", entityType: "StockDocument", entityId: documentId,
            description: `Brouillon de stock ${updated.reference} modifié`,
            payload: { type, lines: lines.length },
          });
          return serialize(updated);
        }

        const created = await tx.stockDocument.create({
          data: {
            companyId,
            fiscalYearId: fiscalYear.id,
            type,
            reference: provisionalStockReference(),
            documentDate,
            warehouseId,
            targetWarehouseId: definition.flow === "TRANSFER" ? targetWarehouseId : null,
            counterpartyId,
            note: optionalText(payload.note, 500),
            createdByUserId: actorUserId,
            lines: { create: lines },
          },
        });
        for (const charge of landedCosts) {
          await tx.stockLandedCost.create({ data: { ...charge, documentId: created.id } });
        }
        await appendActivityAndAudit(tx, {
          companyId, actorUserId, action: "STOCK_DOCUMENT_CREATED", entityType: "StockDocument", entityId: created.id,
          description: `Brouillon de stock ${definition.label} créé`,
          payload: { type, lines: lines.length },
        });
        return serialize(created);
      });
    },

    async deleteDocument(payloadValue: unknown) {
      const payload = record(payloadValue, "La suppression du document");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "createDocuments");
      const documentId = requireId(payload.documentId, "Le document");
      return prisma.$transaction(async (tx: any) => {
        const document = await tx.stockDocument.findFirst({ where: { id: documentId, companyId } });
        if (!document) throw new StockError("Ce document n'existe plus ou n'appartient pas à ce dossier.");
        if (document.status !== STOCK_DOCUMENT_STATUS.draft) {
          throw new StockError("Seul un brouillon peut être supprimé ; un document validé se corrige par contrepassation.");
        }
        await tx.stockDocument.delete({ where: { id: documentId } });
        await appendActivityAndAudit(tx, {
          companyId, actorUserId, action: "STOCK_DOCUMENT_DELETED", entityType: "StockDocument", entityId: documentId,
          description: `Brouillon de stock ${document.reference} supprimé`,
          payload: { type: document.type },
        });
        return serialize({ ok: true, id: documentId });
      });
    },

    /**
     * What validating this document will do, before it is done.
     *
     * Read-only and deliberately cheap: it states the quantities and the dépôt,
     * because "Valider ?" with no numbers is a question nobody can answer.
     */
    async previewValidation(payloadValue: unknown) {
      const payload = record(payloadValue, "La prévisualisation");
      const { prisma, companyId } = await context(payload.companyId, "validateDocuments");
      const documentId = requireId(payload.documentId, "Le document");
      const document = await prisma.stockDocument.findFirst({
        where: { id: documentId, companyId },
        include: {
          lines: { orderBy: { position: "asc" }, include: { article: { select: { id: true, sku: true, designation: true } } } },
          warehouse: true, targetWarehouse: true,
          landedCosts: true,
        },
      });
      if (!document) throw new StockError("Ce document n'existe plus ou n'appartient pas à ce dossier.");
      if (document.status !== STOCK_DOCUMENT_STATUS.draft) throw new StockError("Ce document n'est pas un brouillon.");
      const definition = STOCK_DOCUMENT_TYPES[document.type];
      const outbound = definition.flow === "OUT";
      return serialize({
        documentId: document.id,
        version: document.version,
        type: document.type,
        label: definition.label,
        reference: document.reference,
        date: document.documentDate,
        warehouse: document.warehouse,
        targetWarehouse: document.targetWarehouse,
        lines: document.lines.map((line: any) => ({
          article: line.article,
          quantity: quantity(outbound ? -line.quantity : line.quantity),
        })),
        landedCostTotal: amount(document.landedCosts.reduce((sum: bigint, charge: any) => sum + charge.amount, 0n)),
        warning: "La validation écrit des mouvements immuables et un brouillon comptable lié ; toute correction ultérieure exigera une contrepassation.",
      });
    },

    async validateDocument(payloadValue: unknown) {
      const payload = record(payloadValue, "La validation");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "validateDocuments");
      const documentId = requireId(payload.documentId, "Le document");
      const expectedVersion = payload.expectedVersion === undefined ? undefined : Number(payload.expectedVersion);
      const result = await prisma.$transaction(async (tx: any) => validateStockDocumentInTransaction(tx, {
        companyId, documentId, actorUserId, expectedVersion,
      }));
      return serialize(result);
    },

    async reverseDocument(payloadValue: unknown) {
      const payload = record(payloadValue, "La contrepassation");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "reverseDocuments");
      const documentId = requireId(payload.documentId, "Le document");
      const date = payload.date ? parseAccountingDate(payload.date, "La date de contrepassation") : null;
      const result = await prisma.$transaction(async (tx: any) => reverseStockDocumentInTransaction(tx, {
        companyId, documentId, actorUserId, date, reason: optionalText(payload.reason, 500),
      }));
      return serialize(result);
    },

    async saveArticle(payloadValue: unknown) {
      const payload = record(payloadValue, "L'article");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "manageCatalogue");
      const id = optionalText(payload.id, 200);
      const sku = requireText(payload.sku, "La référence de l'article", 60);
      const designation = requireText(payload.designation, "La désignation de l'article", 200);
      const valuationMethod = payload.valuationMethod ?? "CMP";
      if (!isValuationMethod(valuationMethod)) throw new StockError("La méthode de valorisation est invalide.");
      const unitId = requireId(payload.unitId, "L'unité");

      const unit = await prisma.stockUnit.findFirst({ where: { id: unitId, companyId } });
      if (!unit) throw new StockError("Cette unité n'appartient pas à ce dossier.");
      const familyId = optionalText(payload.familyId, 200);
      if (familyId) {
        const family = await prisma.stockArticleFamily.findFirst({ where: { id: familyId, companyId } });
        if (!family) throw new StockError("Cette famille n'appartient pas à ce dossier.");
      }

      const data = {
        companyId,
        sku,
        designation,
        description: optionalText(payload.description, 1000),
        barcode: optionalText(payload.barcode, 60),
        familyId,
        unitId,
        valuationMethod,
        minQuantity: payload.minQuantity ? requireStockQuantity(payload.minQuantity, "Le stock minimum") : 0n,
        maxQuantity: payload.maxQuantity ? requireStockQuantity(payload.maxQuantity, "Le stock maximum") : null,
        lotTracking: Boolean(payload.lotTracking),
        expiryTracking: Boolean(payload.expiryTracking),
        active: payload.active === undefined ? true : Boolean(payload.active),
        notes: optionalText(payload.notes, 2000),
        searchText: `${sku} ${designation}`.toLowerCase(),
      };

      try {
        return await prisma.$transaction(async (tx: any) => {
          if (id) {
            const existing = await tx.stockArticle.findFirst({ where: { id, companyId } });
            if (!existing) throw new StockError("Cet article n'existe plus ou n'appartient pas à ce dossier.");
            // Changing the method mid-history would reprice movements already
            // in the ledger, so it is refused once the article has moved.
            if (existing.valuationMethod !== valuationMethod) {
              const moved = await tx.stockMovement.count({ where: { companyId, articleId: id } });
              if (moved > 0) {
                throw new StockError("La méthode de valorisation ne peut plus changer : cet article a déjà des mouvements validés.");
              }
            }
            const updated = await tx.stockArticle.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
            await appendActivityAndAudit(tx, {
              companyId, actorUserId, action: "ARTICLE_UPDATED", entityType: "StockArticle", entityId: id,
              description: `Article ${sku} modifié`, payload: { sku, designation },
            });
            return serialize(updated);
          }
          const created = await tx.stockArticle.create({ data });
          await appendActivityAndAudit(tx, {
            companyId, actorUserId, action: "ARTICLE_CREATED", entityType: "StockArticle", entityId: created.id,
            description: `Article ${sku} créé`, payload: { sku, designation },
          });
          return serialize(created);
        });
      } catch (error: any) {
        // Prisma's own message names a constraint; the user needs the value.
        if (error?.code === "P2002") {
          const target = String(error.meta?.target ?? "");
          if (target.includes("barcode")) throw new StockError(`Le code-barres « ${data.barcode} » est déjà utilisé par un autre article.`);
          throw new StockError(`Un article avec la référence ${sku} existe déjà.`);
        }
        throw error;
      }
    },

    async saveFamily(payloadValue: unknown) {
      const payload = record(payloadValue, "La famille");
      const { prisma, companyId } = await context(payload.companyId, "manageCatalogue");
      const id = optionalText(payload.id, 200);
      const code = requireText(payload.code, "Le code de la famille", 40);
      const designation = requireText(payload.designation, "La désignation de la famille", 200);
      const parentFamilyId = optionalText(payload.parentFamilyId, 200);
      if (parentFamilyId && parentFamilyId === id) throw new StockError("Une famille ne peut pas être sa propre famille parente.");
      const data = { companyId, code, designation, parentFamilyId, active: payload.active === undefined ? true : Boolean(payload.active) };
      try {
        const saved = id
          ? await prisma.stockArticleFamily.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
          : await prisma.stockArticleFamily.create({ data });
        return serialize(saved);
      } catch (error: any) {
        if (error?.code === "P2002") throw new StockError(`Une famille avec le code ${code} existe déjà.`);
        throw error;
      }
    },

    async saveUnit(payloadValue: unknown) {
      const payload = record(payloadValue, "L'unité");
      const { prisma, companyId } = await context(payload.companyId, "manageCatalogue");
      const id = optionalText(payload.id, 200);
      const code = requireText(payload.code, "Le code de l'unité", 20);
      const label = requireText(payload.label, "Le libellé de l'unité", 80);
      const data = { companyId, code, label, decimals: Number(payload.decimals ?? 0) || 0, active: payload.active === undefined ? true : Boolean(payload.active) };
      try {
        const saved = id
          ? await prisma.stockUnit.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
          : await prisma.stockUnit.create({ data });
        return serialize(saved);
      } catch (error: any) {
        if (error?.code === "P2002") throw new StockError(`Une unité avec le code ${code} existe déjà.`);
        throw error;
      }
    },

    async saveWarehouse(payloadValue: unknown) {
      const payload = record(payloadValue, "Le dépôt");
      const { prisma, companyId } = await context(payload.companyId, "manageCatalogue");
      const id = optionalText(payload.id, 200);
      const code = requireText(payload.code, "Le code du dépôt", 40);
      const name = requireText(payload.name, "Le nom du dépôt", 160);
      const data = { companyId, code, name, address: optionalText(payload.address, 300), active: payload.active === undefined ? true : Boolean(payload.active) };
      try {
        const saved = id
          ? await prisma.stockWarehouse.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
          : await prisma.stockWarehouse.create({ data });
        return serialize(saved);
      } catch (error: any) {
        if (error?.code === "P2002") throw new StockError(`Un dépôt avec le code ${code} existe déjà.`);
        throw error;
      }
    },

    async saveLot(payloadValue: unknown) {
      const payload = record(payloadValue, "Le lot");
      const { prisma, companyId } = await context(payload.companyId, "manageCatalogue");
      const articleId = requireId(payload.articleId, "L'article");
      const article = await prisma.stockArticle.findFirst({ where: { id: articleId, companyId } });
      if (!article) throw new StockError("Cet article n'appartient pas à ce dossier.");
      const code = requireText(payload.code, "Le code du lot", 80);
      const id = optionalText(payload.id, 200);
      const data = {
        companyId, articleId, code,
        expiresOn: payload.expiresOn ? parseAccountingDate(payload.expiresOn, "La date de péremption") : null,
        note: optionalText(payload.note, 500),
      };
      try {
        const saved = id
          ? await prisma.stockLot.update({ where: { id }, data })
          : await prisma.stockLot.create({ data });
        return serialize(saved);
      } catch (error: any) {
        if (error?.code === "P2002") throw new StockError(`Le lot ${code} existe déjà pour cet article.`);
        throw error;
      }
    },

    async listLots(payloadValue: unknown) {
      const payload = record(payloadValue, "La liste des lots");
      const { prisma, companyId } = await context(payload.companyId, "view");
      const articleId = optionalText(payload.articleId, 200);
      const lots = await prisma.stockLot.findMany({
        where: { companyId, ...(articleId ? { articleId } : {}) },
        orderBy: [{ expiresOn: "asc" }, { code: "asc" }],
        include: { article: { select: { id: true, sku: true, designation: true } } },
      });
      return serialize(lots);
    },

    /** The dossier's stock accounting configuration: journal and mappings. */
    async saveSettings(payloadValue: unknown) {
      const payload = record(payloadValue, "Le paramétrage comptable du stock");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "configureAccounting");
      const stockJournalId = optionalText(payload.stockJournalId, 200);
      if (stockJournalId) {
        const journal = await prisma.journal.findFirst({ where: { id: stockJournalId, companyId, active: true } });
        if (!journal) throw new StockError("Ce journal n'appartient pas à ce dossier ou est archivé.");
      }
      for (const key of ["impairmentAccountId", "impairmentChargeAccountId", "impairmentReversalAccountId"] as const) {
        const accountId = optionalText(payload[key], 200);
        if (!accountId) continue;
        const account = await prisma.account.findFirst({ where: { id: accountId, companyId, active: true } });
        if (!account) throw new StockError("Un compte de dépréciation n'appartient pas à ce dossier.");
      }
      await ensureSettings(prisma, companyId);
      return prisma.$transaction(async (tx: any) => {
        const saved = await tx.stockSettings.update({
          where: { companyId },
          data: {
            allowNegativeStock: Boolean(payload.allowNegativeStock),
            stockJournalId,
            impairmentAccountId: optionalText(payload.impairmentAccountId, 200),
            impairmentChargeAccountId: optionalText(payload.impairmentChargeAccountId, 200),
            impairmentReversalAccountId: optionalText(payload.impairmentReversalAccountId, 200),
            version: { increment: 1 },
          },
        });
        await appendActivityAndAudit(tx, {
          companyId, actorUserId, action: "STOCK_SETTINGS_CHANGED", entityType: "StockSettings", entityId: saved.id,
          description: "Paramétrage comptable du stock modifié",
          payload: { allowNegativeStock: saved.allowNegativeStock, stockJournalId },
        });
        return serialize(saved);
      });
    },

    async saveAccountMapping(payloadValue: unknown) {
      const payload = record(payloadValue, "Le paramétrage comptable du stock");
      const { prisma, companyId, actorUserId } = await context(payload.companyId, "configureAccounting");
      const scope = String(payload.scope ?? "COMPANY");
      if (!["COMPANY", "FAMILY", "ARTICLE"].includes(scope)) throw new StockError("Le niveau de paramétrage est invalide.");
      const familyId = scope === "FAMILY" ? requireId(payload.familyId, "La famille") : null;
      const articleId = scope === "ARTICLE" ? requireId(payload.articleId, "L'article") : null;
      const stockAccountId = requireId(payload.stockAccountId, "Le compte de stock");
      const variationAccountId = requireId(payload.variationAccountId, "Le compte de variation");

      const [stockAccount, variationAccount] = await Promise.all([
        prisma.account.findFirst({ where: { id: stockAccountId, companyId, active: true } }),
        prisma.account.findFirst({ where: { id: variationAccountId, companyId, active: true } }),
      ]);
      if (!stockAccount) throw new StockError("Le compte de stock n'appartient pas à ce dossier ou est désactivé.");
      if (!variationAccount) throw new StockError("Le compte de variation n'appartient pas à ce dossier ou est désactivé.");
      if (familyId && !(await prisma.stockArticleFamily.findFirst({ where: { id: familyId, companyId } }))) {
        throw new StockError("Cette famille n'appartient pas à ce dossier.");
      }
      if (articleId && !(await prisma.stockArticle.findFirst({ where: { id: articleId, companyId } }))) {
        throw new StockError("Cet article n'appartient pas à ce dossier.");
      }

      const scopeKey = mappingScopeKey(scope as any, familyId ?? articleId);
      return prisma.$transaction(async (tx: any) => {
        const saved = await tx.stockAccountMapping.upsert({
          where: { companyId_scopeKey: { companyId, scopeKey } },
          create: { companyId, scope, scopeKey, familyId, articleId, stockAccountId, variationAccountId },
          update: { stockAccountId, variationAccountId, version: { increment: 1 } },
        });
        await appendActivityAndAudit(tx, {
          companyId, actorUserId, action: "STOCK_MAPPING_CHANGED", entityType: "StockAccountMapping", entityId: saved.id,
          description: `Paramétrage comptable du stock (${scope}) enregistré`,
          payload: { scope, scopeKey, stockAccount: stockAccount.code, variationAccount: variationAccount.code },
        });
        return serialize(saved);
      });
    },

    async deleteAccountMapping(payloadValue: unknown) {
      const payload = record(payloadValue, "Le paramétrage comptable du stock");
      const { prisma, companyId } = await context(payload.companyId, "configureAccounting");
      const id = requireId(payload.id, "Le paramétrage");
      const mapping = await prisma.stockAccountMapping.findFirst({ where: { id, companyId } });
      if (!mapping) throw new StockError("Ce paramétrage n'existe plus ou n'appartient pas à ce dossier.");
      await prisma.stockAccountMapping.delete({ where: { id } });
      return serialize({ ok: true, id });
    },
  };
}

/**
 * The Désignation column.
 *
 * Says what the movement actually was. A transfer names the other dépôt and the
 * direction it went, because "Transfert" alone on both halves of a transfer
 * makes the card unreadable at exactly the moment someone is trying to follow
 * where the goods went.
 */
function describeMovement(movement: any): string {
  const definition = STOCK_DOCUMENT_TYPES[movement.documentType];
  const base = definition?.movementLabel ?? movement.documentType;
  if (movement.documentType === "TRANSFER") {
    // Each half names the *other* dépôt: the row that takes goods out says
    // where they went, and the row that brings them in says where they came
    // from. Naming its own dépôt on both halves — which is the easy mistake
    // here — makes the card useless at exactly the moment someone is trying to
    // follow where the goods moved.
    const incoming = movement.direction === "IN";
    const counterpart = incoming ? movement.document?.warehouse : movement.document?.targetWarehouse;
    const name = counterpart?.name ?? "";
    return `${base} ${incoming ? "depuis" : "vers"} ${name}`.trim();
  }
  const reference = movement.document?.reference;
  return reference ? `${base} ${reference}` : base;
}

export type StockService = ReturnType<typeof createStockService>;

type IpcLike = { handle(channel: string, listener: (event: unknown, ...args: any[]) => any): void };

export function registerStockIpc(options: StockServiceOptions & { ipcMain: IpcLike }): StockService {
  const service = createStockService(options);
  const { ipcMain } = options;

  ipcMain.handle("wheat:stock:workspace", (_event, payload) => service.getWorkspace(payload));
  ipcMain.handle("wheat:stock:state", (_event, payload) => service.getStockState(payload));
  ipcMain.handle("wheat:stock:card", (_event, payload) => service.getStockCard(payload));
  ipcMain.handle("wheat:stock:movement", (_event, payload) => service.getMovementDetail(payload));
  ipcMain.handle("wheat:stock:documents", (_event, payload) => service.listDocuments(payload));
  ipcMain.handle("wheat:stock:document", (_event, payload) => service.getDocument(payload));
  ipcMain.handle("wheat:stock:document:save", (_event, payload) => service.saveDocument(payload));
  ipcMain.handle("wheat:stock:document:delete", (_event, payload) => service.deleteDocument(payload));
  ipcMain.handle("wheat:stock:document:preview-validation", (_event, payload) => service.previewValidation(payload));
  ipcMain.handle("wheat:stock:document:validate", (_event, payload) => service.validateDocument(payload));
  ipcMain.handle("wheat:stock:document:reverse", (_event, payload) => service.reverseDocument(payload));
  ipcMain.handle("wheat:stock:article:save", (_event, payload) => service.saveArticle(payload));
  ipcMain.handle("wheat:stock:family:save", (_event, payload) => service.saveFamily(payload));
  ipcMain.handle("wheat:stock:unit:save", (_event, payload) => service.saveUnit(payload));
  ipcMain.handle("wheat:stock:warehouse:save", (_event, payload) => service.saveWarehouse(payload));
  ipcMain.handle("wheat:stock:lot:save", (_event, payload) => service.saveLot(payload));
  ipcMain.handle("wheat:stock:lots", (_event, payload) => service.listLots(payload));
  ipcMain.handle("wheat:stock:settings:save", (_event, payload) => service.saveSettings(payload));
  ipcMain.handle("wheat:stock:mapping:save", (_event, payload) => service.saveAccountMapping(payload));
  ipcMain.handle("wheat:stock:mapping:delete", (_event, payload) => service.deleteAccountMapping(payload));

  return service;
}
