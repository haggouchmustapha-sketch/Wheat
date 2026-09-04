const { test, expect } = require("@playwright/test");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "reconciliation.ts");
const migrationPath = path.join(cwd, "prisma", "migrations", "20260812160058_atlas_1_2_operational", "migration.sql");
const migration13Path = path.join(cwd, "prisma", "migrations", "20260813090000_atlas_1_3_integrity_imports", "migration.sql");
const seedDatabasePath = path.join(cwd, "prisma", "dev.db");

let reconciliation;
let prisma;
let temporaryRoot;

function sqliteFileUrl(filePath) {
  return `file:${filePath.replace(/\\/g, "/")}`;
}

function applyOperationalMigrationIfNeeded(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const present = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'BankReconciliation'").get();
    if (!present) database.exec(fs.readFileSync(migrationPath, "utf8"));
    const present13 = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'AuditChain'").get();
    if (!present13) database.exec(fs.readFileSync(migration13Path, "utf8"));
  } finally {
    database.close();
  }
}

async function createAccountingFixture() {
  const suffix = randomUUID();
  const company = await prisma.company.create({
    data: {
      id: `company-${suffix}`,
      name: "Atlas reconciliation test",
      legalForm: "SARL",
      ice: `ICE-${suffix}`,
      taxId: `IF-${suffix}`,
      city: "Casablanca",
    },
  });
  const bankLedgerAccount = await prisma.account.create({
    data: {
      id: `account-${suffix}`,
      companyId: company.id,
      code: `514-${suffix}`,
      label: "Banque test",
      classNo: 5,
      type: "ASSET",
    },
  });
  const journal = await prisma.journal.create({
    data: {
      id: `journal-${suffix}`,
      companyId: company.id,
      code: `BQ-${suffix}`,
      label: "Banque test",
    },
  });
  const entry = await prisma.entry.create({
    data: {
      id: `entry-${suffix}`,
      companyId: company.id,
      journalId: journal.id,
      journalCodeSnapshot: journal.code,
      number: `BQ-${suffix}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      pieceNumber: "PAY-100",
      label: "Paiement fournisseur",
      status: "POSTED",
      source: "TEST",
      postedAt: new Date("2026-08-01T00:00:00.000Z"),
      lines: {
        create: [{
          id: `line-${suffix}`,
          accountId: bankLedgerAccount.id,
          position: 1,
          accountCodeSnapshot: bankLedgerAccount.code,
          accountLabelSnapshot: bankLedgerAccount.label,
          label: "Sortie banque",
          debitCents: 0n,
          creditCents: 10_000n,
        }],
      },
    },
    include: { lines: true },
  });
  const bankAccount = await prisma.bankAccount.create({
    data: {
      id: `bank-${suffix}`,
      companyId: company.id,
      bankName: "Banque de test",
      iban: `MA64-${suffix}`,
      balanceCents: 123_456n,
      ledgerAccountId: bankLedgerAccount.id,
      balanceSource: "STATEMENT",
    },
  });
  const movement = await prisma.bankMovement.create({
    data: {
      id: `movement-${suffix}`,
      bankAccountId: bankAccount.id,
      date: new Date("2026-08-01T00:00:00.000Z"),
      label: "Virement fournisseur",
      amountCents: -10_000n,
      reference: "PAY-100",
      status: "TO_REVIEW",
      confidence: 0,
    },
  });
  return { company, bankLedgerAccount, journal, entry, line: entry.lines[0], bankAccount, movement };
}

/** One more posted line on the fixture's bank ledger account. Returns the line. */
async function addBankEntry(fixture, { suffix, date, pieceNumber, label, creditCents }) {
  const id = `${fixture.company.id}-${suffix}`;
  const entry = await prisma.entry.create({
    data: {
      id: `entry-${id}`,
      companyId: fixture.company.id,
      journalId: fixture.journal.id,
      journalCodeSnapshot: fixture.journal.code,
      number: `BQ-${id}`,
      date: new Date(date),
      pieceNumber,
      label,
      status: "POSTED",
      source: "TEST",
      postedAt: new Date(date),
      lines: {
        create: [{
          id: `line-${id}`,
          accountId: fixture.bankLedgerAccount.id,
          position: 1,
          accountCodeSnapshot: fixture.bankLedgerAccount.code,
          accountLabelSnapshot: fixture.bankLedgerAccount.label,
          label,
          debitCents: 0n,
          creditCents,
        }],
      },
    },
    include: { lines: true },
  });
  return entry.lines[0];
}

test.beforeAll(async () => {
  reconciliation = tsxRequire(modulePath, __filename);
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-reconciliation-unit-"));
  const temporaryDatabase = path.join(temporaryRoot, "atlas-reconciliation.sqlite");
  fs.copyFileSync(seedDatabasePath, temporaryDatabase);
  applyOperationalMigrationIfNeeded(temporaryDatabase);
  prisma = new PrismaClient({ datasources: { db: { url: sqliteFileUrl(temporaryDatabase) } } });
  await prisma.$connect();
});

test.afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("uses exact integer-cent strings, stable fingerprints, and derived states", async () => {
  expect(reconciliation.parseExactCents("9007199254740993")).toBe(9_007_199_254_740_993n);
  expect(() => reconciliation.parseExactCents(9007199254740992)).toThrow(/integer-cent string/i);
  expect(() => reconciliation.parseExactCents("1.00")).toThrow(/integer-cent string/i);
  expect(() => reconciliation.parseExactCents("9223372036854775808")).toThrow(/64-bit/i);

  expect(reconciliation.parseStatementMoney("1 234,56 MAD")).toBe(123_456n);
  expect(reconciliation.parseStatementMoney("(10.00)")).toBe(-1_000n);
  expect(() => reconciliation.parseStatementMoney(12.34)).toThrow(/as text/i);

  expect(reconciliation.deriveReconciliationState({ amountCents: -10_000n, allocatedCents: 0n })).toEqual({
    status: "UNRECONCILED",
    movementMagnitudeCents: "10000",
    allocatedCents: "0",
    remainingCents: "10000",
  });
  expect(reconciliation.deriveReconciliationState({ amountCents: -10_000n, allocatedCents: 4_000n }).status).toBe("PARTIAL");
  expect(reconciliation.deriveReconciliationState({ amountCents: -10_000n, allocatedCents: 10_000n }).status).toBe("RECONCILED");
  expect(reconciliation.deriveReconciliationState({ amountCents: -10_000n, allocatedCents: 0n, legacyMatchClaimed: true }).status).toBe("REVIEW_REQUIRED");
  expect(reconciliation.deriveReconciliationState({ amountCents: -10_000n, allocatedCents: 10_000n, excludedAt: new Date() }).status).toBe("EXCLUDED");

  const base = {
    bankAccountId: "bank-1",
    date: "2026-08-01",
    amountCents: "-10000",
    label: "  Virement Électricité ",
    reference: " abc-100 ",
  };
  expect(reconciliation.bankMovementFingerprint(base)).toBe(reconciliation.bankMovementFingerprint({
    ...base,
    label: "VIREMENT ELECTRICITE",
    reference: "ABC-100",
  }));
  expect(reconciliation.statementBytesSha256(Buffer.from("Wheat"))).toBe(createHash("sha256").update("Wheat").digest("hex"));
});

test("rejects balance columns and normalizes signed statement rows without floating point", async () => {
  expect(() => reconciliation.assertStatementAmountMapping({ date: "Date", label: "Libellé", amount: "Solde après opération" })).toThrow(/balance column/i);
  expect(() => reconciliation.assertStatementAmountMapping({ date: "Date", label: "Libellé", debit: "Débit", credit: "Closing balance" })).toThrow(/balance column/i);
  expect(() => reconciliation.assertStatementAmountMapping({ date: "Date", label: "Libellé", amount: "Montant", debit: "Débit" })).toThrow(/either one signed amount/i);

  const rows = reconciliation.normalizeStatementRows({
    bankAccountId: "bank-1",
    mapping: { date: "Date", label: "Libellé", debit: "Débit", credit: "Crédit", reference: "Référence" },
    rows: [
      { Date: "01/08/2026", Libellé: "Fournisseur", Débit: "1 000,25", Crédit: "", Référence: "PAY-1" },
      { Date: "2026-08-02", Libellé: "Client", Débit: "", Crédit: "2000.75", Référence: "REC-1" },
    ],
  });
  expect(rows.map((row) => row.amountCents)).toEqual([-100_025n, 200_075n]);
  expect(rows.map((row) => row.date.toISOString().slice(0, 10))).toEqual(["2026-08-01", "2026-08-02"]);
});

test("confirms partial allocations, enforces revision and caps, and preserves immutable history", async () => {
  const fixture = await createAccountingFixture();
  const service = reconciliation.createReconciliationService(prisma, { now: () => new Date("2026-08-12T12:00:00.000Z") });
  const first = await service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: fixture.line.id, amountCents: "6000" }],
    note: "First partial allocation",
  });
  expect(first.movement.revision).toBe(1);
  expect(first.movement.reconciliation.status).toBe("PARTIAL");
  expect(first.movement.reconciliation.remainingCents).toBe("4000");

  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: fixture.line.id, amountCents: "4000" }],
  })).rejects.toThrow(/changed in another window/i);

  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 1,
    allocations: [{ entryLineId: fixture.line.id, amountCents: "4001" }],
  })).rejects.toThrow(/remaining amount|remaining capacity/i);
  expect((await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id } })).revision).toBe(1);

  const second = await service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 1,
    allocations: [{ entryLineId: fixture.line.id, amountCents: "4000" }],
  });
  expect(second.movement.reconciliation.status).toBe("RECONCILED");
  expect(second.movement.reconciliation.remainingCents).toBe("0");

  const candidates = await service.candidates({ movementId: fixture.movement.id });
  expect(candidates.entryLines).toHaveLength(0);
  const workspace = await service.workspace({ companyId: fixture.company.id, bankAccountId: fixture.bankAccount.id });
  expect(workspace.movements[0].reconciliation.status).toBe("RECONCILED");
  expect(workspace.movements[0].amountCents).toBe("-10000");

  const voidedFirst = await service.void({ reconciliationId: first.reconciliation.id, expectedRevision: 2, reason: "Wrong supporting reference" });
  expect(voidedFirst.movement.reconciliation.status).toBe("PARTIAL");
  await expect(service.exclude({ movementId: fixture.movement.id, expectedRevision: 3, reason: "Not an accounting movement" })).rejects.toThrow(/void all active/i);
  await service.void({ reconciliationId: second.reconciliation.id, expectedRevision: 3, reason: "Rebuild allocation" });

  const excluded = await service.exclude({ movementId: fixture.movement.id, expectedRevision: 4, reason: "Personal transaction documented by owner" });
  expect(excluded.reconciliation.status).toBe("EXCLUDED");
  const restored = await service.restore({ movementId: fixture.movement.id, expectedRevision: 5 });
  expect(restored.reconciliation.status).toBe("UNRECONCILED");

  const persistedMovement = await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id }, include: { bankAccount: true } });
  expect(persistedMovement).toBeTruthy();
  expect(persistedMovement.revision).toBe(6);
  expect(persistedMovement.excludedAt).toBeNull();
  expect(persistedMovement.bankAccount.balanceCents).toBe(123_456n);
  expect(await prisma.bankReconciliation.count({ where: { bankMovementId: fixture.movement.id } })).toBe(2);
  expect(await prisma.bankReconciliationAllocation.count({ where: { reconciliation: { bankMovementId: fixture.movement.id } } })).toBe(2);
  expect(await prisma.bankReconciliation.count({ where: { bankMovementId: fixture.movement.id, status: "VOIDED" } })).toBe(2);
});

test("explains every suggestion with the facts its score is made of", async () => {
  const fixture = await createAccountingFixture();
  const service = reconciliation.createReconciliationService(prisma);

  // A second line on the same bank account: right direction, more than enough
  // to cover the movement, five days later, and no shared reference.
  const near = await addBankEntry(fixture, {
    suffix: "near",
    date: "2026-08-06T00:00:00.000Z",
    pieceNumber: "AUTRE-1",
    label: "Autre sortie",
    creditCents: 25_000n,
  });
  // A third: too small to cover it, two months away, nothing in common.
  const far = await addBankEntry(fixture, {
    suffix: "far",
    date: "2026-10-01T00:00:00.000Z",
    pieceNumber: "AUTRE-2",
    label: "Sortie lointaine",
    creditCents: 5_000n,
  });

  const { entryLines } = await service.candidates({ movementId: fixture.movement.id });
  const byId = new Map(entryLines.map((line) => [line.id, line]));

  const exact = byId.get(fixture.line.id);
  expect(exact.score).toBe(100);
  expect(exact.matchReasons).toEqual(["AMOUNT_EXACT", "DATE_SAME_DAY", "REFERENCE_MATCH"]);

  const covering = byId.get(near.id);
  expect(covering.matchReasons).toEqual(["AMOUNT_COVERS", "DATE_WITHIN_10_DAYS"]);
  expect(covering.score).toBe(30);

  // Nothing matched, so nothing is claimed. A suggestion with no evidence
  // behind it must say so rather than borrow a reason from a better one.
  const unrelated = byId.get(far.id);
  expect(unrelated.matchReasons).toEqual([]);
  expect(unrelated.score).toBe(0);

  // The reasons are the score: best-explained first, and never contradictory.
  expect(entryLines.map((line) => line.id)).toEqual([fixture.line.id, near.id, far.id]);
  for (const line of entryLines) {
    expect(line.matchReasons.length > 0).toBe(line.score > 0);
    expect(line.matchReasons).toEqual([...new Set(line.matchReasons)]);
  }
});

test("rejects wrong signs, other-company lines, drafts, and rolls back revision claims", async () => {
  const fixture = await createAccountingFixture();
  const service = reconciliation.createReconciliationService(prisma);
  const suffix = randomUUID();
  const draftEntry = await prisma.entry.create({
    data: {
      id: `draft-${suffix}`,
      companyId: fixture.company.id,
      journalId: fixture.journal.id,
      journalCodeSnapshot: fixture.journal.code,
      number: `DRAFT-${suffix}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      pieceNumber: "DRAFT",
      label: "Draft bank entry",
      status: "DRAFT",
      lines: { create: [{ id: `draft-line-${suffix}`, accountId: fixture.bankLedgerAccount.id, position: 1, accountCodeSnapshot: fixture.bankLedgerAccount.code, accountLabelSnapshot: fixture.bankLedgerAccount.label, label: "Draft", creditCents: 10_000n }] },
    },
    include: { lines: true },
  });
  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: draftEntry.lines[0].id, amountCents: "10000" }],
  })).rejects.toThrow(/not part of a posted entry/i);
  expect((await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id } })).revision).toBe(0);

  const wrongSignEntry = await prisma.entry.create({
    data: {
      id: `wrong-${suffix}`,
      companyId: fixture.company.id,
      journalId: fixture.journal.id,
      journalCodeSnapshot: fixture.journal.code,
      number: `WRONG-${suffix}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      pieceNumber: "WRONG",
      label: "Wrong direction",
      status: "POSTED",
      postedAt: new Date("2026-08-01T00:00:00.000Z"),
      lines: { create: [{ id: `wrong-line-${suffix}`, accountId: fixture.bankLedgerAccount.id, position: 1, accountCodeSnapshot: fixture.bankLedgerAccount.code, accountLabelSnapshot: fixture.bankLedgerAccount.label, label: "Debit", debitCents: 10_000n }] },
    },
    include: { lines: true },
  });
  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: wrongSignEntry.lines[0].id, amountCents: "10000" }],
  })).rejects.toThrow(/opposite bank direction/i);
  expect((await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id } })).revision).toBe(0);

  const unmappedAccount = await prisma.account.create({
    data: {
      id: `unmapped-account-${suffix}`,
      companyId: fixture.company.id,
      code: `511-${suffix}`,
      label: "Cash account, not mapped bank",
      classNo: 5,
      type: "ASSET",
    },
  });
  const unmappedEntry = await prisma.entry.create({
    data: {
      id: `unmapped-entry-${suffix}`,
      companyId: fixture.company.id,
      journalId: fixture.journal.id,
      journalCodeSnapshot: fixture.journal.code,
      number: `UNMAPPED-${suffix}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      pieceNumber: "UNMAPPED",
      label: "Unmapped account",
      status: "POSTED",
      postedAt: new Date("2026-08-01T00:00:00.000Z"),
      lines: { create: [{ id: `unmapped-line-${suffix}`, accountId: unmappedAccount.id, position: 1, accountCodeSnapshot: unmappedAccount.code, accountLabelSnapshot: unmappedAccount.label, label: "Credit", creditCents: 10_000n }] },
    },
    include: { lines: true },
  });
  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: unmappedEntry.lines[0].id, amountCents: "10000" }],
  })).rejects.toThrow(/not on the bank account mapped/i);
  expect((await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id } })).revision).toBe(0);

  const otherCompany = await prisma.company.create({
    data: {
      id: `other-company-${suffix}`,
      name: "Other company",
      legalForm: "SARL",
      ice: `OTHER-ICE-${suffix}`,
      taxId: `OTHER-IF-${suffix}`,
      city: "Rabat",
    },
  });
  const otherJournal = await prisma.journal.create({
    data: { id: `other-journal-${suffix}`, companyId: otherCompany.id, code: `BQ-${suffix}`, label: "Other bank" },
  });
  const otherCompanyEntry = await prisma.entry.create({
    data: {
      id: `other-entry-${suffix}`,
      companyId: otherCompany.id,
      journalId: otherJournal.id,
      journalCodeSnapshot: otherJournal.code,
      number: `OTHER-${suffix}`,
      date: new Date("2026-08-01T00:00:00.000Z"),
      pieceNumber: "OTHER",
      label: "Other company entry",
      status: "POSTED",
      postedAt: new Date("2026-08-01T00:00:00.000Z"),
      lines: { create: [{ id: `other-line-${suffix}`, accountId: fixture.bankLedgerAccount.id, position: 1, accountCodeSnapshot: fixture.bankLedgerAccount.code, accountLabelSnapshot: fixture.bankLedgerAccount.label, label: "Credit", creditCents: 10_000n }] },
    },
    include: { lines: true },
  });
  await expect(service.confirm({
    movementId: fixture.movement.id,
    expectedRevision: 0,
    allocations: [{ entryLineId: otherCompanyEntry.lines[0].id, amountCents: "10000" }],
  })).rejects.toThrow(/belongs to another company/i);
  expect((await prisma.bankMovement.findUnique({ where: { id: fixture.movement.id } })).revision).toBe(0);
});

