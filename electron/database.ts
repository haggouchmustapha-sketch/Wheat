import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { App } from "electron";
import type { PrismaClient as PrismaClientType } from "@prisma/client";
import initMigrationSql from "../prisma/migrations/20260520134350_init/migration.sql?raw";
import dataSafety11MigrationSql from "../prisma/migrations/20260812000000_atlas_1_1_data_safety/migration.sql?raw";
import operational12MigrationSql from "../prisma/migrations/20260812160058_atlas_1_2_operational/migration.sql?raw";
import integrityImports13MigrationSql from "../prisma/migrations/20260813090000_atlas_1_3_integrity_imports/migration.sql?raw";
import importRevisions13MigrationSql from "../prisma/migrations/20260814010000_atlas_1_3_import_revisions/migration.sql?raw";
import complianceClose14MigrationSql from "../prisma/migrations/20260814090000_atlas_1_4_compliance_close/migration.sql?raw";
import postAuditFixesMigrationSql from "../prisma/migrations/20260820010000_post_audit_fixes/migration.sql?raw";
import bankImport20MigrationSql from "../prisma/migrations/20260820180000_bank_import_2_0/migration.sql?raw";
import foundations21MigrationSql from "../prisma/migrations/20260825000000_atlas_2_1_foundations/migration.sql?raw";
import fiscalWorkpapersMigrationSql from "../prisma/migrations/20260827000000_fiscal_workpapers_ai_context/migration.sql?raw";
import wheatAiModelRenameMigrationSql from "../prisma/migrations/20260830120000_wheat_ai_model_rename/migration.sql?raw";
import invoiceOptionalDueDateMigrationSql from "../prisma/migrations/20260831120000_invoice_optional_due_date/migration.sql?raw";
import guidedWorkMigrationSql from "../prisma/migrations/20260901140000_wheat_guided_work/migration.sql?raw";
import formDraftsMigrationSql from "../prisma/migrations/20260902100000_wheat_form_drafts/migration.sql?raw";
import sageThirdPartyMigrationSql from "../prisma/migrations/20260902160000_sage_third_party_accounts/migration.sql?raw";
import { resolveProfileDatabaseFile } from "./profileMigration";
import { readWheatEnv } from "./runtimeEnvironment";

// Keeping the runtime lookup opaque prevents the Electron bundler from
// replacing Node's built-in SQLite module with a browser compatibility shim.
const { DatabaseSync: SQLiteDatabase } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

let prisma: PrismaClientType | null = null;
let databasePath = "";

const toPrismaFileUrl = (filePath: string) => `file:${filePath.replace(/\\/g, "/")}`;
const seedFileName = "wheat-seed.db";
const migrationTableName = "_prisma_migrations";

