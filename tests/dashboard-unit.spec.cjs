const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let dashboard;

test.beforeAll(async () => {
  dashboard = tsxRequire(path.join(root, "electron", "dashboard.ts"), __filename);
});

test("dashboard totals use all rows, exact cents, outstanding balances, and current overdue state", async () => {
  const prisma = {
    entryLine: {
      groupBy: async () => [
        { accountId: "revenue", _sum: { debitCents: 0n, creditCents: 9_007_199_254_740_992n } },
        { accountId: "expense", _sum: { debitCents: 250_001n, creditCents: 0n } },
      ],
    },
    account: {
      findMany: async () => [{ id: "revenue", classNo: 7 }, { id: "expense", classNo: 6 }],
    },
    invoice: {
      findMany: async () => [
        { id: "late-paid", dueDate: new Date("2026-01-01T00:00:00.000Z"), status: "PAID_LATE", ttcCents: 50_000n },
        { id: "old-unpaid", dueDate: new Date("2026-01-02T00:00:00.000Z"), status: "PARTIALLY_PAID_OVERDUE", ttcCents: 10_000n },
        { id: "future-unpaid", dueDate: new Date("2026-12-01T00:00:00.000Z"), status: "PARTIALLY_PAID", ttcCents: 5_000n },
      ],
      groupBy: async () => [{ creditedInvoiceId: "old-unpaid", _sum: { ttcCents: 1_000n } }],
    },
    paymentAllocation: {
      groupBy: async () => [
        { invoiceId: "old-unpaid", _sum: { amountCents: 2_500n } },
        { invoiceId: "future-unpaid", _sum: { amountCents: 3_000n } },
      ],
    },
    bankAccount: { aggregate: async () => ({ _sum: { balanceCents: 9_007_199_254_740_993n } }) },
    entry: { count: async () => 999 },
  };

  const result = await dashboard.buildDashboardMetrics(prisma, "company-1", new Date("2026-08-20T12:00:00.000Z"));
  expect(result).toEqual({
    revenueCents: 9_007_199_254_740_992n,
    expensesCents: 250_001n,
    resultCents: 9_007_199_254_490_991n,
    bankTotalCents: 9_007_199_254_740_993n,
    unpaidTotalCents: 8_500n,
    unpaidCount: 2,
    overdueCount: 1,
    entryCount: 999,
  });
});

test("dashboard does not issue unscoped queries when no company is active", async () => {
  const prisma = new Proxy({}, { get: () => { throw new Error("No query should run"); } });
  await expect(dashboard.buildDashboardMetrics(prisma, undefined)).resolves.toMatchObject({ entryCount: 0, unpaidTotalCents: 0n });
});
