-- Atlas Ledger 1.1 stores every MAD amount as integer centimes. SQLite's
-- ROUND() gives us a deterministic, one-time conversion from the legacy REAL
-- columns while preserving negative bank movements. The desktop migration
-- runner disables foreign-key enforcement before starting this transaction.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

ALTER TABLE "Company" ADD COLUMN "vatFrequency" TEXT NOT NULL DEFAULT 'MONTHLY';

CREATE TABLE "new_Entry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "pieceNumber" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "auditNote" TEXT,
    "postedAt" DATETIME,
    "reversedAt" DATETIME,
    "reversalOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Entry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Entry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Entry" ("id", "companyId", "journalId", "number", "date", "pieceNumber", "label", "status", "source", "auditNote", "postedAt", "createdAt", "updatedAt")
SELECT "id", "companyId", "journalId", "number", "date", "pieceNumber", "label",
       CASE
           WHEN "status" = 'VALIDATED' THEN 'POSTED'
           WHEN "status" = 'PENDING' THEN 'DRAFT'
           WHEN "status" IN ('DRAFT', 'POSTED', 'REVERSED') THEN "status"
           ELSE 'DRAFT'
       END,
       "source", "auditNote",
       CASE WHEN "status" IN ('VALIDATED', 'POSTED', 'REVERSED') THEN COALESCE("updatedAt", "createdAt") ELSE NULL END,
       "createdAt", "updatedAt"
FROM "Entry";
DROP TABLE "Entry";
ALTER TABLE "new_Entry" RENAME TO "Entry";
CREATE UNIQUE INDEX "Entry_companyId_number_key" ON "Entry"("companyId", "number");

CREATE TABLE "new_EntryLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "thirdParty" TEXT,
    CONSTRAINT "EntryLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_EntryLine" ("id", "entryId", "accountId", "label", "debitCents", "creditCents", "thirdParty")
SELECT "id", "entryId", "accountId", "label", CAST(ROUND("debit" * 100.0) AS INTEGER), CAST(ROUND("credit" * 100.0) AS INTEGER), "thirdParty"
FROM "EntryLine";
DROP TABLE "EntryLine";
ALTER TABLE "new_EntryLine" RENAME TO "EntryLine";

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
    CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" ("id", "companyId", "kind", "counterparty", "ice", "invoiceNo", "invoiceDate", "dueDate", "paymentDate", "htCents", "vatCents", "ttcCents", "status", "paymentMethod")
SELECT "id", "companyId", "kind", "counterparty", "ice", "invoiceNo", "invoiceDate", "dueDate", "paymentDate", CAST(ROUND("ht" * 100.0) AS INTEGER), CAST(ROUND("vat" * 100.0) AS INTEGER), CAST(ROUND("ttc" * 100.0) AS INTEGER), "status", "paymentMethod"
FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";

CREATE TABLE "new_BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BankAccount" ("id", "companyId", "bankName", "iban", "balanceCents", "currency")
SELECT "id", "companyId", "bankName", "iban", CAST(ROUND("balance" * 100.0) AS INTEGER), "currency" FROM "BankAccount";
DROP TABLE "BankAccount";
ALTER TABLE "new_BankAccount" RENAME TO "BankAccount";

CREATE TABLE "new_BankMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    CONSTRAINT "BankMovement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BankMovement" ("id", "bankAccountId", "date", "label", "amountCents", "reference", "status", "confidence")
SELECT "id", "bankAccountId", "date", "label", CAST(ROUND("amount" * 100.0) AS INTEGER), "reference", "status", "confidence" FROM "BankMovement";
DROP TABLE "BankMovement";
ALTER TABLE "new_BankMovement" RENAME TO "BankMovement";

CREATE TABLE "new_TaxPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "collectedVatCents" BIGINT NOT NULL,
    "deductibleVatCents" BIGINT NOT NULL,
    "dueVatCents" BIGINT NOT NULL,
    "creditVatCents" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "declarationDue" DATETIME NOT NULL,
    CONSTRAINT "TaxPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TaxPeriod" ("id", "companyId", "label", "collectedVatCents", "deductibleVatCents", "dueVatCents", "creditVatCents", "status", "declarationDue")
SELECT "id", "companyId", "label", CAST(ROUND("collectedVat" * 100.0) AS INTEGER), CAST(ROUND("deductibleVat" * 100.0) AS INTEGER), CAST(ROUND("dueVat" * 100.0) AS INTEGER), CAST(ROUND("creditVat" * 100.0) AS INTEGER), "status", "declarationDue" FROM "TaxPeriod";
DROP TABLE "TaxPeriod";
ALTER TABLE "new_TaxPeriod" RENAME TO "TaxPeriod";

CREATE TABLE "new_Employee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "cin" TEXT NOT NULL,
    "cnss" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "grossSalaryCents" BIGINT NOT NULL,
    "cnssEmployeeCents" BIGINT NOT NULL,
    "amoEmployeeCents" BIGINT NOT NULL,
    "irCents" BIGINT NOT NULL,
    "netSalaryCents" BIGINT NOT NULL,
    CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Employee" ("id", "companyId", "fullName", "cin", "cnss", "position", "grossSalaryCents", "cnssEmployeeCents", "amoEmployeeCents", "irCents", "netSalaryCents")
SELECT "id", "companyId", "fullName", "cin", "cnss", "position", CAST(ROUND("grossSalary" * 100.0) AS INTEGER), CAST(ROUND("cnssEmployee" * 100.0) AS INTEGER), CAST(ROUND("amoEmployee" * 100.0) AS INTEGER), CAST(ROUND("ir" * 100.0) AS INTEGER), CAST(ROUND("netSalary" * 100.0) AS INTEGER) FROM "Employee";
DROP TABLE "Employee";
ALTER TABLE "new_Employee" RENAME TO "Employee";

CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" DATETIME,
    CONSTRAINT "PayrollRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PayrollRun_postedEntryId_fkey" FOREIGN KEY ("postedEntryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayrollRun_postedEntryId_key" ON "PayrollRun"("postedEntryId");
CREATE UNIQUE INDEX "PayrollRun_companyId_period_key" ON "PayrollRun"("companyId", "period");

CREATE TABLE "PayrollRunLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT,
    "employeeName" TEXT NOT NULL,
    "cin" TEXT NOT NULL,
    "cnss" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "grossSalaryCents" BIGINT NOT NULL,
    "cnssEmployeeCents" BIGINT NOT NULL,
    "amoEmployeeCents" BIGINT NOT NULL,
    "irCents" BIGINT NOT NULL,
    "netSalaryCents" BIGINT NOT NULL,
    CONSTRAINT "PayrollRunLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PayrollRunLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PayrollRunLine_payrollRunId_idx" ON "PayrollRunLine"("payrollRunId");
CREATE INDEX "PayrollRunLine_employeeId_idx" ON "PayrollRunLine"("employeeId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