type Migration = {
  name: string;
  sql: string;
  checksum: string;
  disablesForeignKeys?: boolean;
};

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
const migrations: Migration[] = [
  {
    name: "20260520134350_init",
    sql: initMigrationSql,
    checksum: "7c606dc3d1fe9dd42e8965f0169f09bd5e72644c5aab35fd3dc64a207965a5bf",
  },
  {
    name: "20260812000000_atlas_1_1_data_safety",
    sql: dataSafety11MigrationSql,
    checksum: "b76ece8c4d26d06c8d6759a9950cb46e67eab9b67e128cc4fd4233f3cd7a59d5",
    disablesForeignKeys: true,
  },
  {
    name: "20260812160058_atlas_1_2_operational",
    sql: operational12MigrationSql,
    checksum: "b8e3eb67e8b10d3da05849b19ce350ad447add0051333612ad2776bcb97445ea",
    disablesForeignKeys: true,
  },
  {
    name: "20260813090000_atlas_1_3_integrity_imports",
    sql: integrityImports13MigrationSql,
    checksum: "11e76ba0f37d36fa057884256c5dbf1e3e8db0df59e323f8db754011ac755b81",
    disablesForeignKeys: true,
  },
  {
    name: "20260814010000_atlas_1_3_import_revisions",
    sql: importRevisions13MigrationSql,
    checksum: "6676f3844306b876df1feb5a6c259fc58e15e74947119ea074b1e60e6d8871f0",
  },
  {
    name: "20260814090000_atlas_1_4_compliance_close",
    sql: complianceClose14MigrationSql,
    checksum: "8eef9098d814915f80db42394c2679bef78d12cc540090793b1a5f51a90547de",
  },
  {
    name: "20260820010000_post_audit_fixes",
    sql: postAuditFixesMigrationSql,
    checksum: "9e07bd28ea9cafc0365362b151ef12ce54b6776041c751583468c9291a030358",
  },
  {
    name: "20260820180000_bank_import_2_0",
    sql: bankImport20MigrationSql,
    checksum: "ad4057fe25167275cd3c277fe8f3bc9c4e3245a5353087fa382b08ab813920b3",
  },
  {
    name: "20260825000000_atlas_2_1_foundations",
    sql: foundations21MigrationSql,
    checksum: "094cb89b2655de5b08b5e623ad3122f463ea1a2a4f1b81aeae19dc81950ea118",
  },
  {
    name: "20260827000000_fiscal_workpapers_ai_context",
    sql: fiscalWorkpapersMigrationSql,
    checksum: "a0875302bf013216860aedb873393f55ea57fe22560a13f3e66744dcd0df3de2",
  },
  {
    name: "20260830120000_wheat_ai_model_rename",
    sql: wheatAiModelRenameMigrationSql,
    checksum: "c08fc1cd1a4fdf10b6392b7f78005f4695d7d2139160023466cfef76b6d1011c",
  },
  {
    name: "20260831120000_invoice_optional_due_date",
    sql: invoiceOptionalDueDateMigrationSql,
    checksum: "7d81f08726194a22fc1cf10ea3a6ea2a54147f068aad1a2304ec1d8915bb25b5",
    disablesForeignKeys: true,
  },
  {
    name: "20260901140000_wheat_guided_work",
    sql: guidedWorkMigrationSql,
    checksum: "2bf5cfa1cacecd8c0720610b451cc73d5886d0a0b12588a94a137fbc170c6267",
  },
  {
    name: "20260902100000_wheat_form_drafts",
    sql: formDraftsMigrationSql,
    checksum: "3c5c05faa4b6c1b846b287795414dcee7009a8a89ec5e5e6a4d67c782586e4e2",
  },
  {
    name: "20260902160000_sage_third_party_accounts",
    sql: sageThirdPartyMigrationSql,
    checksum: "3d42ccf01d3d26cc042d2399897b35085d3d66faa49ccc9be229013669cc6767",
  },
];

// The migration names below are recorded in each database's _prisma_migrations
// table, so they are permanent identifiers rather than labels: renaming one
// would make every existing installation look like it came from an unknown
// release. They keep their historical spelling for that reason alone.
//
// Keep the untracked baseline plus every historical upgrade checkpoint through
// the current release when a pre-1.1 database is first opened.
const backupRetention = migrations.length;

const BACKUP_PREFIX = "wheat-";
// Backups written before the rename keep their old names; retention must still
// see them so it prunes one combined history rather than two parallel ones.
const BACKUP_PREFIXES = [BACKUP_PREFIX, "atlas-ledger-"] as const;

const resolveUserDataDir = (app: App) => readWheatEnv("WHEAT_USER_DATA_DIR") || app.getPath("userData");

function resolveSeedCandidates() {
  return [
    path.join(process.resourcesPath, "seed", seedFileName),
    path.join(path.dirname(process.execPath), "resources", "seed", seedFileName),
    path.join(process.cwd(), "resources", "seed", seedFileName),
    path.join(process.cwd(), "prisma", "dev.db"),
  ];
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function migrationBackupPath(dbPath: string, migrationName: string) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  return path.join(backupDir, `${BACKUP_PREFIX}${timestampForFile()}-before-${migrationName}.sqlite`);
}

function retainRecentMigrationBackups(dbPath: string) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  if (!fs.existsSync(backupDir)) return;

  const backups = fs.readdirSync(backupDir)
    .filter((name) => BACKUP_PREFIXES.some((prefix) => name.startsWith(prefix)) && name.endsWith(".sqlite"))
    .map((name) => ({ name, path: path.join(backupDir, name) }))
    .sort((left, right) => right.name.localeCompare(left.name));

  for (const backup of backups.slice(backupRetention)) {
    fs.rmSync(backup.path, { force: true });
  }
}

