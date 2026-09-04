const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const auditModulePath = path.join(root, "electron", "audit13.ts");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let audit;
let prisma;
let temporaryRoot;
let company;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  audit = tsxRequire(auditModulePath, __filename);
});

test.beforeEach(async () => {
  expect(fs.existsSync(migratedDatabasePath)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-13-audit-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  company = await prisma.company.create({
    data: {
      name: "Atlas Audit Test",
      legalForm: "SARL",
      ice: "009876543210123",
      taxId: "IF-AUDIT",
      city: "Rabat",
    },
  });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
  company = null;
});

test("canonical audit JSON and hashes are deterministic without losing integer precision", async () => {
  const first = audit.canonicalAuditJson({
    z: 9_007_199_254_740_993n,
    a: { when: new Date("2026-08-13T12:34:56.000Z"), ignored: undefined },
  });
  const second = audit.canonicalAuditJson({
    a: { ignored: undefined, when: new Date("2026-08-13T12:34:56.000Z") },
    z: 9_007_199_254_740_993n,
  });
  expect(first).toBe(second);
  expect(first).toBe('{"a":{"when":"2026-08-13T12:34:56.000Z"},"z":"9007199254740993"}');

  const envelope = {
    chainId: "chain-1",
    sequence: "9007199254740993",
    occurredAt: "2026-08-13T12:34:56.000Z",
    actorUserId: null,
    action: "TEST",
    entityType: "Entry",
    entityId: "entry-1",
    payloadJson: first,
    previousHash: null,
  };
  expect(audit.computeAuditEventHash(envelope)).toMatch(/^[a-f0-9]{64}$/);
  expect(audit.computeAuditEventHash(envelope)).toBe(audit.computeAuditEventHash({ ...envelope }));
  expect(audit.computeAuditEventHash({ ...envelope, entityId: "entry-2" })).not.toBe(audit.computeAuditEventHash(envelope));
});

test("append creates a linked SHA-256 chain and verification accepts untouched events", async () => {
  const occurredAt1 = new Date("2026-08-13T10:00:00.000Z");
  const occurredAt2 = new Date("2026-08-13T10:01:00.000Z");
  const event1 = await prisma.$transaction((tx) => audit.appendAuditEvent(tx, {
    companyId: company.id,
    action: "CREATE_ENTRY",
    entityType: "Entry",
    entityId: "entry-1",
    occurredAt: occurredAt1,
    payload: { debitCents: 9_007_199_254_740_993n, creditCents: 9_007_199_254_740_993n },
  }));
  const event2 = await prisma.$transaction((tx) => audit.appendAuditEvent(tx, {
    companyId: company.id,
    action: "POST_ENTRY",
    entityType: "Entry",
    entityId: "entry-1",
    occurredAt: occurredAt2,
    payload: { status: "POSTED" },
  }));

  expect(event1.sequence).toBe(1n);
  expect(event1.previousHash).toBeNull();
  expect(event1.eventHash).toMatch(/^[a-f0-9]{64}$/);
  expect(event2.sequence).toBe(2n);
  expect(event2.previousHash).toBe(event1.eventHash);
  expect(event2.eventHash).toMatch(/^[a-f0-9]{64}$/);

  const verification = await audit.verifyAuditChain(prisma, company.id);
  expect(verification).toMatchObject({
    valid: true,
    companyId: company.id,
    algorithm: "SHA256",
    eventCount: 2,
    importedUnsealedCount: 0,
    chainedCount: 2,
    firstChainedSequence: "1",
    lastSequence: "2",
    lastEventHash: event2.eventHash,
    problems: [],
  });
});

test("activity and audit append atomically and retain their evidence link", async () => {
  const result = await prisma.$transaction((tx) => audit.appendActivityAndAudit(tx, {
    companyId: company.id,
    action: "UPDATE_ACCOUNT",
    entityType: "Account",
    entityId: "account-1",
    description: "Compte 342100 mis à jour",
    payload: { before: "Clients", after: "Clients nationaux" },
    occurredAt: new Date("2026-08-13T11:00:00.000Z"),
  }));

  const activity = await prisma.activityLog.findUniqueOrThrow({ where: { id: result.activity.id } });
  const event = await prisma.auditEvent.findUniqueOrThrow({ where: { id: result.auditEvent.id } });
  expect(activity.companyId).toBe(company.id);
  expect(activity.detailsJson).toBe('{"after":"Clients nationaux","before":"Clients"}');
  expect(JSON.parse(event.payloadJson)).toEqual({
    activityLogId: activity.id,
    description: "Compte 342100 mis à jour",
    actorSnapshot: null,
    details: { after: "Clients nationaux", before: "Clients" },
  });
  expect((await audit.verifyAuditChain(prisma, company.id)).valid).toBe(true);
});

test("actor identity is snapshotted inside the hashed payload", async () => {
  const actor = await prisma.user.create({
    data: { name: "Amina Comptable", email: `amina-${Date.now()}@atlas.local`, role: "ACCOUNTANT" },
  });
  const result = await prisma.$transaction((tx) => audit.appendActivityAndAudit(tx, {
    companyId: company.id,
    actorUserId: actor.id,
    action: "REVIEW_BOOKS",
    entityType: "Company",
    entityId: company.id,
    description: "Livres relus",
    payload: { scope: "2026-08" },
  }));

  await prisma.user.update({ where: { id: actor.id }, data: { name: "Nom modifié" } });
  const event = await prisma.auditEvent.findUniqueOrThrow({ where: { id: result.auditEvent.id } });
  expect(JSON.parse(event.payloadJson).actorSnapshot).toEqual({
    id: actor.id,
    name: "Amina Comptable",
    email: actor.email,
    role: "ACCOUNTANT",
  });
  expect((await audit.verifyAuditChain(prisma, company.id)).valid).toBe(true);
});

test("verification detects payload, link, terminal hash, and sequence tampering", async () => {
  const first = await prisma.$transaction((tx) => audit.appendAuditEvent(tx, {
    companyId: company.id,
    action: "FIRST",
    entityType: "Test",
    entityId: "one",
    occurredAt: new Date("2026-08-13T12:00:00.000Z"),
    payload: { amountCents: "100" },
  }));
  const second = await prisma.$transaction((tx) => audit.appendAuditEvent(tx, {
    companyId: company.id,
    action: "SECOND",
    entityType: "Test",
    entityId: "two",
    occurredAt: new Date("2026-08-13T12:01:00.000Z"),
    payload: { amountCents: "200" },
  }));
  expect((await audit.verifyAuditChain(prisma, company.id)).valid).toBe(true);

  await prisma.auditEvent.update({ where: { id: first.id }, data: { payloadJson: '{"amountCents":"999"}' } });
  let verification = await audit.verifyAuditChain(prisma, company.id);
  expect(verification.valid).toBe(false);
  expect(verification.problems.some((problem) => /hash.*1|1.*hash/i.test(problem))).toBe(true);

  await prisma.auditEvent.update({ where: { id: first.id }, data: { payloadJson: first.payloadJson } });
  await prisma.auditEvent.update({ where: { id: second.id }, data: { previousHash: "0".repeat(64) } });
  verification = await audit.verifyAuditChain(prisma, company.id);
  expect(verification.valid).toBe(false);
  expect(verification.problems.some((problem) => /précédent.*2|2.*invalide/i.test(problem))).toBe(true);

  await prisma.auditEvent.update({ where: { id: second.id }, data: { previousHash: second.previousHash } });
  const chain = await prisma.auditChain.findUniqueOrThrow({ where: { companyId: company.id } });
  await prisma.auditChain.update({ where: { id: chain.id }, data: { lastEventHash: "f".repeat(64), lastSequence: 3n } });
  verification = await audit.verifyAuditChain(prisma, company.id);
  expect(verification.valid).toBe(false);
  expect(verification.problems.some((problem) => /compteur/i.test(problem))).toBe(true);
  expect(verification.problems.some((problem) => /terminal/i.test(problem))).toBe(true);
});
