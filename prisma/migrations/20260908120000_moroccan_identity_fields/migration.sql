-- Moroccan legal identity, currency and payroll-basis fields.
--
-- A compliant Moroccan invoice header carries ICE, IF, RC and patente. Wheat
-- stored only ICE and IF, so neither the issuing company's own header nor a
-- supplier's could be printed from stored data — the remaining identifiers had
-- to be typed into a document every time. The same identifiers are what the
-- TVA, IS and CNSS declarations key on, so they are prerequisites for every
-- filing feature rather than cosmetic header fields.
--
-- Every column is nullable, or carries the value that preserves today's
-- behaviour, because existing installations already hold dossiers, third
-- parties and invoices that were entered before these fields existed. Nothing
-- here invalidates a stored record or forces a backfill: a dossier missing an
-- RC keeps working exactly as it does now, and the fields surface as gaps to
-- fill rather than as errors.

-- Company: the issuer's own legal identity, plus the postal and contact detail
-- an invoice header and a declaration cover page need.
-- capitalCents is exact centimes like every other monetary column in Wheat.
ALTER TABLE "Company" ADD COLUMN "rc" TEXT;
ALTER TABLE "Company" ADD COLUMN "rcTribunal" TEXT;
ALTER TABLE "Company" ADD COLUMN "patente" TEXT;
ALTER TABLE "Company" ADD COLUMN "cnssAffiliation" TEXT;
ALTER TABLE "Company" ADD COLUMN "address" TEXT;
ALTER TABLE "Company" ADD COLUMN "phone" TEXT;
ALTER TABLE "Company" ADD COLUMN "email" TEXT;
ALTER TABLE "Company" ADD COLUMN "capitalCents" BIGINT;
ALTER TABLE "Company" ADD COLUMN "activitySector" TEXT;

-- Counterparty: the same identifiers for the other side of an invoice, plus the
-- bank identifier a payment file needs.
--
-- vatLiable defaults to 1 because every counterparty Wheat holds today has been
-- treated as VAT-liable by the existing invoice and workpaper paths; defaulting
-- to 0 would silently reclassify historical purchases as non-deductible.
-- defaultTaxRateCode names a TaxRateDefinition.code rather than referencing its
-- row, because tax configurations are versioned and superseded: a stored code
-- keeps resolving across revisions where a foreign key would pin one revision.
ALTER TABLE "Counterparty" ADD COLUMN "rc" TEXT;
ALTER TABLE "Counterparty" ADD COLUMN "patente" TEXT;
ALTER TABLE "Counterparty" ADD COLUMN "cnss" TEXT;
ALTER TABLE "Counterparty" ADD COLUMN "rib" TEXT;
ALTER TABLE "Counterparty" ADD COLUMN "vatLiable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Counterparty" ADD COLUMN "defaultTaxRateCode" TEXT;
ALTER TABLE "Counterparty" ADD COLUMN "exonerationReason" TEXT;

-- Invoice: foreign-currency operations and the VAT regime mention.
--
-- Invoice.currency already existed and defaulted to MAD, but with no rate and
-- no original-currency amounts a foreign invoice could not be held at both
-- values, which is why fiscal table 21 (opérations en devises) is keyed by hand
-- and the écart de change cannot be derived.
--
-- exchangeRate is TEXT holding an exact decimal string, not a float and not
-- basis points: a rate like 10.7852 needs more precision than bps allows, and
-- Wheat never puts a binary float near an accounting figure. This matches how
-- the table 21 catalog already types its "Cours" column.
--
-- The foreign amounts are the invoice as issued; the existing htCents/vatCents/
-- ttcCents remain the MAD booking values, so posting and reporting are
-- unaffected by their presence.
ALTER TABLE "Invoice" ADD COLUMN "exchangeRate" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "foreignHtCents" BIGINT;
ALTER TABLE "Invoice" ADD COLUMN "foreignVatCents" BIGINT;
ALTER TABLE "Invoice" ADD COLUMN "foreignTtcCents" BIGINT;
ALTER TABLE "Invoice" ADD COLUMN "exonerationReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "vatRegimeCode" TEXT;

-- Employee: the facts an IR and CNSS computation reads.
--
-- These are inputs to a calculation that does not exist yet — today every
-- payroll figure is typed in — so they are added ahead of the engine rather
-- than with it, to keep that change to computation alone.
--
-- dependents defaults to 0 rather than NULL so the charges-de-famille term is
-- always defined; 0 is also the value that reproduces today's hand-entered IR,
-- which applies no family deduction at all.
-- seniorityBaseOn is separate from hiredOn because transferred seniority and
-- reprise d'ancienneté make the ancienneté basis differ from the hire date.
ALTER TABLE "Employee" ADD COLUMN "hiredOn" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "maritalStatus" TEXT;
ALTER TABLE "Employee" ADD COLUMN "dependents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "contractType" TEXT;
ALTER TABLE "Employee" ADD COLUMN "cimrRateBps" INTEGER;
ALTER TABLE "Employee" ADD COLUMN "rib" TEXT;
ALTER TABLE "Employee" ADD COLUMN "seniorityBaseOn" DATETIME;
