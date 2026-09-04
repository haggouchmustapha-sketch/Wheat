# Wheat roadmap

## NOW

1. [DONE — FIXED/VERIFIED] Verified Sage 100 configurable TXT formatter/validator: fixed fields, DDMMYY, comma decimals, safe piece numbers, field limits, exact batch balance, explicit mappings, header off, CP1252, and tests.
2. [DONE — BLOCKED SAFELY] Prevent unverified PNM compatibility claims; the export is blocked until authoritative exact positions are supplied.
3. [DONE — FIXED/VERIFIED] Manual-entry and payroll decimal reliability now uses preserved text and integer-cent previews.
4. [DONE — FIXED/VERIFIED] Global Ctrl+N no longer opens a workflow from an active editor; visible Electron coverage was added.
5. [DONE — VERIFIED] Wheat 2.0 lint/build pass; 126 tests pass, 1 is intentionally skipped, and 0 fail with the stable single-worker release gate; SQLite integrity/foreign keys and the current package version are verified.
6. [DONE — FIXED/VERIFIED] Dedicated exact full-company dashboard aggregates cannot be truncated by bootstrap limits.
7. [DONE — FIXED/VERIFIED] Versioned Sage company profiles/mappings persist in SQLite, backups, and the audit log; stale loads cannot overwrite newer edits/company state.
8. [DONE — FIXED/VERIFIED] Missed UI reliability pass: operational form-loss guard, App/Books/operational dialog lifecycle, request-scoped async state, recoverable error drafts, dark operational controls, named collapsed navigation, and stable full-suite TypeScript loading.
9. [DONE — FIXED/VERIFIED] Viewport/layout pass: shell/sidebar height containment, shrink-safe route grids, responsive Settings/bank controls, Books remaining-width breakpoint, and route-wide 80–125% zoom/gradual-resize coverage.
10. [DONE — FIXED/VERIFIED] Wheat 2.0 multi-format bank import: CSV/TXT/XLSX/OFX/QIF/MT940/CAMT.053/selectable-text PDF, review/mapping, atomic validation, duplicate protection, unified history, restart persistence, and reconciliation.
11. [DONE — FIXED/VERIFIED] Real-Electron accountant simulation: customer/supplier, sales/purchase drafts and posting, allocated receipt, books/trial balance/dashboard consistency, and full restart persistence.
12. [DONE — FIXED/VERIFIED] Runtime release defects found by the 2.0 gate: ExcelJS main-process startup crash, missing embedded migration registration, stale draft-version action window, and migration-backup retention.

## NEXT

1. Evaluate database-level posted-entry and cross-company hardening with reversible migrations.
2. [DONE — FIXED/VERIFIED] Add `CompanyUser(companyId, userId)` uniqueness before multi-user expansion.
3. Complete cash vouchers/petty cash and document attachment workflows.
4. Add verified bank-specific presets from real redacted samples; expand bank fees/transfers and payment-evidence matching. Core generic import/history/atomic rollback UX is complete.
5. Complete company identity/fiscal/tax/document settings and safe company archiving/duplication.
6. Build dedicated customer/supplier statements, merge/import/export, supplier defaults, and evidence history.
7. [PARTIAL — CORE FIXED/VERIFIED] Shared accessible dialog behavior and deeper form/focus/theme/minimum-width tests are complete; finish the full RTL/WCAG route matrix.
8. Incrementally split `App.tsx` and lazy-load heavy export/visual modules.

## LATER

1. Analytical dimensions and allocations.
2. Fixed assets and depreciation.
3. Import/customs dossiers and landed cost.
4. Foreign-currency rates, base amounts, and gain/loss accounting.
5. Products/services, devis, orders, delivery notes, and conversion chain.
6. Bilan, CPC, ESG, financing/cash-flow statements, mappings, comparisons, and drill-down.
7. Complete closing and year-end carry-forward production.
8. Durable notifications, review assignments, comments, and document requests.
9. Real identity, roles, permissions, and encrypted deployment guidance for cabinet use.

## FUTURE

1. RAS TVA/IS/IR, VAT prorata, non-resident cases, payment-delay declarations, and liasse fiscale after authoritative domain verification.
2. Official XML/EDI generation and user-controlled DGI/SIMPL workflows after current specifications and security design are supplied.
3. Client portal and collaboration services.
4. Explainable account/tax coding suggestions, anomaly detection, reconciliation learning, and cash forecasting.
5. Mobile/remote architecture only if Wheat deliberately moves beyond the trusted local desktop model.

## Top 10 implementation order

| Order | Item | Scope | Dependencies | Current status | Verification |
|---|---|---|---|---|---|
| 1 | Sage 100 TXT compatibility | Medium | Verified spec supplied | Fixed; locally verified | Contract unit tests plus TXT/CSV Electron export pass; real Sage import remains |
| 2 | Manual-entry exact input | Small | Existing string parser | Fixed | Visible `0.` → `0.01` typing and save pass |
| 3 | PNM safety block | Small | Authoritative schema absent | Fixed safety boundary / domain blocker | Validator and disabled-export UI tests pass |
| 4 | Shortcut editing guard | Small | None | Fixed | Editor, modal, text, and window-count keyboard assertions pass |
| 5 | Persistent Sage configuration | Medium | Migration/IPC | Fixed | Backup/restore/migration/audit plus stale-load Electron tests pass |
| 6 | Posted-ledger DB hardening | Large | Migration design | Next | Migration/integrity suite |
| 7 | Complete dashboard aggregates | Medium | Reporting IPC | Fixed | Exact large-book aggregate and real dashboard-route tests pass |
| 8 | Authentication/permissions | Large | Product deployment decision | Later | Security/permission tests |
| 9 | Financial production | Large | Mapping/domain design | Later | Golden accounting statements |
| 10 | Advanced Moroccan tax | Large | Authoritative domain rules | Blocked — domain verification | Accountant/official-format fixtures |
