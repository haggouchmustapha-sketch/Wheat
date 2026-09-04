-- Unfinished work: what somebody has typed and not yet submitted.
--
-- Deliberately its own table rather than a status on an accounting record. A
-- half-typed invoice is not an Invoice, and writing one into the ledger tables
-- to keep it safe would put a record nobody has decided on into the books —
-- a worse failure than the one this fixes, which is that leaving a screen used
-- to discard whatever had been typed into it.
--
-- Scoped by company and cascaded with it, so unfinished work in one dossier can
-- never surface in another and leaves when the dossier does. The unique key is
-- the draft's identity: two unfinished items in the same family — a purchase
-- invoice and a sale invoice, or edits to two different records — are two rows,
-- so neither can overwrite the other.
CREATE TABLE "FormDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "draftKey" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "baseVersion" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FormDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FormDraft_companyId_entity_draftKey_key" ON "FormDraft"("companyId", "entity", "draftKey");
CREATE INDEX "FormDraft_companyId_updatedAt_idx" ON "FormDraft"("companyId", "updatedAt");
