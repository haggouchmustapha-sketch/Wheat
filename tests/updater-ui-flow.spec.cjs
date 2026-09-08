/**
 * What the accountant actually sees while Wheat updates itself.
 *
 * The service-level guarantees — signature, checksum, staging, rollback, "the
 * app exits only after the helper is ready" — are pinned in `updater.spec.cjs`
 * and are not restated here. What is pinned here is the part a person
 * experiences: that a download shows real figures that move, that a verified
 * update announces itself as installable, that pressing "restart and install"
 * says what is happening before the window would go away, and that an
 * installation which cannot start leaves Wheat running and explains itself
 * instead of hanging on "installing…".
 *
 * These run against the real main process in a real window, because the status
 * pipeline (service → IPC → renderer → dialog) only exists as one thing there.
 *
 * Two recorders carry the specs:
 *
 *  - A **DOM recorder** installed before the interesting click. A local download
 *    of a realistic installer finishes in a fraction of a second, so polling for
 *    the progress dialog would be a coin toss; a MutationObserver instead
 *    records every rendered state as it is committed, and the assertions read
 *    that transcript afterwards. Nothing is simulated — these are the frames the
 *    screen actually drew.
 *  - A **status recorder** on `onUpdateStatus`, holding the byte counts the main
 *    process really emitted, so "the bar moved" is checked against "the bytes
 *    moved" rather than against itself.
 *
 * `WHEAT_UPDATE_ALLOW_INSTALL=1` lets an unpackaged build attempt installation.
 * It is honoured only when unpackaged (see `resolveAutomaticInstallationEnabled`)
 * and grants nothing: a development build has no packaged helper script, so the
 * attempt fails at the readiness gate — which is precisely the failure this file
 * needs to observe.
 */

const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  connectNewRuntime,
  connectPage,
  freePort,
  launchWheat,
  runtimeTargetId,
  stopWheat,
  waitForCdp,
} = require("./wheat-electron-harness.cjs");

/** A stand-in installer big enough that the transfer is reported in stages. */
const ARTIFACT_MEGABYTES = 48;

function publishLocalRelease(updates, version, notes) {
  const artifactName = `WheatSetup-${version}.exe`;
  const artifactPath = path.join(updates, version, artifactName);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const chunk = Buffer.alloc(1024 * 1024, 0x77);
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(artifactPath, "w");
  try {
    for (let index = 0; index < ARTIFACT_MEGABYTES; index += 1) {
      fs.writeSync(handle, chunk);
      hash.update(chunk);
    }
  } finally {
    fs.closeSync(handle);
  }
  const size = ARTIFACT_MEGABYTES * 1024 * 1024;
  fs.writeFileSync(path.join(updates, "latest.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    releaseDate: "2026-09-08",
    notes,
    artifact: `${version}/${artifactName}`,
    sha256: hash.digest("hex"),
    artifactSize: size,
  }, null, 2));
  return { artifactName, artifactPath, size };
}

/**
 * Records every dialog state the renderer commits, deduplicated.
 *
 * Attributes are watched as well as nodes, because the progress bar moves by
 * restyling one element: without them the transcript would show the dialog
 * appearing and never changing.
 */
async function recordDialogs(page) {
  await page.evaluate(() => {
    window.__wheatDialogFrames = [];
    let previous = "";
    const snapshot = () => {
      const dialog = document.querySelector(".wt-dialog");
      if (!dialog) return;
      const bar = dialog.querySelector('[role="progressbar"]');
      const frame = {
        title: dialog.querySelector(".wt-dialog__title")?.textContent?.trim() ?? "",
        note: dialog.querySelector(".wt-dialog__note")?.textContent?.trim() ?? "",
        text: (dialog.textContent ?? "").replace(/\s+/g, " ").trim(),
        progress: bar
          ? {
            determinate: bar.hasAttribute("aria-valuenow"),
            percent: bar.getAttribute("aria-valuenow"),
            width: bar.querySelector("span")?.style.width ?? "",
            indeterminate: bar.classList.contains("wheat-update__bar--indeterminate"),
          }
          : null,
      };
      const serialized = JSON.stringify(frame);
      if (serialized === previous) return;
      previous = serialized;
      if (window.__wheatDialogFrames.length < 800) window.__wheatDialogFrames.push(frame);
    };
    snapshot();
    new MutationObserver(snapshot).observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  });
}

async function recordStatuses(page) {
  await page.evaluate(() => {
    window.__wheatStatuses = [];
    window.wheat.onUpdateStatus((status) => window.__wheatStatuses.push(status));
  });
}

const dialogFrames = (page) => page.evaluate(() => window.__wheatDialogFrames ?? []);
const statuses = (page) => page.evaluate(() => window.__wheatStatuses ?? []);

