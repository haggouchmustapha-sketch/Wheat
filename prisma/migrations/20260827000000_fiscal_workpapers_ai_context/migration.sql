-- Atlas Ledger: normal-regime fiscal preparation workpapers and evidence.

CREATE TABLE "FiscalTableWorkpaper" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "fiscalPackageId" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "computedJson" TEXT NOT NULL DEFAULT '{}',
  "manualJson" TEXT NOT NULL DEFAULT '[]',
  "validationJson" TEXT NOT NULL DEFAULT '[]',
  "sourceHash" TEXT,
  "sourceSummaryJson" TEXT NOT NULL DEFAULT '{}',
  "notApplicableReason" TEXT,
  "reviewedAt" DATETIME,
  "reviewedByUserId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "FiscalTableWorkpaper_fiscalPackageId_fkey" FOREIGN KEY ("fiscalPackageId") REFERENCES "FiscalPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FiscalTableWorkpaper_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "FiscalTableEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workpaperId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'SUPPORT',
  "note" TEXT,
  "documentTitleSnapshot" TEXT NOT NULL,
  "contentSha256Snapshot" TEXT NOT NULL,
  "attachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalTableEvidence_workpaperId_fkey" FOREIGN KEY ("workpaperId") REFERENCES "FiscalTableWorkpaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FiscalTableEvidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FiscalTableWorkpaper_fiscalPackageId_tableId_key" ON "FiscalTableWorkpaper"("fiscalPackageId", "tableId");
CREATE INDEX "FiscalTableWorkpaper_fiscalPackageId_status_idx" ON "FiscalTableWorkpaper"("fiscalPackageId", "status");
CREATE INDEX "FiscalTableWorkpaper_reviewedByUserId_reviewedAt_idx" ON "FiscalTableWorkpaper"("reviewedByUserId", "reviewedAt");
CREATE UNIQUE INDEX "FiscalTableEvidence_workpaperId_documentId_role_key" ON "FiscalTableEvidence"("workpaperId", "documentId", "role");
CREATE INDEX "FiscalTableEvidence_documentId_idx" ON "FiscalTableEvidence"("documentId");
