# Wheat technical debt

## Sage 100 TXT is not compatible with the verified import profile

Severity: High

Status: [FIXED] [VERIFIED] locally on 2026-08-20. `src/lib/sageTxt.ts` now owns the ten-field formatter/validator and the Electron regression creates and inspects TXT/CSV output. A real Sage 100 import is still required before claiming external-system certification.

Affected files: `src/App.tsx` Sage constants, `SageExportPage`, formatter, validator, delimited exporter; `tests/whole-app-regression.spec.cjs`.

Problem: the current path emits slash/ISO dates, dot decimals, raw piece numbers, a mandatory header, user-variable columns, and almost no field/structure validation.

Why it matters: a successful download is presented even though Sage rejects the file. This blocks interoperability and can waste accounting review time.

Recommended fix: create a dedicated reusable Sage TXT formatter/validator with the verified ten fields, DDMMYY, comma decimals, collision-safe piece sanitation, safe physical rows, length/account/journal rules, header control, exact batch balance, and regression tests.

Dependencies: target Sage journal codes and any explicit account mappings remain company/user configuration.

## PNM layout has no authoritative schema

Severity: High

Status: [BLOCKED — DOMAIN VERIFICATION]. The guessed 138/199 output path was removed from the UI/export flow. PNM selection now produces a blocking validation error and no file can be generated.

Affected files: pre-fix `src/App.tsx` PNM helpers; current `src/lib/sageTxt.ts`, `src/App.tsx`, and Sage tests.

Problem: the code concatenates guessed field widths for 138/199-character records. Tests prove only total length, not exact field positions.

Why it matters: fixed-width records can have the expected length and still import into the wrong fields or fail.

Recommended fix: stop claiming compatibility and block production PNM export until an authoritative Sage schema or known-good sample defines every start, length, alignment, and formatter.

Dependencies: BLOCKED — DOMAIN VERIFICATION.

## Manual-entry decimal fields rewrite intermediate input

Severity: High

Status: [FIXED] [VERIFIED] on 2026-08-20. Text is preserved verbatim, previews use integer cents, and the visible Electron workflow types `0.` then `0.01` and saves the draft.

Affected files: `src/App.tsx` `EntryModal`.

Problem: each keystroke is coerced with `Number(event.target.value)` and rendered with `value || ""`; totals use floating-point sums.

Why it matters: users can lose a decimal separator/intermediate zero while entering debit or credit, risking a wrong draft amount.

Recommended fix: retain decimal text verbatim, validate/convert to integer cents only for preview/submission, and add a visible-control regression test for `0.01`, editing, clearing, and balanced save.

Dependencies: existing backend already accepts exact decimal strings.

## Payroll helper decimal fields rewrite intermediate input

Severity: Medium

Status: [FIXED] [VERIFIED] on 2026-08-20. Salary/deduction text remains editable and net pay is calculated in integer cents; the visible Electron workflow verifies the intermediate decimal state and saved employee.

Affected files: `src/App.tsx` `EmployeeModal`.

Problem: the same eager number coercion is used for salary/deduction inputs and the net preview uses floating point.

Why it matters: payroll helper values can be difficult to enter accurately. Wheat does not claim payroll compliance, but stored accounting snapshots still need exact input.

Recommended fix: retain strings and compute the preview in integer cents.

Dependencies: existing `madToCents` service parsing.

## Ctrl+N interrupts active editors

Severity: Medium

Status: [FIXED] [VERIFIED] on 2026-08-20. The global handler prevents the native shortcut but declines to open a workflow when the target is editable; the Electron test verifies the search text, modal count, and window count.

Affected files: `src/App.tsx` global keydown effect.

Problem: Ctrl+N opens a new modal even when the event originated in an input, textarea, select, or contenteditable field.

Why it matters: a user editing accounting data can accidentally cover the active workflow and lose context.

Recommended fix: ignore workflow-opening shortcuts from editable targets; keep Ctrl+K only if deliberately global.

Dependencies: UI regression test.

## Sage profiles are stored only in localStorage

Severity: Medium

Status: [FIXED] [VERIFIED] on 2026-08-20. Migration `20260820010000_post_audit_fixes` adds a versioned, company-unique SQLite profile; validated IPC reads/writes it, saves append an audit event, normal backups include it, and Electron verification removes the localStorage copy before reload.

Affected files: `src/App.tsx` `loadSageProfile` / `saveProfile`; Prisma schema has no Sage profile.

Problem: configuration is per company ID and its loaded JSON is now shape-validated, but it is not part of SQLite, backups, migration history, or audit logs.

