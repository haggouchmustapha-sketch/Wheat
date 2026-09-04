const { test, expect, _electron: electron } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
const initialMigrationName = "20260520134350_init";
/**
 * How many safety copies a first launch must leave behind.
 *
 * One baseline, then one before each migration applied on top of it. Counting
 * the migration folders rather than writing a number keeps this honest: the
 * literal it replaces had silently fallen two releases behind the shipped
 * migration list, so the suite was asserting a state Wheat no longer produced.
 */
const migrationsAfterBaseline = fs
  .readdirSync(path.join(cwd, "prisma", "migrations"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== initialMigrationName)
  .length;
const expectedFirstLaunchBackups = migrationsAfterBaseline + 1;
const initialMigrationChecksum = "7c606dc3d1fe9dd42e8965f0169f09bd5e72644c5aab35fd3dc64a207965a5bf";

function launchAtlas(userDataDir) {
  return electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
}

function createLegacyDatabase(databasePath, { recordMigrationHistory = false } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const sql = fs.readFileSync(path.join(cwd, "prisma", "migrations", initialMigrationName, "migration.sql"), "utf8");
  expect(crypto.createHash("sha256").update(sql).digest("hex")).toBe(initialMigrationChecksum);
  database.exec(sql);
  const now = Date.UTC(2026, 4, 20);
  if (recordMigrationHistory) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
      );
    `);
    database.prepare(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run("legacy-init", initialMigrationChecksum, now, initialMigrationName, now);
  }
  database.prepare(`
    INSERT INTO "Company" (id, name, legalForm, ice, taxId, city, baseCurrency, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'MAD', ?, ?)
  `).run("legacy-company", "LEGACY ATLAS SARL", "SARL", "001589742000063", "IF 48291073", "Casablanca", now, now);
  database.prepare(`
    INSERT INTO "FiscalYear" (id, companyId, label, startsOn, endsOn, lockedTo, status)
    VALUES (?, ?, ?, ?, ?, NULL, 'OPEN')
  `).run("legacy-year", "legacy-company", "Exercice 2026", Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
  database.prepare(`
    INSERT INTO "Journal" (id, companyId, code, label, nextNumber, locked)
    VALUES (?, ?, 'OD', 'Operations diverses', 2, false)
  `).run("legacy-journal", "legacy-company");
  database.prepare(`
    INSERT INTO "Account" (id, companyId, code, label, classNo, type, active)
    VALUES (?, ?, ?, ?, ?, ?, true)
  `).run("legacy-debit", "legacy-company", "342100", "Clients", 3, "ASSET");
  database.prepare(`
    INSERT INTO "Account" (id, companyId, code, label, classNo, type, active)
    VALUES (?, ?, ?, ?, ?, ?, true)
  `).run("legacy-credit", "legacy-company", "712400", "Prestations", 7, "REVENUE");
  database.prepare(`
    INSERT INTO "Entry" (id, companyId, journalId, number, date, pieceNumber, label, status, source, auditNote, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'VALIDATED', 'LEGACY', NULL, ?, ?)
  `).run("legacy-entry", "legacy-company", "legacy-journal", "OD-2026-000001", now, "LEG-1", "Legacy exact cents", now, now);
  database.prepare(`
    INSERT INTO "EntryLine" (id, entryId, accountId, label, debit, credit, thirdParty)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run("legacy-line-debit", "legacy-entry", "legacy-debit", "Debit", 1234.56, 0);
  database.prepare(`
    INSERT INTO "EntryLine" (id, entryId, accountId, label, debit, credit, thirdParty)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run("legacy-line-credit", "legacy-entry", "legacy-credit", "Credit", 0, 1234.56);
  database.prepare(`
    INSERT INTO "BankAccount" (id, companyId, bankName, iban, balance, currency)
    VALUES (?, ?, ?, ?, ?, 'MAD')
  `).run("legacy-bank", "legacy-company", "Legacy bank", "MA00", 1648789000071);
  database.close();
}

test("Wheat baselines and migrates a no-history legacy database once while preserving exact centimes", async () => {
  test.setTimeout(90000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-1-migration-"));
  const userDataDir = path.join(tempDir, "userData");
  const databasePath = path.join(userDataDir, "wheat.sqlite");
  createLegacyDatabase(databasePath);

  let app = await launchAtlas(userDataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    const migrated = await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      return {
        companies: boot.companies.length,
        vatFrequency: boot.companies[0].vatFrequency,
        entryStatus: boot.entries[0].status,
        debit: boot.entries[0].lines.find((line) => line.id === "legacy-line-debit").debit,
        credit: boot.entries[0].lines.find((line) => line.id === "legacy-line-credit").credit,
        balance: boot.bankAccounts[0].balance,
      };
    });
    expect(migrated).toEqual({
      companies: 1,
      vatFrequency: "MONTHLY",
      entryStatus: "POSTED",
      debit: 1234.56,
      credit: 1234.56,
      balance: 1648789000071,
    });
  } finally {
    await app.close();
  }

  const backupDir = path.join(userDataDir, "backups");
  const backupsAfterFirstLaunch = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"));
  expect(backupsAfterFirstLaunch).toHaveLength(expectedFirstLaunchBackups);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("untracked-legacy-baseline"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_1_1_data_safety"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_1_2_operational"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_1_3_integrity_imports"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_1_3_import_revisions"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_1_4_compliance_close"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("post_audit_fixes"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("bank_import_2_0"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("atlas_2_1_foundations"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("fiscal_workpapers_ai_context"))).toBe(true);
  expect(backupsAfterFirstLaunch.some((name) => name.includes("wheat_guided_work"))).toBe(true);

  let database = new DatabaseSync(databasePath);
  // Every migration on disk, baseline included, is recorded as applied.
  expect(database.prepare("SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL").get().count).toBe(expectedFirstLaunchBackups);
  expect(database.prepare("SELECT debitCents FROM EntryLine WHERE id = 'legacy-line-debit'").get().debitCents).toBe(123456);
  expect(database.prepare("SELECT balanceCents FROM BankAccount WHERE id = 'legacy-bank'").get().balanceCents).toBe(164878900007100);
  expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  database.close();

  app = await launchAtlas(userDataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect.poll(() => page.evaluate(async () => (await window.wheat.getBootstrap()).companies.length)).toBe(1);
  } finally {
    await app.close();
  }
  expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"))).toEqual(backupsAfterFirstLaunch);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Wheat refuses a database from a newer schema instead of downgrading it", async () => {
  test.setTimeout(60000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-future-schema-"));
  const userDataDir = path.join(tempDir, "userData");
  const databasePath = path.join(userDataDir, "wheat.sqlite");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.copyFileSync(path.join(cwd, "prisma", "dev.db"), databasePath);

  const database = new DatabaseSync(databasePath);
  try {
    const now = Date.now();
    database.prepare(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run("future-migration", "future-checksum", now, "20990101000000_atlas_future", now);
  } finally {
    database.close();
  }

  const beforeHash = crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex");
  const app = await launchAtlas(userDataDir);
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".recovery-shell")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".recovery-shell")).toContainText("newer or unsupported Wheat release");
  } finally {
    await app.close();
  }

  const afterHash = crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex");
  expect(afterHash).toBe(beforeHash);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Wheat enforces draft, posting, reversal, period lock, and reset invariants", async () => {
  test.setTimeout(90000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-1-ledger-"));
  const userDataDir = path.join(tempDir, "userData");
  const app = await launchAtlas(userDataDir);

  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const api = window.wheat;
      const first = await api.getBootstrap();
      const company = await api.createCompany({
        name: "INTEGRITY TEST SARL",
        legalForm: "SARL",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "QUARTERLY",
      });
      let boot = await api.getBootstrap(company.id);
      const active = boot.companies.find((item) => item.id === company.id);
      const journal = active.journals.find((item) => item.code === "OD");
      const debitAccount = active.accounts.find((item) => item.code === "342100");
      const creditAccount = active.accounts.find((item) => item.code === "712400");

      const incomplete = await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-20",
        pieceNumber: "DRAFT-ONLY",
        label: "Incomplete draft is allowed",
        lines: [{ accountId: debitAccount.id, label: "Draft debit", debit: 10.01, credit: 0 }],
      });
      let incompletePostError = "";
      try { await api.postEntry(incomplete.id); } catch (error) { incompletePostError = String(error); }

      const balanced = await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-20",
        pieceNumber: "POST-1",
        label: "Exact-cent posting",
        lines: [
          { accountId: debitAccount.id, label: "Debit", debit: 1234.56, credit: 0 },
          { accountId: creditAccount.id, label: "Credit", debit: 0, credit: 1234.56 },
        ],
      });
      const posted = await api.postEntry(balanced.id);
      let deletePostedError = "";
      try { await api.deleteEntry(posted.id); } catch (error) { deletePostedError = String(error); }
      let deleteCompanyError = "";
      try { await api.deleteCompany(company.id); } catch (error) { deleteCompanyError = String(error); }
      const reversed = await api.reverseEntry(posted.id, "2026-05-31");
      let duplicateReversalError = "";
      try { await api.reverseEntry(posted.id, "2026-06-01"); } catch (error) { duplicateReversalError = String(error); }

      const duplicate = await api.duplicateEntry(posted.id);
      const fiscalYear = active.fiscalYears.find((year) => year.status === "OPEN");
      await api.lockFiscalPeriod({ companyId: company.id, fiscalYearId: fiscalYear.id, lockedTo: "2026-06-30" });
      const lockedDraft = await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-06-15",
        pieceNumber: "LOCKED-1",
        label: "Locked period draft",
        lines: [
          { accountId: debitAccount.id, label: "Debit", debit: 50, credit: 0 },
          { accountId: creditAccount.id, label: "Credit", debit: 0, credit: 50 },
        ],
      });
      let lockedPostError = "";
      try { await api.postEntry(lockedDraft.id); } catch (error) { lockedPostError = String(error); }

      const employee = await api.saveEmployee({
        companyId: company.id,
        fullName: "Salariée locale",
        cin: "BK123456",
        cnss: "CNSS-LOCAL-1",
        position: "Comptable",
        grossSalary: 10000,
        cnssEmployee: 500,
        amoEmployee: 250,
        ir: 1000,
        netSalary: 8250,
      });
      const updatedEmployee = await api.saveEmployee({
        id: employee.id,
        companyId: company.id,
        fullName: "Salariée locale",
        cin: "BK123456",
        cnss: "CNSS-LOCAL-1",
        position: "Comptable principale",
        grossSalary: 10500,
        cnssEmployee: 500,
        amoEmployee: 250,
        ir: 1000,
        netSalary: 8750,
      });
      const payrollEntry = await api.postPayrollEntry(company.id, "2026-07");

      boot = await api.getBootstrap(company.id);
      const snapshot = {
        firstCompanyCount: first.companies.length,
        vatFrequency: active.vatFrequency,
        incompleteStatus: incomplete.status,
        incompletePostError,
        postedStatus: posted.status,
        postedNumber: posted.number,
        deletePostedError,
        deleteCompanyError,
        reversalStatus: reversed.entry.status,
        duplicateReversalError,
        duplicateStatus: duplicate.entry.status,
        lockedPostError,
        employeePosition: updatedEmployee.position,
        employeeNet: boot.employees.find((item) => item.id === employee.id).netSalary,
        payrollStatus: payrollEntry.status,
        payrollNumber: payrollEntry.number,
        originalStatus: boot.entries.find((entry) => entry.id === posted.id).status,
        exactDebit: boot.entries.find((entry) => entry.id === posted.id).lines[0].debit,
      };
      await api.resetWorkspace({ mode: "blank" });
      snapshot.companyCountAfterReset = (await api.getBootstrap()).companies.length;
      return snapshot;
    });

    expect(result.firstCompanyCount).toBe(0);
    expect(result.vatFrequency).toBe("QUARTERLY");
    expect(result.incompleteStatus).toBe("DRAFT");
    expect(result.incompletePostError).toContain("au moins deux lignes");
    expect(result.postedStatus).toBe("POSTED");
    expect(result.postedNumber).toMatch(/^OD-2026-\d{6}$/);
    expect(result.deletePostedError).toContain("ne peut jamais être supprimée");
    expect(result.deleteCompanyError).toContain("écriture");
    expect(result.reversalStatus).toBe("POSTED");
    expect(result.duplicateReversalError).toContain("déjà été extournée");
    expect(result.duplicateStatus).toBe("DRAFT");
    expect(result.lockedPostError).toContain("verrouillée");
    expect(result.employeePosition).toBe("Comptable principale");
    expect(result.employeeNet).toBe(8750);
    expect(result.payrollStatus).toBe("POSTED");
    expect(result.payrollNumber).toMatch(/^PA-2026-\d{6}$/);
    expect(result.originalStatus).toBe("REVERSED");
    expect(result.exactDebit).toBe(1234.56);
    expect(result.companyCountAfterReset).toBe(0);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Wheat opens recovery instead of substituting demo data when the local database is corrupt", async () => {
  test.setTimeout(45000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-1-recovery-"));
  const userDataDir = path.join(tempDir, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "wheat.sqlite"), "not a sqlite database and never demo data");
  const app = await launchAtlas(userDataDir);

  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".recovery-shell")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".recovery-error")).toContainText("base locale");
    await expect(page.locator(".app-shell")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Wheat allocates a collision-free posted number in every seeded journal", async () => {
  test.setTimeout(90000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-1-numbering-"));
  const userDataDir = path.join(tempDir, "userData");
  const databasePath = path.join(userDataDir, "wheat.sqlite");
  let app = await launchAtlas(userDataDir);
  let companyId;

  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    companyId = await page.evaluate(async () => {
      await window.wheat.resetWorkspace({ mode: "demo" });
      const boot = await window.wheat.getBootstrap();
      return boot.activeCompanyId;
    });
  } finally {
    await app.close();
  }

  // Recreate the stale-counter condition that previously collided with the
  // seeded VE-2026-000087 entry. The production allocator must inspect
  // occupied numbers rather than trusting Journal.nextNumber blindly.
  const database = new DatabaseSync(databasePath);
  expect(database.prepare(`
    SELECT COUNT(*) AS count
    FROM "Entry"
    WHERE "companyId" = ? AND "number" = 'VE-2026-000087'
  `).get(companyId).count).toBe(1);
  database.prepare(`
    UPDATE "Journal"
    SET "nextNumber" = 87
    WHERE "companyId" = ? AND "code" = 'VE'
  `).run(companyId);
  database.close();

  app = await launchAtlas(userDataDir);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    const result = await page.evaluate(async (targetCompanyId) => {
      const api = window.wheat;
      const before = await api.getBootstrap(targetCompanyId);
      const company = before.companies.find((item) => item.id === targetCompanyId);
      const debitAccount = company.accounts.find((item) => item.code === "342100");
      const creditAccount = company.accounts.find((item) => item.code === "712400");
      const occupiedBefore = before.entries.map((entry) => entry.number);
      const posted = [];

      for (const [index, journal] of [...company.journals].sort((left, right) => left.code.localeCompare(right.code)).entries()) {
        const amount = `${100 + index}.01`;
        const draft = await api.createEntry({
          companyId: company.id,
          journalId: journal.id,
          date: "2026-08-12",
          pieceNumber: `NUMBERING-${journal.code}`,
          label: `Contrôle numérotation ${journal.code}`,
          source: "INTEGRITY_TEST",
          lines: [
            { accountId: debitAccount.id, label: `Débit ${journal.code}`, debit: amount, credit: 0 },
            { accountId: creditAccount.id, label: `Crédit ${journal.code}`, debit: 0, credit: amount },
          ],
        });
        const finalEntry = await api.postEntry(draft.id);
        posted.push({ code: journal.code, status: finalEntry.status, number: finalEntry.number });
      }

      const after = await api.getBootstrap(company.id);
      return {
        journalCodes: company.journals.map((journal) => journal.code).sort(),
        occupiedBefore,
        posted,
        allNumbers: after.entries.map((entry) => entry.number),
      };
    }, companyId);

    expect(result.journalCodes).toEqual(["AC", "BQ", "CA", "OD", "PA", "VE"]);
    expect(result.posted).toHaveLength(result.journalCodes.length);
    expect(result.posted.every((entry) => entry.status === "POSTED")).toBe(true);
    expect(new Set(result.posted.map((entry) => entry.number)).size).toBe(result.posted.length);
    expect(result.posted.every((entry) => !result.occupiedBefore.includes(entry.number))).toBe(true);
    expect(new Set(result.allNumbers).size).toBe(result.allNumbers.length);

    const postedVe = result.posted.find((entry) => entry.code === "VE");
    expect(result.occupiedBefore).toContain("VE-2026-000087");
    expect(postedVe.number).toBe("VE-2026-000088");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Wheat payroll snapshots survive employee deletion unchanged", async () => {
  test.setTimeout(90000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-1-payroll-snapshot-"));
  const userDataDir = path.join(tempDir, "userData");
  const databasePath = path.join(userDataDir, "wheat.sqlite");
  const period = "2026-08";
  const app = await launchAtlas(userDataDir);
  let fixture;

  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    fixture = await page.evaluate(async (payrollPeriod) => {
      const api = window.wheat;
      await api.resetWorkspace({ mode: "demo" });
      const boot = await api.getBootstrap();
      const company = boot.companies.find((item) => item.id === boot.activeCompanyId);
      const employees = boot.employees.map((employee) => ({
        id: employee.id,
        fullName: employee.fullName,
        cin: employee.cin,
        cnss: employee.cnss,
        position: employee.position,
        grossSalary: employee.grossSalary,
        cnssEmployee: employee.cnssEmployee,
        amoEmployee: employee.amoEmployee,
        ir: employee.ir,
        netSalary: employee.netSalary,
      }));
      const deletedEmployee = employees[0];
      const postedEntry = await api.postPayrollEntry(company.id, payrollPeriod);
      await api.deleteEmployee(deletedEmployee.id);
      return { companyId: company.id, employees, deletedEmployee, postedEntry };
    }, period);
  } finally {
    await app.close();
  }

  try {
    const database = new DatabaseSync(databasePath);
    const payrollRun = database.prepare(`
      SELECT "id", "status", "postedEntryId", "postedAt"
      FROM "PayrollRun"
      WHERE "companyId" = ? AND "period" = ?
    `).get(fixture.companyId, period);
    expect(payrollRun).toBeTruthy();
    expect(payrollRun.status).toBe("POSTED");
    expect(payrollRun.postedEntryId).toBe(fixture.postedEntry.id);
    expect(payrollRun.postedAt).not.toBeNull();

    const snapshots = database.prepare(`
      SELECT "employeeId", "employeeName", "cin", "cnss", "position",
             "grossSalaryCents", "cnssEmployeeCents", "amoEmployeeCents", "irCents", "netSalaryCents"
      FROM "PayrollRunLine"
      WHERE "payrollRunId" = ?
      ORDER BY "employeeName"
    `).all(payrollRun.id);
    expect(snapshots).toHaveLength(fixture.employees.length);

    const deletedSnapshot = snapshots.find((line) => line.employeeName === fixture.deletedEmployee.fullName);
    expect(deletedSnapshot).toBeTruthy();
    expect(deletedSnapshot.employeeId).toBeNull();
    expect(deletedSnapshot).toMatchObject({
      employeeName: fixture.deletedEmployee.fullName,
      cin: fixture.deletedEmployee.cin,
      cnss: fixture.deletedEmployee.cnss,
      position: fixture.deletedEmployee.position,
      grossSalaryCents: Math.round(Number(fixture.deletedEmployee.grossSalary) * 100),
      cnssEmployeeCents: Math.round(Number(fixture.deletedEmployee.cnssEmployee) * 100),
      amoEmployeeCents: Math.round(Number(fixture.deletedEmployee.amoEmployee) * 100),
      irCents: Math.round(Number(fixture.deletedEmployee.ir) * 100),
      netSalaryCents: Math.round(Number(fixture.deletedEmployee.netSalary) * 100),
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM "Employee" WHERE "id" = ?`).get(fixture.deletedEmployee.id).count).toBe(0);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