function tableExists(db: DatabaseSync, tableName: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(db: DatabaseSync, tableName: string) {
  return new Set(
    (db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

const legacySchemaSignature: Record<string, string[]> = {
  Company: ["id", "name", "legalForm", "ice", "taxId", "city", "baseCurrency", "createdAt", "updatedAt"],
  FiscalYear: ["id", "companyId", "startsOn", "endsOn", "status"],
  User: ["id", "name", "email", "role"],
  CompanyUser: ["id", "companyId", "userId", "role"],
  Account: ["id", "companyId", "code", "label", "classNo", "type"],
  Journal: ["id", "companyId", "code", "label", "nextNumber"],
  Entry: ["id", "companyId", "journalId", "number", "date", "pieceNumber", "label", "status", "createdAt", "updatedAt"],
  EntryLine: ["id", "entryId", "accountId", "label", "debit", "credit"],
  Invoice: ["id", "companyId", "invoiceNo", "invoiceDate", "dueDate", "ht", "vat", "ttc", "status"],
  Document: ["id", "companyId", "title", "type", "fiscalYear", "tags", "ocrText", "extracted", "status"],
  BankAccount: ["id", "companyId", "bankName", "iban", "balance", "currency"],
  BankMovement: ["id", "bankAccountId", "date", "label", "amount", "reference", "status", "confidence"],
  TaxPeriod: ["id", "companyId", "label", "collectedVat", "deductibleVat", "dueVat", "creditVat", "status", "declarationDue"],
  Employee: ["id", "companyId", "fullName", "cin", "cnss", "position", "grossSalary", "cnssEmployee", "amoEmployee", "ir", "netSalary"],
  ActivityLog: ["id", "companyId", "action", "entity", "description", "createdAt"],
};

function ensureMigrationTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${migrationTableName}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )
  `);
}

function baselineUntrackedLegacySchema(db: DatabaseSync) {
  if (tableExists(db, migrationTableName) || !tableExists(db, "Company")) return;

  const mismatches: string[] = [];
  for (const [tableName, requiredColumns] of Object.entries(legacySchemaSignature)) {
    if (!tableExists(db, tableName)) {
      mismatches.push(`${tableName} (missing table)`);
      continue;
    }
    const columns = tableColumns(db, tableName);
    const missingColumns = requiredColumns.filter((column) => !columns.has(column));
    if (missingColumns.length) mismatches.push(`${tableName} (missing ${missingColumns.join(", ")})`);
  }

  if (mismatches.length) {
    throw new Error(
      `Wheat found an unversioned, incomplete database and will not guess its schema: ${mismatches.join("; ")}.`,
    );
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    ensureMigrationTable(db);
    const initMigration = migrations[0];
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO "${migrationTableName}"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(randomUUID(), initMigration.checksum, now, initMigration.name, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original baseline failure.
    }
    throw error;
  }
}

function needsUntrackedLegacyBaseline(db: DatabaseSync) {
  return !tableExists(db, migrationTableName) && tableExists(db, "Company");
}

function appliedMigrations(db: DatabaseSync) {
  if (!tableExists(db, migrationTableName)) return new Map<string, string>();
  const rows = db.prepare(`
    SELECT migration_name, checksum
    FROM "${migrationTableName}"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `).all() as Array<{ migration_name: string; checksum: string }>;
  return new Map(rows.map((row) => [row.migration_name, row.checksum]));
}

function verifyKnownMigrationChecksums(applied: Map<string, string>) {
  const knownNames = new Set(migrations.map((migration) => migration.name));
  const unknownNames = [...applied.keys()].filter((name) => !knownNames.has(name));
  if (unknownNames.length) {
    throw new Error(
      `This database was created by a newer or unsupported Wheat release (${unknownNames.join(", ")}). ` +
      "Open it with that release instead of risking a downgrade.",
    );
  }
  for (const migration of migrations) {
    const recorded = applied.get(migration.name);
    if (recorded && recorded !== migration.checksum) {
      throw new Error(`Database migration ${migration.name} does not match this Wheat release.`);
    }
    if (checksum(migration.sql) !== migration.checksum) {
      throw new Error(`Bundled migration ${migration.name} failed its integrity check.`);
    }
  }
}

function validateDatabase(db: DatabaseSync) {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${integrity.map((row) => row.integrity_check).join(", ")}`);
  }
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length) {
    throw new Error(`SQLite foreign-key validation failed (${foreignKeyErrors.length} violation(s)).`);
  }
}