Why it matters: a restored/moved company can silently lose the exact export configuration used with its Sage dossier.

Recommended fix: persist a versioned company Sage profile and explicit mappings through validated IPC; include it in normal backups/audit history.

Dependencies: schema migration and compatibility migration from localStorage.

## General posted entries are not immutable at the SQLite boundary

Severity: Medium

Affected files: Prisma migrations/schema; entry posting/reversal services.

Problem: application services prevent editing/deleting posted entries, but direct SQLite access can update entry or line rows. Only invoice artifacts have database immutability triggers.

Why it matters: local database access can bypass normal correction history. Audit/integrity checks are detection, not prevention.

Recommended fix: design carefully scoped triggers or an append-only ledger representation that still permits the legitimate posting transition and linked reversal metadata.

Dependencies: migration compatibility, restore/import, performance, recovery tooling.

## Cross-company integrity is primarily service-enforced

Severity: Medium

Affected files: `prisma/schema.prisma`, subledger, operations, reconciliation, reporting.

Problem: many relations use single-column IDs, so SQLite foreign keys do not prove that related account/journal/counterparty rows share the same company.

Why it matters: a future code path or direct SQL mutation could create cross-company links.

Recommended fix: retain current service checks and evaluate composite unique keys/FKs or defensive triggers in a migration designed around SQLite limitations.

Dependencies: schema redesign and migration performance.

## CompanyUser membership can be duplicated

Severity: Low

Status: [FIXED] [VERIFIED] on 2026-08-20. The schema and checked migration enforce `@@unique([companyId, userId])`. Conflicting pre-existing roles make the transactional migration fail without silently discarding either record.

Affected files: `prisma/schema.prisma` `CompanyUser`.

Problem: there is no explicit unique constraint on `(companyId, userId)`.

Why it matters: future multi-user logic could see ambiguous duplicate roles.

Recommended fix: deduplicate safely and add a composite unique constraint before multi-user work.

Dependencies: user/permission architecture.

## Dashboard KPIs rely on bootstrap projections

Severity: Medium

Status: [FIXED] [VERIFIED] on 2026-08-20. `electron/dashboard.ts` now calculates full-company, integer-cent aggregates independently of the 500-row projections, including payments/credit notes in outstanding balances. Unit and Electron tests cover paid-late exclusion, partial balances, large exact values, and the dashboard route.

Affected files: `src/App.tsx` `buildMetrics`, dashboard/production pages; main bootstrap query.

Problem: the bootstrap is intentionally bounded for large books, while dashboard calculations consume loaded arrays.

Why it matters: KPIs can become incomplete as a company grows even though books/exports use dedicated complete queries.

Recommended fix: add dedicated aggregate reporting IPC for dashboard metrics and show scope/as-of information.

Dependencies: reporting service and performance tests.

## Renderer bundle and App component are oversized

Severity: Medium

Status: [PARTIALLY FIXED] [VERIFIED] on 2026-08-20. ExcelJS, jsPDF/autotable, and Recharts are now lazy chunks; the initial renderer fell from about 2.39 MB to about 705 KB before gzip. `App.tsx` remains monolithic and should still be decomposed incrementally.

Affected files: `src/App.tsx`, Vite build configuration.

Problem: `App.tsx` exceeds 5,100 lines and the renderer chunk is about 2.39 MB before gzip.

Why it matters: slower startup, broad rerender/regression surface, and difficult ownership/testing.

Recommended fix: incrementally extract Sage, documents, payroll, settings, and modal modules and lazy-load heavy PDF/XLSX/OCR-facing UI dependencies.

Dependencies: regression tests; no unrelated rewrite.

## Dialog semantics and focus containment are inconsistent

Severity: Medium

Status: [FIXED] [VERIFIED] for audited overlays on 2026-08-20. The shared `useAccessibleDialog` hook covers App, Books, and operational confirmation surfaces with roles/names, Escape, Tab containment, initial focus, scroll locking, and exact trigger focus restoration. Nested-dialog cleanup preserves the previously focused connected control. Electron keyboard regressions exercise these behaviors and assert that no stale backdrop remains.

Affected files: modal components in `src/App.tsx` and operational/compliance workspaces.

Problem: several overlays lack `role="dialog"`, `aria-modal`, focus trapping, background scroll lock, and explicit focus restoration.

Why it matters: keyboard and assistive-technology users can reach obscured content or lose their place.

Recommended fix: introduce a small shared dialog primitive and migrate one workflow at a time with keyboard tests.

Dependencies: accessibility review.

## Stale IPC responses can overwrite newer company/view state

Severity: High UI reliability

