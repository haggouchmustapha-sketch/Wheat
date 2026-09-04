# Wheat 1.4 release notes

Wheat 1.4 is the evidence-and-close release. It preserves the exact-cent books, bounded imports, reconciliation history, complete backup, and local audit chain from 1.3 while adding controlled invoice evidence, linked credits, collection-basis TVA workpapers, and fiscal close.

## Invoice evidence and linked credits

- Posting a normal sales or purchase invoice creates its balanced accounting entry and immutable PDF evidence inside one database transaction.
- The artifact stores a canonical payload, PDF bytes, payload SHA-256, content SHA-256, byte size, revision, actor, and linked invoice/entry identifiers. SQLite triggers reject updates and deletion of immutable artifacts outside the explicit whole-workspace maintenance path.
- Artifact verification re-hashes both the payload and PDF. Export is allowed only after verification.
- A credit note references one posted normal invoice and each credited original line. Amounts remain positive; posting creates the opposite debit/credit direction and does not misuse the technical entry-reversal relation.
- Credits can be partial, but active payments plus posted credits cannot exceed the original TTC. Each credited line is also capped independently for HT, TVA, and TTC.
- Sales credits receive a continuous Wheat sequence; supplier credits require their source reference. Posting reserves capacity, assigns numbers, creates the opposite entry, renders the artifact, and appends audit evidence atomically.
- Posted evidence is not technically voided or rewritten. Further commercial correction uses another linked credit within the remaining capacity.

## Versioned TVA workpapers

- Tax configurations are company-scoped, effective-dated revisions. An active revision is immutable and cannot overlap another active revision.
- Wheat requires the user to record the accounting basis, monthly or quarterly frequency, rule source, rates, collected/deductible direction, optional account mapping, and deductible percentage.
- Wheat 1.4 implements the collection basis only. Monthly and quarterly workpapers cover complete civil periods.
- Invoice lines snapshot the selected configuration revision and tax-rate identifiers/labels/direction when posted. A VAT-bearing invoice cannot post without a matching active configuration and exact computed tax.
- Workpapers reconstruct source events from posted payments and allocations, linked posted credits, accounting reversals, and reasoned adjustments. All money remains integer-cent text across the renderer boundary.
- Generation records a source hash. Regeneration is versioned; stale source evidence blocks review or external-filing recording until the workpaper is rebuilt.
- Adjustments require a reason and hashed managed document. Evidence attachment/removal is version checked.
- `Record filed` records a filing done outside Wheat and requires a hashed document manually classified as `FILING_RECEIPT`. Wheat performs no transmission.
- Reopening a filed workpaper creates a linked revision instead of rewriting the filed record.

## Fiscal close and integrity checkpoints

- Close preview performs deterministic checks for draft entries, imbalance, missing required invoice artifacts, unreviewed TVA periods, stale workpapers, unresolved import/reconciliation evidence, and other year blockers.
- The preview has a canonical check hash. Close re-runs every check inside the transaction and refuses a changed/stale hash.
- A successful close locks the fiscal year, persists a close run, and creates a local audit checkpoint. Reopen requires a reason, follows reverse close order, and preserves the original run.
- Local audit seals verify their covered audit-chain segment and report later chain advancement or tampering. They do not claim an external witness, qualified signature, trusted timestamp, or authority approval.

## Reporting and settlement corrections

- Aged receivables/payables subtract linked posted credits as of their accounting posting date.
- Reversed payment allocations use their explicit reversal accounting date at historical cutoffs.
- Invoice settlement reports payment allocations and credit reductions separately while retaining the compatible total-settled field.
- Integrity checks reject allocations to credits, invalid credit origins, missing required immutable artifacts, and invoices where payments plus credits exceed TTC.

## Migration and reset safety

- Migration: `20260814090000_atlas_1_4_compliance_close`.
- The upgrade is additive. Saved 1.3 databases were checked for table counts, exact 64-bit cent totals, operational links, audit sequences/hashes, SQLite integrity, and foreign keys.
- Existing invoices are preserved as normal invoices. Wheat does not invent tax configurations, workpapers, credits, artifacts, close runs, or authority evidence for historical data.
- Whole-workspace blank reset is the only controlled maintenance operation that temporarily removes immutable-artifact triggers. It deletes 1.4 relations in dependency order and recreates both triggers inside the same SQLite transaction.

## Verification performed

- Prisma validate/generate/status, schema diff, migration/reset/seed, TypeScript, ESLint, and production Vite/Electron build.
- Migration, immutable-artifact, credit-cap/concurrency, VAT source reconstruction, stale-workpaper, evidence, close/reopen, audit-seal, reporting, archive, security, OCR, and whole-app regression suites.
- A real Electron IPC flow posts a tax-versioned invoice, verifies its PDF, posts a partial linked credit, rejects payment beyond the remaining balance, runs integrity checks, performs blank reset, and validates the restored SQLite triggers, integrity, and foreign keys.

## Regulatory and product boundary

Wheat is local bookkeeping software, not a filing intermediary or certified authority system. The 1.4 behavior was designed against the Moroccan CGI 2026 concepts for collection-based TVA, monthly/quarterly periods, invoice evidence, and retention, but users remain responsible for verifying the law, their regime, rates, deductions, declaration format, and filing obligations with a qualified professional.

Wheat 1.4 does not:

- file a DGI declaration or connect to a certified electronic-invoicing API;
- support debit-basis TVA, withholding-tax automation, automatic legal updates, or every exemption/suspension case;
- calculate/certify payroll taxes, CNSS/AMO/IR, payslips, Damancom, or declarations;
- provide qualified signatures, trusted timestamps, external notarization, multi-user authorization, or encryption at rest;
- implement refunds, customer/supplier credit balances, inventory, complete ERP logistics, or multicurrency revaluation.

The app remains free software under GPL-3.0-or-later with no subscription or licence key. It is provided without warranty.

## Official references used for the 1.4 boundary

- [Code général des impôts 2026 — DGI/Ministère de l'Économie et des Finances](https://www.finances.gov.ma/Publication/dgi/2025/CGI-2026-FR.pdf)
- [Télédéclaration et télépaiement obligatoires — Ministère de l'Économie et des Finances](https://www.finances.gov.ma/fr/pages/detail-actualite.aspx?fiche=2291)
- [Téléservices fiscaux SIMPL — Ministère de l'Économie et des Finances](https://www.finances.gov.ma/fr/Pages/e-Services-et-formulaires.aspx)
- [Identifiant commun de l'entreprise — OMPIC](https://www.ompic.ma/fr/content/identifiant-commun-de-lentreprise)
- [Communiqué officiel de 2019 sur la suspension des mesures de facturation électronique — Ministère de l'Économie et des Finances](https://www.finances.gov.ma/fr/Pages/detail-actualite.aspx?fiche=2600)

These links are reference material, not a claim that Wheat implements, validates, or is approved for an official filing or electronic-invoicing interface. Check the latest official publications before operational use.
