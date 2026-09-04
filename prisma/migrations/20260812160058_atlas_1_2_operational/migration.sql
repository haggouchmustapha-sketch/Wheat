-- Atlas Ledger 1.2 operational accounting migration.
-- Existing invoice and bank-match rows are retained as reviewable legacy
-- evidence. This migration deliberately does not infer general-ledger links.
-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN "detailsJson" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "entityId" TEXT;

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "ice" TEXT,
    "taxId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "identityKey" TEXT NOT NULL,
    "defaultReceivableAccountId" TEXT,
    "defaultPayableAccountId" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Counterparty_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Counterparty_defaultReceivableAccountId_fkey" FOREIGN KEY ("defaultReceivableAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Counterparty_defaultPayableAccountId_fkey" FOREIGN KEY ("defaultPayableAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Create stable local counterparties without losing the exact frozen identity
-- on each legacy invoice. ICE wins when present; otherwise the normalized name
-- is used. Empty identities remain isolated per invoice.
WITH "normalized_legacy_parties" AS (
  SELECT
    "id" AS "invoiceId",
    "companyId",
    CASE
      WHEN length(trim(coalesce("ice", ''))) > 0
        THEN 'ICE:' || lower(replace(replace(replace(trim("ice"), ' ', ''), '-', ''), '.', ''))
      WHEN length(trim(coalesce("counterparty", ''))) > 0
        THEN 'LEGACY_NAME:' || lower(trim("counterparty"))
      ELSE 'LEGACY_INVOICE:' || "id"
    END AS "identityKey",
    CASE WHEN length(trim(coalesce("counterparty", ''))) > 0
      THEN trim("counterparty") ELSE 'Tiers sans nom' END AS "displayName",
    nullif(trim(coalesce("ice", '')), '') AS "ice",
    "kind"
  FROM "Invoice"
), "grouped_legacy_parties" AS (
  SELECT
    'legacy-cp-' || min("invoiceId") AS "id",
    "companyId",
    "identityKey",
    max("displayName") AS "displayName",
    max("ice") AS "ice",
    CASE
      WHEN sum(CASE WHEN upper("kind") IN ('SALE', 'SALES', 'VENTE') THEN 1 ELSE 0 END) > 0
       AND sum(CASE WHEN upper("kind") IN ('PURCHASE', 'PURCHASES', 'ACHAT') THEN 1 ELSE 0 END) > 0 THEN 'BOTH'
      WHEN sum(CASE WHEN upper("kind") IN ('SALE', 'SALES', 'VENTE') THEN 1 ELSE 0 END) > 0 THEN 'CUSTOMER'
      ELSE 'SUPPLIER'
    END AS "kind"
  FROM "normalized_legacy_parties"
  GROUP BY "companyId", "identityKey"
)
INSERT INTO "Counterparty" (
  "id", "companyId", "kind", "displayName", "ice", "identityKey",
  "paymentTermsDays", "active", "version", "createdAt", "updatedAt"
)
SELECT "id", "companyId", "kind", "displayName", "ice", "identityKey",
       30, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "grouped_legacy_parties";

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'FA',
    "year" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    CONSTRAINT "InvoiceSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "accountId" TEXT,
    "quantityMilli" BIGINT,
    "unitPriceCents" BIGINT,
    "discountCents" BIGINT NOT NULL DEFAULT 0,
    "vatRateBps" INTEGER,
    "htCents" BIGINT NOT NULL DEFAULT 0,
    "vatCents" BIGINT NOT NULL DEFAULT 0,
    "ttcCents" BIGINT NOT NULL DEFAULT 0,
    "isLegacySummary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InvoiceLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paymentDate" DATETIME NOT NULL,
    "reference" TEXT,
    "method" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "amountCents" BIGINT NOT NULL DEFAULT 0 CHECK ("amountCents" >= 0),
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("lifecycleStatus" IN ('DRAFT', 'POSTED', 'VOIDED', 'LEGACY')),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "controlAccountId" TEXT,
    "settlementAccountId" TEXT,
    "bankAccountId" TEXT,
    "postedEntryId" TEXT,
    "voidEntryId" TEXT,
    "postedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Payment_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_controlAccountId_fkey" FOREIGN KEY ("controlAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_settlementAccountId_fkey" FOREIGN KEY ("settlementAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_postedEntryId_fkey" FOREIGN KEY ("postedEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" > 0),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'REVERSED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" DATETIME,
    "reversalReason" TEXT,
    CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceStoredPath" TEXT,
    "sourceSha256" TEXT NOT NULL,
    "startsOn" DATETIME,
    "endsOn" DATETIME,
    "openingBalanceCents" BIGINT,
    "closingBalanceCents" BIGINT,
    "rowCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'VOIDED')),
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    CONSTRAINT "BankStatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankReconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "bankMovementId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'VOIDED')),
    "note" TEXT,
    "movementSnapshot" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedByUserId" TEXT,
    "voidedAt" DATETIME,
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "BankReconciliation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankReconciliation_bankMovementId_fkey" FOREIGN KEY ("bankMovementId") REFERENCES "BankMovement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankReconciliationAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reconciliationId" TEXT NOT NULL,
    "entryLineId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" > 0),
    CONSTRAINT "BankReconciliationAllocation_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "BankReconciliation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankReconciliationAllocation_entryLineId_fkey" FOREIGN KEY ("entryLineId") REFERENCES "EntryLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankReconciliationPaymentEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reconciliationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" > 0),
    CONSTRAINT "BankReconciliationPaymentEvidence_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "BankReconciliation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankReconciliationPaymentEvidence_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LocalAppSecurity" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pinSalt" TEXT,
    "pinHash" TEXT,
    "pinKeyLength" INTEGER NOT NULL DEFAULT 64,
    "idleMinutes" INTEGER NOT NULL DEFAULT 15,
    "lockOnStartup" BOOLEAN NOT NULL DEFAULT false,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "LocalAppSecurity" ("id", "enabled", "idleMinutes", "lockOnStartup", "updatedAt")
