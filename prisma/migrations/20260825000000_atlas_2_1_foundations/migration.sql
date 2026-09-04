-- Atlas Ledger 2.1.0: additive PCGE, numbering, reporting, fiscal and local-AI foundations.
-- Existing accounts and entries remain untouched and are classified as custom/legacy by defaults.

ALTER TABLE "Account" ADD COLUMN "labelArabic" TEXT;
ALTER TABLE "Account" ADD COLUMN "parentCode" TEXT;
ALTER TABLE "Account" ADD COLUMN "hierarchyDepth" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Account" ADD COLUMN "isStandard" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'CUSTOM';
ALTER TABLE "Account" ADD COLUMN "reportNature" TEXT;
ALTER TABLE "Account" ADD COLUMN "auxiliaryEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "expectedBalance" TEXT NOT NULL DEFAULT 'VARIABLE';
ALTER TABLE "Account" ADD COLUMN "reportingMappingsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Account" ADD COLUMN "fiscalMappingsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Account" ADD COLUMN "effectiveFrom" DATETIME;
ALTER TABLE "Account" ADD COLUMN "effectiveTo" DATETIME;
ALTER TABLE "Account" ADD COLUMN "standardVersion" TEXT;
ALTER TABLE "Account" ADD COLUMN "postable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Account" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Journal" ADD COLUMN "piecePrefix" TEXT;
ALTER TABLE "Journal" ADD COLUMN "piecePattern" TEXT NOT NULL DEFAULT '{journal}-{year}-{sequence}';
ALTER TABLE "Journal" ADD COLUMN "pieceYearFormat" TEXT NOT NULL DEFAULT 'YYYY';
ALTER TABLE "Journal" ADD COLUMN "piecePadding" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "Journal" ADD COLUMN "pieceSeparator" TEXT NOT NULL DEFAULT '-';
ALTER TABLE "Journal" ADD COLUMN "allowManualPieceOverride" BOOLEAN NOT NULL DEFAULT false;
-- Preserve legacy manual piece workflows while new journals remain secure by default.
UPDATE "Journal" SET "allowManualPieceOverride" = true;

ALTER TABLE "Entry" ADD COLUMN "pieceNumberRaw" TEXT;
ALTER TABLE "Entry" ADD COLUMN "pieceNumberSearch" TEXT;
ALTER TABLE "Entry" ADD COLUMN "pieceSequenceNo" INTEGER;
ALTER TABLE "Entry" ADD COLUMN "pieceFiscalYearId" TEXT;

ALTER TABLE "BankStatementImport" ADD COLUMN "canonicalSchemaVersion" TEXT NOT NULL DEFAULT 'ATLAS_BANK_1';
ALTER TABLE "BankStatementImport" ADD COLUMN "validationJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "BankMovement" ADD COLUMN "operationDateRaw" TEXT;
ALTER TABLE "BankMovement" ADD COLUMN "valueDateRaw" TEXT;
ALTER TABLE "BankMovement" ADD COLUMN "dateInferred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BankMovement" ADD COLUMN "rowClass" TEXT NOT NULL DEFAULT 'TRANSACTION';
ALTER TABLE "BankMovement" ADD COLUMN "sourcePage" INTEGER;
ALTER TABLE "BankMovement" ADD COLUMN "rawJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "BankMovement" ADD COLUMN "confidenceJson" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "JournalPieceSequence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "journalId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "nextNumber" INTEGER NOT NULL DEFAULT 1,
  "lastIssued" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalPieceSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "JournalPieceSequence_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "JournalPieceSequence_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OpeningBalanceRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "sourceFiscalYearId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "sourceKind" TEXT NOT NULL DEFAULT 'PREVIOUS_CLOSE',
  "retainedEarningsAccountCode" TEXT,
  "differenceCents" BIGINT NOT NULL DEFAULT 0,
  "warningsJson" TEXT NOT NULL DEFAULT '[]',
  "postedEntryId" TEXT,
  "createdByUserId" TEXT,
  "validatedAt" DATETIME,
  "postedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpeningBalanceRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OpeningBalanceRun_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OpeningBalanceLine" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "accountCodeSnapshot" TEXT NOT NULL,
  "accountLabelSnapshot" TEXT NOT NULL,
  "debitCents" BIGINT NOT NULL DEFAULT 0,
  "creditCents" BIGINT NOT NULL DEFAULT 0,
  "sourceBalanceCents" BIGINT NOT NULL DEFAULT 0,
  "carryForward" BOOLEAN NOT NULL DEFAULT true,
  "warning" TEXT,
  "position" INTEGER NOT NULL,
  CONSTRAINT "OpeningBalanceLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OpeningBalanceRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OpeningBalanceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReportConfiguration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "reportType" TEXT NOT NULL,
  "variant" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "mappingVersion" TEXT NOT NULL,
  "mappingJson" TEXT NOT NULL DEFAULT '{}',
  "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "sourceCitation" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReportConfiguration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FiscalPackage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "regime" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "accountingProfitCents" BIGINT NOT NULL DEFAULT 0,
  "taxableProfitCents" BIGINT NOT NULL DEFAULT 0,
  "validationJson" TEXT NOT NULL DEFAULT '[]',
  "sourceJson" TEXT NOT NULL DEFAULT '{}',
  "generatedAt" DATETIME,
  "lockedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalPackage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FiscalPackage_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FiscalAdjustment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "fiscalPackageId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "legalReference" TEXT,
  "evidenceJson" TEXT NOT NULL DEFAULT '[]',
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalAdjustment_fiscalPackageId_fkey" FOREIGN KEY ("fiscalPackageId") REFERENCES "FiscalPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AtlasAiSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "permissionMode" TEXT NOT NULL DEFAULT 'ASSISTANT',
  "selectedTier" TEXT,
  "selectedModelId" TEXT,
  "modelManifestVersion" TEXT,
  "runtimeVersion" TEXT,
  "hardwareProfileJson" TEXT NOT NULL DEFAULT '{}',
  "benchmarkJson" TEXT NOT NULL DEFAULT '{}',
  "lastHealthCheckAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtlasAiSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AtlasAiAuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "sessionId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "permissionMode" TEXT NOT NULL,
  "requestJson" TEXT NOT NULL,
  "resultSummaryJson" TEXT NOT NULL,
  "confirmationJson" TEXT,
  "status" TEXT NOT NULL,
  "durationMs" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtlasAiAuditEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AtlasKnowledgePattern" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "valueJson" TEXT NOT NULL,
  "evidenceJson" TEXT NOT NULL DEFAULT '[]',
  "confidenceBps" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtlasKnowledgePattern_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Account_companyId_parentCode_active_idx" ON "Account"("companyId", "parentCode", "active");
