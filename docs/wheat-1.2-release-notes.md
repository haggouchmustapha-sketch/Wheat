# Wheat 1.2 release notes

Wheat 1.2 is the operational-accounting release. It builds on the migration, posting, reversal, fiscal-lock, and recovery safeguards introduced in 1.1, then adds persistent subledgers, evidence-based reconciliation, complete Wheat backup archives, and an optional local privacy lock.

The packaged app remains local-first: its core bookkeeping, reconciliation, OCR, and backup workflows do not require a cloud account or subscription. This is not a declaration of DGI certification, statutory compliance, or open-source licensing.

## What changed

### Persistent counterparty and invoice subledger

- `Counterparty` records represent customers, suppliers, or both. Stable identity keys prefer ICE, then tax ID, then a normalized name; legacy records with no reliable identity receive a record-specific key rather than being merged speculatively.
- Counterparties retain optional receivable/payable account defaults, contact details, version numbers, and active/archive state.
- Sales and purchase invoices now have persisted lines, exact HT/TVA/TTC centime values, counterparty identity snapshots, linked documents, account mappings, version numbers, and lifecycle state.
- Draft invoice creation and updates validate counterparty/company ownership, currency, dates, account ownership, exact line totals, and duplicate invoice identity.
- Posting revalidates the fiscal year and inclusive fiscal lock, resolves the collective and VAT accounts, creates a balanced VE or AC accounting entry, posts it, and links it back to the invoice in one transaction.
- Posted invoice corrections use a reasoned void operation that creates a linked reversal entry. A posted invoice with active payment allocations must have those allocations reversed before it can be voided.
- Drafts may be deleted through the service while preserving linked document records. Posted and voided invoice history is not hard-deleted by the normal lifecycle.
- Optimistic version checks reject stale edits instead of silently overwriting another screen's changes.

The operational UI adds dedicated sales, purchases, payments, and counterparties workspaces with exact totals, filters, status indicators, draft forms, and explicit posting confirmation.

### Persistent payments and settlement state

- Receipts and disbursements are persisted separately from invoices and can link to a bank or cash settlement account.
- Payment drafts can contain invoice allocations. Validation prevents cross-company, cross-counterparty, wrong-direction, over-payment, and over-allocation combinations.
- Posting creates and posts the linked BQ or CA accounting entry and activates the settlement evidence in the same transaction.
- Invoice settlement is derived from active allocations belonging to posted or retained legacy payments; it is not inferred from a mutable invoice label.
- Derived states include draft, unpaid, overdue, partially paid, partially paid overdue, paid, paid late, overpaid, and voided.
- Allocation reversal retains the allocation row with reversal metadata. Voiding a posted payment first reverses the linked accounting entry and preserves the payment record.
- Activity-log records identify the affected entity and retain exact amounts and lifecycle details where applicable.

### Exact money boundary

- New invoice, payment, allocation, and reconciliation amounts are stored as SQLite integers represented by Prisma `BigInt` centimes.
- Subledger decimal inputs must be text with no more than two fractional digits. JavaScript `number` values are intentionally rejected at that service boundary so binary floating-point rounding cannot enter the accounting workflow.
- Reconciliation IPC uses exact centime strings. Calculations, caps, and equality checks remain integer operations.
- Renderer responses retain canonical `*Cents` integer strings and also provide established MAD aliases for compatibility. Values that cannot be represented safely as JavaScript numbers use exact decimal text for the alias.

### Evidence-based bank reconciliation