function applyMigration(db: DatabaseSync, migration: Migration) {
  if (migration.disablesForeignKeys) db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(migration.sql);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO "${migrationTableName}"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(randomUUID(), migration.checksum, now, migration.name, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original migration error is the useful one.
    }
    throw error;
  } finally {
    if (migration.disablesForeignKeys) db.exec("PRAGMA foreign_keys=ON");
  }
}

/**
 * Applies every pending, embedded schema migration before Prisma is allowed to
 * query the database. Each existing database is copied before every pending
 * migration. A failed migration is rolled back transactionally; the untouched
 * backup path is included in the error message for manual recovery.
 */
export function migrateAndValidateDatabase(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existedAtStart = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  const db = new SQLiteDatabase(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  try {
    if (needsUntrackedLegacyBaseline(db)) {
      const baselineBackup = migrationBackupPath(dbPath, "untracked-legacy-baseline");
      fs.copyFileSync(dbPath, baselineBackup, fs.constants.COPYFILE_EXCL);
      try {
        baselineUntrackedLegacySchema(db);
        retainRecentMigrationBackups(dbPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Your untracked database is safe at ${baselineBackup}. ${message}`, { cause: error });
      }
    }
    let applied = appliedMigrations(db);
    verifyKnownMigrationChecksums(applied);

    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;

      let backupPath: string | null = null;
      if (existedAtStart || tableExists(db, "Company")) {
        db.exec("PRAGMA wal_checkpoint(FULL)");
        backupPath = migrationBackupPath(dbPath, migration.name);
        fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
      }

      try {
        ensureMigrationTable(db);
        applyMigration(db, migration);
        validateDatabase(db);
        retainRecentMigrationBackups(dbPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Wheat could not apply database migration ${migration.name}. ` +
          `${backupPath ? `Your pre-migration database is safe at ${backupPath}. ` : ""}${message}`,
          { cause: error },
        );
      }

      applied = appliedMigrations(db);
    }

    verifyKnownMigrationChecksums(applied);
    validateDatabase(db);
  } finally {
    db.close();
  }
}

export function resolveDatabasePath(app: App) {
  if (!databasePath) {
    databasePath = readWheatEnv("WHEAT_USER_DATA_DIR") || app.isPackaged
      ? resolveProfileDatabaseFile(resolveUserDataDir(app))
      : path.join(process.cwd(), "prisma", "dev.db");
  }

  return databasePath;
}

export function ensureDatabaseFile(app: App) {
  const dbPath = resolveDatabasePath(app);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  migrateAndValidateDatabase(dbPath);

  process.env.DATABASE_URL = toPrismaFileUrl(dbPath);
  fs.writeFileSync(
    path.join(path.dirname(dbPath), "wheat-startup.log"),
    `database=${dbPath}\npackaged=${app.isPackaged}\nresources=${process.resourcesPath}\nschema=2.1.0\nupdated=${new Date().toISOString()}\n`,
  );
  return dbPath;
}

/** Explicit user-requested demo reset only; never used for first-run setup. */
export function restoreBundledSeed(app: App) {
  const dbPath = resolveDatabasePath(app);
  const seedPath = resolveSeedCandidates().find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    return path.resolve(candidate) !== path.resolve(dbPath);
  });

  if (!seedPath) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const rollbackPath = fs.existsSync(dbPath)
    ? path.join(path.dirname(dbPath), "backups", `${BACKUP_PREFIX}${timestampForFile()}-before-demo-reset.sqlite`)
    : null;
  if (rollbackPath) {
    fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
    fs.copyFileSync(dbPath, rollbackPath, fs.constants.COPYFILE_EXCL);
  }

  try {
    fs.copyFileSync(seedPath, dbPath);
    migrateAndValidateDatabase(dbPath);
  } catch (error) {
    if (rollbackPath) fs.copyFileSync(rollbackPath, dbPath);
    throw error;
  }

  retainRecentMigrationBackups(dbPath);
  process.env.DATABASE_URL = toPrismaFileUrl(dbPath);
  return true;
}

export async function getPrisma(app: App) {
  ensureDatabaseFile(app);

  if (!prisma) {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }

  return prisma;
}

export async function disconnectPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
