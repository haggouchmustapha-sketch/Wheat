const { test, expect } = require("@playwright/test");
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

test("the installed-update modal appears once and Settings can manually check", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-updater-electron-"));
  const profile = path.join(temporary, "profile");
  const updaterDirectory = path.join(profile, "updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(path.join(updaterDirectory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    status: {
      phase: "updated",
      source: "local",
      currentVersion: "2.1.0",
      automaticInstallationEnabled: false,
      message: "Updated to 2.1.0",
    },
    lastSuccessfullyInstalledVersion: "2.1.0",
    notification: {
      version: "2.1.0",
      releaseDate: "2026-08-28",
      notes: ["Added automatic local updates", "Improved update recovery"],
      installedAt: "2026-08-28T00:00:00.000Z",
      consumed: false,
    },
  }));

  const { child, token } = launchWheat({ port, profile, label: "atlas-updater-ui" });
  let browser;
  try {
    await waitForCdp(port, true);
    let connected = await connectPage(port);
    browser = connected.browser;
    let page = connected.page;

    const updateDialog = page.getByRole("dialog", { name: "Wheat a été mis à jour" });
    await expect(updateDialog).toBeVisible({ timeout: 20000 });
    await expect(updateDialog).toContainText("Version 2.1.0");
    await expect(updateDialog).toContainText("Added automatic local updates");
    await updateDialog.getByRole("button", { name: "Fermer" }).click();
    await expect(updateDialog).toHaveCount(0);

    await expect(page.locator(".onboarding-shell")).toBeVisible();
    await page.getByLabel("Nom de la société").fill("UPDATE UI TEST SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    const checkButton = page.getByRole("button", { name: "Rechercher les mises à jour" });
    await checkButton.click();
    await expect(page.getByText("Wheat est à jour", { exact: true })).toBeVisible();

    const previousTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp(); });
    connected = await connectNewRuntime(port, previousTargetId);
    browser = connected.browser;
    page = connected.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("dialog", { name: "Wheat a été mis à jour" })).toHaveCount(0);
  } finally {
    await stopWheat({ browser, child, token });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/**
 * The consent flow, in the real window.
 *
 * The property being pinned is that Wheat asks before it acts. A version that
 * has been found is *offered*; nothing is downloaded until the accountant says
 * so, and Wheat never closes itself. "Plus tard" is a first-class answer that
 * keeps the update available without interrupting again.
 */
test("an available update is offered and waits, and Plus tard stops interrupting", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-updater-consent-"));
  const profile = path.join(temporary, "profile");
  const updates = path.join(temporary, "updates");

  // A local feed standing in for a published GitHub release. The installer is
  // a placeholder: this test is about the decision, not about the bytes.
  const version = "99.0.0";
  const artifactName = `WheatSetup-${version}.exe`;
  const artifactBytes = Buffer.from("placeholder NSIS installer");
  fs.mkdirSync(path.join(updates, version), { recursive: true });
  fs.writeFileSync(path.join(updates, version, artifactName), artifactBytes);
  fs.writeFileSync(path.join(updates, "latest.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    releaseDate: "2026-09-03",
    notes: ["Import bancaire amélioré", "OCR amélioré", "Corrections de stabilité"],
    artifact: `${version}/${artifactName}`,
    sha256: require("node:crypto").createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSize: artifactBytes.length,
  }, null, 2));

  const { child, token } = launchWheat({ port, profile, env: { WHEAT_UPDATES_DIR: updates }, label: "wheat-updater-consent" });
  let browser;
  try {
    await waitForCdp(port, true);
    const connected = await connectPage(port);
    browser = connected.browser;
    const page = connected.page;

    // The launch check runs on its own, beside whatever the person is doing.
    const offer = page.getByRole("dialog", { name: "Une mise à jour de Wheat est disponible" });
    await expect(offer).toBeVisible({ timeout: 30000 });
    await expect(offer).toContainText(`Version ${version}`);
    await expect(offer).toContainText("Import bancaire amélioré");
    await expect(offer).toContainText("Corrections de stabilité");
    await expect(offer.getByRole("button", { name: "Plus tard" })).toBeVisible();
    await expect(offer.getByRole("button", { name: "Mettre à jour" })).toBeVisible();

    // Nothing was downloaded to reach this point: the offer is the whole of what
    // an unattended check is allowed to do.
    const beforeConsent = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(beforeConsent.phase).toBe("available");

    await offer.getByRole("button", { name: "Plus tard" }).click();
    await expect(offer).toHaveCount(0);

    // Still on offer, still not interrupting — and Wheat is still fully usable.
    const postponed = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(postponed).toMatchObject({ phase: "available", availableVersion: version, postponed: true });

    const rechecked = await page.evaluate(() => window.wheat.checkForUpdates());
    expect(rechecked.postponed).toBe(true);
    await expect(page.getByRole("dialog", { name: "Une mise à jour de Wheat est disponible" })).toHaveCount(0);
  } finally {
    await stopWheat({ browser, child, token });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
