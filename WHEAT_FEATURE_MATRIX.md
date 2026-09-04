# Wheat feature matrix

Status reflects the audited 2.0.1 state after the bounded fixes recorded in `WHEAT_FIX_REPORT.md`. “WORKING” means an end-to-end implementation is supported by code and tests, not merely a visible route. Sage TXT is described as locally verified; a real Sage 100 import remains an external verification step.

| Area | Feature | Status | Evidence | Missing | Priority |
|---|---|---|---|---|---|
| 1. Companies | Multiple companies, switching, isolation, identity, fiscal setup | PARTIAL | Company-scoped schema/services; create/switch/delete UI; cross-company tests pass | Full legal/contact/tax fields, archive, duplicate config, setup import | High |
| 2. Chart of accounts | CGNC-oriented accounts and maintenance | PARTIAL | Company-unique codes, settings CRUD/archive, usage checks | Hierarchy, opening balances workflow, tax links, dedicated import/export/suggestions | High |
| 3. Journals | Standard/custom journals, numbering, locks, reports | PARTIAL | Company-unique journals, settings CRUD/archive, posting sequence, reports | Allowed-account rules and richer journal-specific controls | High |
| 4. Journal entries | Draft, post, exact balance, reverse, lock, audit, export | WORKING | Main/operations services and integrity suite; visible `0.`/`0.01` exact-input/save regression passes | Bulk post/reverse and richer attachment selection | Critical |
| 5. Documents / GED | Managed upload, preview, hashes, OCR, links, delete | PARTIAL | Document model, managed provenance, OCR UI, backup inclusion | Multi-file UX, archive/restore lifecycle, broader categories/search | High |
| 6. OCR | PDF/image/text OCR, extraction, confidence, review | PARTIAL | Tesseract/PDF/Sharp service; OCR tests pass | Learning, extraction revision history, explicit reprocess workflow | Medium |
| 7. Purchase invoices | Draft/lines/VAT/post/void/credit/payment/OCR handoff | PARTIAL | Subledger, operational UI, artifact and OCR atomicity tests | Advanced Moroccan purchase cases, import dossier/analytics, FX accounting | High |
| 8. Sales invoices | Draft/lines/VAT/post/PDF/credit/payment/status | PARTIAL | Subledger, immutable artifact/credit tests, and visible exact-decimal create/post regression | Templates/logo/email, advanced FX/RAS/special cases | High |
| 9. Commercial chain | Product, quote, order, delivery, invoice conversion | MISSING | Only invoice and credit-note domain objects exist | Products/services, devis, order, delivery note, conversions | Later |
| 10. Customers | Identity, accounts, invoices, payments, aging | PARTIAL | Counterparty CRUD, receivable defaults, aging/statement reports, and visible create regression | Merge, dedicated import/export, notes/activity view | High |
| 11. Suppliers | Identity, accounts, invoices, payments, aging | PARTIAL | Counterparty CRUD, payable defaults, aging/statement reports | RAS/certificate/RIB/default expense/VAT treatment, merge/import/export | High |
| 12. Bank accounts | Multiple accounts, currency, ledger mapping, movements | PARTIAL | BankAccount model/settings/mapping and reconciliation UI | Journal link, robust balance model, richer account identity | High |
| 13. Statement import | Multi-format detection, mapping, review, validation, atomic import, dedupe, history | PARTIAL | CSV/TXT/XLSX/OFX/QIF/MT940/CAMT.053/selectable-text PDF parser registry; parser and real Electron restart/reconciliation tests | Binary XLS, scanned/ambiguous PDF, saved bank presets, real bank samples | High |
| 14. Reconciliation | Suggested/manual partial matching with immutable history | PARTIAL | Candidate scores, allocations, void/exclude/restore; tests pass | Direct invoice matching UX, FX/fees/transfers, multi-line UI breadth | High |
| 15. Payments | Draft/post/void, methods, partial/multiple allocations | PARTIAL | Payment service/UI, settlement tests, and visible comma-decimal allocation/save regression | Attachment UI and broader overpayment/credit-balance handling | High |
| 16. Card processors | Generic CMI/NAPS settlement workflow | MISSING | No processor entity/service | Gross/fee/net settlement and reconciliation | Later |
| 17. Cash | Petty cash/vouchers/control | MISSING | Cash journal can be represented only by manual entries | Voucher workflow, evidence, balance/control | Next |
| 18. Analytical accounting | Dimensions and allocations | MISSING | No analytic model | Dimensions, splits, reporting | Later |
| 19. Import/customs dossiers | Landed-cost dossier | MISSING | No dossier model | Complete grouped import-cost workflow | Later |
| 20. Foreign currency | Original currency/rate/gain-loss | PARTIAL | Currency stored on invoices/payments/bank accounts | Exchange rate snapshots, base conversion, realized/unrealized differences | Later |
| 21. VAT | Versioned collection-basis workpapers | PARTIAL | Compliance service/UI; exact workpaper tests pass | Debit basis, prorata, customs, official export validation | High |
| 22. RAS TVA | Eligibility, certificates, withholding, declaration | MISSING | No verified domain model | Entire domain-verified workflow | Blocked domain |
| 23. RAS IS / IR | Withholding calculation/declaration | UI ONLY | Limited informational helpers/labels | Evidence-backed rules, entries, periods, exports | Blocked domain |
| 24. Tax declarations | Draft/review/file record/archive | PARTIAL | VAT workpaper lifecycle and manual external-filing record | IS/IR/RAS/other declarations and official formats | High |
| 25. DGI / SIMPL | File generation/direct filing | MISSING | No credentials or filing automation | Verified XML/EDI and secure user-controlled integration | Blocked domain |
| 26. Fixed assets | Asset register and depreciation | MISSING | No asset model | Full acquisition/depreciation/disposal workflow | Later |
| 27. Prepaids/cut-off | Period allocation and reversal | MISSING | Manual entries only | Schedules and generated reversals | Later |
| 28. Aging | Receivable/payable aging and statements | WORKING | Exact cutoff-aware reporting; automated tests | UI polish and broader drill-down | High |
| 29. Payment delays | Due dates, overdue tracking, declaration prep | PARTIAL | Due dates/aging and basic export helper | Legally verified statutory declaration logic | Blocked domain |
| 30. General ledger | Exact ledger, filters, running balance, export | WORKING | Reporting service/books UI/tests | Minor print/customization polish | Critical |
| 31. Trial balance | Opening/period/closing exact balances | WORKING | Reporting service/books UI/tests | Minor presentation options | Critical |
| 32. Financial statements | Bilan, CPC, ESG, comparisons | MISSING | No complete mapping/statement engine | Full statement production and drill-down | High |
| 33. Liasse fiscale | Moroccan fiscal package | MISSING | No forms/cross-form engine | Authoritative forms, validation, exports | Blocked domain |
| 34. Dashboard | Operational KPIs and drill links | PARTIAL | Dedicated exact full-company aggregates feed real cards/queues | Broader drill-down and KPI breadth | Medium |
| 35. Cash flow | Position and forecast | MISSING | Bank balances/due dates exist separately | Unified treasury and 30/60/90 forecast | Later |
| 36. Reporting | Books, aging, statements, integrity | PARTIAL | Reporting service and exports pass tests | Financial/tax/analytic/commercial report breadth | High |
| 37. Exports | CSV/XLSX/PDF and domain exports | PARTIAL | Multiple renderer export paths; complete report traversal | XML/EDI, consistent locale rules, more modules | High |
| 37A. Sage | Sage TXT/CSV/PNM profiles | PARTIAL | Dedicated ten-field TXT/CSV formatter, validator, mapping UI, CP1252, durable audited SQLite profile, and unit/E2E tests pass | Real Sage import confirmation; authoritative PNM schema | High |
| 38. Imports | Controlled ledger and multi-format bank imports | PARTIAL | Ledger staging plus bank parser/review/history pipeline; exact validation and atomic persistence | Broader master-data/document imports and verified bank-specific presets | High |

