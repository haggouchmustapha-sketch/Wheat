-- Atlas 1.3 originally treated a whole source file as one import identity.
-- A workbook may legitimately contain several ledgers, so source provenance
-- and selected evidence scope now have separate hashes. Existing 1.3 batches
-- receive an empty legacy marker; the service deterministically backfills that
-- marker from mappingJson plus the retained source rows before comparing it.
DROP INDEX IF EXISTS "LedgerImportBatch_companyId_sourceSha256_key";

ALTER TABLE "LedgerImportBatch" ADD COLUMN "scopeSha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LedgerImportBatch" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "LedgerImportBatch" ADD COLUMN "supersedesBatchId" TEXT;

CREATE UNIQUE INDEX "LedgerImportBatch_companyId_sourceSha256_scopeSha256_revision_key"
ON "LedgerImportBatch"("companyId", "sourceSha256", "scopeSha256", "revision");

CREATE INDEX "LedgerImportBatch_companyId_sourceSha256_scopeSha256_idx"
ON "LedgerImportBatch"("companyId", "sourceSha256", "scopeSha256");

-- A rejected/cancelled batch can have only one direct successor. This remains
-- a plain scalar rather than a self-FK so the forward migration is additive
-- and cannot disturb retained source rows on existing installations.
CREATE UNIQUE INDEX "LedgerImportBatch_supersedesBatchId_key"
ON "LedgerImportBatch"("supersedesBatchId");
