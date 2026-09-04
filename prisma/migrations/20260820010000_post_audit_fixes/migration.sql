-- Persist company-scoped Sage export profiles in the backed-up SQLite store.
CREATE TABLE "SageExportProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "profileType" TEXT NOT NULL,
    "outputKind" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,
    "includeHeader" BOOLEAN NOT NULL DEFAULT false,
    "accountLength" TEXT NOT NULL DEFAULT 'VARIABLE',
    "journalMappings" TEXT NOT NULL DEFAULT '{}',
    "accountMappings" TEXT NOT NULL DEFAULT '{}',
    "requireJournalMapping" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SageExportProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SageExportProfile_companyId_key" ON "SageExportProfile"("companyId");

-- A user can hold exactly one role in a company. Existing duplicate rows are
-- treated as integrity damage and make the transactional migration fail rather
-- than silently selecting one of potentially conflicting roles.
CREATE UNIQUE INDEX "CompanyUser_companyId_userId_key" ON "CompanyUser"("companyId", "userId");