Status: [FIXED] [VERIFIED] on 2026-08-20. Operational lists/pagination, reconciliation candidates, Books reports/details/settings, compliance workpapers, and Sage profile load/save now use monotonic request identity plus company/edit-revision checks. Delayed-response injection proves a typed Sage mapping is not replaced by an older database result.

Affected files: `src/App.tsx`, `src/components/OperationalAccounting.tsx`, `src/components/BooksWorkspace13.tsx`, `src/components/ComplianceWorkspace14.tsx`.

Problem: an older asynchronous response could commit after a company switch, newer selection, or local edit; shared loading cleanup could also hide a newer request's busy state.

Why it matters: the screen could display or save data belonging to the wrong selection/company, or silently discard a user's newer input.

Implementation and verification: request-scoped commit/error/finally guards invalidate superseded work. Electron fault injection and rapid-selection/company-switch flows pass.

## Recoverable form failures and navigation can discard drafts

Severity: High UI reliability

Status: [FIXED] [VERIFIED] on 2026-08-20. Compliance adjustment/evidence/seal inputs reset only after success; operational tabs cannot switch while a composer is open; company/account/journal drafts reset at explicit company boundaries; entry/company forms have Enter and duplicate-submit guards.

Affected files: `src/App.tsx`, `src/components/OperationalAccounting.tsx`, `src/components/BooksWorkspace13.tsx`, `src/components/ComplianceWorkspace14.tsx`.

Problem: failed actions cleared typed values, tab changes could unmount unsaved operational forms, and unfinished settings drafts could leak to another company.

Why it matters: users could lose work or accidentally submit stale data under a different dossier.

Implementation and verification: state resets are success- or company-boundary-scoped, unsafe tabs are disabled during composition, and busy forms cannot submit twice. Visible Electron error injection preserves the note and restores an enabled retry control.

## Operational dark theme and collapsed navigation were incomplete

Severity: Medium UI/accessibility

Status: [FIXED] [VERIFIED] on 2026-08-20 at the supported 1120px minimum width. Operational surfaces/inputs now use dark-theme variables; collapsed navigation buttons retain `aria-label` and `title`; a live theme switch preserves the open customer form.

Affected files: `src/App.tsx`, `src/components/OperationalAccounting.css`, `tests/ui-reliability-followup.spec.cjs`.

Remaining scope: true mobile remains unsupported by the packaged minimum width, and full Arabic RTL/WCAG visual review is still open.

## Main shell and nested workspaces can overflow the available viewport

Severity: High UI reliability

Status: [FIXED] [VERIFIED] on 2026-08-20 for supported desktop/laptop windows and 80–125% Electron zoom.

Affected files: `src/App.css`, `src/components/BooksWorkspace13.css`, `tests/viewport-layout-regression.spec.cjs`.

Problems reproduced:

- Sidebar min-content height expanded the shell's implicit grid row to 848px inside a 721px content viewport, clipping the workspace and lower controls.
- Implicit `auto` tracks in stack/production grids allowed Saisie children to grow 143px beyond the page while `.page` hid the excess.
- The Settings auto-fit grid created four 300px cards at an intermediate wide viewport, making bank mapping controls overflow their narrow card by 56px.
- Books collapsed its rail at 820px viewport width even though the sidebar/padding left only about 789px for the component at 125% zoom; the fiscal-year form was clipped by 58px.

Implementation: the shell uses a `minmax(0, 1fr)` row; the sidebar is height-constrained and vertically scrollable; route grid tracks/items explicitly shrink with `min-width: 0`; Settings cards use a safe 420px responsive minimum; bank mapping tracks/controls are constrained; and Books reflows at the sidebar-adjusted breakpoint. No global overflow-hiding rule was added.

Verification: all 13 major routes pass nine gradual native window sizes from 1120×760 to 1920×1080 and five zoom factors at minimum/common laptop widths. Deep operational forms, reconciliation inspector, compliance sections, Books workspaces/reports/reference areas, and App dialogs pass at 1120×760/125% zoom. The test asserts document/body/shell/sidebar/workspace/page dimensions, hidden scroll width, out-of-bounds visible elements, local table scroll containment, and dialog reachability.

## Playwright TypeScript loader contention was only partially fixed

Severity: Medium engineering reliability

Status: [FIXED] [VERIFIED] on 2026-08-20. All 15 TypeScript-loading unit specs now use the synchronous scoped `tsx/cjs/api` transform; no asynchronous `tsx/esm/api` imports remain in `tests/`.

Problem: the earlier remediation changed only the bounded-read spec. Under a full Windows run, other loaders intermittently stalled for 30–120 seconds while passing immediately alone.

