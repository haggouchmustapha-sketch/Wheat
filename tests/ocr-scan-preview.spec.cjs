const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("OCR import shows Atlas scan preview and animated highlight layer", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-scan-preview-"));
  const fakeFile = path.join(tempDir, "atlas-scan-preview.txt");
  fs.writeFileSync(fakeFile, [
    "FACTURE N PREVIEW-2026",
    "Fournisseur: Atlas Preview",
    "Date: 22/05/2026",
    "Montant HT: 1000,00 MAD",
    "TVA: 200,00 MAD",
    "Total TTC: 1200,00 MAD",
  ].join("\n"));

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
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.locator(".onboarding-shell, .app-shell").first().waitFor({ state: "visible", timeout: 15000 });
    if (await page.locator(".onboarding-shell").isVisible()) {
      await page.evaluate(async () => {
        await window.wheat.createCompany({
          name: "OCR PREVIEW SARL",
          legalForm: "SARL",
          city: "Casablanca",
          fiscalYearStart: "2026-01-01",
          fiscalYearEnd: "2026-12-31",
        });
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    }
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Documents & OCR", exact: true }).click();
    await expect(page.locator(".smart-dropzone")).toBeVisible({ timeout: 15000 });

    await app.evaluate(({ dialog }, fakeFile) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeFile] });
    }, fakeFile);

    await page.getByRole("button", { name: /Importer une pièce/ }).first().click();
    await expect(page.locator(".scan-preview")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".scan-document")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".scan-target")).toHaveCount(3);
    await expect(page.locator(".scan-preview .scan-caption")).toContainText("atlas-scan-preview.txt");
    await page.screenshot({ path: path.join(tempDir, "scan-preview.png") });
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
