# Wheat AI capability matrix — 2.1.1

This inventory is derived from the 2.1.1 capability registry and the domain services invoked by the desktop UI. The executable registry remains the authority.

Risk semantics:

- Level 0: read or navigation; never mutates.
- Level 1: safe edit; executes immediately after explicit intent in Assistant and Automated modes.
- Level 2: accounting/conformity mutation; confirmed in Assistant mode and immediate only in Automated mode.
- Level 3: high impact; always previewed and confirmed immediately before execution.

| Module | Read | Level 1 | Level 2 | Level 3 | Reversal / notes |
|---|---:|---:|---:|---:|---|
| Company | 1 | 1 | 0 | 0 | Company updates use optimistic versioning. |
| Settings | 1 | 0 | 0 | 0 | Bounded consolidated settings read. |
| Accounts / PCGE | 2 | 1 | 0 | 1 | Official PCGE accounts remain immutable; custom accounts can be restored after archival. |
| Journals | 1 | 0 | 1 | 1 | Archival is reversible by restoring the journal. |
| Fiscal years | 1 | 0 | 1 | 0 | Create/update only; no AI close command exists because no mature shared close command is exposed by this UI. |
| Entries | 3 | 1 | 2 | 3 | Draft deletion is destructive; posted entries are corrected only by the real reversal workflow. |
| Reports | 9 | 0 | 0 | 0 | Exact-cent reporting engines; no mutation. |
| Counterparties | 1 | 3 | 0 | 1 | Archive/restore use the subledger rules. |
| Invoices | 1 | 2 | 0 | 3 | Posting and voiding use subledger posting/reversal, never direct edits to posted records. |
| Payments | 1 | 2 | 1 | 4 | Allocation reversal and payment void use their accounting workflows. |
| Banking | 3 | 1 | 3 | 2 | Rapprochement and exclusion preserve evidence; void/restore follow reconciliation revisions. |
| Documents | 1 | 0 | 0 | 0 | Metadata search only. Fiscal/TVA attachment uses existing managed, hashed documents through those modules. |
| TVA | 3 | 0 | 4 | 4 | Review locks, evidence hashes, revisions and reopen rules remain enforced by compliance services. |
| Fiscal package/workpapers | 4 | 0 | 6 | 5 | Reviewed/N-A tables require explicit reopen; statutory export remains unavailable. |
| Ledger imports | 1 | 0 | 0 | 2 | Only already-managed staged batches can be confirmed/cancelled; no arbitrary path is accepted. |
| Payroll | 1 | 0 | 0 | 1 | Posted payroll is voided through the existing reversal workflow. |
| Audit | 2 | 0 | 0 | 0 | Bounded history and chain verification. |
| Company knowledge | 1 | 1 | 0 | 0 | Upsert is audited and dossier-scoped. |
| Navigation | 1 | 0 | 0 | 0 | Whitelisted application destinations only. |

Totals: 95 capabilities across 19 registry categories: 38 level 0, 12 level 1, 18 level 2, and 27 level 3. Fifty-seven mutation capabilities support dry-run.

## Exhaustive capability inventory

The bracket after each capability is its deterministic risk level.

