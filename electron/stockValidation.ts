/**
 * Validation: the only operation that changes stock.
 *
 * Creating, editing and deleting a draft move nothing. Validating a document
 * runs one Prisma transaction that either does all of this or none of it:
 * permissions and company, the fiscal period, the document's own state, stock
 * availability, numbering, valuation, landed costs, the immutable movements,
 * the balance cache, FIFO layers and their consumption records, the linked
 * accounting draft, the audit event, and the status transition.
 *
 * Everything here runs against the `tx` the caller opened. Nothing in this file
 * opens a transaction of its own, because a step that commits separately is a
 * step that can survive the failure of the ones around it — a movement without
 * its accounting draft, or a draft for stock that never moved.
 *
 * ## Backdating
 *
 * A receipt validated today but dated before movements that already exist would
 * change what those later issues cost. Wheat refuses that rather than rewriting
 * validated history: `assertNoBackdatingConflict` names the movement in the way
 * and tells the user the two corrections that are available. Same-day is fine —
 * the movement sequence gives it a defined place after what is already there.
 */

import { assertPostingPeriodOpen } from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { createStockDraftEntry, requireStockJournal, resolveStockAccounts, type StockAccountingLeg } from "./stockAccounting";
import {
  STOCK_DOCUMENT_STATUS,
  STOCK_DOCUMENT_TYPES,
  StockError,
  allocateStockDocumentNumber,
  enteredLineValue,
  isProvisionalStockReference,
  lotKeyOf,
  positionKey,
  reserveMovementSequences,
  type StockDirection,
} from "./stockDomain";
import {
  allocateProportionally,
  assertStoredRange,
  moneyToDisplay,
  proportionalShare,
  qtyToDisplay,
} from "./stockUnits";
import {
  EMPTY_POSITION,
  StockValuationError,
  applyConsumptionToLayer,
  applyIssueCmp,
  applyReceipt,
  planFifoIssue,
  restoreConsumptionToLayer,
  type FifoConsumption,
  type FifoLayer,
  type StockPosition,
} from "./stockValuation";

type MovementPlan = {
  articleId: string;
  article: any;
  warehouseId: string;
  warehouse: any;
  locationId: string | null;
  lotId: string | null;
  lineId: string;
  direction: StockDirection;
  quantity: bigint;
  value: bigint;
  consumptions: FifoConsumption[];
  /** A FIFO receipt opens a layer; an issue does not. */
  opensLayer: boolean;
  resultingQuantity: bigint;
  resultingValue: bigint;
};

/**
 * The working state of every position a document touches.
 *
 * Held in memory for the length of the transaction so that two lines of one
 * document against the same article compound correctly — the second line has to
 * see what the first one did, and re-reading the balance row would show it the
 * position as it was before either.
 */
class PositionWorkspace {
  private readonly positions = new Map<string, StockPosition>();
  private readonly layers = new Map<string, FifoLayer[]>();
  private readonly layerChanges = new Map<string, FifoLayer>();

  private readonly tx: any;
  private readonly companyId: string;

  constructor(tx: any, companyId: string) {
    this.tx = tx;
    this.companyId = companyId;
  }

  async position(articleId: string, warehouseId: string, lotId: string | null): Promise<StockPosition> {
    const key = positionKey(articleId, warehouseId, lotId);
    const held = this.positions.get(key);
    if (held) return held;
    const balance = await this.tx.stockBalance.findUnique({
      where: {
        companyId_articleId_warehouseId_lotKey: {
          companyId: this.companyId, articleId, warehouseId, lotKey: lotKeyOf(lotId),
        },
      },
      select: { quantity: true, value: true },
    });
    const position: StockPosition = balance ? { quantity: balance.quantity, value: balance.value } : { ...EMPTY_POSITION };
    this.positions.set(key, position);
    return position;
  }

  setPosition(articleId: string, warehouseId: string, lotId: string | null, position: StockPosition) {
    this.positions.set(positionKey(articleId, warehouseId, lotId), position);
  }

  /** Open FIFO layers for a position, oldest first, as the register orders them. */
  async openLayers(articleId: string, warehouseId: string, lotId: string | null): Promise<FifoLayer[]> {
    const key = positionKey(articleId, warehouseId, lotId);
    const held = this.layers.get(key);
    if (held) return held;
    const rows = await this.tx.stockFifoLayer.findMany({
      where: {
        companyId: this.companyId,
        articleId,
        warehouseId,
        ...(lotId ? { lotId } : {}),
        quantityRemaining: { gt: 0n },
      },
      orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
      select: { id: true, quantityRemaining: true, valueRemaining: true },
    });
    const layers: FifoLayer[] = rows.map((row: any) => ({
      id: row.id,
      quantityRemaining: row.quantityRemaining,
      valueRemaining: row.valueRemaining,
    }));
    this.layers.set(key, layers);
    return layers;
  }

