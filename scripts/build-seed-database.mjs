import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Builds the seed database that ships inside a Wheat installer.
 *
 * A packaged Wheat carries one empty-but-migrated SQLite file as
 * `resources/seed/wheat-seed.db`, which `restoreBundledSeed` copies into a new
 * profile. That file used to be `prisma/dev.db` — the developer's own working
 * database — and packaging got it there by running `prisma migrate reset` over
 * it before every build.
 *
 * Two things were wrong with that:
 *
 *  - **It destroyed whatever the developer was working on**, every time anybody
 *    packaged anything, for a file that packaging only ever reads.
 *  - **It was not reproducible.** What shipped was whatever `dev.db` happened to
 *    contain after the reset and the seed ran against a file that already
 *    existed, rather than a database built from the migrations and the seed
 *    alone.
 *
 * So the seed is built here, from nothing, into a disposable file under
 * `build/` — which is generated output, ignored by Git, and beside the
 * generated icon for the same reason. `prisma/dev.db` is never opened.
 *
 *   npm run seed:build
 *
 * `npm run db:reset` still exists and still resets the development database.
 * That is a developer's deliberate choice; it is no longer packaging's side
 * effect.
 */

const root = path.resolve(import.meta.dirname, "..");
const seedPath = path.join(root, "build", "wheat-seed.db");

/**
 * Prisma wants a URL, and a Windows path with backslashes is not one. The same
 * conversion the application makes in `electron/database.ts`.
 */
const databaseUrl = `file:${seedPath.replaceAll("\\", "/")}`;

// Every build starts from nothing, so the shipped file is a function of the
// migrations and the seed script and of nothing else. SQLite's sidecars go too:
// a stale -wal beside a fresh database is a database with someone else's
// uncommitted pages in front of it.
fs.mkdirSync(path.dirname(seedPath), { recursive: true });
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  fs.rmSync(`${seedPath}${suffix}`, { force: true });
}

const environment = { ...process.env, DATABASE_URL: databaseUrl };

/**
 * `migrate deploy`, not `migrate reset`.
 *
 * Deploy applies the pending migrations to whatever is there; against a file
 * that does not exist yet that is the whole history, in order. It has no
 * destructive mode to invoke by accident and no prompt to force past.
 */
function run(label, executable, args) {
  console.log(`  ${label}`);
  execFileSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
}

console.log(`Building the packaged seed database`);
console.log(`  target ${path.relative(root, seedPath)}`);
run("prisma migrate deploy", path.join(root, "node_modules", "prisma", "build", "index.js"), ["migrate", "deploy"]);
run("prisma/seed.ts", path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), [path.join("prisma", "seed.ts")]);

if (!fs.existsSync(seedPath)) throw new Error(`The seed database was not produced at ${seedPath}.`);
const bytes = fs.statSync(seedPath).size;
// A migrated, seeded Wheat database is hundreds of kilobytes. An empty SQLite
// file is 0; a migrated-but-unseeded one is small. Either means a step above
// reported success without doing anything, which would ship a Wheat whose first
// dossier has no chart of accounts.
if (bytes < 64 * 1024) throw new Error(`The seed database is only ${bytes} bytes; the migrations or the seed did not run.`);
console.log(`  ${(bytes / 1024).toFixed(0)} KB`);

/** Where the packaging configuration expects to find it. */
export const PACKAGED_SEED_DATABASE = path.relative(root, seedPath).replaceAll("\\", "/");
