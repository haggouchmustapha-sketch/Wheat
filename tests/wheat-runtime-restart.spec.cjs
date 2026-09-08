const { test, expect } = require("@playwright/test");
const { openDossierForWork } = require("./wheat-ui-helpers.cjs");
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

test("a real Electron relaunch clears stale modal focus and restores keyboard input", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-21-real-restart-"));
  const { child, token } = launchWheat({ port, profile: path.join(temporary, "profile"), label: "atlas-restart-test" });
  let browser;
  try {
    await waitForCdp(port, true, 30000);
    let connected = await connectPage(port);
    browser = connected.browser;
    let page = connected.page;
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("RESTART TEST SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".topbar .primary-button").click();
    const focusedBefore = page.getByPlaceholder("Référence de la pièce");
    await expect(focusedBefore).toBeFocused();
    await focusedBefore.fill("RESTART-PRE-1");

    const previousTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp().catch(() => undefined); return true; });
    connected = await connectNewRuntime(port, previousTargetId);
    browser = connected.browser;
    page = connected.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".entry-modal")).toHaveCount(0);
    const focusState = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inert: document.body.hasAttribute("inert"), overflow: document.body.style.overflow, pointerEvents: document.body.style.pointerEvents }));
    expect(focusState.inert).toBe(false);
    expect(focusState.pointerEvents).toBe("");

    const globalSearch = page.locator(".topbar-search input");
    await globalSearch.fill("capital");
    await expect(globalSearch).toHaveValue("capital");
    await page.keyboard.press("Control+K");
    await expect(page.locator(".wt-palette__search input")).toBeFocused();
    await page.keyboard.type("atlas 2.1");
    await expect(page.locator(".wt-palette__search input")).toHaveValue("atlas 2.1");
    await page.keyboard.press("Escape");

    await page.locator(".wt-rail").getByRole("button", { name: "Comptes & états", exact: true }).click();
    await expect(page.locator(".fiscal-ws")).toBeVisible();
    const pcgeSearch = page.getByPlaceholder("Rechercher numéro, libellé ou arabe…");
    await pcgeSearch.fill("amortissement");
    await expect(pcgeSearch).toHaveValue("amortissement");
    await expect(page.locator(".fiscal-ws-table tbody tr").first()).toBeVisible();

    await page.locator(".topbar .primary-button").click();
    const labelAfter = page.getByPlaceholder("Ex : Facture client mars 2026");
    await labelAfter.fill("Saisie après redémarrage");
    await expect(labelAfter).toHaveValue("Saisie après redémarrage");
    await page.getByRole("button", { name: "Annuler" }).click();
  } finally {
    await stopWheat({ browser, child, token });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
