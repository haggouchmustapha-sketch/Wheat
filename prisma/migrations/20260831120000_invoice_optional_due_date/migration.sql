-- OCR invoices may have no printed due date and no known counterparty terms.
-- Keep that absence as NULL instead of fabricating invoiceDate + 0 days.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "ice" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" DATETIME NOT NULL,
    "dueDate" DATETIME,
    "paymentDate" DATETIME,
    "htCents" BIGINT NOT NULL,
    "vatCents" BIGINT NOT NULL,
    "ttcCents" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "paymentMethod" TEXT,
    "counterpartyId" TEXT,
    "numberKey" TEXT,
    "series" TEXT,
    "sequenceYear" INTEGER,
    "sequenceNo" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "counterpartyNameSnapshot" TEXT,
    "iceSnapshot" TEXT,
    "taxIdSnapshot" TEXT,
    "billingAddressSnapshot" TEXT,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'LEGACY',
    "legacyStatus" TEXT,
    "source" TEXT NOT NULL DEFAULT 'LEGACY_1_1',
    "notes" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT true,
    "reviewNote" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'INVOICE',
    "creditedInvoiceId" TEXT,
    "creditReason" TEXT,
    "taxConfigurationVersionId" TEXT,
    "artifactRequired" BOOLEAN NOT NULL DEFAULT false,
    "controlAccountId" TEXT,
    "vatAccountId" TEXT,
    "postedEntryId" TEXT,
    "voidEntryId" TEXT,
    "postedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_controlAccountId_fkey" FOREIGN KEY ("controlAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_vatAccountId_fkey" FOREIGN KEY ("vatAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_postedEntryId_fkey" FOREIGN KEY ("postedEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_taxConfigurationVersionId_fkey" FOREIGN KEY ("taxConfigurationVersionId") REFERENCES "TaxConfigurationVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Invoice" (
    "artifactRequired", "billingAddressSnapshot", "companyId", "controlAccountId", "counterparty", "counterpartyId",
    "counterpartyNameSnapshot", "createdAt", "creditReason", "creditedInvoiceId", "currency", "documentType", "dueDate",
    "htCents", "ice", "iceSnapshot", "id", "invoiceDate", "invoiceNo", "kind", "legacyStatus", "lifecycleStatus",
    "needsReview", "notes", "numberKey", "paymentDate", "paymentMethod", "postedAt", "postedEntryId", "reviewNote",
    "sequenceNo", "sequenceYear", "series", "source", "status", "taxConfigurationVersionId", "taxIdSnapshot", "ttcCents",
    "updatedAt", "vatAccountId", "vatCents", "version", "voidEntryId", "voidReason", "voidedAt"
)
SELECT
    "artifactRequired", "billingAddressSnapshot", "companyId", "controlAccountId", "counterparty", "counterpartyId",
    "counterpartyNameSnapshot", "createdAt", "creditReason", "creditedInvoiceId", "currency", "documentType", "dueDate",
    "htCents", "ice", "iceSnapshot", "id", "invoiceDate", "invoiceNo", "kind", "legacyStatus", "lifecycleStatus",
    "needsReview", "notes", "numberKey", "paymentDate", "paymentMethod", "postedAt", "postedEntryId", "reviewNote",
    "sequenceNo", "sequenceYear", "series", "source", "status", "taxConfigurationVersionId", "taxIdSnapshot", "ttcCents",
    "updatedAt", "vatAccountId", "vatCents", "version", "voidEntryId", "voidReason", "voidedAt"
FROM "Invoice";

DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_postedEntryId_key" ON "Invoice"("postedEntryId");
CREATE UNIQUE INDEX "Invoice_voidEntryId_key" ON "Invoice"("voidEntryId");
CREATE INDEX "Invoice_companyId_kind_invoiceDate_idx" ON "Invoice"("companyId", "kind", "invoiceDate");
CREATE INDEX "Invoice_companyId_lifecycleStatus_dueDate_idx" ON "Invoice"("companyId", "lifecycleStatus", "dueDate");
CREATE INDEX "Invoice_counterpartyId_dueDate_idx" ON "Invoice"("counterpartyId", "dueDate");
CREATE INDEX "Invoice_creditedInvoiceId_documentType_idx" ON "Invoice"("creditedInvoiceId", "documentType");
CREATE INDEX "Invoice_taxConfigurationVersionId_idx" ON "Invoice"("taxConfigurationVersionId");
CREATE UNIQUE INDEX "Invoice_companyId_numberKey_key" ON "Invoice"("companyId", "numberKey");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
