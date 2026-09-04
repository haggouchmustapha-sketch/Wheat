# Wheat product audit

Audit date: 2026-08-20  
Audited version: 2.0.1  
Scope: current source tree, embedded SQLite migrations, development database, Electron boundary, renderer workflows, exports, and automated tests.

## Executive Summary

Wheat is a substantive local-first bookkeeping application, not a mock. Its strongest systems are exact-cent double-entry posting, draft/post/reversal lifecycles, company-scoped subledgers, controlled imports, bank reconciliation, immutable invoice evidence, audit chaining, managed-file backup/restore, collection-basis VAT workpapers, and fiscal close/reopen controls. The core is materially more mature than the UI breadth suggests.

The accounting foundation is suitable for controlled testing and supervised bookkeeping, but it is not yet production-worthy as a complete Moroccan accounting product. Important gaps remain: no fixed assets, analytical accounting, import dossiers, commercial quote/order/delivery chain, full financial statements, fiscal package, withholding-tax workflows, DGI integration, multicurrency accounting, or real multi-user authorization. Tax behavior is intentionally limited to user-configured collection-basis VAT workpapers and must not be represented as legally certified.

The audit identified Sage 100 interoperability as the largest verified broken workflow and eager decimal coercion as the highest-risk UI defect. The bounded implementation phase corrected the verified Sage TXT/CSV layer, exact manual-entry/payroll typing, and the Ctrl+N editor conflict. PNM is now explicitly blocked because the repository contains no authoritative position schema. These results are locally verified; an actual Sage 100 import is still required before claiming external compatibility certification.

Baseline evidence before implementation:

- `npm run lint`: passed.
- `npm run build`: passed; the baseline Vite build reported a 2.39 MB renderer chunk and a future `__dirname` config warning. The post-audit fix replaced `__dirname` and reduced the initial renderer to about 705 KB through lazy export/chart chunks.
- `npx playwright test --reporter=line`: 100 passed, 1 skipped, 0 failed (101 total).
- `npm audit --json`: the baseline found three high advisories in the Prisma development-tooling chain through `deepmerge-ts`. The post-audit pass tested and locked patched `deepmerge-ts` 8.0.1; final audit reports zero vulnerabilities.
- `prisma/dev.db` SHA-256 remained `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8` across the baseline test run.

Post-fix evidence:

- `npm run lint`: passed.
- `npm run build`: passed; the same Vite configuration and bundle-size warnings remain.
- `npx playwright test --reporter=line --workers=4`: 106 passed, 1 intentionally skipped, 0 failed (107 total).
- A baseline default-worker run reached the 120-second `beforeAll` timeout in `atlas-1.3-bounded-reads` because of Windows `tsx` ESM module-graph contention. The post-audit pass replaced that contended loader path with the synchronous scoped transform; the file passes 2/2 alone and completes reliably inside the final four-worker suite.
- Dedicated Sage unit tests: 6 passed, covering required examples, every field at maximum/+1 width, mappings, exact balance, encoding, header, collisions, and PNM blocking.
- Whole-app Electron regression: passed, including physical TXT/CSV inspection, PNM blocking, profile reload, decimal typing/save, and the Ctrl+N editor guard.
- `prisma/dev.db` SHA-256 remained `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8` after implementation and verification.

## Architecture

### Frontend

React 19 and TypeScript render a single Electron application shell. `src/App.tsx` contains onboarding, navigation, dashboard, documents, payroll, Sage, settings, and manual-entry flows. Operational invoices/payments/reconciliation are in `src/components/OperationalAccounting.tsx`; books/settings/imports/audit are in `BooksWorkspace13.tsx`; VAT and fiscal close are in `ComplianceWorkspace14.tsx`.

The renderer remains overly concentrated in `App.tsx`, but heavy Excel/PDF/chart code now loads on demand. The initial renderer is about 705 KB before gzip instead of the 2.39 MB baseline; incremental component extraction remains useful without a rewrite.

### Backend

The Electron main process is the application service boundary. Domain services are separated into accounting, subledger, operations/imports, reporting, reconciliation, OCR, audit, credit-note evidence, compliance, archive, local security, and security-boundary modules. The preload exposes a narrow named IPC API; Node integration is disabled in the renderer.

### Database

Prisma 6.19.3 uses SQLite. Money fields use `BigInt` integer centimes. Eight embedded, checksummed migrations are applied before Prisma opens the database. Migrations are backed up, validated with SQLite integrity and foreign-key checks, and refused on unknown/newer schemas.

