# Wheat fix and implementation report

Audit baseline was completed and documented before product-code changes. Implementation then remained limited to the highest-priority verified defects; no accounting/tax meaning or unverified PNM positions were invented.

## Baseline verification

Issue / Feature: Repository-wide audit baseline  
Priority: Critical evidence gate  
Pre-fix status: N/A  
Root cause: N/A  
Affected files/components: Entire source/test/migration tree  
Implementation: No product code changed during baseline. The required audit, feature matrix, technical debt, roadmap, fix report, and security report were created first.  
Data/schema impact: None  
Tests added/updated: None at baseline  
Checks executed: `npm run lint`; `npm run build`; `npx playwright test --reporter=line`; `npm audit --json`; canonical database SHA-256 before/after.  
Runtime/end-to-end verification: 100 tests passed, 1 skipped at baseline.  
Post-fix result: [VERIFIED] baseline evidence gate  
Remaining risk: Findings below were then implemented and reverified.  
Blocked follow-up: PNM exact positions require authoritative evidence.

## Verified Sage 100 configurable TXT/CSV

Issue / Feature: Dedicated verified Sage TXT formatter, validator, profile controls, and export workflow  
Priority: High  
Pre-fix status: [BROKEN]  
Root cause: Sage formatting was embedded in a generic renderer exporter. Dates, decimals, piece numbers, header behavior, profile defaults, field validation, and PNM claims conflicted with the verified target profile.  
Affected files/components: `src/lib/sageTxt.ts`; Sage imports/constants/page in `src/App.tsx`; Sage input styling in `src/App.css`; `tests/sage-txt-unit.spec.cjs`; `tests/whole-app-regression.spec.cjs`.  
Implementation: Added an isolated ten-field Sage layer with DDMMYY dates, integer-cent comma amounts, collision-safe alphanumeric piece normalization, safe physical text, all supplied field limits, exactly ten fields/nine semicolons, exact per-entry/batch balance, dual-side checks, explicit journal/account mappings, fixed/variable account lengths, header-off default, optional header, CP1252/UTF-8, and shape-validated per-company profiles. The UI no longer permits arbitrary Sage column order or guessed PNM file creation.  
Data/schema impact: The initial Sage formatter change did not rewrite ledger data. The later checked post-audit migration adds a company-unique, versioned Sage profile; profile saves are audited and included in normal database backups.  
Tests added/updated: Six Sage contract tests cover every required example, all ten fields at maximum and maximum+1 width, empty positions, mappings, variable/fixed account rules, balanced/unbalanced exact cents, piece collisions, headers, French CP1252, and PNM blocking. The Electron regression creates a dedicated company/posted entry, maps its journal, inspects/downloads TXT/CSV/Excel, reloads the profile, and verifies PNM is disabled.  
Checks executed: targeted Sage tests 6/6; whole-app Electron test 1/1; full controlled suite 106 passed/1 skipped; lint/build pass.  
Runtime/end-to-end verification: Real Electron export files were read from disk and asserted field-by-field. No Sage installation was available, so external import is not claimed.  
Post-fix result: [FIXED] [IMPLEMENTED] [VERIFIED] locally  
Remaining risk: Target journal/account codes must already exist in the chosen Sage dossier. Profile durability and actual Sage-version import confirmation remain.  
Blocked follow-up: [BLOCKED — DOMAIN VERIFICATION] PNM needs an authoritative exact-position schema or known-good sample.

## PNM safety boundary

Issue / Feature: Prevent unverified PNM compatibility/output  
Priority: High  
Pre-fix status: [BROKEN] / [UNKNOWN]  
Root cause: Two concatenated 138/199-character layouts had no authoritative positions; prior tests checked only total length.  
Affected files/components: `src/App.tsx`; `src/lib/sageTxt.ts`; Sage unit/Electron tests.  
Implementation: Removed the guessed formatter from the reachable UI/export flow. PNM remains selectable only to expose the explicit domain-verification error; preview explains the blocker and the export button is disabled.  
Data/schema impact: None  
Tests added/updated: Unit validator assertion and Electron disabled-button/preview assertions.  
Checks executed: Included in the passing targeted and full suites.  
Runtime/end-to-end verification: Electron confirmed no PNM export action is available.  
Post-fix result: [FIXED] safety boundary; [BLOCKED — DOMAIN VERIFICATION] format implementation  
Remaining risk: None from the old guessed path; PNM functionality is intentionally unavailable.  
Blocked follow-up: Exact starts, lengths, alignment, padding, and formatters for the target PNM variant.

