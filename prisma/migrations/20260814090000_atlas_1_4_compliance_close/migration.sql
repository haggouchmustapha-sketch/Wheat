-- Atlas Ledger 1.4 compliance evidence, credit-note artifacts, and fiscal close.
-- Existing money-bearing invoice and allocation tables are extended in place:
-- no legacy amount, link, audit event, or lifecycle claim is rewritten.

ALTER TABLE "PaymentAllocation" ADD COLUMN "reversalAccountingDate" DATETIME;

-- Existing seals remain honest local seals. They are not marked verified and no
-- historical purpose or payload digest is invented by this migration.
ALTER TABLE "AuditSeal" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "AuditSeal" ADD COLUMN "payloadSha256" TEXT;
ALTER TABLE "AuditSeal" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "AuditSeal" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "AuditSeal" ADD COLUMN "verificationNote" TEXT;

CREATE TABLE "TaxConfigurationVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "accountingBasis" TEXT NOT NULL,
    "filingFrequency" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "sourceReference" TEXT,
    "payloadSha256" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "retiredAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "TaxConfigurationVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TaxConfigurationVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "TaxConfigurationVersion_companyId_status_effectiveFrom_idx" ON "TaxConfigurationVersion"("companyId", "status", "effectiveFrom");
CREATE INDEX "TaxConfigurationVersion_createdByUserId_createdAt_idx" ON "TaxConfigurationVersion"("createdByUserId", "createdAt");
CREATE UNIQUE INDEX "TaxConfigurationVersion_companyId_lineageKey_revision_key" ON "TaxConfigurationVersion"("companyId", "lineageKey", "revision");

CREATE TABLE "TaxRateDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taxConfigurationVersionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "accountId" TEXT,
    "deductibilityBps" INTEGER NOT NULL DEFAULT 10000,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "TaxRateDefinition_taxConfigurationVersionId_fkey" FOREIGN KEY ("taxConfigurationVersionId") REFERENCES "TaxConfigurationVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TaxRateDefinition_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TaxRateDefinition_accountId_idx" ON "TaxRateDefinition"("accountId");
CREATE UNIQUE INDEX "TaxRateDefinition_taxConfigurationVersionId_code_key" ON "TaxRateDefinition"("taxConfigurationVersionId", "code");
CREATE UNIQUE INDEX "TaxRateDefinition_taxConfigurationVersionId_position_key" ON "TaxRateDefinition"("taxConfigurationVersionId", "position");

-- Neutral defaults classify existing rows as ordinary invoices without claiming
-- that a legacy invoice used a known tax configuration or immutable artifact.
ALTER TABLE "Invoice" ADD COLUMN "documentType" TEXT NOT NULL DEFAULT 'INVOICE';
ALTER TABLE "Invoice" ADD COLUMN "creditedInvoiceId" TEXT REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD COLUMN "creditReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "taxConfigurationVersionId" TEXT REFERENCES "TaxConfigurationVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD COLUMN "artifactRequired" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Invoice_creditedInvoiceId_documentType_idx" ON "Invoice"("creditedInvoiceId", "documentType");
CREATE INDEX "Invoice_taxConfigurationVersionId_idx" ON "Invoice"("taxConfigurationVersionId");

ALTER TABLE "InvoiceLine" ADD COLUMN "creditedInvoiceLineId" TEXT REFERENCES "InvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD COLUMN "taxRateDefinitionId" TEXT REFERENCES "TaxRateDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD COLUMN "taxRateCodeSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "taxRateLabelSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "taxRateDirectionSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "taxConfigurationRevisionSnapshot" INTEGER;
CREATE INDEX "InvoiceLine_creditedInvoiceLineId_idx" ON "InvoiceLine"("creditedInvoiceLineId");
CREATE INDEX "InvoiceLine_taxRateDefinitionId_idx" ON "InvoiceLine"("taxRateDefinitionId");

CREATE TABLE "InvoiceArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'IMMUTABLE_PDF',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesArtifactId" TEXT,
    "pdfBytes" BLOB NOT NULL,
    "storedPath" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "byteSize" BIGINT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "InvoiceArtifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceArtifact_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceArtifact_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InvoiceArtifact_supersedesArtifactId_fkey" FOREIGN KEY ("supersedesArtifactId") REFERENCES "InvoiceArtifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvoiceArtifact_supersedesArtifactId_key" ON "InvoiceArtifact"("supersedesArtifactId");
