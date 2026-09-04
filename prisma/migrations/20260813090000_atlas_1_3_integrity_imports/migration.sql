-- Atlas Ledger 1.3 accounting integrity and auditable import foundation.
-- Historical journal/account labels are snapshotted deterministically. Legacy
-- ActivityLog rows are copied as explicitly unsealed events: no hash or actor
-- authentication is invented for activity that predates the 1.3 chain.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Optimistic-concurrency versions and lifecycle flags.
ALTER TABLE "Company" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "FiscalYear" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Account" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Journal" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Journal" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "BankAccount" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "BankAccount" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Managed-document content metadata is nullable for pre-1.3 files because SQL
-- cannot honestly infer bytes, MIME types, or digests from a filesystem path.
ALTER TABLE "Document" ADD COLUMN "contentSha256" TEXT;
ALTER TABLE "Document" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "Document" ADD COLUMN "byteSize" BIGINT;

-- Entry headers keep the journal code as it existed at creation/posting time.
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
    "journalCodeSnapshot" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Entry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Entry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Entry" (
    "id", "companyId", "journalId", "number", "date", "pieceNumber", "label",
    "status", "source", "auditNote", "postedAt", "reversedAt", "reversalOfId",
    "journalCodeSnapshot", "version", "createdAt", "updatedAt"
)
SELECT
    e."id", e."companyId", e."journalId", e."number", e."date", e."pieceNumber", e."label",
    e."status", e."source", e."auditNote", e."postedAt", e."reversedAt", e."reversalOfId",
    (SELECT j."code" FROM "Journal" j WHERE j."id" = e."journalId"),
    1, e."createdAt", e."updatedAt"
FROM "Entry" e;
DROP TABLE "Entry";
ALTER TABLE "new_Entry" RENAME TO "Entry";
CREATE UNIQUE INDEX "Entry_companyId_number_key" ON "Entry"("companyId", "number");
CREATE INDEX "Entry_companyId_date_status_idx" ON "Entry"("companyId", "date", "status");
CREATE INDEX "Entry_journalId_date_idx" ON "Entry"("journalId", "date");
CREATE INDEX "Entry_reversalOfId_idx" ON "Entry"("reversalOfId");

-- Line positions are 1-based and backfilled by stable id order because 1.2 did
-- not persist an ordering column. Account snapshots come from the linked row.
CREATE TABLE "new_EntryLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "thirdParty" TEXT,
    "counterpartyId" TEXT,
    "position" INTEGER NOT NULL,
    "accountCodeSnapshot" TEXT NOT NULL,
    "accountLabelSnapshot" TEXT NOT NULL,
    CONSTRAINT "EntryLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EntryLine_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
WITH "ranked_lines" AS (
    SELECT
        el."id", el."entryId", el."accountId", el."label", el."debitCents",
        el."creditCents", el."thirdParty", el."counterpartyId",
        ROW_NUMBER() OVER (PARTITION BY el."entryId" ORDER BY el."id") AS "position",
        (SELECT a."code" FROM "Account" a WHERE a."id" = el."accountId") AS "accountCodeSnapshot",
        (SELECT a."label" FROM "Account" a WHERE a."id" = el."accountId") AS "accountLabelSnapshot"
    FROM "EntryLine" el
)
INSERT INTO "new_EntryLine" (
    "id", "entryId", "accountId", "label", "debitCents", "creditCents",
    "thirdParty", "counterpartyId", "position", "accountCodeSnapshot", "accountLabelSnapshot"
)
SELECT
    "id", "entryId", "accountId", "label", "debitCents", "creditCents",
    "thirdParty", "counterpartyId", "position", "accountCodeSnapshot", "accountLabelSnapshot"
FROM "ranked_lines";
DROP TABLE "EntryLine";
ALTER TABLE "new_EntryLine" RENAME TO "EntryLine";
CREATE UNIQUE INDEX "EntryLine_entryId_position_key" ON "EntryLine"("entryId", "position");
CREATE INDEX "EntryLine_counterpartyId_idx" ON "EntryLine"("counterpartyId");
CREATE INDEX "EntryLine_accountId_entryId_idx" ON "EntryLine"("accountId", "entryId");