VALUES ('local', false, 15, false, CURRENT_TIMESTAMP);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "ledgerAccountId" TEXT,
    "balanceAsOf" DATETIME,
    "balanceSource" TEXT NOT NULL DEFAULT 'LEGACY_ESTIMATE',
    CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BankAccount_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BankAccount" ("balanceCents", "bankName", "companyId", "currency", "iban", "id") SELECT "balanceCents", "bankName", "companyId", "currency", "iban", "id" FROM "BankAccount";
DROP TABLE "BankAccount";
ALTER TABLE "new_BankAccount" RENAME TO "BankAccount";
UPDATE "BankAccount"
SET "ledgerAccountId" = (
  SELECT "Account"."id"
  FROM "Account"
  WHERE "Account"."companyId" = "BankAccount"."companyId"
    AND "Account"."code" LIKE '514%'
  LIMIT 1
)
WHERE (
  SELECT count(*) FROM "BankAccount" AS "companyBanks"
  WHERE "companyBanks"."companyId" = "BankAccount"."companyId"
) = 1
AND (
  SELECT count(*) FROM "Account"
  WHERE "Account"."companyId" = "BankAccount"."companyId"
    AND "Account"."code" LIKE '514%'
) = 1;
CREATE UNIQUE INDEX "BankAccount_ledgerAccountId_key" ON "BankAccount"("ledgerAccountId");
CREATE TABLE "new_BankMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL CHECK ("amountCents" <> 0),
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "statementId" TEXT,
    "statementRow" INTEGER,
    "valueDate" DATETIME,
    "externalId" TEXT,
    "fingerprint" TEXT,
    "legacyMatchClaimed" BOOLEAN NOT NULL DEFAULT false,
    "legacyConfidence" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "excludedAt" DATETIME,
    "exclusionReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankMovement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankMovement_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatementImport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BankMovement" (
  "amountCents", "bankAccountId", "confidence", "date", "id", "label", "reference", "status",
  "legacyMatchClaimed", "legacyConfidence", "createdAt", "updatedAt"
)
SELECT
  "amountCents", "bankAccountId", 0, "date", "id", "label", "reference",
  CASE WHEN upper("status") = 'MATCHED' THEN 'REVIEW_REQUIRED' ELSE 'UNMATCHED' END,
  CASE WHEN upper("status") = 'MATCHED' THEN true ELSE false END,
  "confidence", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "BankMovement";
