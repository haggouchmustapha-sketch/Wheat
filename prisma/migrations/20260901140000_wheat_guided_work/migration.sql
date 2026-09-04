-- Guided work: the only two facts about a step that the ledger cannot show.
--
-- Progress itself stays derived from the dossier's own records. What a person
-- decided about a step — postponed it, or declared it inapplicable to this
-- dossier — is not visible in any account, invoice or document, so it is kept
-- here and nowhere else.
CREATE TABLE "GuidedStepDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" TEXT,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuidedStepDecision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GuidedStepDecision_companyId_stepId_key" ON "GuidedStepDecision"("companyId", "stepId");
CREATE INDEX "GuidedStepDecision_companyId_decidedAt_idx" ON "GuidedStepDecision"("companyId", "decidedAt");