-- Payroll posting and voiding are distinct immutable ledger links.
CREATE TABLE "new_PayrollRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedEntryId" TEXT,
    "voidEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PayrollRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PayrollRun_postedEntryId_fkey" FOREIGN KEY ("postedEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PayrollRun_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "Entry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PayrollRun" (
    "id", "companyId", "period", "status", "postedEntryId", "voidEntryId",
    "createdAt", "postedAt", "voidedAt", "voidReason", "version"
)
SELECT
    "id", "companyId", "period", "status", "postedEntryId", NULL,
    "createdAt", "postedAt", NULL, NULL, 1
FROM "PayrollRun";
DROP TABLE "PayrollRun";
ALTER TABLE "new_PayrollRun" RENAME TO "PayrollRun";
CREATE UNIQUE INDEX "PayrollRun_postedEntryId_key" ON "PayrollRun"("postedEntryId");
CREATE UNIQUE INDEX "PayrollRun_voidEntryId_key" ON "PayrollRun"("voidEntryId");
CREATE UNIQUE INDEX "PayrollRun_companyId_period_key" ON "PayrollRun"("companyId", "period");
CREATE INDEX "PayrollRun_companyId_status_period_idx" ON "PayrollRun"("companyId", "status", "period");

-- Generic ledger import staging retains both the source row and normalized
-- draft projection; imported rows are never silently promoted to posted data.
CREATE TABLE "LedgerImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceStoredPath" TEXT,
    "sourceSha256" TEXT NOT NULL,
    "mappingJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STAGED',
    "actorUserId" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    CONSTRAINT "LedgerImportBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerImportBatch_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "LedgerImportRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "rawJson" TEXT NOT NULL,
    "normalizedJson" TEXT,
    "fingerprint" TEXT NOT NULL,
    "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "validationError" TEXT,
    "draftEntryId" TEXT,
    CONSTRAINT "LedgerImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "LedgerImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerImportRow_draftEntryId_fkey" FOREIGN KEY ("draftEntryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "BankImportProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "name" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL DEFAULT 'CSV',
    "mappingJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankImportProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BankImportProfile_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hash-chain storage. A seal is a local integrity checkpoint, not a digital
-- signature and not proof that the selected local actor was authenticated.
CREATE TABLE "AuditChain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'SHA256',
    "lastSequence" BIGINT NOT NULL DEFAULT 0,
    "lastEventHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuditChain_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "previousHash" TEXT,
    "eventHash" TEXT,
    "integrityStatus" TEXT NOT NULL DEFAULT 'CHAINED',
    "legacyActivityLogId" TEXT,
    CONSTRAINT "AuditEvent_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "AuditChain" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AuditSeal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "fromSequence" BIGINT NOT NULL,
    "throughSequence" BIGINT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "rootHash" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'SHA256',
    "sealedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "note" TEXT,
    CONSTRAINT "AuditSeal_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "AuditChain" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuditSeal_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Every existing company receives a chain. Pre-1.3 rows have NULL hashes and
-- IMPORTED_UNSEALED status by design; ordering is deterministic by date then id.
INSERT INTO "AuditChain" (
    "id", "companyId", "algorithm", "lastSequence", "lastEventHash", "createdAt", "updatedAt"
)
SELECT
    'audit-chain-' || c."id",
    c."id",
    'SHA256',
    (SELECT COUNT(*) FROM "ActivityLog" l WHERE l."companyId" = c."id"),
    NULL,
    c."createdAt",
    CURRENT_TIMESTAMP
FROM "Company" c;

