/**
 * A dossier holding an awkwardly named attachment must still back up.
 *
 * The reported defect was not that one document failed: it was that a single
 * managed file stored under a name the archive's path contract refuses made the
 * whole dossier impossible to back up. The repair is unit-tested against the
 * exact filenames that caused it; this test is the other half — that the repair
 * actually runs inside the real application, on the real profile, on the path a
 * person takes when they press "Créer une sauvegarde".
 *
 * It also runs the backup twice, and across a restart, because the reported
 * symptom was discovered on the second attempt.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
const archive = tsxRequire(path.join(cwd, "electron", "archive.ts"), __filename);

/**
 * The attachment, proven present by the archive's own manifest rather than
 * by searching the file for plaintext: entries are compressed, so a byte
 * scan proves nothing either way.
 */
async function attachmentsIn(archivePath, workingDirectory) {
  const summary = await archive.validateWheatBackup(archivePath, { workingDirectory });
  return summary.manifest.files.filter((file) => file.kind === "attachment");
}

/** Where the dossier believes one managed document is stored, read from disk. */
function storedPathOf(databasePath, documentId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare('SELECT "storedPath" FROM "Document" WHERE "id" = ?').get(documentId);
  } finally {
    database.close();
  }
}

/** The shape the recogniser used to produce: a truncation landing on a space. */
const UNSAFE_RELATIVE = "ACME SARL /facture .pdf";

async function launch(userDataDir) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20_000 });
  return { app, page };
}

/** Points every backup save dialog at a known file instead of a chooser. */
async function stubSaveDialog(app, filePath) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, filePath);
}

test("a dossier with an unbackuppable attachment backs up, twice and after a restart", async () => {
  test.setTimeout(240_000);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-backup-electron-"));
  const userDataDir = path.join(tempRoot, "userData");
  let app = null;

  try {
    // --- A dossier with documents, created by the application itself. -------
    let launched = await launch(userDataDir);
    app = launched.app;
    let page = launched.page;
    await page.evaluate(async () => { await window.wheat.resetWorkspace({ mode: "demo" }); });
    const companyId = await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      return boot.activeCompanyId;
    });
    const databasePath = await page.evaluate(() => window.wheat.getDatabasePath());
    expect(fs.existsSync(databasePath)).toBe(true);
    await app.close();
    app = null;

    // --- One attachment stored under a name the archive refuses. -----------
    // Planted directly, because the sanitiser that produced such names has
    // since been fixed: this is the state an existing installation is in, not
    // a state the current application can still create.
    const documentsRoot = path.join(userDataDir, "documents");
    const unsafePath = path.join(documentsRoot, ...UNSAFE_RELATIVE.split("/"));
    const bytes = Buffer.from("facture 1 250,00 MAD\n", "utf8");
    fs.mkdirSync(path.dirname(unsafePath), { recursive: true });
    fs.writeFileSync(unsafePath, bytes);

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(
        'INSERT INTO "Document" ("id","companyId","title","type","fiscalYear","tags","storedPath","contentSha256","mimeType","byteSize","ocrText","extracted","status","createdAt")'
        + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        "doc-unsafe-name",
        companyId,
        "Facture ACME",
        "PURCHASE_INVOICE",
        "2026",
        "[]",
        unsafePath,
        createHash("sha256").update(bytes).digest("hex"),
        "application/pdf",
        bytes.length,
        "facture 1 250,00 MAD",
        "{}",
        "TO_REVIEW",
        new Date().toISOString(),
      );
    } finally {
      database.close();
    }

    // --- The backup a person actually presses. -----------------------------
    launched = await launch(userDataDir);
    app = launched.app;
    page = launched.page;

    const firstBackup = path.join(tempRoot, "premiere.wheatbackup");
    await stubSaveDialog(app, firstBackup);
    const firstPath = await page.evaluate(() => window.wheat.createBackup());
    expect(firstPath, "the first backup returned no archive path").toBeTruthy();
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.statSync(firstPath).size).toBeGreaterThan(0);

    // The attachment travelled. Being left out is the failure this guards
    // against, so its presence is read from the manifest and its identity from
    // the checksum the manifest records.
    const digest = createHash("sha256").update(bytes).digest("hex");
    const firstAttachments = await attachmentsIn(firstPath, tempRoot);
    expect(firstAttachments.map((file) => file.sha256), "the attachment is missing from the archive").toContain(digest);
    for (const file of firstAttachments) {
      expect(archive.isPortableArchiveRelativePath(file.path), file.path).toBe(true);
    }

    // The row now points at a portable name, and at a file that is there.
    const repaired = storedPathOf(databasePath, "doc-unsafe-name");
    expect(fs.existsSync(repaired.storedPath), "the repaired row points at no file").toBe(true);
    expect(fs.readFileSync(repaired.storedPath), "the repair did not carry the bytes").toEqual(bytes);
    // The contract that matters is the archive's, applied to the path the
    // dossier now holds — not a guess about which character was offending.
    const repairedRelative = path.relative(documentsRoot, repaired.storedPath).split(path.sep).join("/");
    expect(archive.isPortableArchiveRelativePath(repairedRelative), repairedRelative).toBe(true);

    // --- Twice: the reported symptom appeared on the second attempt. -------
    const secondBackup = path.join(tempRoot, "seconde.wheatbackup");
    await stubSaveDialog(app, secondBackup);
    const secondPath = await page.evaluate(() => window.wheat.createBackup());
    expect(secondPath, "the second backup returned no archive path").toBeTruthy();
    expect(fs.existsSync(secondPath)).toBe(true);
    expect((await attachmentsIn(secondPath, tempRoot)).map((file) => file.sha256)).toContain(digest);

    await app.close();
    app = null;

    // --- And after a restart, against the same profile. --------------------
    launched = await launch(userDataDir);
    app = launched.app;
    page = launched.page;
    const thirdBackup = path.join(tempRoot, "apres-redemarrage.wheatbackup");
    await stubSaveDialog(app, thirdBackup);
    const thirdPath = await page.evaluate(() => window.wheat.createBackup());
    expect(thirdPath, "the backup after a restart returned no archive path").toBeTruthy();
    expect(fs.existsSync(thirdPath)).toBe(true);
    expect((await attachmentsIn(thirdPath, tempRoot)).map((file) => file.sha256)).toContain(digest);

    /*
     * And the screen says so while it happens.
     *
     * Backing up a dossier copies its database and every stored document. It
     * used to run behind a button that never changed, which from the outside
     * is indistinguishable from a frozen application — and the usual response
     * to a frozen application is to press the button again, which starts a
     * second backup over the first.
     *
     * Driven through the real control rather than the IPC, because the thing
     * being tested is the screen.
     */
    const uiBackup = path.join(tempRoot, "depuis-le-bouton.wheatbackup");
    await stubSaveDialog(app, uiBackup);
    const banner = page.locator(".wt-running-task");
    // The region is always mounted, so a screen reader has somewhere to listen.
    await expect(banner).toHaveCount(1);
    await expect(banner).toHaveAttribute("aria-live", "polite");
    await expect(banner).toBeEmpty();

    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    const backupButton = page.getByRole("button", { name: "Sauvegarder", exact: true });
    await expect(backupButton).toBeVisible({ timeout: 15_000 });
    await backupButton.click();
    await expect(banner).toContainText("Sauvegarde du dossier en cours…", { timeout: 10_000 });
    // And it resolves rather than spinning forever.
    await expect(banner).toBeEmpty({ timeout: 60_000 });
    expect(fs.existsSync(uiBackup), "the button did not produce a backup").toBe(true);
  } finally {
    if (app) await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