  applyLayerChange(articleId: string, warehouseId: string, lotId: string | null, updated: FifoLayer) {
    const key = positionKey(articleId, warehouseId, lotId);
    const layers = this.layers.get(key);
    if (layers) {
      const index = layers.findIndex((layer) => layer.id === updated.id);
      if (index >= 0) layers[index] = updated;
    }
    this.layerChanges.set(updated.id, updated);
  }

  registerNewLayer(articleId: string, warehouseId: string, lotId: string | null, layer: FifoLayer) {
    const key = positionKey(articleId, warehouseId, lotId);
    const layers = this.layers.get(key);
    // Appended rather than sorted in: a layer created now carries the highest
    // sequence this company has issued, so it belongs at the end.
    if (layers) layers.push(layer);
  }

  /** Writes back every position and layer the document changed. */
  async flush() {
    for (const [key, position] of this.positions) {
      const [articleId, warehouseId, lotKey] = key.split("|");
      assertStoredRange(position.quantity, "La quantité en stock");
      assertStoredRange(position.value, "La valeur du stock");
      await this.tx.stockBalance.upsert({
        where: {
          companyId_articleId_warehouseId_lotKey: {
            companyId: this.companyId, articleId, warehouseId, lotKey,
          },
        },
        create: {
          companyId: this.companyId,
          articleId,
          warehouseId,
          lotId: lotKey || null,
          lotKey,
          quantity: position.quantity,
          value: position.value,
        },
        update: { quantity: position.quantity, value: position.value, version: { increment: 1 } },
      });
    }
    for (const layer of this.layerChanges.values()) {
      await this.tx.stockFifoLayer.update({
        where: { id: layer.id },
        data: { quantityRemaining: layer.quantityRemaining, valueRemaining: layer.valueRemaining },
      });
    }
  }
}

function insufficientStockMessage(article: any, warehouse: any, requested: bigint, available: bigint) {
  return `Stock insuffisant pour « ${article.designation} ».\nDisponible au dépôt ${warehouse.name}: ${qtyToDisplay(available)}\nDemandé: ${qtyToDisplay(requested)}`;
}

/**
 * Refuses a validation that would land before movements that already exist.
 *
 * Appending a row with an older date is not enough: every issue validated after
 * that date was valued against a position this receipt would have changed, and
 * their costs are already in the ledger. Wheat states the conflict and leaves
 * the correction to the user, rather than rewriting movements that have been
 * relied on.
 */
async function assertNoBackdatingConflict(tx: any, companyId: string, documentDate: Date, plans: MovementPlan[]) {
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = positionKey(plan.articleId, plan.warehouseId, plan.lotId);
    if (seen.has(key)) continue;
    seen.add(key);
    const latest = await tx.stockMovement.findFirst({
      where: {
        companyId,
        articleId: plan.articleId,
        warehouseId: plan.warehouseId,
        ...(plan.lotId ? { lotId: plan.lotId } : {}),
        documentDate: { gt: documentDate },
      },
      orderBy: [{ documentDate: "desc" }, { sequence: "desc" }],
      select: { documentDate: true, documentType: true },
    });
    if (latest) {
      const blocking = latest.documentDate.toISOString().slice(0, 10);
      throw new StockError(
        `Ce document est daté avant des mouvements déjà validés pour « ${plan.article.designation} » au dépôt ${plan.warehouse.name} `
        + `(mouvement du ${blocking}). Le valider changerait le coût de sorties déjà comptabilisées.\n`
        + `Deux corrections sont possibles : dater ce document après le ${blocking}, ou contrepasser les mouvements postérieurs puis les ressaisir.`,
      );
    }
  }
}