test("imports immutable statement movements, does not mutate balances, and blocks duplicates", async () => {
  const fixture = await createAccountingFixture();
  const service = reconciliation.createReconciliationService(prisma, { now: () => new Date("2026-08-12T15:30:00.000Z") });
  const mapping = { date: "Date", label: "Label", amount: "Amount", reference: "Reference" };
  const rows = [
    { Date: "2026-08-05", Label: "Electricity", Amount: "-1250.25", Reference: "INV-EL-1" },
    { Date: "2026-08-06", Label: "Customer receipt", Amount: "5000,00", Reference: "REC-500" },
  ];
  const sourceSha256 = createHash("sha256").update("statement-one").digest("hex");
  const imported = await service.importStatement({
    bankAccountId: fixture.bankAccount.id,
    sourceName: "statement-august.csv",
    sourceSha256,
    mapping,
    rows,
    openingBalanceCents: "123456",
    closingBalanceCents: "498431",
  });
  expect(imported.movements.map((movement) => movement.amountCents)).toEqual(["-125025", "500000"]);
  expect(imported.movements.every((movement) => movement.revision === 0)).toBe(true);
  expect((await prisma.bankAccount.findUnique({ where: { id: fixture.bankAccount.id } })).balanceCents).toBe(123_456n);

  await expect(service.importStatement({
    bankAccountId: fixture.bankAccount.id,
    sourceName: "same-file.csv",
    sourceSha256,
    mapping,
    rows,
  })).rejects.toThrow(/already imported/i);

  await expect(service.importStatement({
    bankAccountId: fixture.bankAccount.id,
    sourceName: "overlap.csv",
    sourceSha256: createHash("sha256").update("overlapping-statement").digest("hex"),
    mapping,
    rows: [rows[0]],
  })).rejects.toThrow(/suspected duplicate/i);

  expect(await prisma.bankMovement.count({ where: { bankAccountId: fixture.bankAccount.id, statementId: imported.statement.id } })).toBe(2);
  expect((await prisma.bankAccount.findUnique({ where: { id: fixture.bankAccount.id } })).balanceCents).toBe(123_456n);
});

test("registers a stable IPC surface and serializes service results", async () => {
  const fixture = await createAccountingFixture();
  const handlers = new Map();
  const facade = reconciliation.registerReconciliationIpc({
    ipcMain: {
      handle(channel, listener) {
        if (handlers.has(channel)) throw new Error(`duplicate IPC channel ${channel}`);
        handlers.set(channel, listener);
      },
    },
    getPrisma: async () => prisma,
    serialize: (value) => ({ serialized: value }),
  });
  expect([...handlers.keys()].sort()).toEqual(Object.values(reconciliation.RECONCILIATION_IPC_CHANNELS).sort());
  const result = await handlers.get(reconciliation.RECONCILIATION_IPC_CHANNELS.workspace)(null, {
    companyId: fixture.company.id,
    bankAccountId: fixture.bankAccount.id,
  });
  expect(result.serialized.companyId).toBe(fixture.company.id);
  expect(result.serialized.movements[0].amountCents).toBe("-10000");
  expect(typeof facade.confirm).toBe("function");
});