## Exact manual-entry and payroll inputs

Issue / Feature: Preserve intermediate decimal typing and calculate previews without floating point  
Priority: High / Medium  
Pre-fix status: [BROKEN]  
Root cause: Controlled inputs used `Number(event.target.value)` on every keystroke and renderer totals used JavaScript floating point.  
Affected files/components: `src/lib/exactDecimal.ts`; `EntryModal` and `EmployeeModal` in `src/App.tsx`; `tests/sage-txt-unit.spec.cjs`; `tests/whole-app-regression.spec.cjs`.  
Implementation: Amount fields now retain exact decimal text, accept comma/dot input, parse only for preview/submission, calculate totals/net with `BigInt` centimes, format exact MAD previews, and pass decimal strings to the existing exact backend parser.  
Data/schema impact: None. The backend/storage contract was preserved.  
Tests added/updated: Exact decimal helper tests plus visible Electron typing of `0.` then `0.01`, comma credit input, balanced draft save, salary `1000.` then `1000.01`, exact deduction/net, and employee save.  
Checks executed: Targeted tests, full suite, lint, and build all pass.  
Runtime/end-to-end verification: Both workflows completed through visible controls in a temporary Electron profile.  
Post-fix result: [FIXED] [VERIFIED]  
Remaining risk: Broader audit-matrix form coverage remains a roadmap item.  
Blocked follow-up: None.

## Ctrl+N editing guard

Issue / Feature: Do not open a new workflow while an editor owns focus  
Priority: Medium  
Pre-fix status: [BROKEN]  
Root cause: The global keydown handler ignored the event target.  
Affected files/components: keyboard helper/effect in `src/App.tsx`; `tests/whole-app-regression.spec.cjs`.  
Implementation: The handler still prevents the native Ctrl+N action, but exits for input, textarea, select, and contenteditable targets. Normal Ctrl+N outside an editor remains available.  
Data/schema impact: None  
Tests added/updated: Electron verifies retained search text, no Wheat modal, a single app window, then blurs the editor and successfully opens the draft modal with Ctrl+N.  
Checks executed: Whole-app Electron test and full suite pass.  
Runtime/end-to-end verification: Verified in the real Electron renderer.  
Post-fix result: [FIXED] [VERIFIED]  
Remaining risk: Full WCAG/RTL coverage remains separate; modal focus trapping/restoration is now implemented and Electron-verified.  
Blocked follow-up: None.

## Initial fix-pass verification

- `npm run lint`: passed.
- `npm run build`: passed. Existing Vite `__dirname`, large renderer chunk (~2.39 MB), and deprecated inline-dynamic-import warnings remain non-blocking technical debt.
- `npx playwright test --reporter=line --workers=4`: 106 passed, 1 intentionally skipped, 0 failed (107 total).
- A first default six-worker run hit the existing 120-second `beforeAll` contention timeout in the bounded-read test; the file then passed 2/2 alone and the entire four-worker suite passed.
- `prisma/dev.db` before/after SHA-256: `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8`.
- No dependency was added and no schema/data migration was performed.

## Post-audit technical and UI remediation

Issue / Feature: Repeated workspace/Sage loads and stale company bootstrap races  
Priority: High reliability  
Pre-fix status: [BROKEN]  
Root cause: `notify`, refresh adapters, and load callbacks changed identity across renders; Sage and child workspace effects depended on them. Concurrent company loads could also commit an older response after a newer selection.  
Affected files/components: `src/App.tsx`.  
Implementation: Stabilized notification, bootstrap, refresh, and operational adapters with callbacks; added monotonic request IDs so only the newest bootstrap may update UI/loading/recovery state.  
Data/schema impact: None.  
Verification: Lint hook rules, page traversal, company switching, Sage workflow, and the full Electron suite pass.  
Post-fix result: [FIXED] [VERIFIED].