- **Company:** `company.get` [L0], `company.update` [L1].
- **Settings:** `settings.get` [L0].
- **Accounts:** `accounts.search` [L0], `accounts.get` [L0], `accounts.save` [L1], `accounts.set_active` [L3].
- **Journals:** `journals.list` [L0], `journals.save` [L2], `journals.set_active` [L3].
- **Fiscal years:** `fiscal_years.list` [L0], `fiscal_years.save` [L2].
- **Entries:** `entries.search` [L0], `entries.get` [L0], `entries.preview_post` [L0], `entries.create_draft` [L2], `entries.update_draft` [L2], `entries.duplicate` [L1], `entries.delete_draft` [L3], `entries.post` [L3], `entries.reverse` [L3].
- **Reports:** `reports.trial_balance` [L0], `reports.general_ledger` [L0], `reports.journal` [L0], `reports.aged_receivables` [L0], `reports.aged_payables` [L0], `reports.integrity` [L0], `reports.balance` [L0], `reports.bilan` [L0], `reports.cpc` [L0].
- **Subledger:** `counterparties.list` [L0], `counterparties.create` [L1], `counterparties.update` [L1], `counterparties.archive` [L3], `counterparties.restore` [L1].
- **Invoices:** `invoices.list` [L0], `invoices.create_draft` [L1], `invoices.update_draft` [L1], `invoices.delete_draft` [L3], `invoices.post` [L3], `invoices.void` [L3].
- **Payments:** `payments.list` [L0], `payments.create_draft` [L1], `payments.update_draft` [L1], `payments.delete_draft` [L3], `payments.post` [L3], `payments.void` [L3], `payments.allocate` [L2], `payments.reverse_allocation` [L3].
- **Banking:** `banking.position` [L0], `banking.reconciliation_workspace` [L0], `banking.reconciliation_candidates` [L0], `banking.confirm_reconciliation` [L2], `banking.void_reconciliation` [L3], `banking.exclude_movement` [L2], `banking.restore_movement` [L1], `banking.save_account` [L2], `banking.set_account_active` [L3].
- **Documents:** `documents.search` [L0].
- **TVA:** `vat.workspace` [L0], `vat.workpapers` [L0], `vat.workpaper` [L0], `vat.generate` [L2], `vat.regenerate` [L2], `vat.add_adjustment` [L2], `vat.attach_evidence` [L2], `vat.remove_evidence` [L3], `vat.review` [L3], `vat.return_to_draft` [L3], `vat.reopen` [L3].
- **Fiscal package/workpapers:** `fiscal.control` [L0], `fiscal.tables` [L0], `fiscal.table` [L0], `fiscal.validate_package` [L0], `fiscal.generate_package` [L2], `fiscal.add_adjustment` [L2], `fiscal.verify_adjustment` [L3], `fiscal.refresh_table` [L2], `fiscal.save_table` [L2], `fiscal.mark_not_applicable` [L2], `fiscal.attach_evidence` [L2], `fiscal.review_table` [L3], `fiscal.reopen_table` [L3], `fiscal.clear_not_applicable` [L3], `fiscal.remove_evidence` [L3].
- **Imports:** `imports.list` [L0], `imports.confirm` [L3], `imports.cancel` [L3].
- **Payroll:** `payroll.runs` [L0], `payroll.void` [L3].
- **Audit:** `audit.events` [L0], `audit.verify` [L0].
- **Company knowledge:** `knowledge.retrieve` [L0], `knowledge.remember` [L1].
- **Navigation:** `navigation.open` [L0].

Level 0 executes as a read/navigation operation. Level 1 executes immediately after explicit intent in Assistant or Automated mode. Level 2 executes immediately only in Automated mode and otherwise becomes a confirmation proposal. Level 3 always becomes a final confirmation proposal. Read-only mode rejects every L1–L3 capability.

## Operations intentionally not exposed

- Arbitrary SQL, Prisma, database, shell and filesystem access: prohibited by the Wheat AI boundary.
- Document upload/delete and bank-statement/ledger-file staging from a path: current desktop flows begin with a native file picker and managed-file ingestion. They need a future trusted attachment-token command before they can be exposed without handing the model a path or file bytes.
- Backup/restore and workspace reset: destructive filesystem/database lifecycle operations are not appropriate agent capabilities in this release.
- Statutory fiscal export/télédéclaration: Wheat itself marks this unavailable.
- Fiscal-year close: the application has lower-level closing machinery, but not a single mature user command in the current shared operations service that can safely be delegated here.

## Shared service boundary

The registry performs strict schema validation. The domain gateway then derives the active company from trusted IPC input, authorizes the signed-in user and membership, validates every referenced entity against that company, captures optimistic preconditions, and dispatches to `operations13`, `entryCommands21`, `reporting`, `reporting21`, `subledger`, `reconciliation`, `compliance14`, or `fiscal21`. The model receives no generic database or file tool.
