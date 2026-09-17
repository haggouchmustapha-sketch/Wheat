/**
 * Where stock value meets the general ledger.
 *
 * Stock generates exactly one accounting leg: the movement of value into or out
 * of a stock account, against the matching variation account. It never
 * generates a supplier payable, a customer receivable, recoverable VAT or
 * collected VAT — those belong to the invoice that accompanies the goods, and a
 * stock module that also posts them books the same commercial transaction
 * twice.
 *
 * Two rules do most of the work here:
 *
 *  - **No fallback account.** An article whose family and company say nothing
 *    about which stock account it belongs to blocks accounting generation with
 *    a message naming the article. Defaulting to 3111 would post a raw-material
 *    company's entire inventory to merchandise, and would do it silently.
 *  - **The draft is created in the caller's transaction**, through the entry
 *    machinery every other Wheat posting path uses, so the fiscal-period check,
 *    the journal and account validation, the piece numbering and the balance
 *    check all still apply — and so the draft cannot outlive a validation that
 *    rolled back.
 *
 * The suggested Moroccan CGNC codes live in `STOCK_ACCOUNT_SUGGESTIONS`. They
 * are suggestions offered while an accountant configures a dossier, and nothing
 * in this module will post to one that was not explicitly configured.
 */

import { ENTRY_STATUS, assertPostingPeriodOpen, formatCentsAsMad } from "./accounting";
import { createEntryInTransaction } from "./entryCommands21";
import { moneyMicroToCents } from "./stockUnits";

export type StockAccountMappingScope = "COMPANY" | "FAMILY" | "ARTICLE";

export function mappingScopeKey(scope: StockAccountMappingScope, targetId?: string | null): string {
  if (scope === "COMPANY") return "COMPANY";
  if (!targetId) throw new Error("Un paramétrage par famille ou par article doit désigner sa cible.");
  return `${scope}:${targetId}`;
}

/**
 * Candidate CGNC codes, shown while configuring — never posted to on their own.
 *
 * Wheat cannot warrant that a given code is the correct one for a given
 * dossier: that depends on the company's own plan and on the inventory method
 * its accountant applies. These are a starting point for that conversation, and
 * the mapping the accountant saves is what governs.
 */
export const STOCK_ACCOUNT_SUGGESTIONS = [
  { familyHint: "Marchandises", stock: "3111", variation: "6114" },
  { familyHint: "Matières premières", stock: "3121", variation: "6124" },
  { familyHint: "Matières et fournitures consommables", stock: "3122", variation: "6124" },
  { familyHint: "Produits finis", stock: "3151", variation: "7132" },
] as const;

export const STOCK_IMPAIRMENT_SUGGESTIONS = {
  provision: "3911",
  charge: "6196",
  reversal: "7196",
} as const;

export type ResolvedStockAccounts = {
  stockAccountId: string;
  variationAccountId: string;
  scope: StockAccountMappingScope;
};

const MAX_FAMILY_DEPTH = 10;

/**
 * Article override, then the family chain, then the company default.
 *
 * Walking the family chain upwards means a dossier can configure "Matières
 * premières" once and let its sub-families inherit, which is how an accountant
 * already thinks about a chart of accounts.
 */
export async function resolveStockAccounts(
  tx: any,
  companyId: string,
  article: { id: string; designation: string; familyId: string | null },
): Promise<ResolvedStockAccounts> {
  const scopeKeys: string[] = [mappingScopeKey("ARTICLE", article.id)];
  let familyId = article.familyId;
  for (let depth = 0; familyId && depth < MAX_FAMILY_DEPTH; depth += 1) {
    scopeKeys.push(mappingScopeKey("FAMILY", familyId));
    const family = await tx.stockArticleFamily.findFirst({
      where: { id: familyId, companyId },
      select: { parentFamilyId: true },
    });
    familyId = family?.parentFamilyId ?? null;
  }
  scopeKeys.push("COMPANY");

  const mappings = await tx.stockAccountMapping.findMany({
    where: { companyId, scopeKey: { in: scopeKeys } },
  });
  const byKey = new Map<string, any>(mappings.map((mapping: any) => [mapping.scopeKey, mapping]));

  for (const key of scopeKeys) {
    const mapping = byKey.get(key);
    if (mapping) {
      return {
        stockAccountId: mapping.stockAccountId,
        variationAccountId: mapping.variationAccountId,
        scope: mapping.scope as StockAccountMappingScope,
      };
    }
  }
  throw new Error(`Compte de stock non paramétré pour l'article « ${article.designation} ». Renseignez le paramétrage comptable du stock avant de valider.`);
}