Company scoping is consistently enforced in the service layer and tested, but many cross-company invariants are not expressible as composite SQLite foreign keys in the current schema. Posted-entry immutability is enforced by application workflows and audit checks, not by general database triggers. Immutable invoice artifacts do have SQLite update/delete triggers.

### Authentication and authorization

Wheat is a trusted single-user desktop application. It has an optional salted scrypt PIN privacy lock and some stored role data/admin checks, but no user authentication boundary, invitation flow, or complete role-permission enforcement. The README states this limitation accurately.

### Storage

SQLite and managed documents live under the Electron user-data directory. Managed files retain hash, MIME, size, and source provenance. `.atlasbackup` archives contain the database and referenced managed evidence only, with safe-path extraction, manifests, hash verification, staging, and rollback.

### Jobs and queues

There is no persistent background job/queue system. OCR work is local and process-bound. This is acceptable for the current single-user desktop architecture but limits long-running/retryable processing.

### AI and OCR

OCR is real and local: Tesseract.js, local language data, PDF text extraction/rasterization, Sharp preprocessing, rule-based classification, extraction, confidence, duplicate hints, and human correction. The product correctly presents it as assistive. It does not learn from corrections, and the “local analysis” feature is deterministic rule-based analysis rather than generative AI.

### Integrations

The main integrations are local file import/export and Sage export. There is no DGI/SIMPL filing, bank API, email provider, or cloud service. Sage TXT/CSV now has a dedicated locally verified compatibility layer; PNM lacks an authoritative field-position schema and is blocked.

## Accounting Engine Review

Wheat has a real double-entry engine.

- Manual and generated posting validate at least two non-zero lines, reject dual-sided/negative lines, and require exact debit equals credit.
- Money enters the service boundary as exact decimal text or integer centimes and is stored as `BigInt`.
- Posting checks company ownership, journal/account status, fiscal-year coverage, locks, and version conflicts.
- Posted entries are corrected through linked reversal entries; normal UI deletion is limited to drafts.
- Invoice, payment, credit-note, payroll, import, and reconciliation workflows use transactions and preserve evidence.
- Books exclude drafts and use stable, filter-bound pagination.
- Integrity checks detect unbalanced entries, cross-company references, invalid lifecycle evidence, over-allocation, missing artifacts, and ledger imbalance.

Residual risk: a person with direct filesystem/database access can mutate general posted-entry rows because SQLite triggers do not make all posted entries immutable. The audit chain and integrity checks improve detection but are not access control or external notarization.

## Security Review

The Electron boundary is strong for a local desktop app:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, no webviews, no insecure content, and no production DevTools.
- Renderer location is restricted to the exact packaged file or an exact loopback development origin.
- IPC requires the trusted main frame and exact renderer URL.
- Popups, external navigation, redirects, subframe navigation, webviews, and browser permissions fail closed.
- The renderer contains no discovered raw-HTML injection, eval, dynamic script, arbitrary fetch, or postMessage sink.
- CSP blocks scripts outside `self`; styles retain `unsafe-inline` for the current styling stack.
- Archive extraction defends against traversal, collisions, symlinks, unmanifested files, and resource-limit abuse.

Limitations and findings are in `security_best_practices_report.md`. The largest product-security limitation is plaintext local data plus the absence of real authentication/authorization; it is documented rather than hidden. The active npm advisory affects development tooling and needs a tested dependency upgrade path, not a blind downgrade.

## Data Integrity Review

Strengths:

- Integer-cent storage and exact parsing.
- Company-local unique account/journal/entry/invoice sequence keys.
- Restrictive foreign keys for posted evidence and reconciliation history.
- Version checks on mutable drafts/settings.
- Transactional posting, reversal, credit, close, import, and artifact creation.
- Immutable artifact triggers and hash verification.
- Database migration checksums, backups, integrity checks, and foreign-key checks.

Gaps:

- No database-level balanced-posted-entry trigger or universal posted-entry immutability trigger.
- Cross-company correctness depends primarily on service checks rather than composite foreign keys.
- `CompanyUser` lacks an explicit `@@unique([companyId, userId])` constraint.
- Several legacy projection tables/fields coexist with the newer evidence model and require continued careful migration testing.
- Sage profiles are now versioned, company-unique SQLite records written through validated IPC, included in backups, and audited on save; localStorage remains only a compatibility/browser-preview cache.

## UX Review

