const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const routes = [
  ["Accueil", "Le point de départ guidé"],
  ["Production du jour", "La file de travail du jour"],
  ["Tableau de bord", "Chiffre d'affaires"],
  ["Dossiers", "Créer, ouvrir et basculer"],
  ["Écritures", "Saisir et comptabiliser les écritures"],
  ["Documents & OCR", "Documents & OCR"],
  ["Factures & paiements", "Factures de vente et d'achat"],
  ["Banque & rapprochement", "Importer les relevés bancaires"],
  ["TVA", "Préparer, contrôler et archiver la déclaration"],
  ["Paie", "Salariés, éléments de paie"],
  ["Rapports comptables", "Éditer les rapports comptables"],
  ["Export Sage & FEC", "Exporter les écritures vers Sage"],
  ["Réglages", "Profil, sécurité locale"],
];

const desktopSizes = [
  [1120, 760],
  [1160, 760],
  [1200, 768],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1536, 864],
  [1600, 900],
  [1920, 1080],
];

const zoomFactors = [0.8, 0.9, 1, 1.1, 1.25];

test("major pages fit gradual desktop sizes and supported zoom levels", async () => {
  test.setTimeout(180_000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-viewport-"));
  const rendererErrors = [];

  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: {
      ...process.env,
      WHEAT_USER_DATA_DIR: path.join(tempDir, "userData"),
    },
  });

  try {
    const page = await app.firstWindow();
    const browserWindow = await app.browserWindow(page);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });

    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15_000 });
    await page.evaluate(async () => {
      await window.wheat.resetWorkspace({ mode: "demo" });
      window.localStorage.setItem("atlas-ledger-language", "fr");
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15_000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15_000 });

    const setViewport = async (width, height, zoom) => {
      await browserWindow.evaluate((win, value) => win.webContents.setZoomFactor(value), zoom);
      await browserWindow.evaluate((win, bounds) => win.setSize(bounds.width, bounds.height), { width, height });
      await page.waitForTimeout(80);
    };

    const scan = async (route, width, height, zoom) => {
      const result = await page.evaluate(({ routeName, requestedWidth, requestedHeight, zoomFactor }) => {
        const tolerance = 1;
        const root = document.documentElement;
        const body = document.body;
        const shell = document.querySelector(".app-shell");
        const sidebar = document.querySelector(".sidebar");
        const workspace = document.querySelector(".workspace");
        const mainPage = document.querySelector(".page");
        const rectOf = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {
            left: Math.round(rect.left * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
            top: Math.round(rect.top * 10) / 10,
            bottom: Math.round(rect.bottom * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          };
        };
        const isLocallyScrollable = (element) => {
          let parent = element.parentElement;
          while (parent && parent !== mainPage && parent !== body) {
            const style = getComputedStyle(parent);
            const rect = parent.getBoundingClientRect();
            if (
              (style.overflowX === "auto" || style.overflowX === "scroll") &&
              parent.scrollWidth > parent.clientWidth + tolerance &&
              rect.left >= -tolerance &&
              rect.right <= window.innerWidth + tolerance
            ) return true;
            parent = parent.parentElement;
          }
          return false;
        };
        const selectorFor = (element) => {
          if (element.id) return `#${element.id}`;
          const classes = Array.from(element.classList).slice(0, 3).join(".");
          return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
        };
        const offenders = Array.from(document.querySelectorAll("body *"))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return false;
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.display === "none") return false;
            if (rect.right <= window.innerWidth + tolerance && rect.left >= -tolerance) return false;
            return !isLocallyScrollable(element);
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              selector: selectorFor(element),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              width: Math.round(rect.width),
              overflow: Math.round(Math.max(rect.right - window.innerWidth, -rect.left, 0)),
            };
          })
          .sort((a, b) => b.overflow - a.overflow)
          .slice(0, 12);

        const shellRect = rectOf(shell);
        const sidebarRect = rectOf(sidebar);
        const workspaceRect = rectOf(workspace);
        const pageRect = rectOf(mainPage);
        const failures = [];
        if (root.scrollWidth > root.clientWidth + tolerance) failures.push("document horizontal overflow");
        if (body.scrollWidth > body.clientWidth + tolerance) failures.push("body horizontal overflow");
        if (shellRect && (shellRect.left < -tolerance || shellRect.right > window.innerWidth + tolerance)) failures.push("shell outside viewport");
        if (sidebarRect && (sidebarRect.left < -tolerance || sidebarRect.right > window.innerWidth + tolerance)) failures.push("sidebar outside viewport");
        if (workspaceRect && (workspaceRect.left < -tolerance || workspaceRect.right > window.innerWidth + tolerance)) failures.push("workspace outside viewport");
        if (pageRect && pageRect.scrollWidth > pageRect.clientWidth + tolerance) failures.push("page hides horizontal overflow");
        if (shellRect && shellRect.bottom > window.innerHeight + tolerance) failures.push("shell below viewport");
        if (workspaceRect && workspaceRect.bottom > window.innerHeight + tolerance) failures.push("workspace below viewport");
        if (offenders.length) failures.push("visible elements outside viewport");

        return {
          route: routeName,
          requested: `${requestedWidth}x${requestedHeight}`,
          zoom: zoomFactor,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          failures,
          offenders,
          root: rectOf(root),
          body: rectOf(body),
          shell: shellRect,
          sidebar: sidebarRect,
          workspace: workspaceRect,
          page: pageRect,
        };
      }, { routeName: route, requestedWidth: width, requestedHeight: height, zoomFactor: zoom });

      expect(result.failures, JSON.stringify(result, null, 2)).toEqual([]);
    };

    for (const [route, expectedText] of routes) {
      await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
      await page.locator(".wt-rail").getByRole("button", { name: route, exact: true }).click();
      await expect(page.locator(".page")).toContainText(expectedText, { timeout: 15_000 });

      for (const [width, height] of desktopSizes) {
        await setViewport(width, height, 1);
        await scan(route, width, height, 1);
      }

      for (const [width, height] of [[1120, 760], [1366, 768]]) {
        for (const zoom of zoomFactors) {
          await setViewport(width, height, zoom);
          await scan(route, width, height, zoom);
        }
      }
    }

    const assertDialogFits = async (dialogLocator, label) => {
      const metrics = await dialogLocator.evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          clientHeight: dialog.clientHeight,
          scrollHeight: dialog.scrollHeight,
          overflowY: getComputedStyle(dialog).overflowY,
        };
      });
      expect(metrics.left, `${label}: ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(-1);
      expect(metrics.right, `${label}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
      expect(metrics.top, `${label}: ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(-1);
      expect(metrics.bottom, `${label}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.viewportHeight + 1);
      if (metrics.scrollHeight > metrics.clientHeight + 1) expect(["auto", "scroll"]).toContain(metrics.overflowY);
    };

    // Deep route states are exercised at the tightest effective desktop
    // viewport: the native minimum window at 125% zoom.
    await setViewport(1120, 760, 1.25);

    await page.locator(".wt-rail").getByRole("button", { name: "Factures & paiements", exact: true }).click();
    await expect(page.locator(".op-shell")).toBeVisible({ timeout: 15_000 });
    for (const tabName of ["Ventes", "Achats", "Paiements", "Tiers"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tabName}`) }).click();
      await page.waitForTimeout(100);
      await scan(`Factures/${tabName}`, 1120, 760, 1.25);
    }
    for (const [tabName, createName] of [["Ventes", "Nouvelle facture"], ["Paiements", "Nouveau paiement"], ["Tiers", "Nouveau tiers"]]) {
      await page.getByRole("tab", { name: new RegExp(`^${tabName}`) }).click();
      await page.getByRole("button", { name: createName, exact: true }).click();
      await expect(page.locator(".op-composer")).toBeVisible();
      await scan(`Factures/${tabName}/formulaire`, 1120, 760, 1.25);
      await page.getByLabel("Fermer le formulaire").click();
    }

    await page.locator(".wt-rail").getByRole("button", { name: "Banque & rapprochement", exact: true }).click();
    await expect(page.locator(".op-reconciliation")).toBeVisible({ timeout: 15_000 });
    const movementRow = page.locator(".op-recon-table tbody tr").first();
    if (await movementRow.count()) {
      await movementRow.click();
      await expect(page.locator(".op-inspector")).toBeVisible({ timeout: 15_000 });
      await scan("Banque/inspecteur", 1120, 760, 1.25);
      await page.locator(".op-inspector").getByLabel("Fermer").click();
    }

    const bankSelect = page.locator(".op-field--bank select");
    if (await bankSelect.locator("option").count() > 1) {
      const statementPath = path.join(tempDir, "viewport-bank-statement.csv");
      fs.writeFileSync(statementPath, [
        "Date;Description;Reference;Amount;Currency;Long diagnostic column",
        "2026-08-20;Viewport import test;VIEWPORT-001;125,50;MAD;This deliberately wide cell must remain inside the local table scroller",
      ].join("\r\n"));
      await bankSelect.selectOption(await bankSelect.locator("option").nth(1).getAttribute("value"));
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      }, statementPath);
      await page.getByRole("button", { name: "Importer un relevé" }).click();
      const importDialog = page.getByRole("dialog", { name: "Contrôler le relevé bancaire" });
      await expect(importDialog).toBeVisible({ timeout: 15_000 });
      for (const zoom of zoomFactors) {
        await setViewport(1120, 760, zoom);
        await assertDialogFits(importDialog, `Bank import dialog at ${zoom * 100}%`);
        await scan(`Banque/import/${zoom * 100}%`, 1120, 760, zoom);
      }
      await importDialog.getByRole("button", { name: "Fermer" }).click();
      await setViewport(1120, 760, 1.25);
    }

    await page.locator(".wt-rail").getByRole("button", { name: "TVA", exact: true }).click();
    await expect(page.locator(".compliance14-shell")).toBeVisible({ timeout: 15_000 });
    for (const sectionName of ["TVA", "Règles", "Clôture", "Intégrité"]) {
      await page.locator(".compliance14-nav").getByRole("button", { name: new RegExp(`^${sectionName}`) }).click();
      await page.waitForTimeout(180);
      await scan(`TVA/${sectionName}`, 1120, 760, 1.25);
    }

    await page.locator(".wt-rail").getByRole("button", { name: "Rapports comptables", exact: true }).click();
    await expect(page.locator(".books13-shell")).toBeVisible({ timeout: 15_000 });
    for (const workspaceName of ["Rapports", "Imports", "Référentiels", "Contrôles"]) {
      await page.getByRole("tab", { name: new RegExp(`^${workspaceName}`) }).click();
      await page.waitForTimeout(180);
      await scan(`Rapports/${workspaceName}`, 1120, 760, 1.25);
    }

    await page.getByRole("tab", { name: /^Rapports/ }).click();
    for (const reportName of ["Écritures", "Balance", "Grand livre", "Journal", "Ancienneté clients", "Ancienneté fournisseurs", "Compte tiers", "Intégrité"]) {
      await page.locator(".books13-rail").getByRole("button", { name: new RegExp(`^${reportName}`) }).click();
      await page.waitForTimeout(180);
      await scan(`Rapports/${reportName}`, 1120, 760, 1.25);
    }

    await page.getByRole("tab", { name: /^Référentiels/ }).click();
    await expect(page.locator(".books13-rail--settings")).toBeVisible();
    for (const areaName of ["Société", "Exercices", "Comptes", "Journaux", "Banques", "Brouillons"]) {
      await page.locator(".books13-rail--settings").getByRole("button", { name: areaName, exact: true }).click();
      await page.waitForTimeout(100);
      await scan(`Référentiels/${areaName}`, 1120, 760, 1.25);
    }

    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    await page.keyboard.press("Control+N");
    const entryDialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await expect(entryDialog).toBeVisible();
    await assertDialogFits(entryDialog, "Entry dialog");
    await page.keyboard.press("Escape");

    await page.locator(".wt-rail").getByRole("button", { name: "Paie", exact: true }).click();
    await page.getByRole("button", { name: "Ajouter un salarié" }).click();
    const employeeDialog = page.getByRole("dialog", { name: "Ajouter un salarié" });
    await expect(employeeDialog).toBeVisible();
    await assertDialogFits(employeeDialog, "Employee dialog");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nouveau dossier", exact: true }).click();
    const companyDialog = page.getByRole("dialog", { name: "Créer un dossier" });
    await expect(companyDialog).toBeVisible();
    await assertDialogFits(companyDialog, "Company dialog");
    await page.keyboard.press("Escape");

    await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
