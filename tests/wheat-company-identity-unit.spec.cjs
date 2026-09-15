const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const operationsModulePath = path.join(root, "electron", "operations13.ts");
const reviewModulePath = path.join(root, "electron", "wheatReview.ts");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let operations;
let wheatReview;
let prisma;
let temporaryRoot;
let service;
let reviewService;

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

async function createCompanyFixture() {
  return prisma.company.create({
    data: {
      name: "Wheat Identité",
      legalForm: "SARL",
      ice: "001234567890123",
      taxId: "IF-IDENTITY",
      city: "Casablanca",
      vatFrequency: "MONTHLY",
    },
  });
}

function identityPayload(company, overrides = {}) {
  return {
    companyId: company.id,
    expectedVersion: company.version,
    name: company.name,
    legalForm: company.legalForm,
    ice: company.ice,
    taxId: company.taxId,
    city: company.city,
    vatFrequency: company.vatFrequency,
    ...overrides,
  };
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  operations = tsxRequire(operationsModulePath, __filename);
  wheatReview = tsxRequire(reviewModulePath, __filename);
});

test.beforeEach(async () => {
  expect(fs.existsSync(migratedDatabasePath)).toBeTruthy();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-identity-"));
  const databasePath = path.join(temporaryRoot, "wheat.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  service = operations.createOperations13Service({ getPrisma: async () => prisma });
  reviewService = wheatReview.createWheatReviewService({ getPrisma: async () => prisma });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  temporaryRoot = null;
  service = null;
  reviewService = null;
});

test("the Moroccan legal identifiers round-trip through the company service", async () => {
  const company = await createCompanyFixture();

  await service.updateCompanySettings(identityPayload(company, {
    rc: "123456",
    rcTribunal: "Tribunal de commerce de Casablanca",
    patente: "34567890",
    cnssAffiliation: "1234567",
    address: "12 rue Ibn Battouta, Maârif",
    phone: "+212 522 00 00 00",
    email: "contact@exemple.ma",
    activitySector: "Négoce de matériaux",
  }));

  const stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  expect(stored.rc).toBe("123456");
  expect(stored.rcTribunal).toBe("Tribunal de commerce de Casablanca");
  expect(stored.patente).toBe("34567890");
  expect(stored.cnssAffiliation).toBe("1234567");
  expect(stored.address).toBe("12 rue Ibn Battouta, Maârif");
  expect(stored.phone).toBe("+212 522 00 00 00");
  expect(stored.email).toBe("contact@exemple.ma");
  expect(stored.activitySector).toBe("Négoce de matériaux");
  // The pre-existing identity must survive an edit that only adds the new ones.
  expect(stored.ice).toBe("001234567890123");
  expect(stored.version).toBe(company.version + 1);
});

test("share capital is stored as exact centimes, and stays absent when not supplied", async () => {
  const company = await createCompanyFixture();

  await service.updateCompanySettings(identityPayload(company, { capitalCents: "100000.00" }));
  let stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  expect(stored.capitalCents).toBe(10_000_000n);

  // A capital that is not a round number of dirhams must not lose its centimes
  // to a floating-point round trip.
  await service.updateCompanySettings(identityPayload(stored, { capitalCents: "1234567.89" }));
  stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  expect(stored.capitalCents).toBe(123_456_789n);

  // An empty field means "not stated", which is not the same as a capital of 0.
  await service.updateCompanySettings(identityPayload(stored, { capitalCents: "" }));
  stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  expect(stored.capitalCents).toBeNull();

  await expect(service.updateCompanySettings(identityPayload(stored, { capitalCents: "-1" })))
    .rejects.toThrow(/capital social ne peut pas être négatif/i);
});

test("the new identifiers are covered by the same optimistic version check", async () => {
  const company = await createCompanyFixture();
  await service.updateCompanySettings(identityPayload(company, { rc: "111111" }));

  // Second write still carries the stale version the caller first read.
  await expect(service.updateCompanySettings(identityPayload(company, { rc: "222222" })))
    .rejects.toThrow(/modifiée ailleurs/i);

  const stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  expect(stored.rc).toBe("111111");
});

test("the audit entry records the identifiers that changed", async () => {
  const company = await createCompanyFixture();
  await service.updateCompanySettings(identityPayload(company, { rc: "654321", patente: "99887766", capitalCents: "50000.00" }));

  const event = await prisma.auditEvent.findFirst({
    where: { action: "UPDATE_COMPANY_SETTINGS", entityId: company.id },
    orderBy: { sequence: "desc" },
  });
  expect(event).not.toBeNull();
  const details = JSON.parse(event.payloadJson).details;
  expect(details.rc).toBe("654321");
  expect(details.patente).toBe("99887766");
  // BigInt centimes reach the chain as an exact string, never as a float.
  expect(details.capitalCents).toBe("5000000");
});

test("a third party carries the same legal identifiers, and its VAT status round-trips", async () => {
  const company = await createCompanyFixture();
  const subledger = tsxRequire(path.join(root, "electron", "subledger.ts"), __filename)
    .createSubledgerService({ getPrisma: async () => prisma });

  const created = await subledger.createCounterparty({
    companyId: company.id,
    kind: "SUPPLIER",
    displayName: "Fournisseur Atlas",
    ice: "002233445566778",
    taxId: "IF-4455",
    rc: "RC/2019/8841",
    patente: "TP-77-004",
    cnss: "7654321",
    rib: "011780000012345678901234",
    defaultTaxRateCode: "tva20d",
  });

  expect(created.rc).toBe("RC/2019/8841");
  expect(created.patente).toBe("TP-77-004");
  expect(created.cnss).toBe("7654321");
  expect(created.rib).toBe("011780000012345678901234");
  // Upper-cased so it resolves against a TaxRateDefinition code.
  expect(created.defaultTaxRateCode).toBe("TVA20D");
  // Every third party Wheat already holds has been treated as VAT-liable, so
  // that stays the default rather than silently reclassifying purchases.
  expect(created.vatLiable).toBe(true);

  const exempt = await subledger.updateCounterparty({
    id: created.id,
    expectedVersion: created.version,
    companyId: company.id,
    kind: "SUPPLIER",
    displayName: "Fournisseur Atlas",
    vatLiable: false,
    exonerationReason: "Exonération sans droit à déduction",
  });
  expect(exempt.vatLiable).toBe(false);
  expect(exempt.exonerationReason).toBe("Exonération sans droit à déduction");

  // A default rate code that could never resolve is refused at entry rather
  // than ignored later when an invoice is drafted.
  await expect(subledger.createCounterparty({
    companyId: company.id,
    kind: "CLIENT",
    displayName: "Client Bad Code",
    defaultTaxRateCode: "tva 20%",
  })).rejects.toThrow(/caractères non autorisés/i);
});

test("a blank RC or patente never interrupts the identity save, and review never judges their shape", async () => {
  const company = await createCompanyFixture();

  const incomplete = await reviewService.review({
    companyId: company.id,
    workflowId: "company.update",
    draft: identityPayload(company, { ice: "001234567890123" }),
  });
  // A dossier is routinely opened before its RC and patente are to hand. Any
  // finding at all would put the review panel in front of the save, so a blank
  // one raises nothing and the identity still saves in a single step.
  const codes = incomplete.findings.map((item) => item.code);
  expect(codes).not.toContain("COMPANY.RC_MISSING");
  expect(codes).not.toContain("COMPANY.PATENTE_MISSING");
  expect(incomplete.findings).toHaveLength(0);
  expect(incomplete.outcome).toBe("PASS");
  expect(incomplete.acknowledgementRequired).toBe(false);

  // Two dossiers can hold legitimately different-looking identifiers; the
  // reviewer must accept both rather than enforce an invented pattern.
  for (const [rc, patente] of [["123456", "34567890"], ["RC/2019/8841", "TP-77-004"]]) {
    const complete = await reviewService.review({
      companyId: company.id,
      workflowId: "company.update",
      draft: identityPayload(company, { rc, patente }),
    });
    // Accepted on any shape, and positively reported back.
    expect(complete.findings).toHaveLength(0);
    expect(complete.outcome).toBe("PASS");
    expect(complete.confirmed.join(" ")).toContain(rc);
    expect(complete.confirmed.join(" ")).toContain(patente);
  }
});