WITH "legacy_events" AS (
    SELECT
        l.*,
        ROW_NUMBER() OVER (PARTITION BY l."companyId" ORDER BY l."createdAt", l."id") AS "sequence"
    FROM "ActivityLog" l
)
INSERT INTO "AuditEvent" (
    "id", "chainId", "sequence", "occurredAt", "actorUserId", "action",
    "entityType", "entityId", "payloadJson", "previousHash", "eventHash",
    "integrityStatus", "legacyActivityLogId"
)
SELECT
    'audit-event-legacy-' || l."id",
    'audit-chain-' || l."companyId",
    l."sequence",
    l."createdAt",
    l."userId",
    l."action",
    l."entity",
    l."entityId",
    json_object('description', l."description", 'legacyDetailsJson', l."detailsJson"),
    NULL,
    NULL,
    'IMPORTED_UNSEALED',
    l."id"
FROM "legacy_events" l;

-- Stable query and uniqueness indexes.
CREATE INDEX "Company_name_idx" ON "Company"("name");
CREATE INDEX "FiscalYear_companyId_startsOn_endsOn_idx" ON "FiscalYear"("companyId", "startsOn", "endsOn");
CREATE INDEX "Account_companyId_active_classNo_idx" ON "Account"("companyId", "active", "classNo");
CREATE INDEX "Journal_companyId_active_idx" ON "Journal"("companyId", "active");
CREATE INDEX "BankAccount_companyId_active_idx" ON "BankAccount"("companyId", "active");
CREATE INDEX "Document_companyId_status_createdAt_idx" ON "Document"("companyId", "status", "createdAt");
CREATE INDEX "Document_companyId_contentSha256_idx" ON "Document"("companyId", "contentSha256");
CREATE INDEX "ActivityLog_companyId_createdAt_idx" ON "ActivityLog"("companyId", "createdAt");

CREATE UNIQUE INDEX "LedgerImportBatch_companyId_sourceSha256_key" ON "LedgerImportBatch"("companyId", "sourceSha256");
CREATE INDEX "LedgerImportBatch_companyId_status_importedAt_idx" ON "LedgerImportBatch"("companyId", "status", "importedAt");
CREATE INDEX "LedgerImportBatch_actorUserId_importedAt_idx" ON "LedgerImportBatch"("actorUserId", "importedAt");
CREATE INDEX "LedgerImportRow_draftEntryId_idx" ON "LedgerImportRow"("draftEntryId");
CREATE UNIQUE INDEX "LedgerImportRow_batchId_sourceRow_key" ON "LedgerImportRow"("batchId", "sourceRow");
CREATE INDEX "LedgerImportRow_batchId_fingerprint_idx" ON "LedgerImportRow"("batchId", "fingerprint");
CREATE INDEX "LedgerImportRow_batchId_validationStatus_idx" ON "LedgerImportRow"("batchId", "validationStatus");

CREATE UNIQUE INDEX "BankImportProfile_companyId_name_key" ON "BankImportProfile"("companyId", "name");
CREATE INDEX "BankImportProfile_companyId_active_idx" ON "BankImportProfile"("companyId", "active");
CREATE INDEX "BankImportProfile_bankAccountId_active_idx" ON "BankImportProfile"("bankAccountId", "active");

CREATE UNIQUE INDEX "AuditChain_companyId_key" ON "AuditChain"("companyId");
CREATE UNIQUE INDEX "AuditEvent_legacyActivityLogId_key" ON "AuditEvent"("legacyActivityLogId");
CREATE UNIQUE INDEX "AuditEvent_chainId_sequence_key" ON "AuditEvent"("chainId", "sequence");
CREATE INDEX "AuditEvent_chainId_occurredAt_idx" ON "AuditEvent"("chainId", "occurredAt");
CREATE INDEX "AuditEvent_chainId_entityType_entityId_idx" ON "AuditEvent"("chainId", "entityType", "entityId");
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx" ON "AuditEvent"("actorUserId", "occurredAt");
CREATE UNIQUE INDEX "AuditSeal_chainId_throughSequence_key" ON "AuditSeal"("chainId", "throughSequence");
CREATE INDEX "AuditSeal_chainId_sealedAt_idx" ON "AuditSeal"("chainId", "sealedAt");
CREATE INDEX "AuditSeal_actorUserId_sealedAt_idx" ON "AuditSeal"("actorUserId", "sealedAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