Issue / Feature: Complete and exact dashboard KPIs  
Priority: High reliability  
Pre-fix status: [BROKEN]  
Root cause: renderer KPIs consumed capped 500-row bootstrap projections, used floating point, counted paid-late invoices as currently overdue, and treated partially settled invoices incorrectly. The dashboard also had no primary sidebar entry.  
Affected files/components: `electron/dashboard.ts`; bootstrap in `electron/main.ts`; metric rendering and navigation in `src/App.tsx`; `tests/dashboard-unit.spec.cjs`; whole-app regression.  
Implementation: Added complete company-scoped aggregate queries using integer cents, payment allocations and posted credit notes; excluded settled invoices from current overdue counts; rendered exact cents; added the missing dashboard navigation; lazy-loaded charts.  
Data/schema impact: Read-only queries only.  
Verification: Values above `Number.MAX_SAFE_INTEGER`, partial settlement, paid-late exclusion, no-company scope, and the real dashboard route/card are asserted.  
Post-fix result: [FIXED] [VERIFIED].

Issue / Feature: Durable Sage profile and membership integrity  
Priority: Medium integrity  
Pre-fix status: [BROKEN]  
Root cause: Sage mappings existed only in localStorage and `CompanyUser` lacked a composite uniqueness constraint.  
Affected files/components: Prisma schema; migration `20260820010000_post_audit_fixes`; runtime migration registry; main/preload/type IPC; Sage page; migration and Electron tests.  
Implementation: Added a versioned, company-unique Sage profile with validated mapping JSON and audited upsert; added `(companyId,userId)` uniqueness. Conflicting legacy roles fail transactionally instead of being guessed away.  
Data/schema impact: One additive table and one unique index; no ledger money or history rewrite.  
Verification: Exact migration checksum, foreign-key/integrity checks, isolated seven-migration reset/seed, duplicate/conflict tests, audited desktop save, and reload after deleting the browser cache.  
Post-fix result: [FIXED] [VERIFIED].

Issue / Feature: Accessible modal lifecycle  
Priority: Medium UI/accessibility  
Pre-fix status: [BROKEN]  
Root cause: overlays lacked consistent dialog naming/roles, Escape behavior, Tab containment, scroll locking, and trigger focus restoration.  
Affected files/components: `src/lib/useAccessibleDialog.ts`; App employee/entry/company/command/license modals; Books confirmation dialogs; whole-app regression.  
Implementation: Added one shared stack-aware hook and migrated all modal overlays. Native autofocus was replaced with controlled initial focus so the pre-dialog trigger can be restored correctly.  
Data/schema impact: None.  
Verification: Real Electron asserts dialog roles, intended initial focus, body scroll lock/unlock, Escape close, and restored employee trigger focus.  
Post-fix result: [FIXED] [VERIFIED].

Issue / Feature: Build performance/config and dependency advisory  
Priority: Medium performance / Low runtime security  
Pre-fix status: [BROKEN] / advisory open  
Root cause: renderer eagerly bundled ExcelJS, jsPDF/autotable, and Recharts; Vite config used `__dirname`; Prisma tooling resolved vulnerable `deepmerge-ts` 7.x.  
Affected files/components: `src/App.tsx`; `src/components/DashboardCharts.tsx`; `BooksWorkspace13.tsx`; `vite.config.ts`; package manifest/lockfile.  
Implementation: Dynamic export/chart imports, `import.meta.dirname`, and a tested `deepmerge-ts` 8.0.1 override.  
Data/schema impact: None.  
Verification: Initial renderer reduced from about 2.39 MB to about 705 KB before gzip; generate/build/migrate/full suite pass; `npm audit` reports zero vulnerabilities.  
Post-fix result: [FIXED] for eager heavy dependencies/config/advisory; App decomposition remains [PARTIAL].

