# Wheat

Wheat is a Windows-first, local accounting desktop application for Moroccan small businesses, fiduciaires and accounting offices. It uses Electron, React, TypeScript, Prisma and SQLite. The packaged app keeps its accounting, OCR, reporting, reconciliation, tax-workpaper, import, backup and assistant workflows on the computer; none of them requires a cloud account or a subscription.

> Wheat is not certified by the DGI or another authority, and it does not replace review by a qualified Moroccan accounting or tax professional. See [Known limitations](#known-limitations).

## Wheat 2.0 highlights

Wheat 2.0 is an interface release: the accounting engine, tax rules, reconciliation, imports, exports, OCR behaviour and database meaning are unchanged, and no feature was removed.

- **A rebuilt interface.** A grouped navigation rail replaces the flat sidebar; every screen opens with a one-sentence statement of what it is for, a map of what lives on it, and a collapsed "how this works" explanation. Tables, cards, dialogs, filters, empty, loading and error states all come from one design system.
- **Understandable without accounting training.** Correct terminology is kept — *écriture*, *lettrage*, *extourne*, *liasse* — and explained in place, so a business owner or a new employee can follow a screen without a glossary.
- **Every feature stays visible.** All eighteen destinations keep their own labelled navigation entry, each with a plain-language description. Nothing moved into an unlabelled overflow menu; right-click menus only duplicate buttons that are already on screen.
- **One searchable dropdown everywhere.** Accounts, companies, journals, documents, counterparties, invoices, periods and models all use the same combobox with an integrated search bar, keyboard navigation, a visible focus ring, and explicit loading, error and no-result states.
- **A centralised Wheat design system.** Colour, typography, spacing, radii, borders, shadows, surfaces and every component state resolve through tokens in `src/styles/tokens.css`. Light and dark mode are both first-class, built from the official Wheat palette.
- **Wheat AI providers.** Alongside local models, Wheat AI can now use the free tiers of OpenRouter and Groq. Keys are encrypted by the operating system's own credential vault, never stored in plaintext and never returned to the interface. `Automatic — free models` ranks verified free models and fails over when one is rate-limited, exhausted or withdrawn.

The exact 2.0 implementation, evidence and known limits are recorded in [the Wheat 2.0 implementation report](docs/wheat-2/claude-implementation-report.md).

## Wheat 2.0 bank-import foundation retained

- Relevé bancaire imports support CSV, delimited TXT, XLSX, OFX, QIF, MT940, CAMT.053 XML, recognizable selectable-text PDF layouts, and scanned PDF tables through local PaddleOCR/PP-StructureV3.
- File selection never inserts movements immediately. Detection, mapping, bounded preview, validation, warnings/errors, duplicate review, explicit confirmation, atomic persistence, and an import report are separate steps.
- Exact file hashes block renamed copies. Deterministic transaction fingerprints flag overlapping/equivalent movements without silently suppressing legitimate repeats; accepting suspected duplicates requires an explicit checkbox.
- Import history records source format, row/import/skip/error/duplicate counts, account, and timestamp. Imported movements persist across full Electron restart and feed the existing reconciliation engine.
- French decimal/date formats, UTF-8/Windows-1252 text, signed Amount and separate Debit/Credit layouts are covered. A 1,000-row fixture keeps preview rendering bounded.
- Legacy binary XLS is read locally through pinned `xlrd 2.0.2`. Corrupt workbooks and ambiguous PDF/OCR layouts fail with actionable messages rather than guessed accounting data. Scanned PDFs proceed only when PaddleOCR recognizes a bank header with a date and monetary columns; every row still requires mapping, validation, duplicate review, and explicit confirmation.
- The main shell and bank-review dialog are regression-tested across gradual desktop/laptop resizing and 80–125% zoom without page-level overflow hiding.

The historical 2.0 runtime delta and format status are recorded in [the fix report](WHEAT_FIX_REPORT.md) and [feature matrix](WHEAT_FEATURE_MATRIX.md).

## Wheat 1.4 foundation

- Posting a normal invoice now atomically creates its balanced ledger entry and an immutable PDF evidence artifact. Both the canonical payload and PDF bytes are SHA-256 hashed; a render or persistence failure rolls back posting.
- Partial customer and supplier credit notes are linked to the original invoice and original lines. They use positive amounts, post an opposite accounting entry, receive their own continuous sequence and immutable PDF, and cannot exceed the unpaid/uncredited invoice capacity.
- Payments and aging reports treat posted credits as reductions of the open invoice balance. Active payments plus posted credits cannot exceed the original TTC.
- Tax configurations are explicit, versioned, effective-dated, and immutable after activation. Wheat 1.4 intentionally implements collection-basis workpapers only; users must enter and verify applicable rates, direction, deductibility, accounts, frequency, and source reference.
- TVA workpapers are rebuilt from local invoice, payment, allocation, credit, reversal, and adjustment evidence using exact integer centimes. Review, return, external-filing record, and reopen actions retain versions and hashes. Wheat never transmits a declaration.
- Fiscal-year close previews deterministic blockers, rechecks the preview hash inside the close transaction, locks the year, and records an audit checkpoint. Reopen is reasoned, reverse-order, and audit logged.
- Company-local audit seals verify a bounded segment of the existing SHA-256 chain. They are local integrity checkpoints, not electronic signatures, trusted timestamps, or authority certification.
- Filing receipts can be classified manually in the local document workspace and attached as hashed evidence after a filing performed outside Wheat.

Detailed changes are in the [Wheat 1.4 release notes](docs/wheat-1.4-release-notes.md).

### Trustworthy-books foundation retained from 1.3

- The entries book, trial balance, general ledger, journal, aged receivables/payables, counterparty statement, and integrity checks are produced from SQLite with exact integer-cent strings. Drafts are excluded from accounting books.
- Large books use stable, filter-bound cursors. XLSX and PDF actions walk every page before exporting and stop instead of presenting a partial page as a complete report.
- Excel/CSV ledger imports require an explicit column mapping and validate every row and every grouped entry. Wheat stages the source, preserves both source and selected-scope SHA-256 evidence, and creates only draft entries after confirmation. Different workbook scopes remain distinct; cancelled/reviewed scopes can be resumed only through an explicit linked revision. It never guesses balancing accounts, silently posts rows, or confirms the same evidence twice.
- Companies, fiscal years, accounts, journals, and bank accounts have version-checked maintenance workflows. Used historical codes are retained as snapshots; archived or locked references cannot be used for new posting, payments, imports, or reconciliation.
- Manual entry drafts can be corrected without rewriting posted history. Posted payroll runs can be corrected only through a linked, exact extourne with a reason.
- New operational changes append to a company-local SHA-256 audit chain. Pre-1.3 activity is explicitly imported as unsealed provenance with no fabricated hash. Chain verification detects local database tampering; it is not external notarization, a signature, or legal certification.
- Managed OCR documents store content SHA-256, MIME type, and byte size. Complete `.wheatbackup` (and the legacy `.atlasbackup`) archives also include referenced ledger-import source files and verify every managed file against its SQLite provenance before backup and after staged restore.
- Bootstrap data is bounded. Accounting books and Sage export use dedicated complete queries instead of assuming the dashboard snapshot contains the whole ledger.
- The Electron boundary uses one trusted app instance, validates the main renderer/frame for IPC, blocks popups/navigation/webviews/permissions, and ignores environment-controlled renderer or data paths in packaged builds.

The [Wheat 1.3 release notes](docs/wheat-1.3-release-notes.md) document the underlying books, controlled imports, audit chain, and hardened desktop boundary.

### Operational foundation retained from 1.2

- Customers and suppliers are persisted as counterparties, with stable identity keys and optional receivable/payable account defaults.
- Sales and purchase invoices follow an explicit lifecycle. Posting an invoice creates and posts its linked accounting entry; voiding a posted invoice creates a linked reversal instead of deleting history.
- Receipts and disbursements can be drafted, posted, allocated across invoices, and voided through reversal. Invoice balances and paid/overdue states are derived from active allocations on posted payments.
- Accounting amounts continue to use Prisma `BigInt` integer centimes. New subledger inputs accept exact decimal text and reject JavaScript floating-point numbers at the service boundary.
- Bank movements can be allocated partially or across several posted bank-ledger lines. Confirmed reconciliation batches retain their movement snapshot, allocations, optional payment evidence, actor, timestamp, and audit event. Voiding a batch preserves that history.
- Wheat 1.1 movements that merely claimed to be matched migrate to `REVIEW_REQUIRED`; Wheat does not invent accounting evidence for them.
- Manual backup now produces a `.wheatbackup` (and the legacy `.atlasbackup`) archive containing the SQLite database, referenced OCR attachments, and managed source bank statements. A SHA-256 manifest is verified before the archive is accepted.
- Restore is staged and validated before the live database is replaced. Complete archives restore their included attachments to a managed location and rewrite the restored document references. Legacy database-only SQLite backups remain importable.
- An optional local PIN lock can lock on startup, after inactivity, or manually. It uses a salted scrypt-derived verifier and throttles failed attempts. It is an app privacy screen, not encryption, Windows authentication, or multi-user authorization.

The [Wheat 1.2 release notes](docs/wheat-1.2-release-notes.md) document the underlying subledger, reconciliation, archive, and local-lock release.

## First use

On a fresh packaged installation:

1. Open Wheat.
2. Enter the first company's identity, fiscal year, and VAT frequency.
3. Select `Créer mon espace comptable`.
4. Review the starter journals and CGNC-oriented account plan before entering real records.
5. Map each bank account to the corresponding ledger account before reconciling statements.

To inspect sample workflows, select `Explorer une société exemple`. This replaces the current local workspace; it is not a second isolated company. Create and protect a `.wheatbackup` (and the legacy `.atlasbackup`) archive first if the current workspace matters.

If database loading fails, Wheat shows recovery information instead of substituting browser/demo records. Running the React renderer outside Electron remains a clearly marked, non-persistent preview.

## Operational accounting

### Counterparties, invoices, and payments

- A counterparty can be a customer, supplier, or both. Existing financial history prevents identity from being treated as disposable; inactive counterparties are archived.
- Sales invoice numbers use a company/fiscal-year sequence. Supplier invoice numbers remain source-document numbers.
- Invoice and payment drafts use version checks so a stale screen cannot silently overwrite a newer edit.
- Posting validates company ownership, account mapping, fiscal-year coverage, fiscal status, inclusive lock date, line totals, and exact debit/credit balance.
- Posted invoice PDFs are immutable through normal editing. Commercial corrections use a linked partial or full credit note with its own opposite entry and artifact; posted payments retain dated void/reversal workflows.
- Payment allocations are persisted records. Reversing an allocation preserves it as historical evidence rather than erasing it.
- Settlement exposes payment allocations and linked credits separately while deriving one exact remaining balance.
- Legacy 1.1 invoice records are retained as `LEGACY` and marked for review. Where a reliable historical payment date existed, the migration creates a legacy payment/allocation; it does not fabricate a posted accounting entry.

### Bank reconciliation

- Imported statement rows retain their source-file SHA-256, row number, fingerprint, dates, reference, label, and exact amount.
- A bank account must be mapped to a ledger account before Wheat can offer accounting-line candidates.
- Candidates are limited to posted entries on that mapped account and in the correct cash direction.
- One movement can be reconciled in several batches, and one batch can split an amount across several accounting lines. Wheat caps allocations against both the movement remainder and each line's available amount.
- Reconciliation state is derived as `UNRECONCILED`, `PARTIAL`, `RECONCILED`, `EXCLUDED`, or `REVIEW_REQUIRED`.
- Confirmed batches are never hard-deleted. Voiding records a reason and releases their amounts while preserving the original allocation rows and snapshot.
- Excluding and restoring movements is revision-checked and audit-logged. Exclusion is not a substitute for reconciliation evidence.

## Backup and restore

Use `Réglages → Sauvegarder` to create a complete `.wheatbackup` (and the legacy `.atlasbackup`) archive. Wheat checkpoints and disconnects the database, snapshots it, includes referenced OCR documents and source bank statements under Wheat's managed `documents` directory, hashes every payload file, writes a manifest, and validates the finished archive.

The archive intentionally does not sweep arbitrary files from disk. It excludes:

- unreferenced or orphaned files under the documents directory;
- source files outside Wheat's managed documents directory;
- any file not referenced by the backed-up database.

If a referenced managed attachment is missing, Wheat rejects the backup instead of producing a knowingly incomplete archive. Store important backups off the computer and test restoration under your own retention policy; Wheat does not automatically create an off-device copy.

Use `Réglages → Restaurer` to select either a `.wheatbackup` (and the legacy `.atlasbackup`) archive or an older `.sqlite`/`.db` backup. Complete archives are extracted into a private staging directory, checked against their manifest, migrated, and validated for SQLite integrity and foreign keys before replacement. Included attachments are restored under Wheat's managed documents directory. Wheat attempts a full rollback archive of the current workspace before replacement and restores the prior live database if the swap fails.

A legacy SQLite restore remains database-only. It cannot recover attachment files that were never included in the old backup.

## TVA workpapers and fiscal close

Wheat does not ship a hidden “current rate” table. Before posting a VAT-bearing invoice, create and activate an effective-dated configuration under `TVA → Règles`, enter the rules you have verified, and select the matching configuration and rate on the invoice line. Posted invoices snapshot the chosen configuration revision and rate metadata.

The 1.4 workpaper engine is deliberately limited to the collection basis. It constructs period evidence from actual posted settlements and linked credit/reversal events, supports reasoned adjustments with hashed documents, detects stale sources before review or filing, and records only a filing performed outside Wheat. Monthly and quarterly workpapers must cover complete civil periods.

Fiscal close is a separate controlled workflow. Preview the checks, resolve blockers, then confirm with the exact preview hash. Closing locks the fiscal year and creates an integrity checkpoint. Reopening requires a reason and does not erase the close run.

## Optional local PIN lock

The lock can be enabled from Settings with a PIN of 6–64 characters. The app stores a random salt and scrypt-derived verifier, not the PIN itself. Settings can enable startup locking and choose an inactivity timeout; the app can also be locked immediately. Failed unlock attempts receive an increasing retry delay.

This feature only gates normal use through the running Wheat interface. It does not:

- encrypt `wheat.sqlite` (the historical database filename) or attachment files at rest;
- authenticate the Windows user;
- provide roles, permissions, or a multi-user security boundary;
- protect data from an administrator, malware, direct filesystem access, or offline database tools.

Use a protected Windows account, full-disk/device encryption, and protected backups for actual data-at-rest protection.

## Data locations

Development database:

```text
prisma\dev.db
```

Wheat stores everything under `%APPDATA%\Wheat\`. An installation created before the rename is migrated automatically on first launch: the whole `%APPDATA%\Wheat\` directory is moved across in one atomic step, keeping its database, documents, backups and updater state, and the database file is renamed to `wheat.sqlite`. Nothing is merged and nothing is deleted.

Packaged database and startup log:

```text
%APPDATA%\Wheat\wheat.sqlite
%APPDATA%\Wheat\atlas-ledger-startup.log
```

Local update feed, updater state, staged installers, logs, and the most recent program-file rollback snapshot:

```text
%APPDATA%\Wheat\updates\
%APPDATA%\Wheat\updater\state.json
%APPDATA%\Wheat\updater\updater.log
%APPDATA%\Wheat\updater\staging\
%APPDATA%\Wheat\updater\rollback\
```

Updater files are deliberately separate from the database, documents, backups, fiscal packages, imports, and Wheat AI data.

Wheat-managed document copies and restored archive attachments are under:

```text
%APPDATA%\Wheat\documents\
```

Automatic migration, restore, and sample-reset rollback files are under:

```text
%APPDATA%\Wheat\backups\
```

Migration housekeeping retains the untracked legacy baseline plus one checkpoint for every embedded migration in the current release (ten for 2.0.0). User-selected `.wheatbackup` (and the legacy `.atlasbackup`) files are written wherever the user chooses.

## Install and run locally

Requirements: Windows, Node.js, and npm.

```powershell
npm install
npm run dev
```

`npm run dev` generates the Prisma client and launches the Vite/Electron development app.

Database commands:

```powershell
npm run prisma:generate
npm run db:push
npm run db:seed
npm run db:reset
```

`npm run db:reset` is destructive: it recreates `prisma\dev.db` and loads the development/sample fixture. It is not the packaged application's clean first-run path.

## Verify

```powershell
npm run lint
npm run build
npm run test:updater
npx playwright test tests/wheat-migration-operational.spec.cjs tests/wheat-archive-unit.spec.cjs tests/wheat-subledger-unit.spec.cjs tests/wheat-reconciliation-unit.spec.cjs tests/wheat-local-security-unit.spec.cjs --reporter=line
npx playwright test tests/wheat-migration-compliance.spec.cjs tests/wheat-credit-artifacts-unit.spec.cjs tests/wheat-compliance-unit.spec.cjs tests/wheat-electron-integration-compliance.spec.cjs --reporter=line
npx playwright test tests/wheat-foundations.spec.cjs tests/wheat-migration-fiscal.spec.cjs tests/wheat-electron-integration.spec.cjs tests/wheat-runtime-restart.spec.cjs --reporter=line
npm run test:desktop
npm run test:ocr
```

The build outputs are `dist\` and `dist-electron\`.

## Build Windows artifacts

```powershell
npm run installer
npm run portable
npm run pack
```

Expected outputs:

```text
release\2.0.0\WheatSetup-2.0.0.exe
release\2.0.0\WheatPortable-2.0.0.exe
release\2.0.0\win-unpacked\
```

`package.json.version` is the single product-version source of truth. Electron, About, updater metadata, and artifact names derive the SemVer `2.0.0` from it; Windows may represent the file version with a padded fourth component internally.

Packaging commands run `npm run db:reset` so the bundled sample fixture is current. This resets the development database. A fresh packaged profile still starts empty unless the user explicitly requests the sample workspace.

Locally generated executables are not code-signed, so Windows SmartScreen may request confirmation.

## Create and publish a local update

1. Change only `package.json.version` to the next SemVer (for example `2.2.0`).
2. Put one release-note item per line in a Markdown/text file. Leading `-`, `*`, or `•` markers are accepted.
3. Build the NSIS installer and generate the local feed:

```powershell
npm run installer
npm run update:package -- --notes-file docs\wheat-2.0-release-notes.md --minimum-version 2.0.0
```

`--minimum-version` is optional. Notes can alternatively be passed with repeated `--note "..."` arguments. Use `--no-publish` to create only the repository feed, `--output <directory>` for an alternate repository/test feed, or set `WHEAT_LOCAL_UPDATE_DIR` for the installed-app feed. Replacing different bytes for an already-published version is refused unless `--force` is explicitly supplied; publishing a new version is preferred.

The command calculates SHA-256 and creates:

```text
updates\
  latest.json
  2.2.0\
    WheatSetup-2.2.0.exe
    release.json
```

On Windows it also mirrors that feed to `%APPDATA%\Wheat\updates`, where an installed Wheat checks on startup. Development reads the repository `updates` directory (or `WHEAT_UPDATES_DIR`) and fully validates/stages a release, but never runs the installer or overwrites source files.

For a packaged update, the main process validates schema, compatibility, artifact size, and SHA-256 before copying the installer into updater staging. A separate bundled PowerShell helper waits for Electron and Prisma/OCR workers to close, snapshots the current program directory, invokes the existing Electron Builder NSIS installer with app-data preservation, and relaunches Wheat. On installer failure it restores the snapshot where possible and relaunches the previous executable. The new app must start with the expected `package.json.version` before the one-time release-notes modal is enabled. Database changes continue exclusively through the existing embedded, checksummed migration runner.

## Accounting safeguards

- Manual entries, invoices, and payments start as drafts unless posting is explicitly requested.
- Entry posting requires at least two non-zero lines and exact debit/credit equality in centimes.
- Posted and reversed accounting entries cannot be deleted individually through normal workflows.
- Reversals create linked opposite entries and preserve their sources.
- Journal numbers are assigned during posting and are unique per company.
- An inclusive fiscal lock blocks posting on or before its date. Reducing a lock requires explicit unlock first; lock and unlock actions are logged.
- Reports and local analysis exclude draft entries from ledger totals.

These application safeguards do not replace access controls, independent backups, accounting review, or regulatory validation.

## Smart OCR Organizer

The local-first OCR stack uses bundled PaddleOCR 3.7/PP-StructureV3 as its main engine for text, layout, and table recognition. It includes a pinned portable Python 3.12/PaddlePaddle CPU runtime and offline models in full builds. Tesseract.js with bundled French, English, and Arabic data runs only if PaddleOCR is unavailable or returns no usable text; `pdf-parse`, `sharp` preprocessing, rule-based classification and field extraction, local document organization, manual correction, duplicate review, and exports remain in the pipeline.

PaddleOCR runs as a hidden local worker over newline-delimited JSON. Documents are passed by local path or private temporary file, the temporary copy is removed after inference, and the worker cannot persist accounting records. Use `npm run paddle:setup` to prepare/update the portable runtime and models, and `npm run paddle:check` for the local health check. The Documents page reports whether PaddleOCR or the Tesseract fallback is active.

An OCR result is a proposal. Invoice extraction creates a reviewable purchase-invoice draft through the desktop bridge; a person must verify identity, dates, totals, VAT, account mapping, and the source image before posting.

Architecture notes are in [Smart OCR research](docs/smart-ocr-research.md).

## Architecture

```text
electron/
  accounting.ts       Exact money conversion, entry lifecycle, IPC serialization
  archive.ts          .atlasbackup creation, manifest validation, safe extraction
  database.ts         Database path, embedded migrations, checks, rollback retention
  localSecurity.ts    Optional local PIN-lock state and throttling
  main.ts             Electron integration and accounting/document/backup IPC
  paddleOcr.ts        Secure lifecycle, health, timeout, and temp-file bridge for local PaddleOCR
  preload.ts          Context-isolated renderer API bridge
  updater/            Provider-neutral validation, staging, state, and Windows installer orchestration
  reconciliation.ts   Statement import and immutable reconciliation service
  reporting.ts        Exact paginated books, aging, and integrity checks
  smartOcr.ts         Local OCR and document extraction
  subledger.ts        Counterparty, invoice, payment, and settlement service
  creditNotes14.ts    Linked credits and immutable invoice artifact service
  compliance14.ts     Versioned TVA workpapers, fiscal close, and local seals
prisma/
  migrations/         Versioned, checksummed SQLite migrations
  schema.prisma       Accounting domain model
  seed.ts             Explicit fictitious sample workspace
resources/paddleocr/
  worker.py           Local PaddleOCR/PP-StructureV3 JSON-line worker
  requirements.txt   Pinned PaddleOCR and PaddlePaddle runtime versions
resources/updater/
  update-helper.ps1   Out-of-process NSIS replacement and failure recovery helper
src/
  App.tsx             Desktop shell, onboarding, recovery, and feature pages
  components/         Operational accounting, books, reconciliation, and compliance workspaces
  data/               Non-persistent browser-preview data
  types/              Preload API typing
tests/
  atlas-1.2-*.spec.cjs
  atlas-1.3-*.spec.cjs
  atlas-1.4-*.spec.cjs
  electron-smoke.spec.cjs
  ocr-meaningful.spec.cjs
  updater.spec.cjs
  updater-electron.spec.cjs
```

## Licence and cost

Copyright © 2026 Wheat contributors.

Wheat is free software: no subscription, licence key, paid cloud service, or usage fee is required. The source code is licensed under the [GNU General Public License v3.0 or later](LICENSE), so users may run, inspect, modify, and redistribute it under those terms. Wheat is provided without warranty.

## Known limitations

- Wheat 1.4 is not DGI-certified, CNSS-certified, authority-certified, or a guarantee of current statutory compliance.
- TVA screens create local collection-basis workpapers from user-verified, versioned settings. Direct DGI filing, debit-basis processing, automatic legal-rate updates, and validation against current declaration or electronic-invoicing specifications are not included.
- Wheat does not contain an automatically maintained Moroccan tax/payroll rules engine. Payroll does not calculate or certify current CNSS, AMO, IR, employer contributions, payslips, Damancom files, or declarations.
- Invoice PDFs and local audit seals are technical evidence generated by Wheat; they are not qualified signatures, trusted timestamps, official invoice certification, or external notarization.
- Partial credits reduce the invoice balance. Refunds, customer/supplier credit-balance settlement, withholding tax, multicurrency revaluation, and advance-payment allocation remain outside the 1.4 credit workflow.
- OCR is assistive. Scans, handwriting, irregular tables, and extracted identity/tax/accounting fields require human review before posting.
- The subledger is an operational bookkeeping baseline, not a complete ERP, certified invoicing system, inventory system, or multicurrency revaluation engine.
- `.wheatbackup` (and the legacy `.atlasbackup`) includes only database-referenced files inside Wheat's managed documents directory. Unmanaged and unreferenced files require a separate retention decision.
- Whole-workspace reset and sample-workspace replacement remain destructive database operations. Create and protect a full backup first.
- Local analysis supports a limited deterministic intent set and is not generative professional advice.
- Wheat remains a trusted, single-user desktop app. The optional PIN lock is not authentication or authorization, and the SQLite database and attachments remain plaintext at rest unless the device/filesystem provides encryption.
- Locally built Windows artifacts are not code-signed.
