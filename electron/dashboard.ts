import { ENTRY_STATUS } from "./accounting";

const ZERO_METRICS = Object.freeze({
  revenueCents: 0n,
  expensesCents: 0n,
  resultCents: 0n,
  bankTotalCents: 0n,
  unpaidTotalCents: 0n,
  unpaidCount: 0,
  overdueCount: 0,
  entryCount: 0,
});

function absolute(value: bigint) {
  return value < 0n ? -value : value;
}

/** Builds complete, cent-exact dashboard totals without relying on capped bootstrap rows. */
export async function buildDashboardMetrics(prisma: any, companyId?: string, asOf = new Date()) {
  if (!companyId) return { ...ZERO_METRICS };

  const postedStatuses = [ENTRY_STATUS.posted, ENTRY_STATUS.reversed];
  const [accountTotals, accounts, invoices, paymentTotals, creditTotals, bankTotal, entryCount] = await Promise.all([
    prisma.entryLine.groupBy({
      by: ["accountId"],
      where: { entry: { companyId, status: { in: postedStatuses } } },
      _sum: { debitCents: true, creditCents: true },
    }),
    prisma.account.findMany({ where: { companyId, classNo: { in: [6, 7] } }, select: { id: true, classNo: true } }),
    prisma.invoice.findMany({
      where: {
        companyId,
        lifecycleStatus: { in: ["POSTED", "LEGACY"] },
        documentType: { not: "CREDIT_NOTE" },
      },
      select: { id: true, dueDate: true, status: true, ttcCents: true },
    }),
    prisma.paymentAllocation.groupBy({
      by: ["invoiceId"],
      where: {
        status: "ACTIVE",
        invoice: { companyId },
        payment: { lifecycleStatus: { in: ["POSTED", "LEGACY"] } },
      },
      _sum: { amountCents: true },
    }),
    prisma.invoice.groupBy({
      by: ["creditedInvoiceId"],
      where: {
        companyId,
        lifecycleStatus: "POSTED",
        documentType: "CREDIT_NOTE",
        creditedInvoiceId: { not: null },
      },
      _sum: { ttcCents: true },
    }),
    prisma.bankAccount.aggregate({ where: { companyId }, _sum: { balanceCents: true } }),
    prisma.entry.count({ where: { companyId, status: { in: postedStatuses } } }),
  ]);

  const accountClass = new Map<string, number>(accounts.map((account: any) => [account.id, account.classNo]));
  let revenueCents = 0n;
  let expensesCents = 0n;
  for (const total of accountTotals) {
    const debit = BigInt(total._sum.debitCents ?? 0);
    const credit = BigInt(total._sum.creditCents ?? 0);
    if (accountClass.get(total.accountId) === 7) revenueCents += absolute(credit - debit);
    if (accountClass.get(total.accountId) === 6) expensesCents += absolute(debit - credit);
  }

  const allocatedByInvoice = new Map<string, bigint>(paymentTotals.map((total: any) => [total.invoiceId, BigInt(total._sum.amountCents ?? 0)]));
  const creditedByInvoice = new Map<string, bigint>(creditTotals.map((total: any) => [total.creditedInvoiceId, BigInt(total._sum.ttcCents ?? 0)]));
  const asOfDay = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  let unpaidTotalCents = 0n;
  let unpaidCount = 0;
  let overdueCount = 0;
  for (const invoice of invoices) {
    const settledStatus = new Set(["PAID", "PAID_LATE", "OVERPAID", "VOIDED"]);
    const allocated = (allocatedByInvoice.get(invoice.id) ?? 0n) + (creditedByInvoice.get(invoice.id) ?? 0n);
    const total = BigInt(invoice.ttcCents ?? 0);
    const calculatedBalance = total > allocated ? total - allocated : 0n;
    const balance = settledStatus.has(invoice.status) ? 0n : calculatedBalance;
    if (balance === 0n) continue;
    unpaidTotalCents += balance;
    unpaidCount += 1;
    if (!invoice.dueDate) continue;
    const due = new Date(invoice.dueDate);
    const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
    if (!Number.isNaN(dueDay) && dueDay < asOfDay) overdueCount += 1;
  }

  return {
    revenueCents,
    expensesCents,
    resultCents: revenueCents - expensesCents,
    bankTotalCents: BigInt(bankTotal._sum.balanceCents ?? 0),
    unpaidTotalCents,
    unpaidCount,
    overdueCount,
    entryCount,
  };
}
