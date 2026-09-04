/**
 * "Compléter l'identité" completes the identity.
 *
 * The step asks for the ICE, the tax identifier, the legal form and the city,
 * because a Moroccan invoice must carry them. Clicking it used to navigate to
 * the settings tab — a different screen, with a different purpose, where the
 * identity form is one panel among several — and the person arrived having lost
 * the step they were on and with nothing on screen saying what was being asked.
 *
 * This pins the guided action to the editor it names: the dialog opens in
 * place, says what is still missing, writes through the same company service as
 * the referentials form, and hands the person back to guided work with the step
 * re-evaluated against what they just saved.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = require(path.join(cwd, "node_modules", "electron"));

test("the identity step opens the identity editor, saves, and returns to guided work", async () => {
  test.setTimeout(180_000);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-identity-"));
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporaryRoot, "userData") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 30_000 });

  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Nom de la société").fill("IDENTITE SARL");
  await page.getByLabel("Ville").fill("Casablanca");
  await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

  await page.locator(".wt-rail").getByRole("button", { name: "Travail guidé", exact: true }).click();
  await expect(page.locator('[data-testid="guided-work"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".wt-card__title").first()).toHaveText("Compléter l'identité de la société");

  await page.getByRole("button", { name: "Compléter l'identité", exact: true }).first().click();

  // The editor itself, not the settings tab.
  const dialog = page.locator(".wt-dialog", { hasText: "Identité du dossier" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".books13-workspace--settings")).toHaveCount(0);
  // It names what is still missing rather than saying "incomplete".
  await expect(dialog).toContainText("ICE");
  await expect(dialog).toContainText("identifiant fiscal");

  await dialog.getByLabel("Forme juridique").fill("SARL");
  await dialog.getByLabel("ICE").fill("001234567000041");
  await dialog.getByLabel("Identifiant fiscal").fill("1110375");
  await dialog.getByRole("button", { name: "Enregistrer l'identité" }).click();

  // Back in guided work, with the step re-evaluated against what was saved.
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-testid="guided-work"]')).toBeVisible();
  await expect(page.locator(".wt-card__title").first()).not.toHaveText("Compléter l'identité de la société", { timeout: 30_000 });

  const saved = await page.evaluate(async () => {
    const boot = await window.wheat.getBootstrap();
    const company = boot?.company ?? boot?.companies?.[0] ?? null;
    return company ? { ice: company.ice, taxId: company.taxId, legalForm: company.legalForm } : null;
  });
  expect(saved).toMatchObject({ ice: "001234567000041", taxId: "1110375", legalForm: "SARL" });

  await app.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
