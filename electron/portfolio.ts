import { ENTRY_STATUS, rendererSerialize } from "./accounting";
import { invoiceSettlement } from "./dashboard";

/**
 * What is waiting, across every dossier on this machine.
 *
 * Every other screen in Wheat answers a question about one dossier. A fiduciaire
 * does not work that way: the question at the start of the day is which of forty
 * client files needs attention, and answering it by opening each one in turn is
 * the work this screen removes.
 *
 * Read-only by construction. It opens nothing, posts nothing and changes
 * nothing; it reports what each dossier already contains so the person can
 * choose where to go.
 *
 * One deliberate omission: this never says a VAT declaration is late. Filing
 * deadlines are set by law and Wheat has not verified them, so inventing one
 * here would put a false date in front of an accountant who is relying on it.
 * What is reported instead is the fact Wheat can stand behind — which periods
 * have no filed workpaper — leaving the deadline to the person who knows it.
 */

export const PORTFOLIO_IPC_CHANNELS = {
  overview: "wheat:portfolio:overview",
} as const;

type PrismaLike = any;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): unknown };

/** A VAT workpaper that has been superseded is history, not work in progress. */
const LIVE_WORKPAPER_STATUSES = ["DRAFT", "REVIEWED", "FILED"];

function startOfUtcDay(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function sumInto(target: Map<string, number>, key: string | null | undefined, amount: number) {
  if (!key) return;
  target.set(key, (target.get(key) ?? 0) + amount);
}

/**
 * Builds the whole portfolio in a fixed number of grouped queries rather than
 * one dashboard per dossier: the cost must not grow with the number of clients,
 * because the number of clients is exactly what makes this screen worth having.
 */
export async function buildPortfolioOverview(prisma: PrismaLike, asOf = new Date()) {
  const companies = await prisma.company.findMany({
    select: { id: true, name: true, city: true, ice: true, vatFrequency: true },
    orderBy: { name: "asc" },
  });
  if (!companies.length) {
    return { version: "WHEAT_PORTFOLIO_1", generatedAt: asOf.toISOString(), dossiers: [], totals: emptyTotals() };
  }

  const companyIds = companies.map((company: any) => company.id);
  const inScope = { in: companyIds };

  const [
    draftEntries,
    unfiledDocuments,
    stagedImports,
    openFiscalYears,
    bankAccounts,
    invoices,
    allocationTotals,
    creditTotals,
    workpapers,
  ] = await Promise.all([
    prisma.entry.groupBy({ by: ["companyId"], where: { companyId: inScope, status: ENTRY_STATUS.draft }, _count: { _all: true } }),
    // "Unfiled" is read from the links a document does or does not have rather
    // than from its status word: a document that is attached to an entry, an
    // invoice or a payment has been dealt with, whatever it is labelled.
    prisma.document.groupBy({
      by: ["companyId"],
      where: { companyId: inScope, entryId: null, invoiceId: null, paymentId: null, status: { not: "REJECTED" } },
      _count: { _all: true },
    }),
    prisma.ledgerImportBatch.groupBy({ by: ["companyId"], where: { companyId: inScope, status: "STAGED" }, _count: { _all: true } }),
    prisma.fiscalYear.findMany({
      where: { companyId: inScope, status: "OPEN" },
      select: { companyId: true, label: true, startsOn: true, endsOn: true, lockedTo: true },
      orderBy: { startsOn: "desc" },
    }),
    prisma.bankAccount.findMany({ where: { companyId: inScope }, select: { id: true, companyId: true, balanceCents: true } }),
    prisma.invoice.findMany({
      where: {
        companyId: inScope,
        lifecycleStatus: { in: ["POSTED", "LEGACY"] },
        documentType: { not: "CREDIT_NOTE" },
      },
      select: { id: true, companyId: true, dueDate: true, status: true, ttcCents: true },
    }),
    prisma.paymentAllocation.groupBy({
      by: ["invoiceId"],
      where: { status: "ACTIVE", invoice: { companyId: inScope }, payment: { lifecycleStatus: { in: ["POSTED", "LEGACY"] } } },
      _sum: { amountCents: true },
    }),
    prisma.invoice.groupBy({
      by: ["creditedInvoiceId"],
      where: { companyId: inScope, lifecycleStatus: "POSTED", documentType: "CREDIT_NOTE", creditedInvoiceId: { not: null } },
      _sum: { ttcCents: true },
    }),
    prisma.vatWorkpaper.findMany({
      where: { companyId: inScope, status: { in: LIVE_WORKPAPER_STATUSES } },
      select: { companyId: true, periodStart: true, periodEnd: true, status: true },
      orderBy: { periodEnd: "desc" },
    }),
  ]);

  const bankAccountIds = bankAccounts.map((account: any) => account.id);
  const [unreconciledMovements, lastMovements] = bankAccountIds.length
    ? await Promise.all([
        prisma.bankMovement.groupBy({
          by: ["bankAccountId"],
          where: { bankAccountId: { in: bankAccountIds }, status: "UNRECONCILED" },
          _count: { _all: true },
        }),
        prisma.bankMovement.groupBy({ by: ["bankAccountId"], where: { bankAccountId: { in: bankAccountIds } }, _max: { date: true } }),
      ])
    : [[], []];

  const asOfDay = startOfUtcDay(asOf);
  const countBy = (rows: any[]) => new Map<string, number>(rows.map((row: any) => [row.companyId, row._count?._all ?? 0]));
  const draftEntryCount = countBy(draftEntries);
  const unfiledDocumentCount = countBy(unfiledDocuments);
  const stagedImportCount = countBy(stagedImports);

  const companyOfBankAccount = new Map<string, string>(bankAccounts.map((account: any) => [account.id, account.companyId]));
  const bankBalance = new Map<string, bigint>();
  for (const account of bankAccounts) {
    bankBalance.set(account.companyId, (bankBalance.get(account.companyId) ?? 0n) + BigInt(account.balanceCents ?? 0));
  }
  const unreconciledCount = new Map<string, number>();
  for (const row of unreconciledMovements) {
    sumInto(unreconciledCount, companyOfBankAccount.get(row.bankAccountId), row._count?._all ?? 0);
  }
  const lastMovementAt = new Map<string, Date>();
  for (const row of lastMovements) {
    const companyId = companyOfBankAccount.get(row.bankAccountId);
    const date = row._max?.date ? new Date(row._max.date) : null;
    if (!companyId || !date || Number.isNaN(date.getTime())) continue;
    const current = lastMovementAt.get(companyId);
    if (!current || date > current) lastMovementAt.set(companyId, date);
  }

  const allocatedByInvoice = new Map<string, bigint>(allocationTotals.map((row: any) => [row.invoiceId, BigInt(row._sum.amountCents ?? 0)]));
  const creditedByInvoice = new Map<string, bigint>(creditTotals.map((row: any) => [row.creditedInvoiceId, BigInt(row._sum.ttcCents ?? 0)]));
  const receivable = new Map<string, { outstandingCents: bigint; overdueCents: bigint; overdueCount: number }>();
  for (const invoice of invoices) {
    const { balanceCents, overdue } = invoiceSettlement(
      invoice,
      allocatedByInvoice.get(invoice.id) ?? 0n,
      creditedByInvoice.get(invoice.id) ?? 0n,
      asOfDay,
    );
    if (balanceCents === 0n) continue;
    const bucket = receivable.get(invoice.companyId) ?? { outstandingCents: 0n, overdueCents: 0n, overdueCount: 0 };
    bucket.outstandingCents += balanceCents;
    if (overdue) {
      bucket.overdueCents += balanceCents;
      bucket.overdueCount += 1;
    }
    receivable.set(invoice.companyId, bucket);
  }

  const openFiscalYear = new Map<string, any>();
  for (const year of openFiscalYears) {
    if (!openFiscalYear.has(year.companyId)) openFiscalYear.set(year.companyId, year);
  }

  // The most recent live workpaper per dossier, plus how many are not yet filed.
  const latestWorkpaper = new Map<string, any>();
  const unfiledVatPeriods = new Map<string, number>();
  for (const workpaper of workpapers) {
    if (!latestWorkpaper.has(workpaper.companyId)) latestWorkpaper.set(workpaper.companyId, workpaper);
    if (workpaper.status !== "FILED") sumInto(unfiledVatPeriods, workpaper.companyId, 1);
  }

  const dossiers = companies.map((company: any) => {
    const money = receivable.get(company.id) ?? { outstandingCents: 0n, overdueCents: 0n, overdueCount: 0 };
    const fiscalYear = openFiscalYear.get(company.id) ?? null;
    const workpaper = latestWorkpaper.get(company.id) ?? null;
    const lastMovement = lastMovementAt.get(company.id) ?? null;
    const row = {
      companyId: company.id,
      name: company.name,
      city: company.city,
      ice: company.ice,
      vatFrequency: company.vatFrequency,
      openFiscalYear: fiscalYear
        ? { label: fiscalYear.label, startsOn: fiscalYear.startsOn, endsOn: fiscalYear.endsOn, lockedTo: fiscalYear.lockedTo }
        : null,
      draftEntryCount: draftEntryCount.get(company.id) ?? 0,
      unfiledDocumentCount: unfiledDocumentCount.get(company.id) ?? 0,
      stagedImportCount: stagedImportCount.get(company.id) ?? 0,
      unreconciledMovementCount: unreconciledCount.get(company.id) ?? 0,
      bankAccountCount: bankAccounts.filter((account: any) => account.companyId === company.id).length,
      bankTotalCents: bankBalance.get(company.id) ?? 0n,
      lastBankMovementAt: lastMovement,
      daysSinceLastBankMovement: lastMovement ? Math.floor((asOfDay - startOfUtcDay(lastMovement)) / 86_400_000) : null,
      outstandingReceivableCents: money.outstandingCents,
      overdueReceivableCents: money.overdueCents,
      overdueInvoiceCount: money.overdueCount,
      latestVatPeriod: workpaper ? { periodStart: workpaper.periodStart, periodEnd: workpaper.periodEnd, status: workpaper.status } : null,
      unfiledVatPeriodCount: unfiledVatPeriods.get(company.id) ?? 0,
    };
    return { ...row, attention: attentionFor(row) };
  });

  return {
    version: "WHEAT_PORTFOLIO_1",
    generatedAt: asOf.toISOString(),
    dossiers,
    totals: {
      dossierCount: dossiers.length,
      needingAttentionCount: dossiers.filter((dossier: any) => dossier.attention.length > 0).length,
      draftEntryCount: dossiers.reduce((sum: number, d: any) => sum + d.draftEntryCount, 0),
      unfiledDocumentCount: dossiers.reduce((sum: number, d: any) => sum + d.unfiledDocumentCount, 0),
      stagedImportCount: dossiers.reduce((sum: number, d: any) => sum + d.stagedImportCount, 0),
      unreconciledMovementCount: dossiers.reduce((sum: number, d: any) => sum + d.unreconciledMovementCount, 0),
      overdueInvoiceCount: dossiers.reduce((sum: number, d: any) => sum + d.overdueInvoiceCount, 0),
      overdueReceivableCents: dossiers.reduce((sum: bigint, d: any) => sum + d.overdueReceivableCents, 0n),
      outstandingReceivableCents: dossiers.reduce((sum: bigint, d: any) => sum + d.outstandingReceivableCents, 0n),
    },
  };
}

function emptyTotals() {
  return {
    dossierCount: 0,
    needingAttentionCount: 0,
    draftEntryCount: 0,
    unfiledDocumentCount: 0,
    stagedImportCount: 0,
    unreconciledMovementCount: 0,
    overdueInvoiceCount: 0,
    overdueReceivableCents: 0n,
    outstandingReceivableCents: 0n,
  };
}

/**
 * Why a dossier is on the list, in the words the person would use.
 *
 * Each reason names a countable fact and the screen it is settled on. Nothing
 * here is a deadline or a judgement about lateness against the law — only about
 * work that is sitting unfinished in Wheat itself.
 */
function attentionFor(row: any) {
  const reasons: Array<{ code: string; label: string; count: number }> = [];
  if (!row.openFiscalYear) reasons.push({ code: "NO_OPEN_FISCAL_YEAR", label: "Aucun exercice ouvert", count: 0 });
  if (row.stagedImportCount > 0) reasons.push({ code: "STAGED_IMPORT", label: "Import en attente de confirmation", count: row.stagedImportCount });
  if (row.draftEntryCount > 0) reasons.push({ code: "DRAFT_ENTRIES", label: "Écritures en brouillon", count: row.draftEntryCount });
  if (row.unfiledDocumentCount > 0) reasons.push({ code: "UNFILED_DOCUMENTS", label: "Documents non rattachés", count: row.unfiledDocumentCount });
  if (row.unreconciledMovementCount > 0) reasons.push({ code: "UNRECONCILED_BANK", label: "Mouvements bancaires non rapprochés", count: row.unreconciledMovementCount });
  if (row.unfiledVatPeriodCount > 0) reasons.push({ code: "VAT_NOT_FILED", label: "Périodes de TVA non déposées", count: row.unfiledVatPeriodCount });
  if (row.overdueInvoiceCount > 0) reasons.push({ code: "OVERDUE_RECEIVABLES", label: "Factures clients échues", count: row.overdueInvoiceCount });
  return reasons;
}

export function registerPortfolioIpc(options: {
  ipcMain: IpcLike;
  getPrisma: () => Promise<PrismaLike>;
  serialize?: <T>(value: T) => T;
  now?: () => Date;
}) {
  const serialize = options.serialize ?? rendererSerialize;
  options.ipcMain.handle(PORTFOLIO_IPC_CHANNELS.overview, async () =>
    serialize(await buildPortfolioOverview(await options.getPrisma(), options.now?.() ?? new Date())),
  );
  return PORTFOLIO_IPC_CHANNELS;
}
