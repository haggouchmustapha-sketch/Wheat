# Wheat 1.3 release notes

Wheat 1.3 is the trustworthy-books release. It preserves the exact-cent operational accounting and complete backup foundation from 1.2 while replacing demo-style reporting and import shortcuts with bounded, auditable workflows.

## Accounting books and exports

- Entries, trial balance, general ledger, journal, aged receivables, aged payables, counterparty statement, and integrity checks are calculated in the main process from SQLite.
- Posted and reversed evidence is included; drafts are explicitly excluded.
- Monetary outputs remain integer-cent strings across IPC, including values above JavaScript's safe integer range.
- Stable cursors are tied to their filters and reject tampering or reuse with another query.
- On-screen pages are bounded. “Complete” XLSX/PDF exports retrieve every cursor page, reject cursor loops, and stop at a stated safety limit rather than exporting an undisclosed partial result.
- Sage export reads the complete posted/reversed set through a dedicated query, uses historical journal/account snapshots, formats exact cent strings, and rejects amounts wider than the selected fixed-width profile.

## Controlled imports

- Wheat no longer guesses accounts, totals, or balancing lines from a spreadsheet.
- A user maps every required column, previews every source row, and stages the file before any entry is created.
- Validation checks exact amounts, active accounts and journals, fiscal dates, group headers, duplicate source rows, and debit/credit balance for every proposed entry.
- The original managed source, SHA-256, mapping, raw rows, normalized rows, fingerprints, validation results, and resulting draft links are retained.
- Confirmation re-reads and hashes the managed source. A missing or changed source prevents draft creation.
- Source bytes and the selected sheet/mapping/row scope receive separate hashes. A different scope from the same workbook can be staged independently; a reviewed or cancelled scope can be resumed only as an explicit linked revision. Wheat still blocks a second confirmation of already imported evidence.

## Referential maintenance and corrections

- Company, fiscal-year, account, journal, and bank-account edits use optimistic versions.
- Historical journal/account codes and labels are snapshotted on entries and lines.
- Used identifiers cannot be silently rewritten. Archiving blocks future use but does not delete history.
- Draft entries can be corrected with exact cent inputs. Posted entries retain reversal-only correction semantics.
- Posted payroll runs retain employee snapshots and can be corrected only by a dated, reasoned, exact reversal entry.

## Audit and document evidence

- Each company has a local SHA-256 event chain with canonical JSON, monotonically increasing sequence numbers, previous hashes, and verification.
- Existing 1.2 `ActivityLog` rows migrate as `IMPORTED_UNSEALED` and have no invented hashes. The first genuine 1.3 event begins the verifiable segment.
- Company creation, profile changes, settings, ledger lifecycle actions, subledger actions, reconciliation, imports, payroll corrections, and OCR imports append evidence through the trusted main process.
- OCR-managed documents store content SHA-256, MIME type, and byte size. Their database rows and audit event are created in one database transaction after local processing.
- This chain is local tamper detection only. It has no trusted timestamp, external witness, qualified signature, or authority certification.

## Runtime and data safety

- Dashboard/bootstrap collections are capped and disclose their limits. Exact books use dedicated queries.
- Packaged builds ignore development renderer and alternate-profile environment variables.
- IPC accepts only the trusted main web contents, main frame, and local renderer location. Popups, webviews, unexpected navigation, subframes, and permissions are denied.
- Complete `.atlasbackup` archives include referenced OCR documents, source bank statements, and managed ledger-import sources. Wheat verifies each managed file against the SHA-256/size stored in SQLite before backup and after staged restore, in addition to archive-manifest verification. Restore retains the maintenance gate, rollback, and recovery behavior from 1.2.

## Migration

- Migrations: `20260813090000_atlas_1_3_integrity_imports` and additive `20260814010000_atlas_1_3_import_revisions`
- Entry lines receive deterministic positions and immutable account snapshots.
- Entries receive journal snapshots and optimistic versions.
- Operational entities receive active/version fields where required.
- Ledger import, bank import profile, audit chain/event/seal, document fingerprint, and payroll correction storage is added without guessing old links.
- Saved 1.2 databases were tested through the migration with exact 64-bit cent totals, links, foreign keys, and SQLite integrity preserved.

## Honest limitations

- Wheat is not DGI-, CNSS-, or authority-certified and does not file declarations or connect to an official electronic-invoicing API.
- The 1.3 TVA screen is historical tracking only. It does not determine the applicable regime, collection/debit exigibility, rate, deduction eligibility, or filing values.
- Payroll amounts are user-entered records. Wheat does not certify current CNSS, AMO, IR, employer contributions, payslips, Damancom files, or declarations.
- Sage formats vary by product/version/configuration. Validate a profile and sample export with the target Sage installation before operational use.
- OCR output requires human review.
- The local PIN is a privacy screen, not authentication or encryption. SQLite and managed attachments remain plaintext at rest; rely on the Windows account and disk protection.
- Wheat is designed as trusted single-user local software, not a multi-user authorization system.
- The audit chain is stored with the database it protects and is not externally anchored.
- Wheat is free software under GPL-3.0-or-later. Redistribution and modified versions must follow the terms in the repository `LICENSE`; the software is provided without warranty.
