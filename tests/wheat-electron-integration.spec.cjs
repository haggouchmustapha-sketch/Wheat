const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startOllamaFixture } = require("./fixtures/ollama-server.cjs");

test("Wheat services share the desktop database, numbering and typed-tool boundary", async () => {
  test.setTimeout(120000);
  const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-21-integration-"));
  const provider = await startOllamaFixture();
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "profile"), OLLAMA_HOST: provider.url },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("ATLAS 21 INTEGRATION SARL");
    await page.getByLabel("Ville").fill("Rabat");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });

    const result = await page.evaluate(async () => {
      const api = window.wheat;
      const boot = await api.getBootstrap();
      const company = boot.companies[0];
      const journal = company.journals.find((item) => item.code === "OD");
      const asset = company.accounts.find((item) => item.code === "234");
      const equity = company.accounts.find((item) => item.code === "111");
      const date = company.fiscalYears[0].startsOn.slice(0, 10);
      const securedJournal = await api.saveJournal({
        companyId: company.id,
        id: journal.id,
        expectedVersion: journal.version,
        code: journal.code,
        label: journal.label,
        locked: journal.locked,
        piecePrefix: journal.piecePrefix ?? journal.code,
        piecePattern: journal.piecePattern ?? "{journal}-{year}-{sequence}",
        pieceYearFormat: journal.pieceYearFormat ?? "YYYY",
        piecePadding: journal.piecePadding ?? 6,
        pieceSeparator: journal.pieceSeparator ?? "-",
        allowManualPieceOverride: false,
      });
      const preview = await api.previewPieceNumber({ companyId: company.id, journalId: journal.id, date });
      const first = await api.createEntry({ companyId: company.id, journalId: journal.id, date, label: "Première séquence 2.1", status: "POSTED", lines: [{ accountId: asset.id, label: "Débit", debit: "100.00", credit: "0" }, { accountId: equity.id, label: "Crédit", debit: "0", credit: "100.00" }] });
      const second = await api.createEntry({ companyId: company.id, journalId: journal.id, date, label: "Deuxième séquence 2.1", status: "POSTED", lines: [{ accountId: asset.id, label: "Débit", debit: "25.00", credit: "0" }, { accountId: equity.id, label: "Crédit", debit: "0", credit: "25.00" }] });
      let manualRejected = "";
      try { await api.createEntry({ companyId: company.id, journalId: journal.id, date, pieceNumber: "MANUAL-1", label: "Refus manuel", lines: [{ accountId: asset.id, label: "Débit", debit: "1", credit: "0" }, { accountId: equity.id, label: "Crédit", debit: "0", credit: "1" }] }); }
      catch (error) { manualRejected = String(error?.message ?? error); }
      const balance = await api.getBalanceFamily({ companyId: company.id, view: "GENERAL", from: date, to: company.fiscalYears[0].endsOn.slice(0, 10) });
      const bilan = await api.getBilan({ companyId: company.id, asOf: company.fiscalYears[0].endsOn.slice(0, 10), variant: "NORMAL" });
      const aiStatus = await api.getWheatAiStatus({ companyId: company.id });
      const capabilities = await api.listWheatAiTools();
      await api.configureWheatAi({ companyId: company.id, permissionMode: "READ_ONLY" });
      const accountSearch = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration", toolName: "search_accounts", arguments: { query: "capital", limit: 10 } });
      let readOnlyRejected = "";
      try { await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration", toolName: "create_account_subdivision", confirmed: true, arguments: { parentCode: "234", code: "23499", label: "Test IA" } }); }
      catch (error) { readOnlyRejected = String(error?.message ?? error); }
      await api.configureWheatAi({ companyId: company.id, permissionMode: "ASSISTANT" });
      // Legacy names and canonical names both reach the same registry/service
      // path. Level-1 safe edits execute immediately in assistant mode.
      const createdByTool = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration", toolName: "create_account_subdivision", arguments: { parentCode: "234", code: "23499", label: "Test IA" } });
      const createdByCapability = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-211", capabilityId: "accounts.save", arguments: { parentCode: "234", code: "23498", label: "Test IA 2.1.1", type: "ASSET" } });
      const dryRunPlan = await api.executeWheatAiPlan({ companyId: company.id, sessionId: "integration-plan-211", dryRun: true, calls: [
        { capabilityId: "navigation.open", arguments: { target: "bilan" } },
        { capabilityId: "accounts.save", arguments: { parentCode: "234", code: "23497", label: "Aperçu non persisté", type: "ASSET" } },
      ] });
      const dryRunSearch = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-plan-check-211", capabilityId: "accounts.search", arguments: { query: "23497", limit: 10 } });
      const draft = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-entry-211", capabilityId: "entries.create_draft", confirmed: true, arguments: { journalId: journal.id, date, label: "Écriture exacte Wheat AI 2.1.1", lines: [{ accountId: asset.id, label: "Débit exact", debitCents: "120001", creditCents: "0" }, { accountId: equity.id, label: "Crédit exact", debitCents: "0", creditCents: "120001" }] } });
      const postPreview = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-entry-preview-211", capabilityId: "entries.post", dryRun: true, arguments: { entryId: draft.result.id } });
      let highRiskRejected = "";
      try { await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-entry-post-211", capabilityId: "entries.post", arguments: { entryId: draft.result.id } }); }
      catch (error) { highRiskRejected = String(error?.message ?? error); }
      const draftAfterPreview = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-entry-check-211", capabilityId: "entries.get", arguments: { entryId: draft.result.id } });
      const navigation = await api.executeWheatAiTool({ companyId: company.id, sessionId: "integration-nav-211", capabilityId: "navigation.open", arguments: { target: "documents" } });
      return {
        standardAccounts: company.accounts.filter((account) => account.isStandard).length,
        roots: company.accounts.filter((account) => account.isStandard && account.parentCode === null).map((account) => account.code),
        journalManualOverride: securedJournal.allowManualPieceOverride,
        preview,
        first: { pieceNumber: first.pieceNumber, sequence: first.pieceSequenceNo, fiscalYearId: first.pieceFiscalYearId },
        second: { pieceNumber: second.pieceNumber, sequence: second.pieceSequenceNo, fiscalYearId: second.pieceFiscalYearId },
        manualRejected,
        balance: { balanced: balance.balanced, debit: balance.totals.periodDebitCents, credit: balance.totals.periodCreditCents },
        bilan: { balanced: bilan.balanced, statutory: bilan.statutoryFinalizationAvailable },
        ai: { recommendation: aiStatus.recommendation, privacy: aiStatus.privacy, capabilityRegistry: aiStatus.capabilityRegistry, modelCount: aiStatus.models.length, bundledModelCount: aiStatus.models.filter((model) => model.provider === "WHEAT").length, ollamaModelCount: aiStatus.models.filter((model) => model.provider === "OLLAMA").length, runtimeInstalled: aiStatus.runtime.installed },
        capabilityCount: capabilities.length,
        capabilityRiskLevels: [...new Set(capabilities.map((item) => item.riskLevel))].sort(),
        searchCount: accountSearch.result.length,
        readOnlyRejected,
        createdCode: createdByTool.result.code,
        createdCode211: createdByCapability.result.code,
        plan: { dryRun: dryRunPlan.dryRun, executed: dryRunPlan.executed, actionCount: dryRunPlan.actions.length, previewSummary: dryRunPlan.actions[1].preview.summary },
        dryRunPersistedCount: dryRunSearch.result.length,
        draft: { debitCents: draft.result.lines[0].debitCents, status: draftAfterPreview.result.status },
        postPreview: { dryRun: postPreview.dryRun, executed: postPreview.executed, summary: postPreview.preview.summary },
        highRiskRejected,
        navigation: navigation.result.navigation,
      };
    });
    expect(result.standardAccounts).toBe(1134);
    expect(result.roots).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(result.journalManualOverride).toBe(false);
    expect(result.first.pieceNumber).toBe(result.preview.pieceNumber);
    expect(result.second.sequence).toBe(result.first.sequence + 1);
    expect(result.first.fiscalYearId).toBe(result.second.fiscalYearId);
    expect(result.manualRejected).toMatch(/remplacement manuel/i);
    expect(result.balance).toEqual({ balanced: true, debit: "12500", credit: "12500" });
    expect(result.bilan).toEqual({ balanced: true, statutory: false });
    expect(result.ai.privacy).toMatchObject({ localOnly: true, databaseAccess: false, toolBoundary: "TYPED_TOOLS_ONLY" });
    expect(result.ai.modelCount).toBeGreaterThanOrEqual(3);
    expect(result.ai.bundledModelCount).toBe(3);
    expect(result.ai.ollamaModelCount).toBeGreaterThan(0);
    expect(result.ai.runtimeInstalled).toBe(false);
    expect(result.ai.privacy).toMatchObject({ rawSql: false, rawPrisma: false, shell: false, arbitraryFilesystem: false });
    // The registry grows as Wheat exposes more of itself to the assistant; what
    // must not change is that every capability stays typed and dossier-scoped,
    // and that the mutating ones support a dry run.
    expect(result.ai.capabilityRegistry.total).toBeGreaterThanOrEqual(105);
    expect(result.ai.capabilityRegistry.dryRunCount).toBeGreaterThanOrEqual(61);
    expect(result.ai.capabilityRegistry.categories).toHaveLength(19);
    expect(result.capabilityCount).toBe(result.ai.capabilityRegistry.total);
    expect(result.capabilityRiskLevels).toEqual([0, 1, 2, 3]);
    expect(result.searchCount).toBeGreaterThan(0);
    expect(result.readOnlyRejected).toMatch(/lecture seule/i);
    expect(result.createdCode).toBe("23499");
    expect(result.createdCode211).toBe("23498");
    expect(result.plan).toMatchObject({ dryRun: true, executed: false, actionCount: 2 });
    expect(result.plan.previewSummary).toMatch(/subdivision/i);
    expect(result.dryRunPersistedCount).toBe(0);
    expect(result.draft).toEqual({ debitCents: "120001", status: "DRAFT" });
    expect(result.postPreview).toMatchObject({ dryRun: true, executed: false });
    expect(result.postPreview.summary).toMatch(/comptabiliser/i);
    expect(result.highRiskRejected).toMatch(/confirmation explicite/i);
    expect(result.navigation).toMatchObject({ target: "documents" });

    /*
     * Everything above drove the domain through the IPC bridge, so the shell
     * has not been told that this dossier now holds posted entries — and until
     * it is, the setup gate quite correctly still has the rail restricted to
     * the screens that build a dossier. Reloading is the interface learning
     * what the bridge already did; without it this asserts on a rail that is
     * showing the truth as the renderer last read it.
     */
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Comptes & états", exact: true }).click();
    await expect(page.locator(".fiscal-ws")).toBeVisible();
    await expect(page.getByText("1 134 comptes officiels")).toBeVisible();
    await expect(page.getByRole("tab", { name: /Wheat AI/ })).toHaveCount(0);
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    await expect(page.locator(".wheat-ai-workspace")).toBeVisible();
    // The workspace opens with its purpose statement and the model card, both
    // of which are rendered from live status rather than a static string.
    await expect(page.getByText(/Wheat AI travaille sur/)).toBeVisible();
    await expect(page.getByText("Modèle utilisé")).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await provider.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