Issue / Feature: Full-suite TypeScript-loader contention  
Priority: Medium engineering reliability  
Pre-fix status: [BROKEN intermittently]  
Root cause: the original fix changed only the bounded-read file, while 14 other specs still asynchronously compiled TypeScript/ESM dependency graphs. On Windows, any of these could stall a `beforeAll` for 30–120 seconds even though the same tests passed immediately alone.  
Affected files/components: all 15 TypeScript-loading unit specs under `tests/`.  
Implementation: Switched every remaining graph load to the synchronous scoped CJS transform supported by the same `tsx` package, removing the contended ESM-loader path without weakening assertions or increasing timeouts.  
Verification: All 30 spec files passed in fresh-process isolation; the normal four-worker suite then passed 111 with 1 intentional skip and 0 failures in 38.1 seconds.  
Post-fix result: [FIXED] [VERIFIED].

## Final post-audit verification

- `npm run lint`: passed.
- `npm run build`: passed; heavy XLSX/PDF/chart libraries are separate lazy chunks and the initial renderer is about 705 KB before gzip.
- `npx playwright test --reporter=line --workers=4`: 110 passed, 1 intentionally skipped, 0 failed (111 total).
- `npm audit --json`: 0 vulnerabilities.
- Seven-migration reset/seed, migration preservation, rollback-on-conflicting-membership, SQLite integrity, and foreign-key checks pass.
- `prisma/dev.db` was not rewritten by the implementation or test runs; its SHA-256 remains `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8`.

## Missed UI reliability follow-up

Issue / Feature: Global Ctrl+K interrupts active data-entry editors  
Priority: High UI reliability  
Pre-fix symptom: Ctrl+K could open the command palette while the user was typing in a billing/settings form.  
Root cause: unlike the already-fixed Ctrl+N path, the Ctrl+K handler did not classify editable event targets.  
Affected files/components: keyboard effect in `src/App.tsx`; follow-up Electron regression.  
Implementation: Editable inputs/textareas/selects/contenteditable elements now suppress the workflow shortcut. The top-bar search remains an explicit exception so the established command-palette behavior is preserved.  
Regression/runtime verification: An operational input keeps focus/value and opens no palette; the legacy desktop smoke confirms Ctrl+K still opens from top-bar search. [FIXED] [VERIFIED]

Issue / Feature: Operational draft loss, confirmation cleanup, and form semantics  
Priority: High UI/accessibility  
Pre-fix symptom: switching operational tabs could unmount an open invoice/payment/customer composer; the custom confirmation lacked the shared focus/scroll/restore lifecycle; entry/company creation did not have native Enter-submit semantics or duplicate-submit protection.  
Root cause: composer routing and confirmation state were local ad hoc controls, and two App modals were generic containers rather than forms.  
Affected files/components: `src/App.tsx`; `src/components/OperationalAccounting.tsx`; `src/lib/useAccessibleDialog.ts`.  
Implementation: Other operational tabs are disabled while composing; the confirmation uses the shared accessible hook/backdrop; nested cleanup restores the exact previous connected control; entry/company modals are semantic forms with busy-state guards.  
Regression/runtime verification: Electron creates and posts a sales invoice, saves an allocated payment, verifies disabled tabs, enters/exits the confirmation with focus/scroll/backdrop assertions, and submits company creation with Enter. [FIXED] [VERIFIED]

Issue / Feature: Stale async results overwrite newer UI/company state  
Priority: High data/UI reliability  
Pre-fix symptom: delayed operational, reconciliation, Books, compliance, or Sage responses could commit after a newer company/selection/edit; an older `finally` could clear a newer busy state.  
Root cause: loaders lacked request identity and Sage profile writes lacked company/edit-revision capture.  
Affected files/components: `src/App.tsx`; `src/components/OperationalAccounting.tsx`; `src/components/BooksWorkspace13.tsx`; `src/components/ComplianceWorkspace14.tsx`.  
Implementation: Added monotonic request IDs, company identity, and Sage edit-revision guards to result/error/finally commits; changing company/selection invalidates in-flight detail work.  
Regression/runtime verification: Delayed IPC injection proves a locally typed `USR` Sage journal mapping is not overwritten by late persisted `OLD`; company-switch/settings and reconciliation paths are guarded by the same request-scoped pattern. [FIXED] [VERIFIED]