The application has a coherent Wheat identity, a useful “Production” work queue, quick add/command palette, explicit drafts, visible warnings, reversal confirmations, source previews, and accounting evidence. It does not resemble a pixel clone of the referenced competitor.

The main usability risks are breadth and density: fourteen top-level navigation items, large monolithic pages, partially translated screens, and two parallel books/report navigation entries. Missing product flows are generally not disguised as complete. The previous “PNM - Format Sage” overclaim was removed; PNM is now labelled unverified and blocked.

## UI Reliability & Interaction Review

### Input reliability

The automated desktop suite verifies navigation, topbar search typing/clearing, profile editing/persistence, language switching, command-palette typing, scrolling, Sage mappings/exports, and the absence of renderer console errors. Operational invoice, credit, payment, book-edit, tax, manual-entry, and payroll forms retain decimal values as strings and pass exact text to the service boundary. The follow-up Electron matrix additionally creates a customer, sales invoice, payment allocation, account, and journal through visible controls at the packaged minimum width.

Post-fix result: `EntryModal` and `EmployeeModal` preserve intermediate text such as `0.` and calculate previews with `BigInt` centimes through `src/lib/exactDecimal.ts`. The Electron regression types `0.` then `0.01`, completes a balanced draft, repeats the intermediate-state check for salary, saves an exact employee net, and observes no renderer error. [FIXED] [VERIFIED]

### Focus and keyboard behavior

Focus and Escape handling pass for search, command palette, App/Books dialogs, and operational confirmations. Ctrl+N prevents the native browser action but opens no Wheat workflow when its event target is editable. Ctrl+K now follows the same editor-safety rule, while remaining deliberately available from the top-bar search. The regressions verify retained text, zero unintended modals, one application window, and normal shortcut behavior outside data-entry editors. [FIXED] [VERIFIED]

### Overlay and modal lifecycle

No permanently stuck overlay occurred in the full automated suite. App, Books, and operational confirmation overlays now share dialog semantics, initial focus, Escape/Tab containment, background scroll locking, and exact trigger focus restoration. Nested cleanup restores the previous connected control instead of jumping to the parent dialog's first field. The Electron regression also asserts that no stale backdrop remains. Full WCAG/RTL coverage remains separate.

### Forms

Core operational forms have explicit busy states, `try/finally`, error surfaces, cancel paths, and optimistic version checks. Manual-entry and company creation are semantic forms with Enter submission and duplicate-submit guards; their close/cancel controls are disabled while saving. Operational tabs are disabled while an invoice/payment/customer composer is open, preventing silent draft loss. Recoverable compliance failures retain typed evidence/seal data. Some legacy/simple forms still use `any` and component-local validation.

### Editable tables and search/autocomplete

The books draft editor keeps cell values as strings and is keyboard-usable. There is no broad spreadsheet-grade editable grid or account autocomplete. Search is mainly page-local; a true global multi-entity search is missing. Follow-up fault injection reproduced delayed-response overwrite risk in Sage/settings/operational/report/compliance views; request identity and company checks now prevent an older response from committing after a newer selection or edit. [FIXED] [VERIFIED]

### Async/loading/error state

Reviewed operational components clear busy/loading state in request-scoped `finally` blocks. The 112-passing follow-up suite includes failure/rollback tests for archive, OCR handoff, artifacts, imports, migrations, local lock, reconciliation, fiscal close, delayed Sage profile loading, recoverable compliance seal failure, and route-wide viewport constraints. Exhaustive timeout/cancellation injection for every IPC-backed control remains unverified.

### Responsive and theme behavior

The dedicated viewport pass covers all 13 major routes at nine gradually resized desktop/laptop windows from 1120×760 through 1920×1080, plus 80%, 90%, 100%, 110%, and 125% zoom at minimum and common laptop widths. It also covers every operational tab/form, the reconciliation inspector, every compliance section, all Books workspaces/reports/reference areas, and the three large App dialogs at the tightest effective viewport. The shell, sidebar, workspace, page scroll width, visible element bounds, local table scrolling, and dialog reachability are asserted without globally hiding overflow. [FIXED] [VERIFIED]

The pass fixed sidebar min-content height stretching the shell below the viewport, implicit grid tracks widening Saisie, narrow auto-fit Settings cards overflowing bank controls, and a Books breakpoint that ignored sidebar-adjusted available width. At the packaged 1120px minimum width, collapsed navigation remains named and scroll-reachable. True tablet/mobile use remains unsupported. Arabic sets `dir="rtl"`, but full RTL visual and interaction verification is incomplete. The operational workspace retains its verified dark-theme behavior.

