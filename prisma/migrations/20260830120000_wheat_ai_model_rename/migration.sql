-- Renames the three Wheat AI tables from their pre-rename "Atlas" names.
--
-- The rows are preserved: SQLite's ALTER TABLE ... RENAME TO keeps the data and
-- rewrites the foreign keys that reference these tables. Only the indexes need
-- recreating, because SQLite has no ALTER INDEX ... RENAME.
--
-- Historical audit rows are deliberately left untouched. AuditEvent.action is
-- covered by the SHA-256 audit chain, so rewriting stored "ATLAS_AI_*" action
-- strings would invalidate every company's chain.

ALTER TABLE "AtlasAiSettings" RENAME TO "WheatAiSettings";
ALTER TABLE "AtlasAiAuditEvent" RENAME TO "WheatAiAuditEvent";
ALTER TABLE "AtlasKnowledgePattern" RENAME TO "WheatKnowledgePattern";

DROP INDEX IF EXISTS "AtlasAiSettings_companyId_key";
DROP INDEX IF EXISTS "AtlasAiAuditEvent_companyId_createdAt_idx";
DROP INDEX IF EXISTS "AtlasAiAuditEvent_sessionId_createdAt_idx";
DROP INDEX IF EXISTS "AtlasKnowledgePattern_companyId_kind_key_key";
DROP INDEX IF EXISTS "AtlasKnowledgePattern_companyId_kind_active_idx";

CREATE UNIQUE INDEX "WheatAiSettings_companyId_key" ON "WheatAiSettings"("companyId");
CREATE INDEX "WheatAiAuditEvent_companyId_createdAt_idx" ON "WheatAiAuditEvent"("companyId", "createdAt");
CREATE INDEX "WheatAiAuditEvent_sessionId_createdAt_idx" ON "WheatAiAuditEvent"("sessionId", "createdAt");
CREATE UNIQUE INDEX "WheatKnowledgePattern_companyId_kind_key_key" ON "WheatKnowledgePattern"("companyId", "kind", "key");
CREATE INDEX "WheatKnowledgePattern_companyId_kind_active_idx" ON "WheatKnowledgePattern"("companyId", "kind", "active");
