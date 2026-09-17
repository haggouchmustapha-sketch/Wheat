/**
 * The vocabulary of the stock module: what a document is, which way it moves
 * stock, and the small shared rules every stock path has to agree on.
 *
 * The document type owns the direction. A line always carries a positive
 * quantity, and "this is an issue" is stated once, by the type, rather than by
 * a minus sign a caller might forget — the single exception is `ADJUSTMENT`,
 * where the whole point is that the user says which way it goes.
 */

import { randomUUID } from "node:crypto";

import { requireText } from "./accounting";
import { qtyFromDecimal, valueFromUnitPrice } from "./stockUnits";

export type StockDirection = "IN" | "OUT";

export type StockDocumentTypeDefinition = {
  /** "IN"/"OUT" move one way; "LINE" asks the line; "TRANSFER" does both. */
  flow: StockDirection | "LINE" | "TRANSFER";
  /** Numbering prefix: BR-2026-000001. */
  prefix: string;
  label: string;
  /** French, for the Désignation column of the stock card. */
  movementLabel: string;
  requiresCounterparty: boolean;
  /**
   * Whether an inbound line may state its own acquisition value. Where it may
   * not, the value comes from the position the goods are entering, because
   * nothing about the event itself sets a new cost.
   */
  acceptsEnteredValue: boolean;
  /** Landed costs only make sense where an acquisition sets the cost. */
  acceptsLandedCosts: boolean;
};

