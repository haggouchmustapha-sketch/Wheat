/**
 * The review layer and the guided journey inside the real application.
 *
 * The unit suites prove the pipeline's rules; this one proves the wiring: the
 * bridge method exists, the IPC handler is registered, the result survives
 * serialisation, the shared dialog appears at the right moment, a deterministic
 * blocker really does stop the save, and Escape puts the person back on their
 * form with nothing written.
 *
 * It also pins the honest-unavailability promise end to end: on a machine with
 * no local model and no provider key — which is what CI is — the dialog says
 * the AI review did not run, and the deterministic verdict is still there.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile, openDossierForWork } = require("./wheat-ui-helpers.cjs");

test("the shared review and the guided journey are wired end to end", async () => {
  test.setTimeout(180000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-review-e2e-"));
  const app = await electron.launch({
    executablePath: electronExe,
    args: packagedExe ? [] : [cwd],
    cwd,
    env: {
      ...process.env,
      APPDATA: path.join(tempDir, "appData"),
      LOCALAPPDATA: path.join(tempDir, "localAppData"),
      WHEAT_USER_DATA_DIR: path.join(tempDir, "userData"),
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await assertIsolatedProfile(page, tempDir);

    /* ---------------------------------------------------------- the bridge */

    const bridge = await page.evaluate(() => ({
      review: typeof window.wheat.reviewBeforeMutation,
      coverage: typeof window.wheat.getReviewCoverage,
      journey: typeof window.wheat.getGuidedJourney,
    }));
    expect(bridge).toEqual({ review: "function", coverage: "function", journey: "function" });

    const coverage = await page.evaluate(() => window.wheat.getReviewCoverage());
    expect(coverage.total).toBeGreaterThan(150);
    expect(coverage.byClassification.REVIEW_REQUIRED).toBeGreaterThanOrEqual(40);
    // Every workflow carries the reason it is classified the way it is.
    expect(coverage.workflows.every((item) => String(item.reason || "").length > 20)).toBe(true);

    /* ------------------------------------------------------- a real dossier */

    const fixture = await page.evaluate(async () => {
      const api = window.wheat;
      let boot = await api.getBootstrap();
      let company = boot.companies.find((item) => item.id === boot.activeCompanyId) ?? boot.companies[0];
      if (!company) {
        company = await api.createCompany({
          name: "REVIEW E2E SARL",
          legalForm: "SARL",
          ice: "001000000000009",
          taxId: "IF 100009",
          city: "Casablanca",
          fiscalYearStart: "2026-01-01",
          fiscalYearEnd: "2026-12-31",
          vatFrequency: "MONTHLY",
        });
        boot = await api.getBootstrap(company.id);
        company = boot.companies.find((item) => item.id === company.id) ?? boot.companies[0];
      }
      const journal = company.journals.find((item) => item.code === "OD") ?? company.journals[0];
      const debit = company.accounts.find((item) => item.code === "342100") ?? company.accounts[0];
      const credit = company.accounts.find((item) => item.code.startsWith("7")) ?? company.accounts[1];
      const pieceNumber = `REVIEW-${Date.now()}`;
      await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-21T00:00:00.000Z",
        pieceNumber,
        label: "Écriture relue par Wheat",
        source: "REVIEW_E2E",
        lines: [
          { accountId: debit.id, label: "Débit", debit: 500, credit: 0 },
          { accountId: credit.id, label: "Crédit", debit: 0, credit: 500 },
        ],
      });
      return { companyId: company.id, journalId: journal.id, debitId: debit.id, creditId: credit.id, pieceNumber };
    });

    /* --------------------------------------- the review itself, through IPC */

    const unbalanced = await page.evaluate(async ({ companyId, journalId, debitId, creditId }) => window.wheat.reviewBeforeMutation({
      companyId,
      workflowId: "entry.create",
      draft: {
        journalId,
        date: "2026-05-21",
        label: "Écriture déséquilibrée",
        lines: [
          { accountId: debitId, label: "Débit", debit: "100.00", credit: "0" },
          { accountId: creditId, label: "Crédit", debit: "0", credit: "90.00" },
        ],
      },
    }), fixture);

    expect(unbalanced.blocked).toBe(true);
    expect(unbalanced.findings.map((item) => item.code)).toContain("ENTRY.UNBALANCED");
    // Provenance has to be honest whichever way this machine is configured:
    // with a local model installed the review really runs locally, and with
    // none it says so instead of presenting the deterministic half as an AI
    // reading. Both are asserted, so neither can quietly become the other.
    expect(unbalanced.model.ran).toBe(unbalanced.model.status === "LOCAL" || unbalanced.model.status === "REMOTE");
    if (unbalanced.model.ran) {
      expect(["LOCAL", "REMOTE"]).toContain(unbalanced.model.locality);
      expect(unbalanced.model.modelId).toBeTruthy();
      expect(unbalanced.model.message).toMatch(unbalanced.model.locality === "LOCAL" ? /quitté cet ordinateur/i : /distance/i);
    } else {
      expect(["UNAVAILABLE", "DECLINED", "FAILED"]).toContain(unbalanced.model.status);
      expect(unbalanced.model.locality).toBe(unbalanced.model.status === "FAILED" ? unbalanced.model.locality : "NONE");
      expect(unbalanced.model.message).toMatch(/déterministes/i);
    }
    // A model may never turn a deterministic blocker into an opinion.
    expect(unbalanced.findings.filter((item) => item.severity === "BLOCKER").every((item) => item.origin === "DETERMINISTIC")).toBe(true);
    expect(unbalanced.checked.length).toBeGreaterThan(0);

    // The review must not have created anything while inspecting.
    const entryCountAfterReview = await page.evaluate(async (companyId) => {
      const boot = await window.wheat.getBootstrap(companyId);
      return boot.entries.filter((entry) => entry.label === "Écriture déséquilibrée").length;
    }, fixture.companyId);
    expect(entryCountAfterReview).toBe(0);

    /* -------------------------------------------------------- the journey */

    const journey = await page.evaluate((companyId) => window.wheat.getGuidedJourney({ companyId }), fixture.companyId);
    expect(journey.total).toBe(15);
    expect(journey.next).toBeTruthy();
    expect(String(journey.next.why).length).toBeGreaterThan(30);
    expect(journey.stages.every((stage) => ["DONE", "READY", "BLOCKED", "NEEDS_ANSWER"].includes(stage.status))).toBe(true);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.locator(".app-shell").first().waitFor({ timeout: 20000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".wt-rail").getByRole("button", { name: "Accueil", exact: true }).click();
    const journeyPanel = page.locator("[data-testid='wheat-journey']");
    await expect(journeyPanel).toBeVisible({ timeout: 15000 });
    await expect(journeyPanel.locator("[data-stage='dossier']")).toContainText("Créer le dossier");
    await expect(journeyPanel.locator("[data-stage='entries']")).toBeVisible();

    /* ------------------------------------- silence, on ordinary interaction */

    /*
     * The reviewer used to appear during ordinary bookkeeping.
     *
     * Reading a screen, opening a form and closing it again are not accounting
     * events, and a level-2 draft that passes every deterministic check owes
     * nobody a second opinion. The reviewer surface must be absent throughout —
     * not merely empty — and no provider or model identifier may reach the
     * window on this path.
     */
    const reviewSurface = page.locator(".wt-review");

    for (const destination of ["Tableau de bord", "Écritures", "Factures & paiements", "Banque & rapprochement", "Accueil"]) {
      await page.locator(".wt-rail").getByRole("button", { name: destination, exact: true }).click();
      await page.waitForTimeout(150);
      await expect(reviewSurface, `the reviewer appeared on ${destination}`).toHaveCount(0);
    }

    // A form opened, typed into, and abandoned.
    await page.getByRole("banner").getByRole("button", { name: "Nouvelle écriture" }).click();
    const scratchDialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await expect(scratchDialog).toBeVisible();
    await page.getByPlaceholder("Ex : Facture client mars 2026").fill("Brouillon abandonné");
    await expect(reviewSurface).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(scratchDialog).toHaveCount(0, { timeout: 10000 });
    await expect(reviewSurface).toHaveCount(0);

    // A level-2 save that passes every check: reviewed deterministically,
    // reported as needing no reading, and shown to nobody.
    const quietReview = await page.evaluate((companyId) => window.wheat.reviewBeforeMutation({
      companyId,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "FOURNISSEUR SILENCIEUX SARL", ice: "001234567000041" },
    }), fixture.companyId);
    expect(quietReview.outcome).toBe("PASS");
    expect(quietReview.model.status).toBe("NOT_NEEDED");
    expect(quietReview.model.ran).toBe(false);
    // The ordinary reading path never names the provider or the model.
    expect(JSON.stringify(quietReview.model.message ?? "")).not.toMatch(/ollama|openrouter|groq|llama|qwen|mistral/i);
    await expect(reviewSurface).toHaveCount(0);

    /* ---------------------------------- the dialog, on a real blocked save */

    await page.getByRole("banner").getByRole("button", { name: "Nouvelle écriture" }).click();
    const entryDialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await expect(entryDialog).toBeVisible();
    await page.getByPlaceholder("Ex : Facture client mars 2026").fill("Saisie volontairement déséquilibrée");
    await page.getByPlaceholder("Détail de la ligne").nth(0).fill("Débit");
    await page.getByPlaceholder("Détail de la ligne").nth(1).fill("Crédit");
    await page.getByLabel(/^Débit de la ligne/).nth(0).fill("100.00");
    await page.getByLabel(/^Crédit de la ligne/).nth(1).fill("90.00");
    await page.getByRole("button", { name: /Enregistrer le brouillon/ }).click();

    const reviewDialog = page.locator(".wt-review");
    await expect(reviewDialog).toBeVisible({ timeout: 15000 });
    await expect(reviewDialog).toContainText("Correction nécessaire");
    await expect(reviewDialog).toContainText("L'écriture n'est pas équilibrée.");
    // Why it matters, in accounting terms, not just "invalid".
    await expect(reviewDialog).toContainText("partie double");
    /*
     * The provenance line reports a reading that was attempted: it was read
     * here, read remotely, or attempted and not completed.
     *
     * It is deliberately absent when no reading was owed. "Contrôles Wheat
     * uniquement" and "Relecture Wheat AI non exécutée" were removed with the
     * behaviour they described — announcing an absent second opinion on top
     * of a real finding taught people that Wheat AI keeps failing — so this
     * no longer accepts them.
     */
    const provenance = reviewDialog.locator(".wt-review__provenance");
    if (await provenance.count()) {
      await expect(provenance).toContainText(/Relu par Wheat AI|Relecture par Wheat AI non aboutie/);
      await expect(provenance).not.toContainText(/Contrôles Wheat uniquement|non exécutée/);
    }
    await expect(reviewDialog.getByRole("button", { name: "Continuer" })).toBeDisabled();

    // Escape returns to the form; nothing has been written.
    await page.keyboard.press("Escape");
    await expect(reviewDialog).toHaveCount(0, { timeout: 10000 });
    await expect(entryDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(entryDialog).toHaveCount(0, { timeout: 10000 });

    const unbalancedSaved = await page.evaluate(async (companyId) => {
      const boot = await window.wheat.getBootstrap(companyId);
      return boot.entries.some((entry) => entry.label === "Saisie volontairement déséquilibrée");
    }, fixture.companyId);
    expect(unbalancedSaved).toBe(false);

    /* --------------------------------- the context menu, and its equivalent */

    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    const entryRow = page.locator("tbody tr").filter({ hasText: fixture.pieceNumber });
    await expect(entryRow).toHaveCount(1);
    await entryRow.click({ button: "right" });
    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();
    for (const label of ["Ouvrir dans le grand livre", "Relire avec Wheat", "Dupliquer en brouillon", "Comptabiliser", "Filtrer sur ce journal", "Copier le libellé"]) {
      await expect(contextMenu).toContainText(label);
    }
    // Every item is a real button, so the menu is reachable by keyboard.
    expect(await contextMenu.getByRole("menuitem").count()).toBeGreaterThanOrEqual(8);
    // Escape closes it, as it must.
    await page.keyboard.press("Escape");
    await expect(contextMenu).toHaveCount(0);

    // "Relire avec Wheat" opens the same shared surface, and writes nothing.
    await entryRow.click({ button: "right" });
    await contextMenu.getByRole("menuitem", { name: "Relire avec Wheat" }).click();
    await expect(reviewDialog).toBeVisible({ timeout: 15000 });
    await expect(reviewDialog).toContainText("Comptabiliser une écriture");
    await page.keyboard.press("Escape");
    await expect(reviewDialog).toHaveCount(0, { timeout: 10000 });

    const stillDraft = await page.evaluate(async ({ companyId, pieceNumber }) => {
      const boot = await window.wheat.getBootstrap(companyId);
      return boot.entries.find((entry) => entry.pieceNumber === pieceNumber)?.status ?? null;
    }, fixture);
    expect(stillDraft).toBe("DRAFT");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