| 39. Search | Entry/page-local search and command palette | PARTIAL | Topbar/page filters and palette | True global multi-entity search/autocomplete | Medium |
| 40. Users | User profiles and lifecycle | PARTIAL | User/CompanyUser models; local profile rename | Real create/invite/deactivate/authentication workflow | Later |
| 41. Roles/permissions | Company roles/admin gates | BACKEND ONLY | Role fields and selected admin checks | Authenticated multi-user enforcement and UI | Later |
| 42. Client portal | External collaboration portal | MISSING | No server/portal architecture | Entire feature | Future |
| 43. Comments | Collaboration/comments/review requests | MISSING | No comment model | Entire feature | Future |
| 44. Audit log | Activity history and hash chain/seals | WORKING | Audit13/compliance services, UI, tamper tests | External notarization intentionally absent | Critical |
| 45. Period closing | Period lock and controlled fiscal close/reopen | WORKING | FiscalYear locks, close previews/hashes/seals, tests | Year-end carry-forward/financial production | Critical |
| 46. Numbering | Entry and sales/credit sequences | PARTIAL | Transactional company/year numbering and collision tests | All future commercial document types/settings UI | High |
| 47. Notifications | Durable reminders/alerts | UI ONLY | Toasts and dashboard warnings | Persistent tasks, deadlines, delivery/preferences | Later |
| 48. Security | Electron boundary, PIN, local data protection | PARTIAL | Boundary/local-lock/archive tests pass; dependency audit is clean | Real auth/authz and encryption at rest | Critical |
| 49. Backup/recovery | Complete managed archive and staged restore | WORKING | Manifest/hash/path/rollback tests pass | Automated off-device scheduling | Critical |
| 50. Performance | Bounded reads and large-book behavior | PARTIAL | Stable cursors; complete dashboard aggregates; lazy XLSX/PDF/chart chunks; 70-row UI scroll regression | Production-volume benchmarks and further App decomposition | Medium |
| 51. Mobile/responsive | Reduced-width/tablet/mobile UI | PARTIAL | All 13 routes pass gradual 1120–1920px resizing and 80–125% zoom; deep tabs/forms/reports/dialogs pass at 1120px/125%; shell/sidebar/page bounds and hidden overflow are asserted | True tablet/mobile remains outside the packaged minimum; full RTL visual QA remains | Later |
| 52. Accessibility/UX | Keyboard, labels, focus, dialogs | PARTIAL | App/Books/operational dialog lifecycle; exact nested focus restore; Ctrl+N/Ctrl+K editor guards; broader form/Enter/error recovery verified in Electron | Full WCAG/RTL audit and remaining route/form coverage | Medium |
| 53. Localization | French, English, Arabic/RTL | PARTIAL | Language setting, nav/page copy, root direction | Many untranslated strings and full RTL/local-format QA | Medium |
| 54. AI/automation | Explainable OCR/suggestions/local analysis | PARTIAL | OCR confidence/reasons and deterministic matching | Learning, anomaly ML, forecasts/predictions | Later |
| 55. Anomaly detection | Integrity/duplicate/outlier warnings | PARTIAL | Integrity checks, duplicate imports/documents/invoices | Broader severity center and behavioral anomalies | High |
| 56. Data integrity | Constraints, exact money, isolation, immutability | PARTIAL | BigInt, FKs, transactions, membership uniqueness, integrity tests | DB-level posted-entry/cross-company hardening | Critical |
| 57. Testing | Unit/integration/migration/Electron/OCR/UI tests | WORKING | 126 passed, 1 intentionally skipped, 0 failed; accountant and multi-format bank restart scenarios, migration, OCR, async races, dialogs, themes, resizing, and zoom included | Legal tax fixtures, real bank samples, and production-volume benchmarks | Critical |