- Bank accounts can map to their actual ledger account. Reconciliation candidates are restricted to posted entry lines on that account, in the same company, and in the same cash direction as the statement movement.
- Statement imports persist a source-file SHA-256, date range, row count, optional opening/closing balances, and each movement's source row, reference, external ID, fingerprint, dates, and exact amount.
- Reimporting the same source hash into the same bank account is rejected. Suspected duplicate row fingerprints require explicit acknowledgement.
- A movement can be confirmed in partial batches. Each batch can split an amount across multiple posted bank-ledger lines, and repeated batches can finish the remaining amount later.
- Wheat caps a batch against the movement remainder and caps each accounting line against its remaining unallocated magnitude. Optional posted-payment evidence is independently capped and cannot exceed the accounting allocation batch.
- Reconciliation state is derived from active evidence as `UNRECONCILED`, `PARTIAL`, or `RECONCILED`. Exclusion is a separate explicit state.
- A confirmation stores an immutable movement snapshot plus its accounting allocations, optional payment evidence, actor, timestamp, note, and audit event.
- Voiding a reconciliation requires a reason and changes its status to `VOIDED`; it does not delete the snapshot or allocation rows. The amounts become available again only because derived state ignores voided batches.
- Movement revisions prevent two stale screens from confirming, voiding, excluding, or restoring the same state concurrently.

Wheat 1.1's old `MATCHED` flag did not identify an accounting entry line and therefore was not valid reconciliation evidence. During migration, those claims become `legacyMatchClaimed` plus `REVIEW_REQUIRED`. A user must inspect the movement and confirm a real allocation; Wheat does not fabricate a link.

### Complete `.atlasbackup` archives

- Manual backup now writes a versioned `.atlasbackup` ZIP archive rather than a loose database copy.
- The archive contains exactly one SQLite database plus every OCR attachment and source bank statement that the backed-up database currently references inside Wheat's managed `documents` directory.
- `manifest.json` records the backup format/version, backup ID, creation timestamp, app version, payload path, kind, byte size, and SHA-256 for every included file.
- Creation checkpoints/disconnects SQLite, snapshots files into a private staging directory, rejects active journal/WAL ambiguity, validates the database, hashes each payload, writes the archive without replacing an existing destination, and validates the finished archive again.
- Archive validation rejects unsafe paths, duplicate/colliding entries, symbolic-link-style entries, undeclared files, missing files, unsupported compression, invalid sizes, hash mismatches, corrupt SQLite, and configured resource-limit violations.
- A referenced managed attachment that is missing causes backup creation to fail. Wheat does not silently produce an incomplete archive.
- Restore extracts into a private staging directory, verifies the manifest and all hashes, migrates the staged database, checks SQLite integrity and foreign keys, restores included attachments into a new managed restore directory, and rewrites the restored `Document.storedPath` values.
- Before replacing a live workspace, Wheat attempts a full rollback archive. If full rollback creation fails, it keeps an explicitly named emergency SQLite copy; swap failures restore the prior database and remove the newly restored attachment directory.
- Older `.sqlite` and `.db` backups remain accepted through the legacy database-only restore path.

Scope matters: `.atlasbackup` includes database-referenced files under Wheat's managed documents root. It does not include unreferenced/orphaned files or arbitrary source files elsewhere on the computer. A legacy SQLite backup still cannot recover attachments it never contained.

### Optional local PIN lock

- Settings can enable a 6–64 character local PIN, lock immediately, lock at app startup, and configure an inactivity timeout (or disable idle locking).
- Wheat stores a 32-byte random salt and a scrypt-derived verifier; it does not store the plaintext PIN.
- Verification uses a timing-safe comparison. Failed attempts persist a counter and receive an exponentially increasing delay capped at five minutes.
- When the lock is active, normal business IPC first asserts that the local session is unlocked and refreshes its activity timestamp.
- Status responses expose only operational lock state and retry timing, never the salt or verifier.

This is deliberately described as `LOCAL_APP_LOCK`. It masks and gates the Wheat interface for a trusted local desktop session. It is not encryption, Windows-user authentication, role-based authorization, or protection against direct filesystem/database access. The SQLite database and managed attachments remain plaintext at rest unless Windows or the storage device provides encryption.

### OCR-to-subledger handoff