Issue / Feature: Recoverable failures clear drafts or leak them across companies  
Priority: High UI reliability  
Pre-fix symptom: failed compliance adjustment/evidence/seal actions cleared typed fields, while unfinished account/journal/settings drafts could survive a company switch.  
Root cause: form resets ran unconditionally after caught service failures and configuration draft lifetime was not tied to company identity.  
Affected files/components: `src/components/ComplianceWorkspace14.tsx`; `src/components/BooksWorkspace13.tsx`.  
Implementation: Actions return success and clear only after confirmed success; selected detail/config is invalidated safely; all configuration drafts reset at the explicit company boundary.  
Regression/runtime verification: A forced seal failure leaves the typed note visible, displays the error, and re-enables retry; an incomplete account cannot leak into the next company. [FIXED] [VERIFIED]

Issue / Feature: Operational dark theme and minimum-width navigation accessibility  
Priority: Medium UI/accessibility  
Pre-fix symptom: the operational workspace kept light hard-coded surfaces/inputs in dark mode, and the collapsed 1120px sidebar exposed icon-only buttons without accessible names.  
Root cause: operational CSS did not map its local colors to `.dark` overrides, and nav labels were visually hidden without an explicit accessible name/title.  
Affected files/components: `src/components/OperationalAccounting.css`; sidebar buttons in `src/App.tsx`.  
Implementation: Added dark operational variables/surface/control/status overrides and explicit translated `aria-label`/`title` values for every navigation button.  
Regression/runtime verification: Electron runs at 1120x700, asserts the Tiers nav name, changes theme without losing the open customer form, and verifies computed dark shell/input colors. [FIXED] [VERIFIED]

Issue / Feature: Broader visible form reliability coverage  
Priority: Critical regression protection  
Affected files/components: new `tests/ui-reliability-followup.spec.cjs`; existing desktop/whole-app suites.  
Implementation: Added one isolated-company Electron matrix covering customer, sales invoice, payment allocation, operational confirmation, company creation, account/journal settings, Sage delayed load, compliance failure recovery, minimum-width navigation, dark theme, exact decimals, Delete/editor isolation, and renderer errors.  
Regression/runtime verification: The new test passes; the legacy desktop smoke and whole-app test pass; previously fixed manual-entry exact decimals, payroll exact decimals, and Ctrl+N editor isolation remain green. [VERIFIED]

## Final missed-fixes verification

- `npm run lint`: passed.
- `npm run build`: passed; initial renderer is about 708 KB before gzip and the existing >500 KB advisory remains non-blocking technical debt.
- `npx playwright test --reporter=line --workers=4`: 112 passed, 1 intentionally skipped, 0 failed (113 total) in 52.7 seconds after the viewport regression was added.
- `npm audit --json`: 0 vulnerabilities across 881 dependencies.
- All 30 spec files also passed in a fresh-process isolation diagnostic used to identify the loader contention.
- Canonical `prisma/dev.db` SHA-256 remained `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8` before and after implementation/testing.

## Viewport and layout overflow follow-up

Issue / Feature: Shell and sidebar extend below the usable viewport  
Priority: High UI reliability  
Pre-fix symptom: At the native 1120×760 minimum, the Chromium content viewport was 1104×721 but the sidebar's min-content height expanded the workspace to 848px. Lower navigation/content was clipped by the shell.  
Root cause: the fixed-height application grid used an implicit `auto` row and the sidebar did not permit vertical shrinking/scrolling.  
Affected files/components: shell/sidebar rules in `src/App.css`.  
Implementation: Added an explicit `minmax(0, 1fr)` shell row, `min-height: 0`, and sidebar-local vertical scrolling. The shell/workspace now remain exactly inside the content viewport while all navigation stays scroll-reachable.  
Regression/runtime verification: Electron asserts shell/sidebar/workspace bounds at nine gradual sizes and all zoom factors; route navigation continues to work at 125% zoom. [FIXED] [VERIFIED]

