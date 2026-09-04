/**
 * Guided work driven through the real application, not the engine alone.
 *
 * The unit suite (`wheat-guided-work`) pins the decisions. This pins that they
 * survive the whole stack — IPC bridge, React screen, domain services, SQLite —
 * and that the screen honours the two rules that make approval meaningful:
 *
 *   a line Wheat flagged for review is *not* ticked for you, and the primary
 *   button stays disabled until somebody ticks it deliberately;
 *
 *   approving executes through the ordinary domain service, so what lands in
 *   the database is what that service would have written from its own screen.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");

test("guided work prepares, refuses to self-approve a flagged line, then executes it", async () => {
  test.setTimeout(180_000);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-guided-electron-"));
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporaryRoot, "userData") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 30_000 });

  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Nom de la société").fill("GUIDED SARL");
  await page.getByLabel("Ville").fill("Casablanca");
  await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

  // A dossier whose identity is complete but whose VAT is not configured: the
  // first step Wheat can actually perform rather than merely advise on.
  await page.evaluate(async () => {
    const boot = await window.wheat.getBootstrap();
    const company = boot.companies[0];
    await window.wheat.updateCompanySettings({
      companyId: company.id,
      expectedVersion: company.version,
      name: company.name,
      legalForm: "SARL",
      ice: "000187958000077",
      taxId: "1110375",
      city: "Casablanca",
      vatFrequency: "MONTHLY",
    });
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 30_000 });
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

  await page.locator(".wt-rail").getByRole("button", { name: "Travail guidé", exact: true }).click();
  await expect(page.locator('[data-testid="guided-work"]')).toBeVisible({ timeout: 30_000 });

  // DETECT + PREPARE: a concrete operation, with what Wheat read to build it.
  await expect(page.locator('[data-testid="guided-operations"] .wt-guided__op')).toHaveCount(1, { timeout: 30_000 });
  const detected = await page.locator('[data-testid="guided-detected"] dt').allTextContents();
  expect(detected).toContain("Taux retenus");
  expect(detected).toContain("TVA facturée");
  expect(detected).toContain("TVA récupérable");
  // The accounts come from this dossier's own chart, not from a constant.
  await expect(page.locator('[data-testid="guided-detected"]')).toContainText("445500");
  await expect(page.locator('[data-testid="guided-detected"]')).toContainText("345520");

  // REVIEW: no piece in the dossier confirms the rates, so the line is flagged
  // and left unticked — and the primary button says why it is disabled.
  await expect(page.locator('[data-testid="guided-operations"] .wt-guided__op[data-status="REVIEW"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="guided-operations"] input[type="checkbox"]').first()).not.toBeChecked();
  await expect(page.locator(".wt-guided__approve button")).toBeDisabled();
  await expect(page.locator(".wt-guided__approve-note")).toContainText(/Aucune ligne n'est cochée/);

  // APPROVE + EXECUTE, deliberately.
  await page.locator('[data-testid="guided-operations"] input[type="checkbox"]').first().check();
  await expect(page.locator(".wt-guided__approve button")).toBeEnabled();
  await page.locator(".wt-guided__approve button").click();
  await expect(page.locator('[data-testid="guided-executed"] li')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('[data-testid="guided-failed"]')).toHaveCount(0);

  // What actually landed: an active configuration, written by the tax service.
  const stored = await page.evaluate(async () => {
    const boot = await window.wheat.getBootstrap();
    const workspace = await window.wheat.getTaxWorkspace({ companyId: boot.activeCompanyId });
    const configurations = workspace.configurations ?? workspace.taxConfigurations ?? [];
    const active = configurations.filter((item) => item.status === "ACTIVE");
    return active.map((item) => ({
      frequency: item.filingFrequency,
      basis: item.accountingBasis,
      rateCount: (item.rates ?? []).length,
      directions: [...new Set((item.rates ?? []).map((rate) => rate.direction))].sort(),
    }));
  });
  expect(stored).toHaveLength(1);
  expect(stored[0].frequency).toBe("MONTHLY");
  expect(stored[0].basis).toBe("COLLECTION");
  // Four statutory rates, each on both sides of the ledger.
  expect(stored[0].rateCount).toBe(8);
  expect(stored[0].directions).toEqual(["COLLECTED", "DEDUCTIBLE"]);

  // NEXT: the step is recomputed from the dossier and no longer offers itself.
  await expect(page.locator('[data-testid="guided-steps"] [data-step="vat-configuration"]')).toHaveCount(0, { timeout: 30_000 });

  expect(consoleErrors).toEqual([]);

  await app.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("a postponed step steps aside in the interface and can be resumed", async () => {
  test.setTimeout(180_000);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-guided-postpone-"));
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
  await page.getByLabel("Nom de la société").fill("REPORT SARL");
  await page.getByLabel("Ville").fill("Casablanca");
  await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

  await page.locator(".wt-rail").getByRole("button", { name: "Travail guidé", exact: true }).click();
  await expect(page.locator('[data-testid="guided-work"]')).toBeVisible({ timeout: 30_000 });

  const firstStep = await page.locator(".wt-card__title").first().textContent();
  await page.getByRole("button", { name: "Reporter" }).click();
  // The step Wheat was on is no longer the one it asks about…
  await expect(page.locator(".wt-card__title").first()).not.toHaveText(firstStep, { timeout: 30_000 });
  // …but it is still listed, marked as postponed, never as finished.
  await page.getByRole("button", { name: "Afficher tout le parcours" }).click();
  await expect(page.locator('[data-testid="guided-steps"]')).toContainText("Reportée");

  // Scoped to the journey list and named for what it resumes: "Reprendre" on
  // its own also matches the setup gate's "…à reprendre" choices, which sit
  // above guided work on the same screen.
  await page.locator('[data-testid="guided-steps"]').getByRole("button", { name: "Reprendre l'étape" }).first().click();
  await expect(page.locator(".wt-card__title").first()).toHaveText(firstStep, { timeout: 30_000 });

  await app.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