/** Landed costs, spread over the lines they belong to, summing to the charge. */
async function allocateLandedCosts(tx: any, document: any, lines: any[]) {
  const charges = await tx.stockLandedCost.findMany({ where: { documentId: document.id }, orderBy: { position: "asc" } });
  if (charges.length === 0) return new Map<string, bigint>();
  const definition = STOCK_DOCUMENT_TYPES[document.type];
  if (!definition.acceptsLandedCosts) {
    throw new StockError(`Un ${definition.label.toLowerCase()} ne peut pas porter de frais d'acquisition.`);
  }

  const allocated = new Map<string, bigint>(lines.map((line) => [line.id, 0n]));
  for (const charge of charges) {
    const weights = charge.allocationMethod === "QUANTITY"
      ? lines.map((line) => line.quantity)
      : lines.map((line) => enteredLineValue(line) ?? 0n);
    let parts: bigint[];
    if (charge.allocationMethod === "MANUAL") {
      const manual = await tx.stockLandedCostAllocation.findMany({ where: { landedCostId: charge.id } });
      const byLine = new Map<string, bigint>(manual.map((row: any) => [row.documentLineId, row.amount]));
      parts = lines.map((line) => byLine.get(line.id) ?? 0n);
      const total = parts.reduce((sum, part) => sum + part, 0n);
      if (total !== charge.amount) {
        throw new StockError(`La répartition manuelle de « ${charge.label} » totalise ${moneyToDisplay(total)} au lieu de ${moneyToDisplay(charge.amount)}.`);
      }
    } else {
      parts = allocateProportionally(charge.amount, weights);
      await tx.stockLandedCostAllocation.deleteMany({ where: { landedCostId: charge.id } });
      for (const [index, line] of lines.entries()) {
        if (parts[index] === 0n) continue;
        await tx.stockLandedCostAllocation.create({
          data: { landedCostId: charge.id, documentLineId: line.id, amount: parts[index] },
        });
      }
    }
    for (const [index, line] of lines.entries()) {
      allocated.set(line.id, (allocated.get(line.id) ?? 0n) + parts[index]);
    }
  }
  return allocated;
}

/**
 * The value an inbound line brings in.
 *
 * An acquisition states its own cost. Everything else — a return, an inventory
 * surplus, the receiving half of a transfer — enters at what the position is
 * already worth, because nothing about those events establishes a new cost. A
 * position with nothing in it offers no such figure, so the line has to carry
 * one, and the error says exactly that.
 */
function inboundValue(definition: any, line: any, allocatedCharge: bigint, position: StockPosition, article: any): bigint {
  const entered = enteredLineValue(line);
  if (entered !== null) {
    if (!definition.acceptsEnteredValue) {
      throw new StockError(`Un ${definition.label.toLowerCase()} ne reçoit pas de valeur saisie : sa valeur vient du stock existant.`);
    }
    return entered + allocatedCharge;
  }
  if (position.quantity > 0n) {
    return proportionalShare(position.value, line.quantity, position.quantity) + allocatedCharge;
  }
  throw new StockError(`Aucune valeur n'est connue pour « ${article.designation} » : le stock est vide, indiquez la valeur d'acquisition sur la ligne.`);
}

async function planOutbound(
  workspace: PositionWorkspace,
  article: any,
  warehouse: any,
  line: any,
  quantity: bigint,
  allowNegative: boolean,
): Promise<{ value: bigint; consumptions: FifoConsumption[]; position: StockPosition }> {
  const position = await workspace.position(article.id, warehouse.id, line.lotId ?? null);
  if (article.valuationMethod === "FIFO") {
    const layers = await workspace.openLayers(article.id, warehouse.id, line.lotId ?? null);
    let plan;
    try {
      plan = planFifoIssue(layers, quantity);
    } catch (error) {
      if (error instanceof StockValuationError && error.message === "INSUFFICIENT_STOCK") {
        const available = layers.reduce((sum, layer) => sum + layer.quantityRemaining, 0n);
        throw new StockError(
          `${insufficientStockMessage(article, warehouse, quantity, available)}\n`
          + "La méthode FIFO n'autorise aucun stock négatif : il n'existe aucune couche d'acquisition à consommer.",
        );
      }
      throw error;
    }
    for (const consumption of plan.consumptions) {
      const layer = layers.find((candidate) => candidate.id === consumption.layerId)!;
      workspace.applyLayerChange(article.id, warehouse.id, line.lotId ?? null, applyConsumptionToLayer(layer, consumption));
    }
    return {
      value: plan.totalValue,
      consumptions: plan.consumptions,
      position: { quantity: position.quantity - quantity, value: position.value - plan.totalValue },
    };
  }

  try {
    const outcome = applyIssueCmp(position, quantity, { allowNegative });
    return { value: outcome.valueRemoved, consumptions: [], position: outcome.position };
  } catch (error) {
    if (error instanceof StockValuationError && error.message === "INSUFFICIENT_STOCK") {
      throw new StockError(insufficientStockMessage(article, warehouse, quantity, position.quantity));
    }
    if (error instanceof StockValuationError && error.message === "NO_COST_BASIS") {
      throw new StockError(
        `Le stock négatif est autorisé, mais « ${article.designation} » n'a aucune valeur de référence au dépôt ${warehouse.name}.\n`
        + "Wheat n'invente pas un coût : saisissez d'abord une entrée en stock.",
      );
    }
    throw error;
  }
}

export type ValidateStockDocumentInput = {
  companyId: string;
  documentId: string;
  actorUserId: string | null;
  expectedVersion?: number;
};

/**
 * Validates one stock document, atomically.
 *
 * The caller owns the transaction; every write below belongs to it.
 */