Issue / Feature: Saisie route children widen beyond the page  
Priority: High UI reliability  
Pre-fix symptom: At minimum width, the Saisie title/action bar/panels measured 1147px inside a 1007px page client area and were clipped about 143px past the right edge.  
Root cause: implicit grid auto tracks honored child min-content widths; `.page { overflow-x: hidden }` masked the overflow rather than preventing it.  
Affected files/components: stack/production/page-title layout rules in `src/App.css`.  
Implementation: Route grids now use `minmax(0, 1fr)` and their direct children/title copy explicitly permit shrinking with `min-width: 0` and `max-width: 100%`. Wide tables retain their own local scroll containers.  
Regression/runtime verification: The regression inspects actual page `scrollWidth`, element bounds, and scroll ancestry; no page-level hiding is accepted. [FIXED] [VERIFIED]

Issue / Feature: Settings bank mapping overflows at intermediate wide windows  
Priority: High UI reliability  
Pre-fix symptom: At 1536×864, the auto-fit Settings grid created four narrow ~300px cards; each bank mapping control extended 56px beyond the screen despite the window being wider than minimum.  
Root cause: a generic 300px card minimum was too small for the bank label/select/create-control layout, and its nested tracks/flex item retained intrinsic widths.  
Affected files/components: Settings and bank mapping rules in `src/App.css`.  
Implementation: Settings uses a safe responsive 420px card minimum, the mapping is a shrink-safe single-column grid, and labels/controls/selects can shrink within their card.  
Regression/runtime verification: Settings passes the complete size/zoom matrix, including the previously failing 1536px case. [FIXED] [VERIFIED]

Issue / Feature: Books nested forms ignore sidebar-adjusted available width  
Priority: High UI reliability  
Pre-fix symptom: At 1120×760/125% zoom, the CSS viewport was about 883px but Books had only ~789px after the Wheat sidebar/page padding. Its internal 222px rail did not collapse, clipping the fiscal-year form by 58px.  
Root cause: the Books breakpoint was 820px and watched the overall viewport instead of accounting for the parent shell's occupied width.  
Affected files/components: responsive breakpoint in `src/components/BooksWorkspace13.css`.  
Implementation: Books reflows its rail/workspace at 980px, before the remaining component width becomes unsafe.  
Regression/runtime verification: Every Books workspace, all eight report views, and all six reference areas pass at the tightest 125% zoom state. [FIXED] [VERIFIED]

Issue / Feature: Permanent route-wide viewport regression  
Priority: Critical regression protection  
Affected files/components: new `tests/viewport-layout-regression.spec.cjs`.  
Implementation: The Electron test visits all 13 major routes at 1120×760, 1160×760, 1200×768, 1280×800, 1366×768, 1440×900, 1536×864, 1600×900, and 1920×1080. Each route is also checked at 80%, 90%, 100%, 110%, and 125% zoom at minimum/common laptop widths. Deep operational forms, reconciliation inspector, compliance sections, Books workspaces/reports/reference areas, and entry/employee/company dialogs run at 1120×760/125%.  
Verification criteria: no document/body/page horizontal overflow; shell/sidebar/workspace remain inside the viewport; no visible element escapes unless contained by a legitimate local horizontal scroller; fixed/large dialogs remain inside the viewport and scroll internally when needed; renderer errors remain empty.  
Post-fix result: [FIXED] [VERIFIED].

## Final viewport-pass verification

- `npm run lint`: passed.
- `npm run build`: passed.
- Critical Electron group (desktop smoke, UI reliability, viewport matrix, whole-app): 4 passed.
- `npx playwright test --reporter=line --workers=4`: 112 passed, 1 intentionally skipped, 0 failed (113 total) in 52.7 seconds.
- `npm audit --json`: 0 vulnerabilities across 881 dependencies.
- Canonical database SHA-256 remains `8306E3FB62E86B786BDCE3E267A2D0C29EC7247F586182C35E3B39C17EBF1FA8`.

## Wheat 2.0 runtime accountant and bank-import pass