test("the download shows real moving figures, becomes installable, and a helper that cannot start leaves Wheat open", async () => {
  test.setTimeout(180000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-updater-ui-flow-"));
  const profile = path.join(temporary, "profile");
  const updates = path.join(temporary, "updates");
  const version = "99.1.0";
  const notes = ["Import bancaire plus rapide", "Rapprochement corrige"];
  const release = publishLocalRelease(updates, version, notes);

  const { child, token } = launchWheat({
    port,
    profile,
    env: { WHEAT_UPDATES_DIR: updates, WHEAT_UPDATE_ALLOW_INSTALL: "1" },
    label: "wheat-updater-ui-flow",
  });
  let browser;
  try {
    await waitForCdp(port, true);
    const connected = await connectPage(port);
    browser = connected.browser;
    const page = connected.page;

    const offer = page.getByRole("dialog", { name: "Une mise à jour de Wheat est disponible" });
    await expect(offer).toBeVisible({ timeout: 30000 });

    await recordDialogs(page);
    await recordStatuses(page);
    await offer.getByRole("button", { name: "Mettre à jour" }).click();

    // ---- downloading → verifying → ready ---------------------------------
    const ready = page.getByRole("dialog", { name: "La mise à jour est prête" });
    await expect(ready).toBeVisible({ timeout: 60000 });
    await expect(ready).toContainText(`Version ${version}`);
    for (const note of notes) await expect(ready).toContainText(note);
    await expect(ready.getByRole("button", { name: "Redémarrer et installer" })).toBeVisible();

    // Nothing offers a second download once the first has started: the offer is
    // gone, and Réglages only shows "Mettre à jour" while a version is merely
    // available.
    await expect(page.getByRole("button", { name: "Mettre à jour" })).toHaveCount(0);

    const downloadFrames = (await dialogFrames(page)).filter((frame) => frame.title.startsWith("Téléchargement"));
    expect(downloadFrames.length).toBeGreaterThan(1);
    // The version being fetched stays on screen throughout.
    for (const frame of downloadFrames) expect(frame.note).toBe(`Version ${version}`);
    // A determinate bar, and the figures beside it: percentage, received, total.
    const percentages = downloadFrames
      .filter((frame) => frame.progress?.determinate)
      .map((frame) => Number(frame.progress.percent));
    expect(percentages.length).toBeGreaterThan(1);
    expect(Math.min(...percentages)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...percentages)).toBe(100);
    expect([...percentages].sort((a, b) => a - b)).toEqual(percentages);
    expect(new Set(percentages).size).toBeGreaterThan(1);
    const complete = downloadFrames[downloadFrames.length - 1];
    expect(complete.text).toContain(`${ARTIFACT_MEGABYTES} Mo / ${ARTIFACT_MEGABYTES} Mo`);
    expect(complete.progress.width).toBe("100%");

    // The bar tracked bytes the main process actually transferred, not a timer.
    const progressStatuses = (await statuses(page)).filter((status) => status.phase === "downloading" && status.download);
    expect(progressStatuses.length).toBeGreaterThan(1);
    const transferred = progressStatuses.map((status) => status.download.transferredBytes);
    expect([...transferred].sort((a, b) => a - b)).toEqual(transferred);
    expect(transferred[transferred.length - 1]).toBe(release.size);
    for (const status of progressStatuses) expect(status.download.totalBytes).toBe(release.size);

    const stagedBefore = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(stagedBefore.phase).toBe("ready");
    expect(stagedBefore.automaticInstallationEnabled).toBe(true);

    // ---- installing, then a helper that cannot start ---------------------
    await page.evaluate(() => { window.__wheatDialogFrames.length = 0; window.__wheatStatuses.length = 0; });
    await ready.getByRole("button", { name: "Redémarrer et installer" }).click();

    const failed = page.getByRole("dialog", { name: "L'installation n'a pas pu démarrer" });
    await expect(failed).toBeVisible({ timeout: 60000 });

    // Wheat said what it was doing before it would have closed, with an
    // indeterminate bar: the NSIS installer publishes no progress of its own.
    const installingFrames = (await dialogFrames(page)).filter((frame) => frame.title.startsWith("Installation de la mise à jour"));
    expect(installingFrames.length).toBeGreaterThan(0);
    expect(installingFrames[0].note).toBe(`Version ${version}`);
    expect(installingFrames[0].text).toContain("se fermer et se rouvrir automatiquement");
    expect(installingFrames[0].progress).toMatchObject({ determinate: false, indeterminate: true });

    const installStatuses = await statuses(page);
    expect(installStatuses.map((status) => status.phase)).toContain("installing");
    // And it did not stay there.
    expect(installStatuses[installStatuses.length - 1].phase).toBe("ready");

    // The window is still here, still usable, still the version it was.
    await expect(page.locator(".onboarding-shell")).toBeVisible();
    await expect(failed).toContainText(`Wheat ${stagedBefore.currentVersion} n'a pas été modifié`);
    await expect(failed.getByRole("button", { name: "Réessayer l'installation" })).toBeVisible();

    const afterFailure = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(afterFailure).toMatchObject({ phase: "ready", availableVersion: version, currentVersion: stagedBefore.currentVersion });
    expect(afterFailure.error).toMatch(/helper/i);

    // The verified installer is still staged, so "réessayer" costs no download.
    const stagedArtifact = path.join(profile, "updater", "staging", version, release.artifactName);
    expect(fs.statSync(stagedArtifact).size).toBe(release.size);
    const stateOnDisk = JSON.parse(fs.readFileSync(path.join(profile, "updater", "state.json"), "utf8"));
    expect(stateOnDisk.pending.release.version).toBe(version);
    expect(stateOnDisk.pending.installStartedAt).toBeUndefined();

    await failed.getByRole("button", { name: "Plus tard" }).click();
    await page.getByLabel("Nom de la société").fill("APRES ECHEC SARL");
    await expect(page.getByLabel("Nom de la société")).toHaveValue("APRES ECHEC SARL");
  } finally {
    await stopWheat({ browser, child, token });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a completed installation is confirmed on the next launch, once, with the accounting data untouched", async () => {
  test.setTimeout(180000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-updater-ui-confirm-"));
  const profile = path.join(temporary, "profile");
  // An empty feed: this spec is about the launch after an install, so nothing
  // new must be offered on top of it.
  const updates = path.join(temporary, "updates");
  fs.mkdirSync(updates, { recursive: true });

  const { child, token } = launchWheat({
    port,
    profile,
    env: { WHEAT_UPDATES_DIR: updates },
    label: "wheat-updater-ui-confirm",
  });
  let browser;
  try {
    await waitForCdp(port, true);
    let connected = await connectPage(port);
    browser = connected.browser;
    let page = connected.page;

    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 20000 });
    await page.getByLabel("Nom de la société").fill("MISE A JOUR SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });

    const before = await page.evaluate(() => window.wheat.getBootstrap());
    const installedVersion = (await page.evaluate(() => window.wheat.getUpdateStatus())).currentVersion;

    // The unattended launch check must have settled before its state file is
    // replaced, or it would write over the state this spec is about.
    await expect
      .poll(() => page.evaluate(() => window.wheat.getUpdateStatus().then((status) => status.phase)), { timeout: 30000 })
      .toBe("up-to-date");

    // The state the Windows helper leaves behind when it has finished: an
    // installation was started for a version that is now the running one.
    // Written after the unattended launch check, which has long since settled.
    fs.writeFileSync(path.join(profile, "updater", "state.json"), JSON.stringify({
      schemaVersion: 1,
      status: {
        phase: "installing",
        source: "local",
        currentVersion: installedVersion,
        availableVersion: installedVersion,
        automaticInstallationEnabled: false,
        message: `Installing update ${installedVersion}`,
      },
      pending: {
        release: {
          schemaVersion: 1,
          version: installedVersion,
          releaseDate: "2026-09-08",
          notes: ["Suivi de la mise a jour visible", "Reprise apres echec d'installation"],
          artifact: `${installedVersion}/WheatSetup-${installedVersion}.exe`,
          sha256: "0".repeat(64),
        },
        artifactPath: path.join(profile, "updater", "staging", installedVersion, "WheatSetup.exe"),
        previousVersion: "0.0.1",
        stagedAt: new Date().toISOString(),
        installStartedAt: new Date().toISOString(),
      },
    }, null, 2));

    const previousTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp().catch(() => undefined); });
    connected = await connectNewRuntime(port, previousTargetId);
    browser = connected.browser;
    page = connected.page;

    const notice = page.getByRole("dialog", { name: "Wheat a été mis à jour" });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice).toContainText(`Version ${installedVersion}`);
    await expect(notice).toContainText("Suivi de la mise a jour visible");
    await expect(notice).toContainText("Vos données comptables sont intactes");

    // The claim the notice makes is the one that gets checked.
    const after = await page.evaluate(() => window.wheat.getBootstrap());
    expect(after.companies.map((company) => company.name)).toEqual(before.companies.map((company) => company.name));
    expect(after.entries.length).toBe(before.entries.length);

    await notice.getByRole("button", { name: "Continuer" }).click();
    await expect(notice).toHaveCount(0);

    const confirmed = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(confirmed).toMatchObject({ phase: "up-to-date", currentVersion: installedVersion });

    // Once, not on every launch afterwards.
    const secondTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp().catch(() => undefined); });
    connected = await connectNewRuntime(port, secondTargetId);
    browser = connected.browser;
    page = connected.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("dialog", { name: "Wheat a été mis à jour" })).toHaveCount(0);
  } finally {
    await stopWheat({ browser, child, token });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