DROP TABLE "BankMovement";
ALTER TABLE "new_BankMovement" RENAME TO "BankMovement";
CREATE INDEX "BankMovement_bankAccountId_date_idx" ON "BankMovement"("bankAccountId", "date");
CREATE INDEX "BankMovement_statementId_date_idx" ON "BankMovement"("statementId", "date");
CREATE INDEX "BankMovement_bankAccountId_fingerprint_idx" ON "BankMovement"("bankAccountId", "fingerprint");
CREATE UNIQUE INDEX "BankMovement_statementId_statementRow_key" ON "BankMovement"("statementId", "statementRow");
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "entryId" TEXT,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "storedPath" TEXT,
    "ocrText" TEXT NOT NULL,
    "extracted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TO_REVIEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Document_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("companyId", "createdAt", "entryId", "extracted", "fiscalYear", "id", "ocrText", "status", "storedPath", "tags", "title", "type") SELECT "companyId", "createdAt", "entryId", "extracted", "fiscalYear", "id", "ocrText", "status", "storedPath", "tags", "title", "type" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE TABLE "new_EntryLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "thirdParty" TEXT,
    "counterpartyId" TEXT,
    CONSTRAINT "EntryLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EntryLine_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_EntryLine" ("accountId", "creditCents", "debitCents", "entryId", "id", "label", "thirdParty") SELECT "accountId", "creditCents", "debitCents", "entryId", "id", "label", "thirdParty" FROM "EntryLine";
DROP TABLE "EntryLine";
ALTER TABLE "new_EntryLine" RENAME TO "EntryLine";
CREATE INDEX "EntryLine_counterpartyId_idx" ON "EntryLine"("counterpartyId");
CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "ice" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" DATETIME NOT NULL,
    "dueDate" DATETIME NOT NULL,
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
    CONSTRAINT "Invoice_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" (
  "companyId", "counterparty", "dueDate", "htCents", "ice", "id", "invoiceDate", "invoiceNo",
  "kind", "paymentDate", "paymentMethod", "status", "ttcCents", "vatCents", "counterpartyId",
  "numberKey", "currency", "counterpartyNameSnapshot", "iceSnapshot", "lifecycleStatus",
  "legacyStatus", "source", "needsReview", "reviewNote", "version", "createdAt", "updatedAt"
)
SELECT
  "legacyInvoice"."companyId", "legacyInvoice"."counterparty", "legacyInvoice"."dueDate",
  "legacyInvoice"."htCents", "legacyInvoice"."ice", "legacyInvoice"."id",
  "legacyInvoice"."invoiceDate", "legacyInvoice"."invoiceNo", "legacyInvoice"."kind",
  "legacyInvoice"."paymentDate", "legacyInvoice"."paymentMethod", "legacyInvoice"."status",
  "legacyInvoice"."ttcCents", "legacyInvoice"."vatCents",
  (
    SELECT "Counterparty"."id"
    FROM "Counterparty"
    WHERE "Counterparty"."companyId" = "legacyInvoice"."companyId"
      AND "Counterparty"."identityKey" = CASE
        WHEN length(trim(coalesce("legacyInvoice"."ice", ''))) > 0
          THEN 'ICE:' || lower(replace(replace(replace(trim("legacyInvoice"."ice"), ' ', ''), '-', ''), '.', ''))
        WHEN length(trim(coalesce("legacyInvoice"."counterparty", ''))) > 0
          THEN 'LEGACY_NAME:' || lower(trim("legacyInvoice"."counterparty"))
        ELSE 'LEGACY_INVOICE:' || "legacyInvoice"."id"
      END
    LIMIT 1
  ),
  CASE
    WHEN upper("legacyInvoice"."kind") IN ('SALE', 'SALES', 'VENTE') THEN 'SALE:'
    ELSE 'PURCHASE:'
  END || lower(trim(coalesce("legacyInvoice"."invoiceNo", ''))) || ':LEGACY:' || "legacyInvoice"."id",
  'MAD', "legacyInvoice"."counterparty", "legacyInvoice"."ice", 'LEGACY',
  "legacyInvoice"."status", 'LEGACY_1_1', true,
  'Importée depuis Atlas 1.1 — non liée au grand livre.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Invoice" AS "legacyInvoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_postedEntryId_key" ON "Invoice"("postedEntryId");
CREATE UNIQUE INDEX "Invoice_voidEntryId_key" ON "Invoice"("voidEntryId");
CREATE INDEX "Invoice_companyId_kind_invoiceDate_idx" ON "Invoice"("companyId", "kind", "invoiceDate");
CREATE INDEX "Invoice_companyId_lifecycleStatus_dueDate_idx" ON "Invoice"("companyId", "lifecycleStatus", "dueDate");
CREATE INDEX "Invoice_counterpartyId_dueDate_idx" ON "Invoice"("counterpartyId", "dueDate");
CREATE UNIQUE INDEX "Invoice_companyId_numberKey_key" ON "Invoice"("companyId", "numberKey");

-- Preserve every legacy total as a single immutable summary line. No account,
-- quantity, VAT rate, or journal entry is guessed during migration.
INSERT INTO "InvoiceLine" (
  "id", "invoiceId", "position", "description", "htCents", "vatCents", "ttcCents", "isLegacySummary"
)
SELECT 'legacy-line-' || "id", "id", 1, 'Solde importé Atlas 1.1',
       "htCents", "vatCents", "ttcCents", true