export const STOCK_DOCUMENT_TYPES: Record<string, StockDocumentTypeDefinition> = {
  OPENING_STOCK: {
    flow: "IN", prefix: "SI", label: "Stock initial", movementLabel: "Stock initial",
    requiresCounterparty: false, acceptsEnteredValue: true, acceptsLandedCosts: false,
  },
  PURCHASE_RECEIPT: {
    flow: "IN", prefix: "BR", label: "Bon de réception", movementLabel: "Achat",
    requiresCounterparty: true, acceptsEnteredValue: true, acceptsLandedCosts: true,
  },
  PRODUCTION_RECEIPT: {
    flow: "IN", prefix: "BP", label: "Entrée de production", movementLabel: "Production",
    requiresCounterparty: false, acceptsEnteredValue: true, acceptsLandedCosts: false,
  },
  CUSTOMER_RETURN: {
    flow: "IN", prefix: "RC", label: "Retour client", movementLabel: "Retour client",
    requiresCounterparty: true, acceptsEnteredValue: true, acceptsLandedCosts: false,
  },
  INVENTORY_SURPLUS: {
    flow: "IN", prefix: "IE", label: "Excédent d'inventaire", movementLabel: "Excédent inventaire",
    requiresCounterparty: false, acceptsEnteredValue: true, acceptsLandedCosts: false,
  },
  SALES_ISSUE: {
    flow: "OUT", prefix: "BS", label: "Bon de sortie", movementLabel: "Vente",
    requiresCounterparty: true, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  SUPPLIER_RETURN: {
    flow: "OUT", prefix: "RF", label: "Retour fournisseur", movementLabel: "Retour fournisseur",
    requiresCounterparty: true, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  PRODUCTION_CONSUMPTION: {
    flow: "OUT", prefix: "CP", label: "Consommation de production", movementLabel: "Consommation production",
    requiresCounterparty: false, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  INTERNAL_CONSUMPTION: {
    flow: "OUT", prefix: "CI", label: "Consommation interne", movementLabel: "Consommation interne",
    requiresCounterparty: false, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  INVENTORY_SHORTAGE: {
    flow: "OUT", prefix: "IM", label: "Manquant d'inventaire", movementLabel: "Manquant inventaire",
    requiresCounterparty: false, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  CLOSING_ADJUSTMENT: {
    flow: "OUT", prefix: "AC", label: "Régularisation de clôture", movementLabel: "Régularisation de clôture",
    requiresCounterparty: false, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
  ADJUSTMENT: {
    flow: "LINE", prefix: "AJ", label: "Ajustement de stock", movementLabel: "Ajustement inventaire",
    requiresCounterparty: false, acceptsEnteredValue: true, acceptsLandedCosts: false,
  },
  TRANSFER: {
    flow: "TRANSFER", prefix: "TR", label: "Transfert entre dépôts", movementLabel: "Transfert",
    requiresCounterparty: false, acceptsEnteredValue: false, acceptsLandedCosts: false,
  },
};

export const STOCK_DOCUMENT_TYPE_IDS = Object.keys(STOCK_DOCUMENT_TYPES);

export const STOCK_DOCUMENT_STATUS = {
  draft: "DRAFT",
  validated: "VALIDATED",
  reversed: "REVERSED",
} as const;

export class StockError extends Error {}

/**
 * The placeholder a draft carries until it is validated.
 *
 * A stock document reference is unique per dossier, so a draft needs *some*
 * value from the moment it is created — but it must not consume a number from
 * the sequence, because a draft that is edited for a week, or deleted, would
 * leave a permanent gap in a numbering an accountant is entitled to read as
 * continuous. Validation is what allocates the real number, exactly as
 * `provisionalEntryNumber` works on the accounting side.
 */
const PROVISIONAL_PREFIX = "BROUILLON-";

export function provisionalStockReference(): string {
  return `${PROVISIONAL_PREFIX}${randomUUID()}`;
}

export function isProvisionalStockReference(value: string | null | undefined): boolean {
  return !value || value.startsWith(PROVISIONAL_PREFIX);
}

export function requireStockDocumentType(value: unknown): string {
  if (typeof value !== "string" || !STOCK_DOCUMENT_TYPES[value]) {
    throw new StockError("Le type de document de stock est invalide.");
  }
  return value;
}

/**
 * Which columns of the stock card a movement belongs in.
 *
 * "Achats" means an acquisition and "Ventes" means a sale. A transfer, a
 * production run and an inventory surplus all increase stock, and none of them
 * is a purchase — putting them in the Achats column would make the card lie
 * about where the goods came from, so they carry their own label and sit in the
 * neutral movement columns instead.
 */
export function stockCardColumn(documentType: string, direction: StockDirection): "OPENING" | "PURCHASE" | "SALE" | "OTHER" {
  if (documentType === "OPENING_STOCK") return "OPENING";
  if (documentType === "PURCHASE_RECEIPT") return "PURCHASE";
  if (documentType === "SALES_ISSUE") return "SALE";
  void direction;
  return "OTHER";
}

/**
 * What the user stated a line is worth, before landed costs.
 *
 * A line may say "10 units at 120,50" or "this line is worth 1205" and both
 * mean the same thing. Everything that needs the entered value asks here, so
 * valuation and landed-cost allocation cannot disagree about which lines carry
 * value — a disagreement that shows up as a charge spread over nothing.
 *
 * Returns `null` when the line states no value at all, which is a different
 * thing from stating zero.
 */
export function enteredLineValue(line: { quantity: bigint; unitValue?: bigint | null; grossValue?: bigint | null }): bigint | null {
  if (line.unitValue !== null && line.unitValue !== undefined) {
    return valueFromUnitPrice(line.quantity, line.unitValue);
  }
  if (line.grossValue !== null && line.grossValue !== undefined && line.grossValue !== 0n) {
    return line.grossValue;
  }
  return null;
}

/** "" for an article without lot tracking, so the balance unique constrains it. */
export function lotKeyOf(lotId: string | null | undefined): string {
  return lotId ?? "";
}

export function positionKey(articleId: string, warehouseId: string, lotId: string | null | undefined): string {
  return `${articleId}|${warehouseId}|${lotKeyOf(lotId)}`;
}

export function requireStockQuantity(value: unknown, label = "La quantité"): bigint {
  const quantity = qtyFromDecimal(value, label);
  if (quantity <= 0n) throw new StockError(`${label} doit être strictement positive.`);
  return quantity;
}

export function optionalStockDirection(value: unknown): StockDirection | null {
  if (value === null || value === undefined || value === "") return null;
  if (value !== "IN" && value !== "OUT") throw new StockError("Le sens du mouvement est invalide.");
  return value;
}

export function requireStockReferenceText(value: unknown, label: string, maxLength = 80): string {
  return requireText(value, label, maxLength);
}

/**
 * Allocates the next number for a document type, per company and fiscal year.
 *
 * Its own counter, never `JournalPieceSequence`: an accounting piece number
 * answers to the journal it belongs to, and borrowing that sequence would make
 * a stock receipt consume a number the ledger was going to use.
 */
export async function allocateStockDocumentNumber(
  tx: any,
  input: { companyId: string; fiscalYearId: string; type: string; date: Date },
): Promise<string> {
  const definition = STOCK_DOCUMENT_TYPES[input.type];
  if (!definition) throw new StockError("Le type de document de stock est invalide.");

  const existing = await tx.stockDocumentSequence.findUnique({
    where: { companyId_fiscalYearId_type: { companyId: input.companyId, fiscalYearId: input.fiscalYearId, type: input.type } },
  });
  const sequence = existing
    ? await tx.stockDocumentSequence.update({
        where: { id: existing.id },
        data: { nextNumber: { increment: 1 }, lastIssued: existing.nextNumber, version: { increment: 1 } },
      })
    : await tx.stockDocumentSequence.create({
        data: {
          companyId: input.companyId,
          fiscalYearId: input.fiscalYearId,
          type: input.type,
          prefix: definition.prefix,
          nextNumber: 2,
          lastIssued: 1,
        },
      });
  const issued = sequence.lastIssued;
  const year = input.date.getUTCFullYear();
  return `${sequence.prefix}-${year}-${String(issued).padStart(sequence.padding, "0")}`;
}

/**
 * Reserves the next movement sequence numbers for a company.
 *
 * Monotonic and allocated inside the validating transaction, so two movements
 * dated the same day always have a defined order — which is what FIFO
 * consumption and the running balance on the stock card both depend on.
 */
export async function reserveMovementSequences(tx: any, companyId: string, count: number): Promise<bigint[]> {
  if (count <= 0) return [];
  const settings = await tx.stockSettings.findUnique({ where: { companyId }, select: { id: true, nextMovementSequence: true } });
  if (!settings) throw new StockError("Le paramétrage du stock est absent pour ce dossier.");
  const first = settings.nextMovementSequence;
  await tx.stockSettings.update({
    where: { id: settings.id },
    data: { nextMovementSequence: first + BigInt(count), version: { increment: 1 } },
  });
  return Array.from({ length: count }, (_value, index) => first + BigInt(index));
}