CREATE INDEX "Account_companyId_isStandard_postable_idx" ON "Account"("companyId", "isStandard", "postable");
CREATE INDEX "Entry_companyId_journalId_pieceNumber_idx" ON "Entry"("companyId", "journalId", "pieceNumber");
CREATE UNIQUE INDEX "JournalPieceSequence_journalId_fiscalYearId_key" ON "JournalPieceSequence"("journalId", "fiscalYearId");
CREATE INDEX "JournalPieceSequence_companyId_fiscalYearId_idx" ON "JournalPieceSequence"("companyId", "fiscalYearId");
CREATE INDEX "OpeningBalanceRun_companyId_fiscalYearId_status_idx" ON "OpeningBalanceRun"("companyId", "fiscalYearId", "status");
CREATE UNIQUE INDEX "OpeningBalanceLine_runId_position_key" ON "OpeningBalanceLine"("runId", "position");
CREATE INDEX "OpeningBalanceLine_accountId_idx" ON "OpeningBalanceLine"("accountId");
CREATE UNIQUE INDEX "ReportConfiguration_companyId_reportType_variant_templateVersion_key" ON "ReportConfiguration"("companyId", "reportType", "variant", "templateVersion");
CREATE INDEX "ReportConfiguration_companyId_reportType_active_idx" ON "ReportConfiguration"("companyId", "reportType", "active");
CREATE UNIQUE INDEX "FiscalPackage_companyId_fiscalYearId_regime_templateVersion_key" ON "FiscalPackage"("companyId", "fiscalYearId", "regime", "templateVersion");
CREATE INDEX "FiscalPackage_companyId_fiscalYearId_status_idx" ON "FiscalPackage"("companyId", "fiscalYearId", "status");
CREATE INDEX "FiscalAdjustment_fiscalPackageId_kind_idx" ON "FiscalAdjustment"("fiscalPackageId", "kind");
CREATE UNIQUE INDEX "AtlasAiSettings_companyId_key" ON "AtlasAiSettings"("companyId");
CREATE INDEX "AtlasAiAuditEvent_companyId_createdAt_idx" ON "AtlasAiAuditEvent"("companyId", "createdAt");
CREATE INDEX "AtlasAiAuditEvent_sessionId_createdAt_idx" ON "AtlasAiAuditEvent"("sessionId", "createdAt");
CREATE UNIQUE INDEX "AtlasKnowledgePattern_companyId_kind_key_key" ON "AtlasKnowledgePattern"("companyId", "kind", "key");
CREATE INDEX "AtlasKnowledgePattern_companyId_kind_active_idx" ON "AtlasKnowledgePattern"("companyId", "kind", "active");