CREATE INDEX "InvoiceArtifact_companyId_createdAt_idx" ON "InvoiceArtifact"("companyId", "createdAt");
CREATE INDEX "InvoiceArtifact_contentSha256_idx" ON "InvoiceArtifact"("contentSha256");
CREATE INDEX "InvoiceArtifact_payloadSha256_idx" ON "InvoiceArtifact"("payloadSha256");
CREATE UNIQUE INDEX "InvoiceArtifact_invoiceId_kind_revision_key" ON "InvoiceArtifact"("invoiceId", "kind", "revision");

-- The artifact row and its embedded bytes are append-only evidence. A later
-- rendering is a new revision linked through supersedesArtifactId.
CREATE TRIGGER "InvoiceArtifact_immutable_update"
BEFORE UPDATE ON "InvoiceArtifact"
WHEN OLD."immutable" = true
BEGIN
  SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be updated; append a revision instead.');
END;
CREATE TRIGGER "InvoiceArtifact_immutable_delete"
BEFORE DELETE ON "InvoiceArtifact"
WHEN OLD."immutable" = true
BEGIN
  SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be deleted.');
END;

CREATE TABLE "VatWorkpaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taxConfigurationVersionId" TEXT NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesWorkpaperId" TEXT,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "basisSnapshot" TEXT NOT NULL,
    "frequencySnapshot" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "evidenceSha256" TEXT,
    "collectedVatCents" BIGINT NOT NULL DEFAULT 0,
    "deductibleVatCents" BIGINT NOT NULL DEFAULT 0,
    "adjustmentVatCents" BIGINT NOT NULL DEFAULT 0,
    "netVatDueCents" BIGINT NOT NULL DEFAULT 0,
    "creditCarryforwardCents" BIGINT NOT NULL DEFAULT 0,
    "preparedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedByUserId" TEXT,
    "filedAt" DATETIME,
    "filedByUserId" TEXT,
    "filingReference" TEXT,
    "filingReceiptDocumentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VatWorkpaper_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaper_taxConfigurationVersionId_fkey" FOREIGN KEY ("taxConfigurationVersionId") REFERENCES "TaxConfigurationVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaper_supersedesWorkpaperId_fkey" FOREIGN KEY ("supersedesWorkpaperId") REFERENCES "VatWorkpaper" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaper_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaper_filedByUserId_fkey" FOREIGN KEY ("filedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaper_filingReceiptDocumentId_fkey" FOREIGN KEY ("filingReceiptDocumentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VatWorkpaper_supersedesWorkpaperId_key" ON "VatWorkpaper"("supersedesWorkpaperId");
CREATE INDEX "VatWorkpaper_companyId_periodStart_periodEnd_status_idx" ON "VatWorkpaper"("companyId", "periodStart", "periodEnd", "status");
CREATE INDEX "VatWorkpaper_taxConfigurationVersionId_idx" ON "VatWorkpaper"("taxConfigurationVersionId");
CREATE INDEX "VatWorkpaper_reviewedByUserId_reviewedAt_idx" ON "VatWorkpaper"("reviewedByUserId", "reviewedAt");
CREATE INDEX "VatWorkpaper_filedByUserId_filedAt_idx" ON "VatWorkpaper"("filedByUserId", "filedAt");
CREATE INDEX "VatWorkpaper_filingReceiptDocumentId_idx" ON "VatWorkpaper"("filingReceiptDocumentId");
CREATE UNIQUE INDEX "VatWorkpaper_companyId_lineageKey_revision_key" ON "VatWorkpaper"("companyId", "lineageKey", "revision");