### Highest-risk UI components

1. Large `App.tsx` state surface and modal orchestration.
2. Full RTL/WCAG interaction coverage across all routes.
3. Remaining legacy/simple forms that use `any` and local validation.
4. Exhaustive timeout/cancellation injection for every IPC-backed control.
5. Production-volume responsive/performance behavior beyond the supported desktop minimum.

## Sage 100 Export Review (pre-fix)

| Requirement | Pre-fix status | Evidence / root cause |
|---|---|---|
| Dedicated 10-field Sage TXT order | PARTIAL | Default columns happen to match, but the user can arbitrarily remap them and the exporter is generic. |
| DDMMYY date | BROKEN | `formatSageDate` only supports `DD/MM/YYYY` and `YYYY-MM-DD`. |
| Comma, two-decimal amounts | BROKEN | `sageDecimalFromCents` emits a dot. |
| Piece-number sanitization/collision check | BROKEN | Raw `pieceNumber` is exported; no collision validation. |
| Field-length validator | BROKEN | Only PNM amount digit width is checked. |
| Journal mapping | MISSING | Entry journal snapshots are emitted directly; no Sage target-code mapping. |
| Account-length rule and explicit mapping | MISSING | Raw account snapshots are emitted; no target-profile validation/mapping. |
| Header suppression | BROKEN | `buildSageDelimitedLines` always emits a header. |
| Windows-1252 | PARTIAL | A local encoder exists and covers common CP1252 characters; unsupported characters become `?`. |
| Empty optional positions | PARTIAL | Empty values retain array positions, but quoting can introduce a generic CSV grammar rather than the verified safe-normalized Sage row. |
| Separate debit/credit and exact balance | PARTIAL | Fields are separate and each entry is checked exactly; batch totals and invalid dual-sided rows are not fully reported. |
| Exactly 10 fields / 9 semicolons / one physical line | BROKEN | Arbitrary column mapping and quoted separators mean the verified physical-row requirement is not enforced. |
| Per-company profile | FIXED / VERIFIED locally | Versioned company-unique SQLite profile with mappings/rules, validated IPC, audited save, backup inclusion, and reload after browser-cache deletion. |
| PNM fixed positions | UNKNOWN / BLOCKED — DOMAIN VERIFICATION | Two layouts are assembled by guessed concatenation. Tests prove only total length, not authoritative positions. |
| Dedicated Sage tests | MISSING | Existing whole-app test validates file creation/length, not verified Sage import structure. |

## Sage 100 Export Review (post-fix)

| Requirement | Post-fix result | Evidence / remaining limit |
|---|---|---|
| Dedicated 10-field Sage TXT/CSV order | FIXED / VERIFIED locally | `src/lib/sageTxt.ts` owns an immutable ordered schema; unit and Electron tests assert ten fields and nine semicolons. |
| DDMMYY dates | FIXED / VERIFIED locally | Central UTC formatter passes 29/30 May examples; empty due date stays in position. |
| Comma, exactly two decimals | FIXED / VERIFIED locally | Integer-cent formatter passes 13000,00; 2600,00; 20833,33; 4166,67; and 0,00 examples. |
| Piece sanitization/collisions | FIXED / VERIFIED locally | Alphanumeric normalizer passes all supplied examples and blocks post-normalization collisions. |
| Length/physical-row validation | FIXED / VERIFIED locally | Every field is tested at maximum and maximum+1; controls/separators are normalized and malformed rows block export. |
| Journal/account configuration | IMPLEMENTED / VERIFIED locally | Explicit journal mappings, optional account mappings, and variable/fixed account lengths are visible and validated; no target code is silently invented. |
| Header | FIXED / VERIFIED locally | Off by default and optional; both modes are tested. |
| Windows-1252 | VERIFIED locally | Dedicated encoder round-trips supplied French terms; unsupported characters become `?`. |
| Exact entry/batch balance | FIXED / VERIFIED locally | Per-entry and batch totals use `BigInt`; dual-sided/zero lines and imbalance block file creation. |
| Per-company durability | FIXED / VERIFIED locally | SQLite persistence, audit event, checked migration, and real Electron reload without localStorage. |
| PNM | BLOCKED — DOMAIN VERIFICATION | Guessed generator path is no longer reachable; selection shows a blocker and disables export. Exact positions still require authoritative evidence. |

No claim is made that local contract conformance guarantees import into every Sage 100 dossier. Journal/account existence and a real target-version import must be verified by the user with the selected Sage company.