Issue / Feature: Multi-format bank statements were selected and persisted before a complete review workflow  
Priority: Critical accounting safety and usefulness  
Pre-fix symptom: The bank action depended on generic renderer CSV/XLSX helpers, lacked a reusable format architecture, practical banking formats, unified result counts, and a complete pre-persistence validation/report step.  
Root cause: Parsing, mapping inference, and the final import action were coupled across the renderer and reconciliation call.  
Affected files/components: `electron/bankStatementImporter.ts`; reconciliation service/IPC; main/preload/type boundary; `src/App.tsx`; operational bank history UI/CSS; Prisma schema and `20260820180000_bank_import_2_0`; parser/migration/Electron tests.  
Implementation: Added content-aware parser adapters for CSV, TXT, XLSX, OFX, QIF, MT940, CAMT.053, and constrained selectable-text PDF. Every adapter produces one tabular/normalized review contract. Users see format, mapping, preview, row errors, warnings, currency mismatch, duplicates, and ready count before an atomic transaction. Import history records format/import/skipped/error/duplicate counts.  
Regression/runtime verification: Controlled fixtures cover French decimals, accents, CP1252, multiple date shapes, signed and split amounts, renamed XLSX detection, 1,000 rows, malformed rows, corrupt inputs, duplicate file/transaction fingerprints, restart persistence, and reconciliation. The real Electron path imported nine supported-format statements and reopened all nine after restart. [FIXED] [VERIFIED]

| Format | Result | Verification / limit |
|---|---|---|
| CSV | Implemented | Unit + Electron; signed and Debit/Credit layouts |
| TXT | Implemented | Unit + Electron; semicolon/tab plus shared comma/pipe parser |
| XLSX | Implemented | Unit + Electron; content signature survives rename |
| XLS | Safely unsupported | Binary signature detected; unit + Electron rejection with conversion guidance |
| OFX | Implemented | Unit + Electron generic fixture |
| QIF | Implemented | Unit + Electron generic fixture |
| MT940 | Implemented | Unit + Electron standard transaction fixture |
| CAMT.053 | Implemented | Unit + Electron ISO 20022 fixture |
| PDF text | Constrained implementation | Unit, render inspection, and Electron for recognizable delimited text/table |
| PDF scan/ambiguous | Safely unsupported | Unit failure paths; no OCR/table guessing |

Issue / Feature: Electron crashed before opening after the first XLSX parser implementation  
Priority: Critical runtime  
Root cause: Static ExcelJS bundling emitted CommonJS `require("crypto")` inside the ESM Electron main bundle.  
Affected files/components: `electron/bankStatementImporter.ts`; Electron production bundle.  
Implementation: Load ExcelJS through `createRequire(import.meta.url)` inside the Node main process.  
Regression/runtime verification: Production build completes with a roughly 578 KB main bundle; the real app launches and imports XLSX. [FIXED] [VERIFIED]

Issue / Feature: Fresh profiles opened with a missing bank-history column  
Priority: High runtime/data migration  
Root cause: The Prisma migration existed on disk but was initially omitted from Wheat's embedded checksummed runtime migration registry.  
Affected files/components: `electron/database.ts`; 2.0 migration test.  
Implementation: Registered the exact raw SQL and SHA-256 digest, extended startup schema identity to 2.0.0, and verified an in-place legacy import-history upgrade.  
Regression/runtime verification: Fresh Electron profiles and upgraded fixtures expose all history columns; integrity and foreign-key checks pass. [FIXED] [VERIFIED]

Issue / Feature: Edited draft could immediately post with a stale optimistic version  
Priority: High workflow reliability  
Root cause: The composer closed before the list refresh committed, briefly exposing old row action closures.  
Affected files/components: operational invoice/payment draft actions; accountant runtime regression.  
Implementation: Edit/delete/post actions stay disabled while any operational mutation/refetch is active. Backend version checks remain strict.  
Regression/runtime verification: The accountant scenario edits and immediately posts sales and purchase invoices without false conflicts. [FIXED] [VERIFIED]

Issue / Feature: Eighth migration pruned the original recovery baseline  
Priority: High recovery reliability  
Root cause: Migration-backup retention remained fixed at seven after 2.0 added the eighth checkpoint.  
Affected files/components: `electron/database.ts`; migration integrity tests.  
Implementation: Retain eight checkpoints and reconstruct pre-migration test fixtures explicitly instead of depending on the mutable development database state.  
Regression/runtime verification: Legacy Electron migration retains baseline plus all named checkpoints, applies exactly eight migrations, and is idempotent on second launch. [FIXED] [VERIFIED]