## Wheat 2.0 bank-statement format matrix

| Format | Implementation status | Unit tested | Real Electron tested | Duplicate tested | Limits |
|---|---|---:|---:|---:|---|
| CSV | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Signed Amount or separate Debit/Credit; editable mapping |
| TXT/delimited | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Semicolon, comma, tab, or pipe; UTF-8/Windows-1252 |
| XLSX | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | First usable worksheet; mapping remains reviewable |
| XLS | UNSUPPORTED SAFELY | Yes (rejection) | Yes (rejection) | N/A | Binary XLS is detected and requires conversion to XLSX/CSV |
| OFX | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Generic statement transactions; real bank variants still need samples |
| QIF | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Bank transaction records; real exporter variants still need samples |
| MT940 | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Standard `:61:`/`:86:` transaction records; bank dialects need samples |
| CAMT.053 XML | IMPLEMENTED + VERIFIED | Yes | Yes | Yes | Generic ISO 20022 statement entries; bank dialects need samples |
| PDF selectable text | IMPLEMENTED, CONSTRAINED + VERIFIED | Yes | Yes | Yes | Only recognizable delimited text/table layouts |
| PDF scanned/ambiguous | UNSUPPORTED SAFELY | Yes (rejection) | Failure path tested | N/A | No bank-table OCR guessing; export CSV/OFX/CAMT instead |

## Sage requirement detail

| Area | Feature | Status | Evidence | Missing | Priority |
|---|---|---|---|---|---|
| Sage TXT | Fixed 10-column order | WORKING | `src/lib/sageTxt.ts` fixes order; tests assert ten fields/nine semicolons and empty positions | Real Sage import confirmation | High |
| Sage TXT | DDMMYY | WORKING | Central UTC day formatter; required examples pass | Real Sage import confirmation | High |
| Sage TXT | Comma decimals | WORKING | Integer-cent formatter emits comma and exactly two decimals | Real Sage import confirmation | High |
| Sage TXT | Piece sanitization and collision detection | WORKING | Alphanumeric normalization plus blocking batch collision validation | Real Sage import confirmation | High |
| Sage TXT | Field length/structure validation | WORKING | All ten maxima, required fields, physical lines, controls, dual sides, and exact balance tested | Real Sage import confirmation | High |
| Sage profile | Journal/account mapping and account length | WORKING | Explicit mappings/fixed-or-variable length; versioned company-unique SQLite persistence; audited save; backup/reload regression | Real Sage dossier confirmation | High |
| Sage profile | Header off | WORKING | Default false; optional header toggle and tests | Real Sage import confirmation | High |
| Sage encoding | Windows-1252 | WORKING | Dedicated CP1252 path preserves tested French text; unsupported characters become `?` | Real target-version confirmation | Medium |
| Sage PNM | Exact fixed positions | UNKNOWN | Export is now blocked and no compatibility claim is shown | Authoritative schema/sample | Blocked domain |