- The desktop bridge now turns reviewed invoice extraction into a purchase-invoice draft linked to the managed document instead of treating OCR output as sufficient evidence for automatic posting.
- The handoff validates HT, TVA, TTC, counterparty identity, and required default account configuration before creating the draft.
- A person must still compare the draft with the source document, correct extraction errors, choose appropriate accounts, and explicitly post it.

## Upgrade behavior from 1.1

The 1.2 schema migration is embedded and checksummed like the earlier migrations. Before applying pending migrations to an existing database, Wheat retains its normal timestamped rollback copy and validates the result.

The migration is intentionally conservative:

- existing accounting entries and exact invoice centime totals are retained;
- each 1.1 invoice becomes a `LEGACY` invoice marked `needsReview` with one exact summary line;
- counterparties are grouped only when a stable legacy ICE/name identity supports it; blank identity gets a record-specific counterparty;
- a historical payment/allocation is created only when the old invoice actually has a payment date;
- no posted invoice/payment accounting entry is invented for legacy records;
- old bank `MATCHED` claims become `REVIEW_REQUIRED` rather than fake reconciliation batches.

After upgrading, review every legacy invoice and every `REVIEW_REQUIRED` bank movement against source documents and a trusted accounting report.

## Recommended upgrade steps

1. Close other Wheat processes.
2. Preserve an independent copy of `%APPDATA%\Wheat\` before installing the new build.
3. Start Wheat and allow pending migrations to finish.
4. Keep the timestamped pre-migration rollback file until representative balances, entries, invoices, and documents have been checked.
5. Map each bank account to its corresponding ledger account before attempting reconciliation.
6. Review all `LEGACY` invoices and `REVIEW_REQUIRED` movements.
7. Create a new `.atlasbackup`, move a copy off the computer, and test a restore in a separate controlled profile.

The packaged database remains at:

```text
%APPDATA%\Wheat\wheat.sqlite
```

Managed documents and automatic rollback files remain under:

```text
%APPDATA%\Wheat\documents\
%APPDATA%\Wheat\backups\
```

## Developer verification

```powershell
npm install
npm run lint
npm run build
npx playwright test tests/atlas-1.2-migration.spec.cjs tests/atlas-1.2-archive-unit.spec.cjs tests/atlas-1.2-subledger-unit.spec.cjs tests/atlas-1.2-reconciliation-unit.spec.cjs tests/atlas-1.2-local-security-unit.spec.cjs --reporter=line
npm run test:desktop
npm run test:ocr
```

Generate local Windows artifacts with:

```powershell
npm run installer
npm run portable
```

Expected outputs:

```text
release\WheatSetup.exe
release\AtlasLedgerPortable.exe
```

Packaging invokes the destructive development command `npm run db:reset` to refresh the bundled sample fixture. A fresh packaged profile still uses the empty first-run path unless the user explicitly chooses the sample workspace.

Locally generated artifacts are not code-signed, so Windows SmartScreen may request confirmation.

## Remaining limitations

- No DGI certification, authority certification, direct filing, or guarantee of current statutory compliance.
- No validation against current DGI declaration or electronic-invoicing technical specifications.
- No versioned Moroccan tax/payroll rules engine. Payroll does not calculate or certify current CNSS, AMO, IR, employer contributions, payslips, Damancom files, or declarations.
- OCR remains assistive and requires human review before accounting use.
- The subledger is an operational baseline, not a complete ERP, certified invoicing system, inventory system, or multicurrency revaluation engine.
- `.atlasbackup` excludes unreferenced files and files outside Wheat's managed documents root. It is not an automatic off-device backup service.
- The local analysis supports a limited deterministic question set and is not generative professional advice.
- Wheat 1.2 retains a trusted, single-user desktop posture. The optional PIN is not authentication/authorization, and the database and attachments are not encrypted at rest by Wheat.
- Whole-workspace reset and sample replacement remain intentionally destructive operations.
- Windows executables built locally are not code-signed.
- The repository has no software licence. Local use does not require a subscription, but open-source and redistribution rights have not been granted or defined.