FROM "Invoice";

-- A legacy payment is created only when Atlas 1.1 stored an actual payment
-- date. This preserves paid aging without inventing bank or ledger evidence.
INSERT INTO "Payment" (
  "id", "companyId", "counterpartyId", "kind", "paymentDate", "reference", "method", "currency",
  "amountCents", "lifecycleStatus", "source", "notes", "version", "createdAt", "updatedAt"
)
SELECT
  'legacy-payment-' || "id", "companyId", "counterpartyId",
  CASE WHEN upper("kind") IN ('SALE', 'SALES', 'VENTE') THEN 'RECEIPT' ELSE 'DISBURSEMENT' END,
  "paymentDate", "invoiceNo", coalesce(nullif(trim("paymentMethod"), ''), 'LEGACY'), 'MAD',
  "ttcCents", 'LEGACY', 'LEGACY_1_1',
  'Paiement importé sans preuve bancaire ni écriture liée.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Invoice"
WHERE "paymentDate" IS NOT NULL
  AND "ttcCents" > 0
  AND "counterpartyId" IS NOT NULL
  AND upper("kind") IN ('SALE', 'SALES', 'VENTE', 'PURCHASE', 'PURCHASES', 'ACHAT');

INSERT INTO "PaymentAllocation" (
  "id", "paymentId", "invoiceId", "amountCents", "status", "createdAt"
)
SELECT 'legacy-allocation-' || "Invoice"."id", 'legacy-payment-' || "Invoice"."id",
       "Invoice"."id", "Invoice"."ttcCents", 'ACTIVE', CURRENT_TIMESTAMP
FROM "Invoice"
WHERE "Invoice"."paymentDate" IS NOT NULL
  AND "Invoice"."ttcCents" > 0
  AND "Invoice"."counterpartyId" IS NOT NULL
  AND upper("Invoice"."kind") IN ('SALE', 'SALES', 'VENTE', 'PURCHASE', 'PURCHASES', 'ACHAT');
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Counterparty_companyId_displayName_idx" ON "Counterparty"("companyId", "displayName");

-- CreateIndex
CREATE INDEX "Counterparty_companyId_kind_active_idx" ON "Counterparty"("companyId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Counterparty_companyId_identityKey_key" ON "Counterparty"("companyId", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_companyId_series_year_key" ON "InvoiceSequence"("companyId", "series", "year");

-- CreateIndex
CREATE INDEX "InvoiceLine_accountId_idx" ON "InvoiceLine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_postedEntryId_key" ON "Payment"("postedEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_voidEntryId_key" ON "Payment"("voidEntryId");

-- CreateIndex
CREATE INDEX "Payment_companyId_lifecycleStatus_paymentDate_idx" ON "Payment"("companyId", "lifecycleStatus", "paymentDate");

-- CreateIndex
CREATE INDEX "Payment_counterpartyId_paymentDate_idx" ON "Payment"("counterpartyId", "paymentDate");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_status_idx" ON "PaymentAllocation"("paymentId", "status");

-- CreateIndex
CREATE INDEX "PaymentAllocation_invoiceId_status_idx" ON "PaymentAllocation"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "BankStatementImport_bankAccountId_endsOn_idx" ON "BankStatementImport"("bankAccountId", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementImport_bankAccountId_sourceSha256_key" ON "BankStatementImport"("bankAccountId", "sourceSha256");

-- CreateIndex
CREATE INDEX "BankReconciliation_bankMovementId_status_confirmedAt_idx" ON "BankReconciliation"("bankMovementId", "status", "confirmedAt");

-- CreateIndex
CREATE INDEX "BankReconciliation_companyId_confirmedAt_idx" ON "BankReconciliation"("companyId", "confirmedAt");

-- CreateIndex
CREATE INDEX "BankReconciliationAllocation_entryLineId_idx" ON "BankReconciliationAllocation"("entryLineId");

-- CreateIndex
CREATE UNIQUE INDEX "BankReconciliationAllocation_reconciliationId_entryLineId_key" ON "BankReconciliationAllocation"("reconciliationId", "entryLineId");

-- CreateIndex
CREATE INDEX "BankReconciliationPaymentEvidence_paymentId_idx" ON "BankReconciliationPaymentEvidence"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "BankReconciliationPaymentEvidence_reconciliationId_paymentId_key" ON "BankReconciliationPaymentEvidence"("reconciliationId", "paymentId");