/** One article's net effect on the ledger for a single stock document. */
export type StockAccountingLeg = {
  stockAccountId: string;
  variationAccountId: string;
  label: string;
  /** Positive when stock value increases, negative when it decreases. */
  valueMicro: bigint;
};

export type StockEntryRequest = {
  companyId: string;
  journalId: string;
  date: Date;
  label: string;
  reference: string;
  legs: StockAccountingLeg[];
  counterpartyId?: string | null;
};

export class StockAccountingError extends Error {}

/**
 * Builds the balanced DRAFT entry for a validated stock document.
 *
 * Each leg becomes a pair of lines on its own accounts, converted to centimes
 * once, here, at the boundary. A leg worth less than half a centime rounds to
 * nothing and is dropped rather than posted as a zero line — an entry line with
 * no amount is refused by Wheat's own validation, and dropping it keeps the
 * entry balanced because both of its sides round identically.
 *
 * Returns `null` when nothing survives rounding, which is a real outcome for a
 * transfer between warehouses that share a stock account: the goods moved, the
 * ledger has nothing to say about it, and inventing an entry to prove the
 * module was here would be noise in the journal.
 */
export async function createStockDraftEntry(tx: any, request: StockEntryRequest) {
  const lines: Array<{
    accountId: string;
    label: string;
    debitCents: bigint;
    creditCents: bigint;
    thirdParty: string | null;
    counterpartyId: string | null;
  }> = [];

  for (const leg of request.legs) {
    const cents = moneyMicroToCents(leg.valueMicro, "La valeur du mouvement");
    if (cents === 0n) continue;
    const amount = cents < 0n ? -cents : cents;
    const increasing = cents > 0n;
    // Stock rises: the stock account is debited and the variation account
    // credited. Stock falls: exactly the reverse.
    lines.push({
      accountId: increasing ? leg.stockAccountId : leg.variationAccountId,
      label: leg.label,
      debitCents: amount,
      creditCents: 0n,
      thirdParty: null,
      counterpartyId: null,
    });
    lines.push({
      accountId: increasing ? leg.variationAccountId : leg.stockAccountId,
      label: leg.label,
      debitCents: 0n,
      creditCents: amount,
      thirdParty: null,
      counterpartyId: null,
    });
  }

  if (lines.length === 0) return null;

  const debitCents = lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const creditCents = lines.reduce((sum, line) => sum + line.creditCents, 0n);
  if (debitCents !== creditCents) {
    throw new StockAccountingError(`L'écriture de stock générée est déséquilibrée de ${formatCentsAsMad(debitCents - creditCents)} MAD.`);
  }

  await assertPostingPeriodOpen(tx, request.companyId, request.date, "La date du document de stock");

  const { created } = await createEntryInTransaction(
    tx,
    {
      companyId: request.companyId,
      journalId: request.journalId,
      date: request.date,
      pieceNumber: null,
      label: request.label,
      source: "STOCK",
      status: ENTRY_STATUS.draft,
      lines,
    } as any,
    { auditNote: `Brouillon généré par le module Stock pour ${request.reference}` },
  );
  return created;
}

/**
 * The journal stock posts to, which the dossier has to have chosen.
 *
 * Picking one automatically would put stock movements into whichever journal
 * happened to sort first, and a journal is a decision an accountant makes about
 * how their books read.
 */
export async function requireStockJournal(tx: any, companyId: string): Promise<string> {
  const settings = await tx.stockSettings.findUnique({ where: { companyId }, select: { stockJournalId: true } });
  if (!settings?.stockJournalId) {
    throw new StockAccountingError("Aucun journal n'est paramétré pour les écritures de stock. Choisissez-le dans le paramétrage comptable du stock.");
  }
  return settings.stockJournalId;
}
