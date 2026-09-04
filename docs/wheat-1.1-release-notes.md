# Wheat 1.1 release notes

Wheat 1.1 is the first data-safety release. It replaces implicit demo behavior with an explicit local accounting lifecycle and lays the groundwork for real daily use. It is not a declaration of DGI certification or production readiness.

## What changed

### Clean first run

- A new desktop profile creates and migrates an empty SQLite database.
- If no company exists, Wheat opens first-company onboarding for identity, fiscal year, and monthly or quarterly VAT frequency.
- The created company receives starter journals, a basic CGNC-oriented account plan, one open fiscal year, a zero-balance bank account, and a draft VAT period. It receives no sample entries, invoices, documents, employees, or bank movements.
- The bundled fictitious company is loaded only through the explicit `Explorer une société exemple` or demo-reset action. The UI warns that this replaces the current database and retains managed document copies so the pre-reset rollback can still reference them.
- Database failures are not replaced silently with sample accounting data. The browser-only renderer preview remains non-persistent and displays a visible preview banner.

### Safe schema upgrades and money storage

- The desktop embeds ordered migrations and verifies their SHA-256 checksums before applying them.
- Before each pending migration of an existing database, Wheat writes a timestamped rollback copy beside the database under `backups`.
- Migration execution is transactional, followed by SQLite integrity and foreign-key checks. Migration and demo-reset housekeeping retains the five most recent files matching Wheat's rollback-backup naming convention. Restore rollback files are also written to the backup directory and should be reviewed under the user's retention policy.
- Legacy floating-point monetary columns are converted once using `ROUND(value * 100)` and stored as SQLite integers represented by Prisma `BigInt` fields.
- The renderer continues receiving MAD-valued fields such as `debit`, `credit`, `ttc`, and `balance`; internal `*Cents` values and JavaScript `bigint` values do not cross the IPC boundary. Values beyond JavaScript's safe integer range are emitted as exact decimal text.

The migration conversion rounds legacy values to the nearest centime. Review migrated balances against a trusted pre-upgrade report before continuing real work.

### Entry lifecycle and auditability

- Manual accounting records are created as `DRAFT` entries.
- Posting assigns the final journal number and changes the entry to `POSTED` only after account, journal, fiscal-year, lock-date, line, and centime-balance validation.
- Only drafts can be deleted individually through the entry workflow. Linked document records are preserved if their draft is deleted. The separately confirmed whole-workspace reset remains intentionally destructive.
- A posted entry is corrected through reversal. Wheat posts an opposite linked entry and changes the original to `REVERSED`; it never deletes the posted source.
- Duplicate creates a new draft rather than copying a posted state.
- Create, post, duplicate, delete-draft, reversal, lock, and unlock actions add activity-log records.

### Fiscal locks

- Each fiscal year can be locked through an inclusive date.
- Entries dated on or before the lock cannot be posted.
- A fiscal-year status other than `OPEN` also prevents posting.
- Extending a lock is allowed. Reducing it requires an explicit unlock first; both actions are logged.

### Period payroll

- Payroll posting accepts an explicit `YYYY-MM` period and dates the accounting entry at month end.
- Employee gross salary must equal net salary plus the stored employee CNSS, AMO, and IR deductions before posting.
- A unique company/period payroll-run record prevents accidental double posting.
- Each run stores a per-employee snapshot of name, CIN, CNSS number, position, gross salary, employee CNSS/AMO/IR deductions, and net salary. Deleting the current employee profile clears only the optional link; the run values remain.
- The generated balanced entry posts gross expense against net pay, social deductions, and salary IR liabilities.

This workflow snapshots values already recorded on employee profiles. Wheat 1.1 does not calculate legally current rates, employer contributions, payslips, Damancom files, or certified payroll declarations.

### Honest local analysis

- The former assistant presentation is now `Analyse locale`.
- Answers are deterministic calculations over the active company's loaded posted entries, invoices, documents, VAT periods, and bank movements.
- Supported intents include unpaid invoices, VAT-period display, duplicate piece numbers, balance equality, unmatched bank movements, and pending documents.
- Each response shows its record scope. Unsupported questions return the available scope and suggested keywords rather than a fabricated answer.

### Backup and restore validation

- Backup disconnects the database client, copies to a temporary file, validates the SQLite header and integrity, checks for the Wheat company table, and only then finalizes the selected target.
- Restore validates the selected file first, copies it to staging, applies pending migrations, checks integrity and foreign keys, and only then replaces the live database.
- Before restore replacement, Wheat retains a rollback copy of the prior live database. A failed replacement restores the previous file.
- The database cannot be backed up onto itself or restored from itself.

The 1.1 backup format contains only SQLite data. OCR and document attachment binaries are not included. Preserve the entire Wheat user-data directory for complete recovery.

### Document retention and deletion

- Blank and sample-workspace resets retain Wheat-managed OCR/document copies on disk. This keeps file references usable if a separately preserved pre-reset SQLite database is restored. A blank reset does not create that database backup automatically; use `Sauvegarder` first.
- A retained copy can become invisible in the replacement workspace until its corresponding database is restored.
- Explicit deletion from the document organizer removes the database record and asks Windows to move the managed file to the Recycle Bin. If Windows refuses the move, Wheat leaves the file intact on disk.
- A company cannot be deleted while document records remain; they must be reviewed and deleted explicitly first.
- Deleting a posted document record does not delete its posted accounting entry.

## Upgrade notes

1. Close other Wheat processes.
2. Preserve a separate copy of `%APPDATA%\Wheat\` before installing a new build.
3. Start Wheat. Pending migrations run before Prisma reads accounting data.
4. Keep the timestamped pre-migration backup until balances and representative entries have been reviewed.
5. Compare opening/closing balances and several amounts containing decimals against a trusted pre-upgrade report.

The packaged database remains at:

```text
%APPDATA%\Wheat\wheat.sqlite
```

Automatic rollback copies are under:

```text
%APPDATA%\Wheat\backups\
```

## Developer verification

```powershell
npm install
npm run lint
npm run build
npm run test:desktop
npm run test:ocr
```

Generate distributables with:

```powershell
npm run installer
npm run portable
```

Expected artifacts:

```text
release\WheatSetup.exe
release\AtlasLedgerPortable.exe
```

These locally generated artifacts are not code-signed, so Windows SmartScreen may request confirmation.

Packaging runs the destructive development command `npm run db:reset` to refresh the bundled sample fixture. It does not cause a fresh packaged user profile to load that fixture automatically.

## Remaining limitations

- No DGI certification, direct filing, or guarantee of current statutory compliance.
- No versioned Moroccan tax/payroll rules engine.
- No complete invoice/customer/supplier/payment subledger lifecycle yet.
- No full bank reconciliation links, split/partial matching, or reconciliation statement.
- OCR output must be reviewed by a person before accounting use.
- Database backup excludes locally stored attachment files.
- Local analysis supports a small deterministic intent set and is not AI-generated professional advice.
- The local admin profile is not an authentication boundary: in-app role enforcement and at-rest database/attachment encryption are not implemented. Use Wheat 1.1 only within a trusted Windows user account.
- No repository software licence has been selected yet.
