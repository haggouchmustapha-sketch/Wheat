const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "subledger.ts");
const accountingModulePath = path.join(cwd, "electron", "accounting.ts");
let subledger;
let accounting;

test.beforeAll(async () => {
  subledger = tsxRequire(modulePath, __filename);
  accounting = tsxRequire(accountingModulePath, __filename);
});

test("renderer serialization preserves canonical integer-cent strings beyond safe decimal round trips", async () => {
  const serialized = accounting.rendererSerialize({
    debitCents: 9_007_199_254_740_991n,
    amountCents: 9_007_199_254_740_992n,
  });
  expect(serialized.debitCents).toBe("9007199254740991");
  expect(serialized.amountCents).toBe("9007199254740992");
  expect(serialized.amount).toBe("90071992547409.92");
});

test("strict decimal parsing never accepts a JavaScript float", async () => {
  expect(subledger.strictDecimalToCents("0")).toBe(0n);
  expect(subledger.strictDecimalToCents("12.3")).toBe(1_230n);
  expect(subledger.strictDecimalToCents("12,34")).toBe(1_234n);
  expect(subledger.strictDecimalToCents("0012.30")).toBe(1_230n);
  expect(subledger.strictDecimalToCents(1_234n)).toBe(1_234n);

  expect(() => subledger.strictDecimalToCents(12.34)).toThrow(/texte décimal/i);
  expect(() => subledger.strictDecimalToCents("1.234")).toThrow(/deux décimales/i);
  expect(() => subledger.strictDecimalToCents("1e3")).toThrow(/deux décimales/i);
  expect(() => subledger.strictDecimalToCents("-1")).toThrow(/positif/i);
  expect(() => subledger.strictDecimalToCents("0", "Le règlement", false)).toThrow(/strictement positif/i);
});

test("counterparty identities are deterministic and prefer official identifiers", async () => {
  expect(subledger.counterpartyIdentityKey({ displayName: "Société Étoile", ice: " 001 589 " })).toBe("ICE:001589");
  expect(subledger.counterpartyIdentityKey({ displayName: "ignored", taxId: "IF-48 29" })).toBe("TAX:IF4829");
  expect(subledger.counterpartyIdentityKey({ displayName: " Société Étoile SARL " })).toBe("NAME:SOCIETE ETOILE SARL");
  expect(subledger.counterpartyIdentityKey({ displayName: "société   étoile sarl" })).toBe("NAME:SOCIETE ETOILE SARL");
  expect(subledger.counterpartyIdentityKey({ displayName: "شركة الأطلس" })).toBe("NAME:شركة الاطلس");
});

test("invoice settlement is derived only from active allocations on posted payments", async () => {
  const invoice = {
    ttcCents: 10_000n,
    dueDate: new Date("2026-06-30T00:00:00.000Z"),
    lifecycleStatus: "POSTED",
    allocations: [
      {
        amountCents: 2_500n,
        status: "ACTIVE",
        payment: { lifecycleStatus: "POSTED", paymentDate: new Date("2026-06-15T00:00:00.000Z") },
      },
      {
        amountCents: 3_000n,
        status: "REVERSED",
        payment: { lifecycleStatus: "POSTED", paymentDate: new Date("2026-06-16T00:00:00.000Z") },
      },
      {
        amountCents: 1_000n,
        status: "ACTIVE",
        payment: { lifecycleStatus: "DRAFT", paymentDate: new Date("2026-06-17T00:00:00.000Z") },
      },
    ],
  };

  expect(subledger.deriveInvoiceSettlement(invoice, new Date("2026-06-20T00:00:00.000Z"))).toEqual({
    paymentAllocatedCents: 2_500n,
    creditedCents: 0n,
    allocatedCents: 2_500n,
    balanceCents: 7_500n,
    settlementStatus: "PARTIALLY_PAID",
    paidAt: null,
  });
  expect(subledger.deriveInvoiceSettlement({ ...invoice, allocations: [] }, new Date("2026-06-30T23:59:59.000Z")).settlementStatus).toBe("UNPAID");
  expect(subledger.deriveInvoiceSettlement(invoice, new Date("2026-07-01T00:00:00.000Z")).settlementStatus).toBe("PARTIALLY_PAID_OVERDUE");
});

test("full, late, overpaid, draft, and void settlements are explicit", async () => {
  const base = {
    ttcCents: 10_000n,
    dueDate: "2026-06-30T00:00:00.000Z",
    lifecycleStatus: "POSTED",
  };
  const allocation = (amountCents, paymentDate) => ({
    amountCents,
    status: "ACTIVE",
    payment: { lifecycleStatus: "POSTED", paymentDate },
  });

  expect(subledger.deriveInvoiceSettlement({ ...base, allocations: [allocation(10_000n, "2026-06-30T00:00:00.000Z")] }).settlementStatus).toBe("PAID");
  const late = subledger.deriveInvoiceSettlement({ ...base, allocations: [allocation(10_000n, "2026-07-02T00:00:00.000Z")] });
  expect(late.settlementStatus).toBe("PAID_LATE");
  expect(late.paidAt.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  expect(subledger.deriveInvoiceSettlement({ ...base, allocations: [allocation(10_001n, "2026-06-20T00:00:00.000Z")] }).settlementStatus).toBe("OVERPAID");
  expect(subledger.deriveInvoiceSettlement({
    ...base,
    lifecycleStatus: "LEGACY",
    allocations: [{ amountCents: 10_000n, status: "ACTIVE", payment: { lifecycleStatus: "LEGACY", paymentDate: "2026-07-02T00:00:00.000Z" } }],
  }).settlementStatus).toBe("PAID_LATE");
  expect(subledger.deriveInvoiceSettlement({ ...base, lifecycleStatus: "DRAFT", allocations: [] }).settlementStatus).toBe("DRAFT");
  expect(subledger.deriveInvoiceSettlement({ ...base, lifecycleStatus: "VOIDED", allocations: [] })).toEqual({
    paymentAllocatedCents: 0n,
    creditedCents: 0n,
    allocatedCents: 0n,
    balanceCents: 0n,
    settlementStatus: "VOIDED",
    paidAt: null,
  });
});

test("IPC registration exposes the complete subledger surface", async () => {
  const registrations = new Map();
  const ipcMain = {
    handle(channel, listener) {
      if (registrations.has(channel)) throw new Error(`duplicate channel ${channel}`);
      registrations.set(channel, listener);
    },
  };
  const service = subledger.registerSubledgerIpc({
    ipcMain,
    getPrisma: async () => ({}),
    serialize: (value) => value,
  });

  expect(registrations.size).toBe(Object.keys(subledger.SUBLEDGER_IPC_CHANNELS).length);
  expect(registrations.has("wheat:invoice:post")).toBe(true);
  expect(registrations.has("wheat:invoice:void")).toBe(true);
  expect(registrations.has("wheat:payment:allocate")).toBe(true);
  expect(registrations.has("wheat:payment:reverse-allocation")).toBe(true);
  expect(typeof service.createInvoiceDraft).toBe("function");
  expect(typeof service.postPayment).toBe("function");
});