## Tax / Morocco-Specific Review

Wheat uses CGNC-oriented starter accounts and Morocco-first French terminology. VAT is deliberately configuration-driven: the user supplies effective dates, basis, frequency, rates, direction, deductibility, accounts, and a source reference. Activated configurations are immutable revisions. The implemented workpaper engine is collection-basis only and traces posted invoices, allocations, credits, reversals, adjustments, and evidence.

Not implemented or not verified: debit-basis VAT, RAS TVA/IS/IR, VAT prorata, customs VAT, payment-delay legal declarations, non-resident rules, liasse fiscale, current official XML/EDI formats, and DGI/SIMPL filing. These require domain verification before claims of compliance.

## Testing Review

The repository has unusually strong automated coverage for its size: 113 Playwright-discovered unit, migration, integration, Electron, OCR, archive, security-boundary, reporting, reconciliation, subledger, audit, compliance, Sage, dashboard, whole-app, and viewport tests. The controlled follow-up run passed 112 with 1 intentional skip using four workers. Exact money, complete dashboard aggregation, company isolation, locks, reversals, over-allocation, backup path safety, migration preservation, immutable artifacts, Sage durability/rows, dialog focus, stale-response rejection, recoverable UI errors, responsive naming, dark-theme controls, visible form workflows, gradual resizing, and zoom behavior are explicitly exercised.

Important gaps:

- Real Sage 100 import confirmation is unavailable in this environment.
- PNM position tests cannot exist until an authoritative schema/sample is supplied; export is blocked meanwhile.
- UI interaction tests now cover manual entry, payroll, customers, sales invoices, payments, accounts, journals, company creation, Sage profiles, operational confirmations, and compliance error recovery, but not every form on every route.
- No real multi-user permission tests because no real multi-user boundary exists.
- No legally verified Moroccan tax golden files.
- No large-production-volume performance benchmark.

## Major Bugs and Risks

Resolved in the original pass: verified Sage TXT structure, unverified PNM exposure, manual-entry/payroll decimal coercion, and Ctrl+N editor interruption. Resolved in this follow-up: Ctrl+K editor interruption, operational draft-loss navigation, incomplete dialog cleanup, stale async response commits, failed-action draft clearing, cross-company settings draft leakage, operational dark-theme inconsistency, unnamed collapsed navigation, Enter/duplicate form submission, and suite-wide TypeScript-loader contention.

1. High / blocked: PNM remains unavailable until an authoritative fixed-position schema or known-good sample is supplied.
2. Medium: incomplete authentication/authorization and plaintext at-rest storage limit deployment scenarios.
3. Medium: general posted entries are not immutable against direct SQLite mutation.
4. Medium: cross-company consistency still relies primarily on service checks rather than composite database keys.
5. Medium: monolithic `App.tsx` still increases regression risk despite the much smaller initial renderer.
6. Medium: localization/RTL coverage is incomplete.
7. Medium: advanced Moroccan accounting coverage is incomplete and must not be inferred from generic labels.
8. Low: CSP still permits inline styles.
9. Low: real production-volume performance benchmarks are absent.
10. Blocked: a real Sage dossier import is still needed before external compatibility certification.

## Top 10 Reliability and Usefulness Changes

| Order | Change | Why it matters | Scope | Systems / dependencies | Implementation status | Verification status |
|---|---|---|---|---|---|---|
| 1 | Verified Sage 100 TXT formatter and validator | Current files failed known Sage rules. | Medium | Sage module/UI/tests | FIXED / IMPLEMENTED | Unit contract plus real Electron TXT/CSV export pass; real Sage import remains |
| 2 | Exact string-based manual-entry input | Prevents lost/rewritten accounting amounts. | Small | Entry/payroll modals, decimal helper, renderer tests | FIXED | Visible intermediate typing and save pass |
| 3 | Block unverified PNM compatibility claims | Prevents unsafe interoperability. | Small | Sage UI/validator | FIXED safety boundary / BLOCKED domain | Unit and Electron disabled-export checks pass |
| 4 | Guard global shortcuts during editing | Prevents modal interruption/data loss. | Small | App keyboard handler, UI tests | FIXED | Retained text/no modal/single window and normal shortcut both pass |
| 5 | Persist Sage profile/mappings in company backup | Makes interoperability configuration durable/auditable. | Medium | Prisma migration, IPC, backup | FIXED | SQLite/audit/migration plus cache-free Electron reload pass |
| 6 | Database hardening for posted ledger invariants | Reduces direct-SQL mutation risk. | Large | SQLite triggers/migration, posting lifecycle | NEXT | Needs careful migration design |
| 7 | Dedicated complete dashboard metrics | Avoids partial/bounded KPI displays. | Medium | Aggregate service, dashboard | FIXED | Exact large-value/settlement unit test and real dashboard route pass |
| 8 | Real authentication and permissions | Required for cabinet/multi-user deployment. | Large | Identity, roles, encryption/session model | LATER | Current single-user limitation verified |
| 9 | Complete financial statements/closing production | Required for end-to-end books. | Large | Mapping engine, Bilan/CPC/ESG, close | LATER | Missing |
| 10 | Domain-verified Moroccan advanced tax modules | Required for RAS/prorata/liasse claims. | Large | Tax engine, exports, authoritative samples | BLOCKED — DOMAIN VERIFICATION | Not implemented |

