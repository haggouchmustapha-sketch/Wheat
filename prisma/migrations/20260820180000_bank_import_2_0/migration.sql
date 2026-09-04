-- Atlas Ledger 2.0 keeps one cross-format bank import history with review counts.
ALTER TABLE "BankStatementImport" ADD COLUMN "sourceFormat" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "BankStatementImport" ADD COLUMN "importedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BankStatementImport" ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BankStatementImport" ADD COLUMN "errorCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BankStatementImport" ADD COLUMN "duplicateCount" INTEGER NOT NULL DEFAULT 0;

-- Historical imports were fully atomic: their persisted row count is their imported count.
UPDATE "BankStatementImport" SET "importedCount" = "rowCount" WHERE "importedCount" = 0;