CREATE TABLE "VatWorkpaperLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workpaperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventDate" DATETIME NOT NULL,
    "invoiceId" TEXT,
    "invoiceLineId" TEXT,
    "paymentAllocationId" TEXT,
    "direction" TEXT NOT NULL,
    "taxRateCodeSnapshot" TEXT NOT NULL,
    "taxRateLabelSnapshot" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "taxableCents" BIGINT NOT NULL,
    "vatCents" BIGINT NOT NULL,
    "grossCents" BIGINT NOT NULL,
    "eligibility" TEXT NOT NULL DEFAULT 'INCLUDED',
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatWorkpaperLine_workpaperId_fkey" FOREIGN KEY ("workpaperId") REFERENCES "VatWorkpaper" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaperLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaperLine_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaperLine_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "PaymentAllocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "VatWorkpaperLine_invoiceId_idx" ON "VatWorkpaperLine"("invoiceId");
CREATE INDEX "VatWorkpaperLine_invoiceLineId_idx" ON "VatWorkpaperLine"("invoiceLineId");
CREATE INDEX "VatWorkpaperLine_paymentAllocationId_idx" ON "VatWorkpaperLine"("paymentAllocationId");
CREATE UNIQUE INDEX "VatWorkpaperLine_workpaperId_position_key" ON "VatWorkpaperLine"("workpaperId", "position");
CREATE UNIQUE INDEX "VatWorkpaperLine_workpaperId_eventKey_key" ON "VatWorkpaperLine"("workpaperId", "eventKey");

CREATE TABLE "VatWorkpaperAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workpaperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "taxableCents" BIGINT NOT NULL DEFAULT 0,
    "vatCents" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceDocumentId" TEXT,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatWorkpaperAdjustment_workpaperId_fkey" FOREIGN KEY ("workpaperId") REFERENCES "VatWorkpaper" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaperAdjustment_evidenceDocumentId_fkey" FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "VatWorkpaperAdjustment_evidenceDocumentId_idx" ON "VatWorkpaperAdjustment"("evidenceDocumentId");
CREATE UNIQUE INDEX "VatWorkpaperAdjustment_workpaperId_position_key" ON "VatWorkpaperAdjustment"("workpaperId", "position");

CREATE TABLE "VatWorkpaperEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workpaperId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "contentSha256Snapshot" TEXT NOT NULL,
    "byteSizeSnapshot" BIGINT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatWorkpaperEvidence_workpaperId_fkey" FOREIGN KEY ("workpaperId") REFERENCES "VatWorkpaper" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VatWorkpaperEvidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "VatWorkpaperEvidence_documentId_idx" ON "VatWorkpaperEvidence"("documentId");
CREATE UNIQUE INDEX "VatWorkpaperEvidence_workpaperId_documentId_role_key" ON "VatWorkpaperEvidence"("workpaperId", "documentId", "role");

CREATE TABLE "FiscalCloseRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "cutoffAt" DATETIME NOT NULL,
    "checksJson" TEXT NOT NULL,
    "checksSha256" TEXT NOT NULL,
    "reason" TEXT,
    "actorUserId" TEXT,
    "auditSealId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "FiscalCloseRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FiscalCloseRun_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FiscalCloseRun_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FiscalCloseRun_auditSealId_fkey" FOREIGN KEY ("auditSealId") REFERENCES "AuditSeal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FiscalCloseRun_auditSealId_key" ON "FiscalCloseRun"("auditSealId");
CREATE INDEX "FiscalCloseRun_companyId_status_createdAt_idx" ON "FiscalCloseRun"("companyId", "status", "createdAt");
CREATE INDEX "FiscalCloseRun_actorUserId_createdAt_idx" ON "FiscalCloseRun"("actorUserId", "createdAt");
CREATE UNIQUE INDEX "FiscalCloseRun_fiscalYearId_sequence_key" ON "FiscalCloseRun"("fiscalYearId", "sequence");

-- Existing closed fiscal years remain legacy close claims: all new close and
-- actor fields are null until a user runs the explicit 1.4 close workflow.
ALTER TABLE "FiscalYear" ADD COLUMN "closedAt" DATETIME;
ALTER TABLE "FiscalYear" ADD COLUMN "closedByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FiscalYear" ADD COLUMN "closeRunId" TEXT REFERENCES "FiscalCloseRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FiscalYear" ADD COLUMN "reopenedAt" DATETIME;
ALTER TABLE "FiscalYear" ADD COLUMN "reopenedByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FiscalYear" ADD COLUMN "reopenReason" TEXT;
CREATE UNIQUE INDEX "FiscalYear_closeRunId_key" ON "FiscalYear"("closeRunId");