## Recommended Immediate Priorities

Completed in this run: the first four pre-fix priorities (verified Sage TXT, exact decimal inputs, shortcut guard, and PNM safety block).

Completed after the initial audit: versioned Sage persistence/audit, complete exact dashboard aggregates, shared accessible modal behavior, callback/race stabilization, dashboard navigation, build code splitting, membership uniqueness, and the clean dependency override.

Completed in the missed-UI follow-up: broader editor/form/dialog coverage, operational dark-mode/minimum-width fixes, request-scoped async commits, error-state draft preservation, cross-company draft isolation, and consistent synchronous TypeScript loading across the test harness.

1. Design reversible database hardening for posted-ledger/cross-company invariants.
2. Decompose the remaining monolithic App surface without changing accounting behavior.
3. Complete localization/RTL and broader WCAG interaction review.
4. Add production-volume performance benchmarks.
5. Keep all missing legal/tax behavior explicitly marked as domain-verification work.

## Wheat 2.0 missed-functional-fixes delta

The 2.0 pass exercised a clean fictional `Wheat Test SARL` dossier through the real Electron UI. It created customer and supplier records, drafted/edited/posted sales and purchase invoices, posted and allocated a customer receipt, generated a balanced trial balance/report, checked dashboard totals, imported and reconciled bank movements, and restarted Electron against the same user-data directory. The created invoices, counterparties, payment, ledger totals, bank history, movements, and reconciliation survived restart.

The bank-statement path is now a parser registry with one normalized review/persistence contract rather than a renderer-only CSV/XLSX shortcut. CSV, delimited TXT, XLSX, OFX, QIF, MT940, CAMT.053, and reliably delimited selectable-text PDF are implemented and runtime-verified. Detection uses content signatures/structure as well as names. The review dialog exposes mapping, bounded preview, row errors, warnings, currency mismatch, duplicate counts, and an explicit confirmation step before one atomic database transaction. Exact file hashes and transaction fingerprints protect renamed/equivalent repeats; import history records format and outcome counts.

Safety limits are explicit: legacy binary XLS is detected but rejected with conversion guidance; scanned/image-only and ambiguous free-form PDFs are rejected rather than converted into guessed transactions. No Moroccan-bank-specific format is claimed without a real sample. Generic mapping/adapters are ready for future CIH, Banque Populaire, Attijariwafa bank, Bank of Africa, Crédit du Maroc, Saham Bank/SGMB, CFG Bank, or other verified samples.

Runtime-only defects found and fixed during this delta included: Electron startup failure caused by statically bundling ExcelJS into the ESM main process; a missing 2.0 migration in the embedded runtime registry that broke fresh-profile bank history; stale optimistic invoice versions being actionable while a draft refresh was still in flight; and seven-file migration-backup retention pruning the original baseline after the eighth migration. The bank-review dialog was added to the gradual 1120–1920 desktop and 80–125% zoom audit; its wide preview remains inside a local scroller.

Final 2.0 evidence: lint passed; production build passed; the stable single-worker suite passed 126 with 1 intentional skip and 0 failures (127 discovered) in 3.1 minutes; npm audit reported 0 vulnerabilities across 881 dependencies. The final packaging reset produced a canonical seed database with `integrity_check=ok`, zero foreign-key violations, eight completed migrations, and SHA-256 `0A5A5BFD9AB4AF1BDDA22FE43DA893FE76ED8693CDE0771EF9956EC96FB42C20`. Runtime scenarios used isolated temporary profiles and did not leave their test statements in the canonical database.