Why it matters: a red aggregate suite could hide real regressions and made release verification worker-count dependent.

Verification: every spec passed in a fresh-process isolation diagnostic; the latest normal four-worker command passes 112 tests with 1 intentional skip and 0 failures.

## Localization is incomplete

Severity: Medium

Affected files: `src/App.tsx`, all component workspaces and CSS.

Problem: French/English/Arabic nav and selected text exist, but many workflow strings remain French and RTL has not been comprehensively verified.

Why it matters: switching language produces mixed-language screens; Arabic layout may remain visually inconsistent.

Recommended fix: centralize message catalogs, remove hard-coded workflow text, and add RTL screenshots and form interaction tests.

Dependencies: terminology/domain review.

## Prisma development dependency advisory

Severity: Low for shipped runtime / High advisory rating upstream

Status: [FIXED] [VERIFIED] on 2026-08-20. A lockfile override selects patched `deepmerge-ts` 8.0.1 while retaining Prisma 6.19.3. Prisma generate, fresh eight-migration reset/seed, build, and the full suite pass; `npm audit` reports zero vulnerabilities.

Affected files: `package.json`, `package-lock.json` (`prisma` -> `@prisma/config` -> `deepmerge-ts`).

Problem: `npm audit` reports a recursive-object stack-exhaustion advisory. The dependency is used in local build/config tooling; no untrusted recursive config input was identified in the packaged accounting runtime.

Why it matters: developer/CI denial of service remains possible if hostile configuration reaches the toolchain.

Recommended fix: test a coordinated Prisma CLI/client upgrade when an upstream fixed compatible release is available. Do not apply the suggested blind downgrade to 6.12.0 without migration/build verification.

Dependencies: Prisma release compatibility and full migration suite.

## Missing advanced accounting modules

Severity: Medium

Affected files: product architecture.

Problem: analytical accounting, fixed assets, import dossiers, commercial chain, multicurrency accounting, financial statements, RAS workflows, liasse, and DGI filing are absent or incomplete.

Why it matters: Wheat cannot yet replace a complete Moroccan accounting production stack.

Recommended fix: follow the phased roadmap and require authoritative domain inputs for tax/legal behavior.

Dependencies: accountant review and official format/rule examples.

## Bank-statement import breadth and real-bank adapters

Severity: Medium product breadth; High data safety if overstated

Status: [PARTIALLY FIXED] [VERIFIED] in 2.0. CSV, delimited TXT, XLSX, OFX, QIF, MT940, CAMT.053, and constrained selectable-text PDF share a normalized parser/review/atomic-import pipeline. Exact-file and transaction-fingerprint duplicate checks, import history, mapping, row validation, restart persistence, and reconciliation are runtime-tested.

Remaining debt: binary XLS is intentionally rejected; scanned/image-only or ambiguous PDFs are not treated as bank tables; mapping presets are not yet saved per bank; and generic OFX/QIF/MT940/CAMT adapters have controlled fixtures but no supplied real Moroccan-bank export samples.

Recommended fix: add named presets only from consented, redacted real exports with golden normalization tests. Add OCR table import only after a reviewable cell/row extraction system can demonstrate that it never guesses accounting amounts.

Dependencies: real CIH/Banque Populaire/Attijariwafa/BOA/CDM/Saham/CFG samples and user/domain validation.

## Electron main-process CommonJS parser loading

Severity: Critical runtime reliability

Status: [FIXED] [VERIFIED] in 2.0. Static ExcelJS bundling caused the Rolldown ESM main bundle to call `require("crypto")` and crash before the application window opened. The bank importer now resolves ExcelJS with `createRequire(import.meta.url)` at runtime, matching Electron's supported Node boundary. The production Electron bundle launches and XLSX imports pass in the real application.

## Migration checkpoint retention after 2.0

Severity: High recovery reliability

Status: [FIXED] [VERIFIED] in 2.0. Adding an eighth embedded migration made the prior seven-file cap prune the original untracked legacy baseline. Retention is now eight, and the legacy-to-2.0 Electron migration regression asserts the baseline plus every named checkpoint and verifies that a second launch creates no extra backups.

## Draft refresh optimistic-version race

Severity: High workflow reliability

Status: [FIXED] [VERIFIED] in 2.0. After saving an edited invoice/payment draft, old list-row actions could briefly remain clickable while refreshed versions were loading, producing a false "modified in another window" conflict. Draft edit/delete/post actions now remain disabled until the refreshed record is committed. The end-to-end accountant workflow edits and immediately posts both sales and purchase drafts without retrying.