Issue / Feature: Bank review at laptop width and zoom  
Priority: High UI reachability  
Implementation: The modal uses shrink-safe tracks, viewport-bounded width/height, internal vertical scroll, and preview-local horizontal scrolling.  
Regression/runtime verification: The full route audit now includes the bank dialog with a deliberately wide row at 1120×760 and 80/90/100/110/125% zoom; no document/page overflow or unreachable dialog bounds occur. [FIXED] [VERIFIED]

## Final Wheat 2.0 verification

- `npm run lint`: passed.
- `npm run build`: passed; Electron main bundle is about 578 KB before gzip and launches successfully.
- `npx playwright test --reporter=line --workers=1`: 126 passed, 1 intentionally skipped, 0 failed (127 discovered) in 3.1 minutes.
- Dedicated 2.0 parser/migration/accountant/bank-Electron group: 14 passed; the previously failing migration/race rerun group: 13 passed.
- `npm audit --json`: 0 vulnerabilities across 881 dependencies.
- `prisma/dev.db`: eight completed migrations, `PRAGMA integrity_check=ok`, zero foreign-key violations. The final packaging reset seed has SHA-256 `0A5A5BFD9AB4AF1BDDA22FE43DA893FE76ED8693CDE0771EF9956EC96FB42C20`.
- Version identity: `package.json`, lockfile root, runtime startup marker, and in-app fallback are `2.0.0`.
- Runtime errors observed and fixed: ExcelJS/ESM startup crash and missing embedded 2.0 migration. Final accountant and bank-import Electron runs recorded no meaningful renderer/page errors.

## Windows 2.0.0 release artifact correction

Issue / Feature: Top-level Windows packages still contained the prior 1.4 build  
Priority: Critical release correctness  
Root cause: Updating `package.json` changed future package metadata but did not rebuild `release/`; artifact names also omitted the version, making stale packages indistinguishable.  
Implementation: Installer and portable artifact names now include `${version}`. Existing 1.4 artifacts were moved to `release/legacy-1.4.0/`; fresh NSIS, portable, unpacked, and source packages were generated from the 2.0.0 source and eight-migration seed. The source archive excludes `.env`, build outputs, and release payloads.  
Verification: Installer and portable Windows `FileVersion`/`ProductVersion` are `2.0.0`; `release/win-unpacked/Wheat.exe` is `2.0.0.0`; a packaged runtime launch returned `appVersion: 2.0.0`; all SHA-256 manifest entries match. The executables are not Authenticode-certified because no publisher certificate is configured. [FIXED] [VERIFIED]

## Windows 2.0.1 PaddleOCR primary release

Issue / Feature: PaddleOCR was packaged and preferred, but a lower heuristic score could still make Tesseract the selected document result.  
Priority: High OCR/release correctness  
Implementation: PaddleOCR 3.7 is now the authoritative OCR path whenever it returns usable text: PP-OCR handles ordinary documents and PP-StructureV3 handles scanned bank tables. Tesseract.js is invoked only when PaddleOCR is unavailable, fails, or returns no usable text. Package metadata, runtime OCR identity, startup diagnostics, in-app version fallback, tests, and release documentation are aligned on `2.0.1`.  
Verification: Lint and the production build pass; the full suite finishes with 129 passed, 2 intentionally skipped, and 0 failed. The real eight-fixture OCR regression completes in 46.5 seconds after mobile-model optimization, and the dedicated primary-engine regression requires a successful Paddle result to expose exactly one OCR candidate—the PaddleOCR candidate. Installer, portable, source, and unpacked artifacts were generated in `release/2.0.1`; Windows metadata reports 2.0.1, the packaged worker reports PaddleOCR 3.7.0/PaddlePaddle 3.3.1/Python 3.12.10, the isolated packaged UI health test passes, both compressed executables pass a complete 7-Zip payload test, and every SHA-256 manifest entry verifies. The executables remain unsigned because no publisher certificate is configured. [FIXED] [VERIFIED]