export async function validateStockDocumentInTransaction(tx: any, input: ValidateStockDocumentInput) {
  const document = await tx.stockDocument.findFirst({
    where: { id: input.documentId, companyId: input.companyId },
    include: {
      warehouse: true,
      targetWarehouse: true,
      lines: {
        orderBy: { position: "asc" },
        include: { article: true, warehouse: true },
      },
    },
  });
  if (!document) throw new StockError("Ce document de stock n'existe plus ou n'appartient pas à ce dossier.");
  if (document.status !== STOCK_DOCUMENT_STATUS.draft) {
    throw new StockError(document.status === STOCK_DOCUMENT_STATUS.reversed
      ? "Ce document a été contrepassé et ne peut plus être validé."
      : "Ce document est déjà validé.");
  }
  if (input.expectedVersion !== undefined && document.version !== input.expectedVersion) {
    throw new StockError("Ce document a changé depuis son affichage. Rechargez-le avant de le valider.");
  }
  if (document.lines.length === 0) throw new StockError("Un document de stock doit comporter au moins une ligne.");

  const definition = STOCK_DOCUMENT_TYPES[document.type];
  if (!definition) throw new StockError("Le type de ce document de stock est inconnu.");
  if (definition.requiresCounterparty && !document.counterpartyId) {
    throw new StockError(`Un ${definition.label.toLowerCase()} doit désigner un tiers.`);
  }
  if (definition.flow === "TRANSFER") {
    if (!document.targetWarehouseId) throw new StockError("Un transfert doit désigner un dépôt de destination.");
    if (document.targetWarehouseId === document.warehouseId) {
      throw new StockError("Un transfert doit désigner deux dépôts différents.");
    }
  }

  const fiscalYear = await assertPostingPeriodOpen(tx, document.companyId, document.documentDate, "La date du document de stock");
  const settings = await tx.stockSettings.findUnique({ where: { companyId: document.companyId } });
  if (!settings) throw new StockError("Le paramétrage du stock est absent pour ce dossier.");

  for (const line of document.lines) {
    if (line.quantity <= 0n) throw new StockError(`La ligne ${line.position} doit porter une quantité strictement positive.`);
    if (line.article.companyId !== document.companyId) throw new StockError("Une ligne référence un article d'un autre dossier.");
    if (!line.article.active) throw new StockError(`L'article « ${line.article.designation} » est désactivé.`);
    if (line.article.lotTracking && !line.lotId) {
      throw new StockError(`L'article « ${line.article.designation} » est suivi par lot : indiquez le lot de la ligne ${line.position}.`);
    }
    if (definition.flow === "LINE" && !line.direction) {
      throw new StockError(`La ligne ${line.position} d'un ajustement doit indiquer son sens.`);
    }
  }

  const allocatedCharges = definition.acceptsLandedCosts
    ? await allocateLandedCosts(tx, document, document.lines)
    : new Map<string, bigint>();

  const workspace = new PositionWorkspace(tx, document.companyId);
  const plans: MovementPlan[] = [];

  for (const line of document.lines) {
    const article = line.article;
    const sourceWarehouse = line.warehouse ?? document.warehouse;
    const lineDirection: StockDirection | null = definition.flow === "LINE"
      ? (line.direction as StockDirection)
      : definition.flow === "TRANSFER" ? null : definition.flow;

    if (definition.flow === "TRANSFER") {
      // The value leaving the source is exactly the value entering the target:
      // the company still owns the same goods at the same cost, so total
      // quantity and total value are unchanged by construction rather than by a
      // recomputation that could round differently on each side.
      const outbound = await planOutbound(workspace, article, sourceWarehouse, line, line.quantity, settings.allowNegativeStock);
      workspace.setPosition(article.id, sourceWarehouse.id, line.lotId ?? null, outbound.position);
      plans.push({
        articleId: article.id, article, warehouseId: sourceWarehouse.id, warehouse: sourceWarehouse,
        locationId: line.locationId ?? null, lotId: line.lotId ?? null, lineId: line.id,
        direction: "OUT", quantity: line.quantity, value: outbound.value,
        consumptions: outbound.consumptions, opensLayer: false,
        resultingQuantity: outbound.position.quantity, resultingValue: outbound.position.value,
      });

      const targetWarehouse = document.targetWarehouse;
      const targetPosition = await workspace.position(article.id, targetWarehouse.id, line.lotId ?? null);
      const receivedPosition = applyReceipt(targetPosition, line.quantity, outbound.value);
      workspace.setPosition(article.id, targetWarehouse.id, line.lotId ?? null, receivedPosition);
      plans.push({
        articleId: article.id, article, warehouseId: targetWarehouse.id, warehouse: targetWarehouse,
        locationId: null, lotId: line.lotId ?? null, lineId: line.id,
        direction: "IN", quantity: line.quantity, value: outbound.value,
        consumptions: [], opensLayer: article.valuationMethod === "FIFO",
        resultingQuantity: receivedPosition.quantity, resultingValue: receivedPosition.value,
      });
      continue;
    }

    if (lineDirection === "IN") {
      const position = await workspace.position(article.id, sourceWarehouse.id, line.lotId ?? null);
      const value = inboundValue(definition, line, allocatedCharges.get(line.id) ?? 0n, position, article);
      const next = applyReceipt(position, line.quantity, value);
      workspace.setPosition(article.id, sourceWarehouse.id, line.lotId ?? null, next);
      plans.push({
        articleId: article.id, article, warehouseId: sourceWarehouse.id, warehouse: sourceWarehouse,
        locationId: line.locationId ?? null, lotId: line.lotId ?? null, lineId: line.id,
        direction: "IN", quantity: line.quantity, value,
        consumptions: [], opensLayer: article.valuationMethod === "FIFO",
        resultingQuantity: next.quantity, resultingValue: next.value,
      });
      continue;
    }

    const outbound = await planOutbound(workspace, article, sourceWarehouse, line, line.quantity, settings.allowNegativeStock);
    workspace.setPosition(article.id, sourceWarehouse.id, line.lotId ?? null, outbound.position);
    plans.push({
      articleId: article.id, article, warehouseId: sourceWarehouse.id, warehouse: sourceWarehouse,
      locationId: line.locationId ?? null, lotId: line.lotId ?? null, lineId: line.id,
      direction: "OUT", quantity: line.quantity, value: outbound.value,
      consumptions: outbound.consumptions, opensLayer: false,
      resultingQuantity: outbound.position.quantity, resultingValue: outbound.position.value,
    });
  }

  await assertNoBackdatingConflict(tx, document.companyId, document.documentDate, plans);

  // The draft's placeholder becomes a real number here, and only here: a draft
  // that is never validated consumes nothing from the sequence.
  const reference = isProvisionalStockReference(document.reference)
    ? await allocateStockDocumentNumber(tx, {
      companyId: document.companyId, fiscalYearId: fiscalYear.id, type: document.type, date: document.documentDate,
    })
    : document.reference;
  const sequences = await reserveMovementSequences(tx, document.companyId, plans.length);
  const validatedAt = new Date();

  for (const [index, plan] of plans.entries()) {
    const movement = await tx.stockMovement.create({
      data: {
        companyId: document.companyId,
        articleId: plan.articleId,
        warehouseId: plan.warehouseId,
        locationId: plan.locationId,
        lotId: plan.lotId,
        documentId: document.id,
        documentLineId: plan.lineId,
        documentType: document.type,
        documentDate: document.documentDate,
        sequence: sequences[index],
        direction: plan.direction,
        quantity: assertStoredRange(plan.quantity, "La quantité du mouvement"),
        value: assertStoredRange(plan.value, "La valeur du mouvement"),
        resultingQuantity: assertStoredRange(plan.resultingQuantity, "La quantité résultante"),
        resultingValue: assertStoredRange(plan.resultingValue, "La valeur résultante"),
        counterpartyId: document.counterpartyId,
        createdByUserId: input.actorUserId,
      },
    });

    if (plan.opensLayer) {
      const layer = await tx.stockFifoLayer.create({
        data: {
          companyId: document.companyId,
          articleId: plan.articleId,
          warehouseId: plan.warehouseId,
          lotId: plan.lotId,
          documentId: document.id,
          documentLineId: plan.lineId,
          documentDate: document.documentDate,
          sequence: sequences[index],
          quantityReceived: plan.quantity,
          quantityRemaining: plan.quantity,
          valueReceived: plan.value,
          valueRemaining: plan.value,
          counterpartyId: document.counterpartyId,
        },
      });
      workspace.registerNewLayer(plan.articleId, plan.warehouseId, plan.lotId, {
        id: layer.id, quantityRemaining: plan.quantity, valueRemaining: plan.value,
      });
    }

    for (const consumption of plan.consumptions) {
      await tx.stockFifoConsumption.create({
        data: {
          companyId: document.companyId,
          layerId: consumption.layerId,
          movementId: movement.id,
          documentId: document.id,
          documentLineId: plan.lineId,
          kind: "CONSUMPTION",
          quantity: consumption.quantity,
          value: consumption.value,
          exhausted: consumption.exhausted,
        },
      });
    }

    await tx.stockDocumentLine.update({
      where: { id: plan.lineId },
      data: {
        stockValue: plan.direction === "IN" ? plan.value : -plan.value,
        allocatedChargeValue: allocatedCharges.get(plan.lineId) ?? 0n,
      },
    });
  }

  await workspace.flush();

  // One accounting leg per article: the net value the document moved on that
  // article's own stock and variation accounts. A transfer nets to zero on both
  // and therefore posts nothing, which is correct — the goods never left the
  // company.
  const legsByArticle = new Map<string, StockAccountingLeg>();
  for (const plan of plans) {
    const accounts = await resolveStockAccounts(tx, document.companyId, plan.article);
    const signedValue = plan.direction === "IN" ? plan.value : -plan.value;
    const existing = legsByArticle.get(plan.articleId);
    if (existing) {
      existing.valueMicro += signedValue;
    } else {
      legsByArticle.set(plan.articleId, {
        stockAccountId: accounts.stockAccountId,
        variationAccountId: accounts.variationAccountId,
        label: `${definition.movementLabel} ${reference} — ${plan.article.designation}`.slice(0, 250),
        valueMicro: signedValue,
      });
    }
  }
  const legs = [...legsByArticle.values()].filter((leg) => leg.valueMicro !== 0n);

  let entryId: string | null = null;
  if (legs.length > 0) {
    const journalId = await requireStockJournal(tx, document.companyId);
    const entry = await createStockDraftEntry(tx, {
      companyId: document.companyId,
      journalId,
      date: document.documentDate,
      label: `${definition.label} ${reference}`.slice(0, 300),
      reference,
      legs,
      counterpartyId: document.counterpartyId,
    });
    entryId = entry?.id ?? null;
  }

  // Claimed on the version that was read: a second click that reaches this line
  // after the first one committed finds no draft to claim and stops here, so a
  // double validation cannot produce a second set of movements.
  const claimed = await tx.stockDocument.updateMany({
    where: { id: document.id, status: STOCK_DOCUMENT_STATUS.draft, version: document.version },
    data: {
      status: STOCK_DOCUMENT_STATUS.validated,
      reference,
      validatedAt,
      validatedByUserId: input.actorUserId,
      accountingEntryId: entryId,
      fiscalYearId: fiscalYear.id,
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) throw new StockError("Ce document a déjà été validé par une autre opération.");

  await appendActivityAndAudit(tx, {
    companyId: document.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_DOCUMENT_VALIDATED",
    entityType: "StockDocument",
    entityId: document.id,
    description: `${reference} validé (${plans.length} mouvement(s))`,
    payload: {
      type: document.type,
      reference,
      movements: plans.length,
      entryId,
      lines: document.lines.length,
    },
  });

  return tx.stockDocument.findUniqueOrThrow({
    where: { id: document.id },
    include: {
      lines: { orderBy: { position: "asc" }, include: { article: true } },
      movements: { orderBy: { sequence: "asc" } },
      warehouse: true,
      targetWarehouse: true,
      counterparty: true,
      accountingEntry: { select: { id: true, number: true, status: true, pieceNumber: true } },
    },
  });
}

/**
 * Contrepassation: the correction that does not rewrite anything.
 *
 * The original document keeps every row it wrote. The reversal appends the
 * opposite movements, and under FIFO it returns each consumption to the layer
 * it actually came from — a restoration row per original consumption — because
 * an average recomputed now would be a different cost, and the difference would
 * reach the ledger with nothing to justify it.
 */
export async function reverseStockDocumentInTransaction(tx: any, input: {
  companyId: string;
  documentId: string;
  actorUserId: string | null;
  date?: Date | null;
  reason?: string | null;
}) {
  const original = await tx.stockDocument.findFirst({
    where: { id: input.documentId, companyId: input.companyId },
    include: {
      warehouse: true,
      targetWarehouse: true,
      lines: { orderBy: { position: "asc" }, include: { article: true, warehouse: true } },
      movements: { orderBy: { sequence: "asc" } },
    },
  });
  if (!original) throw new StockError("Ce document de stock n'existe plus ou n'appartient pas à ce dossier.");
  if (original.status !== STOCK_DOCUMENT_STATUS.validated) {
    throw new StockError("Seul un document validé peut être contrepassé.");
  }
  if (original.reversedAt) throw new StockError("Ce document a déjà été contrepassé.");

  const definition = STOCK_DOCUMENT_TYPES[original.type];
  const reversalDate = input.date ?? original.documentDate;
  const fiscalYear = await assertPostingPeriodOpen(tx, original.companyId, reversalDate, "La date de contrepassation");

  const workspace = new PositionWorkspace(tx, original.companyId);
  const plans: MovementPlan[] = [];

  for (const movement of original.movements) {
    const line = original.lines.find((candidate: any) => candidate.id === movement.documentLineId)!;
    const article = line.article;
    const warehouse = movement.warehouseId === original.warehouseId ? original.warehouse : original.targetWarehouse ?? line.warehouse;
    const position = await workspace.position(movement.articleId, movement.warehouseId, movement.lotId);

    if (movement.direction === "IN") {
      // Undoing a receipt. Under FIFO the layer it opened must still be whole:
      // giving back quantity that has already been sold would leave the later
      // issues costed against stock that no longer exists.
      if (article.valuationMethod === "FIFO") {
        const layer = await tx.stockFifoLayer.findFirst({
          where: { documentId: original.id, documentLineId: line.id, warehouseId: movement.warehouseId },
        });
        if (layer && layer.quantityRemaining !== layer.quantityReceived) {
          const consumed = (layer.quantityReceived as bigint) - (layer.quantityRemaining as bigint);
          throw new StockError(
            `La contrepassation de « ${article.designation} » est impossible : une partie de cette réception a déjà été consommée.\n`
            + `Reçu: ${qtyToDisplay(layer.quantityReceived)}\nRestant: ${qtyToDisplay(layer.quantityRemaining)}\nDéjà consommé: ${qtyToDisplay(consumed)}`,
          );
        }
        if (layer) {
          workspace.applyLayerChange(movement.articleId, movement.warehouseId, movement.lotId, {
            id: layer.id, quantityRemaining: 0n, valueRemaining: 0n,
          });
        }
      }
      if (position.quantity < movement.quantity) {
        throw new StockError(
          `La contrepassation de « ${article.designation} » retirerait ${qtyToDisplay(movement.quantity)} d'une position qui n'en contient que ${qtyToDisplay(position.quantity)} au dépôt ${warehouse.name}.\n`
          + "Contrepassez d'abord les sorties postérieures.",
        );
      }
      // Quantity alone is not enough. Under CMP a later issue can carry away
      // more value than this receipt brought in, and giving back the receipt's
      // original value would leave the position worth less than nothing — a
      // position no sequence of real events could produce.
      if (position.value < movement.value) {
        throw new StockError(
          `La contrepassation de « ${article.designation} » retirerait ${moneyToDisplay(movement.value)} d'une position qui ne vaut que ${moneyToDisplay(position.value)} au dépôt ${warehouse.name}.\n`
          + "Contrepassez d'abord les mouvements postérieurs qui ont consommé cette valeur.",
        );
      }
      const next = { quantity: position.quantity - movement.quantity, value: position.value - movement.value };
      workspace.setPosition(movement.articleId, movement.warehouseId, movement.lotId, next);
      plans.push({
        articleId: movement.articleId, article, warehouseId: movement.warehouseId, warehouse,
        locationId: movement.locationId, lotId: movement.lotId, lineId: line.id,
        direction: "OUT", quantity: movement.quantity, value: movement.value,
        consumptions: [], opensLayer: false,
        resultingQuantity: next.quantity, resultingValue: next.value,
      });
      continue;
    }

    const consumptions = await tx.stockFifoConsumption.findMany({
      where: { movementId: movement.id, kind: "CONSUMPTION" },
    });
    for (const consumption of consumptions) {
      const layer = await tx.stockFifoLayer.findUniqueOrThrow({ where: { id: consumption.layerId } });
      const current: FifoLayer = { id: layer.id, quantityRemaining: layer.quantityRemaining, valueRemaining: layer.valueRemaining };
      workspace.applyLayerChange(movement.articleId, movement.warehouseId, movement.lotId, restoreConsumptionToLayer(current, {
        layerId: consumption.layerId, quantity: consumption.quantity, value: consumption.value, exhausted: false,
      }));
    }
    const next = { quantity: position.quantity + movement.quantity, value: position.value + movement.value };
    workspace.setPosition(movement.articleId, movement.warehouseId, movement.lotId, next);
    plans.push({
      articleId: movement.articleId, article, warehouseId: movement.warehouseId, warehouse,
      locationId: movement.locationId, lotId: movement.lotId, lineId: line.id,
      direction: "IN", quantity: movement.quantity, value: movement.value,
      consumptions: consumptions.map((consumption: any) => ({
        layerId: consumption.layerId, quantity: consumption.quantity, value: consumption.value, exhausted: false,
      })),
      opensLayer: false,
      resultingQuantity: next.quantity, resultingValue: next.value,
    });
  }

  const reference = await allocateStockDocumentNumber(tx, {
    companyId: original.companyId, fiscalYearId: fiscalYear.id, type: original.type, date: reversalDate,
  });
  const reversal = await tx.stockDocument.create({
    data: {
      companyId: original.companyId,
      fiscalYearId: fiscalYear.id,
      type: original.type,
      reference,
      documentDate: reversalDate,
      warehouseId: original.warehouseId,
      targetWarehouseId: original.targetWarehouseId,
      counterpartyId: original.counterpartyId,
      status: STOCK_DOCUMENT_STATUS.validated,
      note: input.reason ?? `Contrepassation de ${original.reference}`,
      createdByUserId: input.actorUserId,
      validatedByUserId: input.actorUserId,
      validatedAt: new Date(),
      reversalOfId: original.id,
      lines: {
        create: original.lines.map((line: any) => ({
          position: line.position,
          articleId: line.articleId,
          quantity: line.quantity,
          unitId: line.unitId,
          warehouseId: line.warehouseId,
          locationId: line.locationId,
          lotId: line.lotId,
          expiresOn: line.expiresOn,
          direction: line.direction === "IN" ? "OUT" : line.direction === "OUT" ? "IN" : null,
          description: `Contrepassation — ${line.description ?? line.article?.designation ?? ""}`.slice(0, 250),
        })),
      },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  const reversalLineByPosition = new Map<number, any>(reversal.lines.map((line: any) => [line.position, line]));

  const sequences = await reserveMovementSequences(tx, original.companyId, plans.length);
  for (const [index, plan] of plans.entries()) {
    const originalLine = original.lines.find((line: any) => line.id === plan.lineId)!;
    const reversalLine = reversalLineByPosition.get(originalLine.position)!;
    const movement = await tx.stockMovement.create({
      data: {
        companyId: original.companyId,
        articleId: plan.articleId,
        warehouseId: plan.warehouseId,
        locationId: plan.locationId,
        lotId: plan.lotId,
        documentId: reversal.id,
        documentLineId: reversalLine.id,
        documentType: original.type,
        documentDate: reversalDate,
        sequence: sequences[index],
        direction: plan.direction,
        quantity: plan.quantity,
        value: plan.value,
        resultingQuantity: plan.resultingQuantity,
        resultingValue: plan.resultingValue,
        counterpartyId: original.counterpartyId,
        createdByUserId: input.actorUserId,
      },
    });
    for (const consumption of plan.consumptions) {
      await tx.stockFifoConsumption.create({
        data: {
          companyId: original.companyId,
          layerId: consumption.layerId,
          movementId: movement.id,
          documentId: reversal.id,
          documentLineId: reversalLine.id,
          kind: "RESTORATION",
          quantity: consumption.quantity,
          value: consumption.value,
          exhausted: false,
        },
      });
    }
    await tx.stockDocumentLine.update({
      where: { id: reversalLine.id },
      data: { stockValue: plan.direction === "IN" ? plan.value : -plan.value },
    });
  }

  await workspace.flush();

  const legsByArticle = new Map<string, StockAccountingLeg>();
  for (const plan of plans) {
    const accounts = await resolveStockAccounts(tx, original.companyId, plan.article);
    const signedValue = plan.direction === "IN" ? plan.value : -plan.value;
    const existing = legsByArticle.get(plan.articleId);
    if (existing) existing.valueMicro += signedValue;
    else {
      legsByArticle.set(plan.articleId, {
        stockAccountId: accounts.stockAccountId,
        variationAccountId: accounts.variationAccountId,
        label: `Contrepassation ${original.reference} — ${plan.article.designation}`.slice(0, 250),
        valueMicro: signedValue,
      });
    }
  }
  const legs = [...legsByArticle.values()].filter((leg) => leg.valueMicro !== 0n);
  let entryId: string | null = null;
  if (legs.length > 0) {
    const journalId = await requireStockJournal(tx, original.companyId);
    const entry = await createStockDraftEntry(tx, {
      companyId: original.companyId,
      journalId,
      date: reversalDate,
      label: `Contrepassation ${definition.label} ${original.reference}`.slice(0, 300),
      reference: reversal.reference,
      legs,
    });
    entryId = entry?.id ?? null;
  }
  if (entryId) {
    await tx.stockDocument.update({ where: { id: reversal.id }, data: { accountingEntryId: entryId } });
  }

  const claimed = await tx.stockDocument.updateMany({
    where: { id: original.id, status: STOCK_DOCUMENT_STATUS.validated, reversedAt: null, version: original.version },
    data: { status: STOCK_DOCUMENT_STATUS.reversed, reversedAt: new Date(), version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new StockError("Ce document a déjà été contrepassé par une autre opération.");

  await appendActivityAndAudit(tx, {
    companyId: original.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_DOCUMENT_REVERSED",
    entityType: "StockDocument",
    entityId: original.id,
    description: `${original.reference} contrepassé par ${reversal.reference}`,
    payload: { reversalId: reversal.id, reference: reversal.reference, entryId },
  });

  return tx.stockDocument.findUniqueOrThrow({
    where: { id: reversal.id },
    include: {
      lines: { orderBy: { position: "asc" }, include: { article: true } },
      movements: { orderBy: { sequence: "asc" } },
      accountingEntry: { select: { id: true, number: true, status: true } },
    },
  });
}
