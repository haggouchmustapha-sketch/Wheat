import { PrismaClient } from "@prisma/client";
import { seedPcgeForCompany } from "../electron/chartOfAccounts21";

const prisma = new PrismaClient();

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const cents = (value: number) => BigInt(Math.round(value * 100));

async function seedCompany(input: {
  name: string;
  legalForm: string;
  ice: string;
  taxId: string;
  city: string;
}) {
  const company = await prisma.company.create({
    data: {
      ...input,
      fiscalYears: {
        create: [
          { label: "Exercice 2025", startsOn: d("2025-01-01"), endsOn: d("2025-12-31"), lockedTo: d("2025-12-31"), status: "CLOSED" },
          { label: "Exercice 2026", startsOn: d("2026-01-01"), endsOn: d("2026-12-31"), lockedTo: d("2026-03-31"), status: "OPEN" },
        ],
      },
      journals: {
        create: [
          { code: "OD", label: "Opérations diverses", nextNumber: 246, allowManualPieceOverride: true },
          { code: "BQ", label: "Banque", nextNumber: 158, allowManualPieceOverride: true },
          { code: "VE", label: "Ventes", nextNumber: 88, allowManualPieceOverride: true },
          { code: "AC", label: "Achats", nextNumber: 144, allowManualPieceOverride: true },
          { code: "CA", label: "Caisse", nextNumber: 320, allowManualPieceOverride: true },
          { code: "PA", label: "Paie", nextNumber: 44, allowManualPieceOverride: true },
        ],
      },
      accounts: {
        create: [
          { code: "111100", label: "Capital social", classNo: 1, type: "EQUITY" },
          { code: "211100", label: "Frais préliminaires", classNo: 2, type: "ASSET" },
          { code: "233200", label: "Matériel de transport", classNo: 2, type: "ASSET" },
          { code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
          { code: "345510", label: "TVA récupérable sur immobilisations", classNo: 3, type: "ASSET" },
          { code: "345520", label: "TVA récupérable sur charges", classNo: 3, type: "ASSET" },
          { code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY" },
          { code: "445500", label: "Etat - TVA facturée", classNo: 4, type: "LIABILITY" },
          { code: "445660", label: "Etat - TVA due", classNo: 4, type: "LIABILITY" },
          { code: "514100", label: "Banques", classNo: 5, type: "ASSET" },
          { code: "514200", label: "Attijariwafa bank", classNo: 5, type: "ASSET" },
          { code: "514300", label: "CIH Bank", classNo: 5, type: "ASSET" },
          { code: "514400", label: "Crédit Agricole", classNo: 5, type: "ASSET" },
          { code: "516100", label: "Caisses", classNo: 5, type: "ASSET" },
          { code: "611100", label: "Achats de marchandises", classNo: 6, type: "EXPENSE" },
          { code: "612500", label: "Achats non stockés", classNo: 6, type: "EXPENSE" },
          { code: "614100", label: "Locations et charges locatives", classNo: 6, type: "EXPENSE" },
          { code: "617100", label: "Rémunérations du personnel", classNo: 6, type: "EXPENSE" },
          { code: "711100", label: "Ventes de marchandises", classNo: 7, type: "REVENUE" },
          { code: "712400", label: "Prestations de services", classNo: 7, type: "REVENUE" },
        ],
      },
    },
    include: { accounts: true, journals: true },
  });

  await seedPcgeForCompany(prisma, company.id);

  const account = (code: string) => company.accounts.find((a) => a.code === code)!;
  const journal = (code: string) => company.journals.find((j) => j.code === code)!;

  const entries = [
    {
      journal: "VE",
      number: "VE-2026-000087",
      date: "2026-05-30",
      pieceNumber: "FA-2026-1287",
      label: "Clients - Facture FA-2026-1287",
      lines: [
        ["342100", "Client Groupe Horizon", 25000, 0],
        ["712400", "Prestation comptable", 0, 20833.33],
        ["445500", "TVA facturée", 0, 4166.67],
      ],
    },
    {
      journal: "BQ",
      number: "BQ-2026-000156",
      date: "2026-05-30",
      pieceNumber: "VIR-BMCI-156",
      label: "BMCI - Virement reçu",
      lines: [
        ["514100", "Encaissement client", 18500, 0],
        ["342100", "Règlement client", 0, 18500],
      ],
    },
    {
      journal: "AC",
      number: "AC-2026-000143",
      date: "2026-05-29",
      pieceNumber: "FR-9876",
      label: "Fournisseurs - Facture FR-9876",
      lines: [
        ["612500", "Achats non stockés", 13000, 0],
        ["345520", "TVA récupérable", 2600, 0],
        ["441100", "Fournisseur", 0, 15600],
      ],
    },
    {
      journal: "OD",
      number: "OD-2026-000245",
      date: "2026-05-30",
      pieceNumber: "OD-245",
      label: "Clients - Facture FA-2026-1287",
      lines: [
        ["342100", "Clients", 25000, 0],
        ["712400", "Honoraires", 0, 20833.33],
        ["445500", "TVA facturée", 0, 4166.67],
      ],
    },
    {
      journal: "OD",
      number: "OD-2026-000244",
      date: "2026-05-29",
      pieceNumber: "TVA-05-2026",
      label: "TVA à décaisser - Mai 2026",
      status: "PENDING",
      lines: [
        ["445500", "TVA collectée", 4925140.75, 0],
        ["345520", "TVA déductible", 0, 3048720.57],
        ["445660", "TVA due", 0, 1876420.18],
      ],
    },
  ];

  const createdEntries = new Map<string, Awaited<ReturnType<typeof prisma.entry.create>>>();
  for (const entry of entries) {
    const createdEntry = await prisma.entry.create({
      data: {
        companyId: company.id,
        journalId: journal(entry.journal).id,
        journalCodeSnapshot: journal(entry.journal).code,
        number: entry.number,
        date: d(entry.date),
        pieceNumber: entry.pieceNumber,
        label: entry.label,
        status: entry.status === "PENDING" ? "DRAFT" : "POSTED",
        postedAt: entry.status === "PENDING" ? null : d(entry.date),
        source: "SEED",
        auditNote: "Seed demo entry with balanced debit/credit lines",
        lines: {
          create: entry.lines.map(([code, label, debit, credit], index) => ({
            accountId: account(code as string).id,
            position: index + 1,
            accountCodeSnapshot: account(code as string).code,
            accountLabelSnapshot: account(code as string).label,
            label: label as string,
            debitCents: cents(debit as number),
            creditCents: cents(credit as number),
          })),
        },
      },
      include: { lines: true },
    });
    createdEntries.set(entry.number, createdEntry);
  }

  const counterparties = await Promise.all([
    { kind: "CUSTOMER", displayName: "Groupe Horizon Distribution", ice: "001589742000063", identityKey: "ICE:001589742000063", receivable: true },
    { kind: "CUSTOMER", displayName: "Riad Services SARL", ice: "001372951000048", identityKey: "ICE:001372951000048", receivable: true },
    { kind: "SUPPLIER", displayName: "Techno Bureau Maroc", ice: "000894112000089", identityKey: "ICE:000894112000089", receivable: false },
    { kind: "SUPPLIER", displayName: "Maroc Leasing", ice: "000456777000011", identityKey: "ICE:000456777000011", receivable: false },
  ].map((party) => prisma.counterparty.create({
    data: {
      companyId: company.id,
      kind: party.kind,
      displayName: party.displayName,
      legalName: party.displayName,
      ice: party.ice,
      identityKey: party.identityKey,
      defaultReceivableAccountId: party.receivable ? account("342100").id : null,
      defaultPayableAccountId: party.receivable ? null : account("441100").id,
      paymentTermsDays: 30,
    },
  })));
  const party = (name: string) => counterparties.find((counterparty) => counterparty.displayName === name)!;
  const saleEntry = createdEntries.get("VE-2026-000087")!;
  const purchaseEntry = createdEntries.get("AC-2026-000143")!;
  const bankEntry = createdEntries.get("BQ-2026-000156")!;

  const saleInvoice = await prisma.invoice.create({
    data: {
      companyId: company.id,
      counterpartyId: party("Groupe Horizon Distribution").id,
      kind: "SALE",
      counterparty: "Groupe Horizon Distribution",
      counterpartyNameSnapshot: "Groupe Horizon Distribution",
      ice: "001589742000063",
      iceSnapshot: "001589742000063",
      invoiceNo: "FA-2026-1287",
      numberKey: "SALE:fa-2026-1287",
      series: "FA",
      sequenceYear: 2026,
      sequenceNo: 1287,
      invoiceDate: d("2026-05-30"),
      dueDate: d("2026-07-29"),
      htCents: cents(20833.33),
      vatCents: cents(4166.67),
      ttcCents: cents(25000),
      status: "PARTIAL",
      lifecycleStatus: "POSTED",
      source: "MANUAL",
      needsReview: false,
      paymentMethod: "Virement",
      controlAccountId: account("342100").id,
      vatAccountId: account("445500").id,
      postedEntryId: saleEntry.id,
      postedAt: d("2026-05-30"),
      lines: { create: [{ position: 1, description: "Prestation comptable", accountId: account("712400").id, htCents: cents(20833.33), vatCents: cents(4166.67), ttcCents: cents(25000) }] },
    },
  });

  await prisma.invoice.create({
    data: {
      companyId: company.id,
      counterpartyId: party("Riad Services SARL").id,
      kind: "SALE", counterparty: "Riad Services SARL", counterpartyNameSnapshot: "Riad Services SARL",
      ice: "001372951000048", iceSnapshot: "001372951000048", invoiceNo: "FA-2026-1244",
      numberKey: `SALE:fa-2026-1244:LEGACY:${company.id}`, invoiceDate: d("2026-02-14"), dueDate: d("2026-04-14"),
      htCents: cents(72000), vatCents: cents(14400), ttcCents: cents(86400), status: "OVERDUE",
      lifecycleStatus: "LEGACY", legacyStatus: "OVERDUE", source: "LEGACY_1_1", needsReview: true,
      reviewNote: "Démonstration d'une facture importée sans lien comptable.", paymentMethod: "Chèque",
      lines: { create: [{ position: 1, description: "Solde historique importé", htCents: cents(72000), vatCents: cents(14400), ttcCents: cents(86400), isLegacySummary: true }] },
    },
  });

  await prisma.invoice.create({
    data: {
      companyId: company.id,
      counterpartyId: party("Techno Bureau Maroc").id,
      kind: "PURCHASE", counterparty: "Techno Bureau Maroc", counterpartyNameSnapshot: "Techno Bureau Maroc",
      ice: "000894112000089", iceSnapshot: "000894112000089", invoiceNo: "FR-9876", numberKey: `PURCHASE:${party("Techno Bureau Maroc").id}:fr-9876`,
      invoiceDate: d("2026-05-29"), dueDate: d("2026-06-28"), htCents: cents(13000), vatCents: cents(2600), ttcCents: cents(15600),
      status: "UNPAID", lifecycleStatus: "POSTED", source: "OCR", needsReview: false, paymentMethod: "Virement",
      controlAccountId: account("441100").id, vatAccountId: account("345520").id, postedEntryId: purchaseEntry.id, postedAt: d("2026-05-29"),
      lines: { create: [{ position: 1, description: "Achats non stockés", accountId: account("612500").id, htCents: cents(13000), vatCents: cents(2600), ttcCents: cents(15600) }] },
    },
  });

  const legacyPaidInvoice = await prisma.invoice.create({
    data: {
      companyId: company.id, counterpartyId: party("Maroc Leasing").id,
      kind: "PURCHASE", counterparty: "Maroc Leasing", counterpartyNameSnapshot: "Maroc Leasing",
      ice: "000456777000011", iceSnapshot: "000456777000011", invoiceNo: "ML-2026-0081",
      numberKey: `PURCHASE:ml-2026-0081:LEGACY:${company.id}`, invoiceDate: d("2026-01-20"), dueDate: d("2026-03-20"), paymentDate: d("2026-05-02"),
      htCents: cents(184000), vatCents: cents(36800), ttcCents: cents(220800), status: "PAID_LATE", paymentMethod: "Prélèvement",
      lifecycleStatus: "LEGACY", legacyStatus: "PAID_LATE", source: "LEGACY_1_1", needsReview: true,
      reviewNote: "Paiement historique conservé sans preuve bancaire ni écriture liée.",
      lines: { create: [{ position: 1, description: "Solde historique importé", htCents: cents(184000), vatCents: cents(36800), ttcCents: cents(220800), isLegacySummary: true }] },
    },
  });

  const legacyPayment = await prisma.payment.create({
    data: {
      companyId: company.id, counterpartyId: party("Maroc Leasing").id, kind: "DISBURSEMENT", paymentDate: d("2026-05-02"),
      reference: "ML-2026-0081", method: "Prélèvement", amountCents: cents(220800), lifecycleStatus: "LEGACY", source: "LEGACY_1_1",
      notes: "Paiement historique sans preuve bancaire ni écriture liée.",
    },
  });
  await prisma.paymentAllocation.create({ data: { paymentId: legacyPayment.id, invoiceId: legacyPaidInvoice.id, amountCents: cents(220800) } });
  await prisma.invoiceSequence.create({ data: { companyId: company.id, series: "FA", year: 2026, nextNumber: 1288, padding: 6 } });

  const primaryBank = await prisma.bankAccount.create({
    data: {
      companyId: company.id,
      bankName: "BMCI - Compte principal",
      iban: "01178000012100000000",
      balanceCents: cents(3245680.45),
      ledgerAccountId: account("514100").id,
      balanceAsOf: d("2026-05-30"),
      balanceSource: "STATEMENT_CLOSING",
      movements: {
        create: [
          { date: d("2026-05-30"), label: "VIR GROUPE HORIZON FA-1287", amountCents: cents(18500), reference: "VIR-BMCI-156", status: "RECONCILED", confidence: 0, legacyConfidence: null },
          { date: d("2026-05-28"), label: "FRAIS BANCAIRES MAI 2026", amountCents: cents(-350), reference: "FB-05-2026", status: "UNRECONCILED", confidence: 0 },
          { date: d("2026-05-26"), label: "REGLEMENT TECH BURO FR-9876", amountCents: cents(-15600), reference: "FR-9876", status: "UNRECONCILED", confidence: 0 },
        ],
      },
    },
    include: { movements: true },
  });

  const receipt = await prisma.payment.create({
    data: {
      companyId: company.id,
      counterpartyId: party("Groupe Horizon Distribution").id,
      kind: "RECEIPT",
      paymentDate: d("2026-05-30"),
      reference: "VIR-BMCI-156",
      method: "Virement",
      amountCents: cents(18500),
      lifecycleStatus: "POSTED",
      source: "BANK",
      controlAccountId: account("342100").id,
      settlementAccountId: account("514100").id,
      bankAccountId: primaryBank.id,
      postedEntryId: bankEntry.id,
      postedAt: d("2026-05-30"),
    },
  });
  await prisma.paymentAllocation.create({ data: { paymentId: receipt.id, invoiceId: saleInvoice.id, amountCents: cents(18500) } });

  const incomingMovement = primaryBank.movements.find((movement) => movement.reference === "VIR-BMCI-156")!;
  const incomingBankLine = bankEntry.lines.find((line) => line.accountId === account("514100").id)!;
  await prisma.bankReconciliation.create({
    data: {
      companyId: company.id,
      bankMovementId: incomingMovement.id,
      status: "ACTIVE",
      note: "Rapprochement démontré avec preuve comptable exacte.",
      movementSnapshot: JSON.stringify({ date: "2026-05-30", reference: incomingMovement.reference, amountCents: incomingMovement.amountCents.toString(), label: incomingMovement.label }),
      allocations: { create: [{ entryLineId: incomingBankLine.id, amountCents: cents(18500) }] },
      paymentEvidence: { create: [{ paymentId: receipt.id, amountCents: cents(18500) }] },
    },
  });

  await prisma.bankAccount.createMany({
    data: [
      { companyId: company.id, bankName: "Attijariwafa bank", iban: "00778000023100000000", balanceCents: cents(2156234.12), ledgerAccountId: account("514200").id },
      { companyId: company.id, bankName: "CIH Bank", iban: "23078000034100000000", balanceCents: cents(1842107.35), ledgerAccountId: account("514300").id },
      { companyId: company.id, bankName: "Crédit Agricole", iban: "02278000045100000000", balanceCents: cents(1104299.75), ledgerAccountId: account("514400").id },
    ],
  });

  await prisma.taxPeriod.create({
    data: {
      companyId: company.id,
      label: "TVA Mai 2026",
      collectedVatCents: cents(4925140.75),
      deductibleVatCents: cents(3048720.57),
      dueVatCents: cents(1876420.18),
      creditVatCents: cents(231250),
      status: "TO_FILE",
      declarationDue: d("2026-06-20"),
    },
  });

  await prisma.document.createMany({
    data: [
      { companyId: company.id, title: "Facture Techno Bureau FR-9876.pdf", type: "Facture fournisseur", fiscalYear: "2026", tags: "achat,tva,ocr", ocrText: "Techno Bureau Maroc ICE 000894112000089 HT 13000 TVA 2600 TTC 15600", extracted: JSON.stringify({ supplier: "Techno Bureau Maroc", ice: "000894112000089", date: "2026-05-29", ht: 13000, vat: 2600, ttc: 15600 }), status: "EXTRACTED" },
      { companyId: company.id, title: "Relevé BMCI Mai 2026.xlsx", type: "Relevé bancaire", fiscalYear: "2026", tags: "banque,rapprochement", ocrText: "BMCI VIR GROUPE HORIZON FA-1287 FRAIS BANCAIRES", extracted: JSON.stringify({ bank: "BMCI", period: "Mai 2026", movements: 34 }), status: "LINKED" },
    ],
  });

  await prisma.employee.createMany({
    data: [
      { companyId: company.id, fullName: "Salma El Idrissi", cin: "BK245178", cnss: "183456789", position: "Comptable senior", grossSalaryCents: cents(12500), cnssEmployeeCents: cents(560), amoEmployeeCents: cents(275), irCents: cents(1450), netSalaryCents: cents(10215) },
      { companyId: company.id, fullName: "Yassine Berrada", cin: "BE339901", cnss: "284991001", position: "Assistant comptable", grossSalaryCents: cents(7200), cnssEmployeeCents: cents(322.56), amoEmployeeCents: cents(158.4), irCents: cents(475), netSalaryCents: cents(6244.04) },
      { companyId: company.id, fullName: "Nora Ait Lahcen", cin: "EE148520", cnss: "392810445", position: "Réviseur", grossSalaryCents: cents(9800), cnssEmployeeCents: cents(439.04), amoEmployeeCents: cents(215.6), irCents: cents(920), netSalaryCents: cents(8225.36) },
    ],
  });

  return company;
}

async function main() {
  // 1.4 compliance records are deliberately not synthesized for demo data:
  // configs, immutable artifacts, VAT workpapers, and close runs must originate
  // from the explicit user workflows that produce their evidence hashes.
  await prisma.vatWorkpaperEvidence.deleteMany();
  await prisma.vatWorkpaperAdjustment.deleteMany();
  await prisma.vatWorkpaperLine.deleteMany();
  await prisma.vatWorkpaper.deleteMany();
  await prisma.invoiceArtifact.deleteMany();
  await prisma.fiscalYear.updateMany({ data: { closeRunId: null } });
  await prisma.fiscalCloseRun.deleteMany();
  await prisma.auditSeal.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.auditChain.deleteMany();
  await prisma.fiscalTableEvidence.deleteMany();
  await prisma.fiscalTableWorkpaper.deleteMany();
  await prisma.fiscalAdjustment.deleteMany();
  await prisma.fiscalPackage.deleteMany();
  await prisma.wheatAiAuditEvent.deleteMany();
  await prisma.wheatKnowledgePattern.deleteMany();
  await prisma.wheatAiSettings.deleteMany();
  await prisma.ledgerImportRow.deleteMany();
  await prisma.ledgerImportBatch.deleteMany();
  await prisma.bankImportProfile.deleteMany();
  await prisma.bankReconciliationPaymentEvidence.deleteMany();
  await prisma.bankReconciliationAllocation.deleteMany();
  await prisma.bankReconciliation.deleteMany();
  await prisma.paymentAllocation.deleteMany();
  await prisma.document.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.taxRateDefinition.deleteMany();
  await prisma.taxConfigurationVersion.deleteMany();
  await prisma.counterparty.deleteMany();
  await prisma.invoiceSequence.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.companyUser.deleteMany();
  await prisma.user.deleteMany();
  await prisma.payrollRun.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.taxPeriod.deleteMany();
  await prisma.bankMovement.deleteMany();
  await prisma.bankStatementImport.deleteMany();
  await prisma.bankAccount.deleteMany();
  await prisma.entryLine.deleteMany();
  await prisma.entry.deleteMany();
  await prisma.journal.deleteMany();
  await prisma.account.deleteMany();
  await prisma.fiscalYear.deleteMany();
  await prisma.company.deleteMany();

  const user = await prisma.user.create({
    data: { name: "M. Amine B.", email: "amine@wheat.local", role: "ADMIN", twoFactorOn: true },
  });

  const argane = await seedCompany({
    name: "SOCIÉTÉ ARGANE SARL",
    legalForm: "SARL",
    ice: "001589742000063",
    taxId: "IF 48291073",
    city: "Casablanca",
  });

  const trading = await seedCompany({
    name: "MAGHREB TRADING",
    legalForm: "SARL AU",
    ice: "002741963000017",
    taxId: "IF 39048122",
    city: "Rabat",
  });

  await prisma.companyUser.createMany({
    data: [
      { companyId: argane.id, userId: user.id, role: "ADMIN" },
      { companyId: trading.id, userId: user.id, role: "ACCOUNTANT" },
    ],
  });

  await prisma.activityLog.createMany({
    data: [
      { companyId: argane.id, userId: user.id, action: "WORKSPACE_OPEN", entity: "Session", description: "Ouverture de l'espace comptable local" },
      { companyId: argane.id, userId: user.id, action: "VALIDATE_ENTRY", entity: "Entry", description: "Écriture VE-2026-000087 validée et auditée" },
      { companyId: argane.id, userId: user.id, action: "OCR_EXTRACT", entity: "Document", description: "Extraction OCR pour FR-9876 avec proposition d'écriture" },
      { companyId: argane.id, userId: user.id, action: "BACKUP_READY", entity: "Backup", description: "Sauvegarde complète locale prête à exporter" },
    ],
  });

  // Demo activity predates the first executable 1.3 audit write. Preserve it
  // exactly as migration-imported provenance: attributed but deliberately
  // unsealed, unhashed, and never presented as authenticated history.
  for (const company of [argane, trading]) {
    const legacyLogs = await prisma.activityLog.findMany({
      where: { companyId: company.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    await prisma.auditChain.create({
      data: {
        companyId: company.id,
        lastSequence: BigInt(legacyLogs.length),
        lastEventHash: null,
        events: {
          create: legacyLogs.map((log, index) => ({
            sequence: BigInt(index + 1),
            occurredAt: log.createdAt,
            actorUserId: log.userId,
            action: log.action,
            entityType: log.entity,
            entityId: log.entityId,
            payloadJson: JSON.stringify({
              description: log.description,
              legacyDetailsJson: log.detailsJson,
            }),
            previousHash: null,
            eventHash: null,
            integrityStatus: "IMPORTED_UNSEALED",
            legacyActivityLogId: log.id,
          })),
        },
      },
    });
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
