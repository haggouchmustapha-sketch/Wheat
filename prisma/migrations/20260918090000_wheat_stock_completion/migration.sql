-- Wheat stock: physical inventory, impairment, unit conversion.
--
-- The stock module's first migration created these tables against a design that
-- no service had yet exercised. Writing the services found three places where
-- the model could not express what the workflow actually needs:
--
--  - a campaign has to be able to cover the whole dossier, not one dépôt, and
--    its count rows then have to say which dépôt each count belongs to;
--  - an impairment has to record the quantity and the recoverable value the
--    accountant entered, not only the difference they imply, because the
--    difference alone cannot be audited back to a decision;
--  - a document line has to keep the unit the user worked in *and* the factor
--    that was in force, so that editing a conversion later cannot reprice a
--    movement that is already in the ledger.
--
-- The three tables rebuilt below are rebuilt because SQLite cannot relax a NOT
-- NULL column or replace a unique index in place. Rows are carried across, so a
-- dossier that already opened the module keeps whatever it holds; in practice
-- these tables are empty, because nothing reached them before this commit.
--
-- The rebuild needs foreign keys off, which the migration runner does for this
-- migration through `disablesForeignKeys` rather than through a PRAGMA here: a
-- PRAGMA inside the transaction the runner opens would be silently ignored.

-- ---------------------------------------------------------------------------
-- StockInventoryCampaign: warehouseId becomes nullable ("tous les dépôts"),
-- and the campaign records when its theoretical snapshot was frozen.
-- ---------------------------------------------------------------------------
CREATE TABLE "new_StockInventoryCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "warehouseId" TEXT,
    "countDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdByUserId" TEXT,
    "frozenAt" DATETIME,
    "closedAt" DATETIME,
    "closedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockInventoryCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StockInventoryCampaign" ("id", "companyId", "reference", "warehouseId", "countDate", "status", "note", "createdByUserId", "closedAt", "closedByUserId", "version", "createdAt", "updatedAt")
SELECT "id", "companyId", "reference", "warehouseId", "countDate", "status", "note", "createdByUserId", "closedAt", "closedByUserId", "version", "createdAt", "updatedAt" FROM "StockInventoryCampaign";
DROP TABLE "StockInventoryCampaign";
ALTER TABLE "new_StockInventoryCampaign" RENAME TO "StockInventoryCampaign";
CREATE INDEX "StockInventoryCampaign_companyId_status_idx" ON "StockInventoryCampaign"("companyId", "status");
CREATE UNIQUE INDEX "StockInventoryCampaign_companyId_reference_key" ON "StockInventoryCampaign"("companyId", "reference");

-- ---------------------------------------------------------------------------
-- StockInventoryCount: each count names its dépôt, and the unique that keeps a
-- campaign from holding two counts for one position widens to include it.
-- countedAt distinguishes "counted as zero" from "not counted yet", which the
-- variance report and the validation both have to treat differently. unitValue
-- carries a cost for goods found that the dossier holds none of: an excédent
-- entering an empty position has no existing value to be worth, and Wheat does
-- not invent one.
-- ---------------------------------------------------------------------------
CREATE TABLE "new_StockInventoryCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lotId" TEXT,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "locationId" TEXT,
    "expectedQuantity" BIGINT NOT NULL DEFAULT 0,
    "expectedValue" BIGINT NOT NULL DEFAULT 0,
    "countedQuantity" BIGINT,
    "countedAt" DATETIME,
    "unitValue" BIGINT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockInventoryCount_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StockInventoryCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StockInventoryCount" ("id", "campaignId", "articleId", "warehouseId", "lotId", "lotKey", "locationId", "expectedQuantity", "expectedValue", "countedQuantity", "note", "createdAt", "updatedAt")
SELECT "c"."id", "c"."campaignId", "c"."articleId", COALESCE("k"."warehouseId", ''), "c"."lotId", "c"."lotKey", "c"."locationId", "c"."expectedQuantity", "c"."expectedValue", "c"."countedQuantity", "c"."note", "c"."createdAt", "c"."updatedAt"
FROM "StockInventoryCount" "c"
LEFT JOIN "StockInventoryCampaign" "k" ON "k"."id" = "c"."campaignId";
DROP TABLE "StockInventoryCount";
ALTER TABLE "new_StockInventoryCount" RENAME TO "StockInventoryCount";
CREATE UNIQUE INDEX "StockInventoryCount_campaignId_warehouseId_articleId_lotKey_key" ON "StockInventoryCount"("campaignId", "warehouseId", "articleId", "lotKey");
CREATE INDEX "StockInventoryCount_campaignId_idx" ON "StockInventoryCount"("campaignId");

-- ---------------------------------------------------------------------------
-- StockUnitConversion gains a version and an active flag so a conversion can be
-- retired without deleting the row historical lines were written against.
-- ---------------------------------------------------------------------------
ALTER TABLE "StockUnitConversion" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StockUnitConversion" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- StockDocumentLine: quantity is what the user entered, in the line's own unit.
-- baseQuantity is that quantity in the article's base unit, and unitFactor is
-- the conversion that produced it — frozen here so that changing a conversion
-- later cannot reprice a movement already written.
--
-- Existing lines were all entered in the article's own unit, which is exactly
-- what a factor of 1 000 000 (1,000000) and baseQuantity = quantity say.
-- ---------------------------------------------------------------------------
ALTER TABLE "StockDocumentLine" ADD COLUMN "baseQuantity" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "StockDocumentLine" ADD COLUMN "unitFactor" BIGINT NOT NULL DEFAULT 1000000;
UPDATE "StockDocumentLine" SET "baseQuantity" = "quantity";

-- ---------------------------------------------------------------------------
-- StockImpairment records the decision, not only its result: the quantity held
-- and the recoverable value the accountant entered are what the amount was
-- derived from, and an amount whose inputs are gone cannot be audited.
-- ---------------------------------------------------------------------------
ALTER TABLE "StockImpairment" ADD COLUMN "quantity" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "StockImpairment" ADD COLUMN "recoverableValue" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "StockImpairment" ADD COLUMN "note" TEXT;
ALTER TABLE "StockImpairment" ADD COLUMN "supportingDocumentId" TEXT REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockImpairment_supportingDocumentId_idx" ON "StockImpairment"("supportingDocumentId");
