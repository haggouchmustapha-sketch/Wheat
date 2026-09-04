/**
 * The executable coverage proof for the shared review layer.
 *
 * `electron/preload.ts` is the only door between the renderer and the main
 * process, so its channel list *is* the complete inventory of what a person can
 * make Wheat do. This suite parses that list from the source and fails if a
 * single channel is missing from `electron/wheatWorkflowRegistry.ts`.
 *
 * That is the point: a new IPC channel added without a classification is a
 * workflow nobody decided about — reviewed, deterministic-only, or exempt for a
 * stated reason. Here it stops being possible to add one silently.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const registry = tsxRequire(path.join(root, "electron", "wheatWorkflowRegistry.ts"), __filename);
const reviewModule = tsxRequire(path.join(root, "electron", "wheatReview.ts"), __filename);
const capabilities = tsxRequire(path.join(root, "electron", "wheatAiCapabilityRegistry.ts"), __filename);

function preloadChannels() {
  const source = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  const matches = source.matchAll(/ipcRenderer\.(?:invoke|on|removeListener)\("([^"]+)"/g);
  return [...new Set([...matches].map((match) => match[1]))];
}

test.describe("workflow coverage matrix", () => {
  test("every renderer channel is classified, with a reason", () => {
    const channels = preloadChannels();
    expect(channels.length).toBeGreaterThan(150);

    const missing = channels.filter((channel) => !registry.getWheatWorkflow(channel));
    expect(missing, `unclassified renderer channels:\n${missing.join("\n")}`).toEqual([]);

    for (const workflow of registry.WHEAT_WORKFLOW_REGISTRY) {
      expect(["REVIEW_REQUIRED", "DETERMINISTIC_ONLY", "EXEMPT"], workflow.id).toContain(workflow.classification);
      // An exemption without a reason is an omission dressed up as a decision.
      expect(String(workflow.reason ?? "").trim().length, `${workflow.id} has no reason`).toBeGreaterThan(20);
      expect(workflow.id, `${workflow.id} id/channel collision`).not.toBe(workflow.channel);
    }
  });

  test("ids and channels are unique, and every id resolves both ways", () => {
    const ids = registry.WHEAT_WORKFLOW_REGISTRY.map((item) => item.id);
    const channels = registry.WHEAT_WORKFLOW_REGISTRY.map((item) => item.channel);
    expect(new Set(ids).size, "duplicate workflow ids").toBe(ids.length);
    expect(new Set(channels).size, "duplicate workflow channels").toBe(channels.length);
    for (const workflow of registry.WHEAT_WORKFLOW_REGISTRY) {
      expect(registry.getWheatWorkflow(workflow.id).channel).toBe(workflow.channel);
      expect(registry.getWheatWorkflow(workflow.channel).id).toBe(workflow.id);
    }
  });

  test("every accounting mutation is reviewed, and no read is", () => {
    const accountingEntities = new Set([
      "Entry", "Invoice", "Payment", "Counterparty", "VatWorkpaper", "FiscalPackage",
      "FiscalTableWorkpaper", "BankReconciliation", "BankStatementImport", "LedgerImportBatch",
      "TaxConfigurationVersion", "PayrollRun", "Company", "FiscalYear",
    ]);
    for (const workflow of registry.WHEAT_WORKFLOW_REGISTRY) {
      if (!workflow.mutating) {
        expect(workflow.classification, `${workflow.id} is a read`).toBe("EXEMPT");
        continue;
      }
      if (workflow.classification === "EXEMPT") continue;
      if (accountingEntities.has(workflow.entity)) {
        expect(["REVIEW_REQUIRED", "DETERMINISTIC_ONLY"], workflow.id).toContain(workflow.classification);
      }
    }
    const coverage = registry.wheatWorkflowCoverage();
    expect(coverage.byClassification.REVIEW_REQUIRED).toBeGreaterThanOrEqual(40);
    expect(coverage.byClassification.REVIEW_REQUIRED + coverage.byClassification.DETERMINISTIC_ONLY + coverage.byClassification.EXEMPT)
      .toBe(coverage.total);
  });

  test("each declared review kind has an implementation", () => {
    const service = reviewModule.createWheatReviewService({ getPrisma: async () => ({}) });
    const coverage = service.coverage();
    for (const kind of coverage.reviewKinds) {
      expect(coverage.implementedReviewKinds, `no reviewer for ${kind}`).toContain(kind);
    }
    expect(coverage.reviewKinds.length).toBeGreaterThanOrEqual(25);
  });

  test("a workflow that names a Wheat AI capability names a real one", () => {
    for (const workflow of registry.WHEAT_WORKFLOW_REGISTRY) {
      if (!workflow.capabilityId) continue;
      expect(capabilities.getWheatAiCapability(workflow.capabilityId), `${workflow.id} -> ${workflow.capabilityId}`).toBeTruthy();
    }
  });

  test("the review layer exposes no escape hatch of its own", () => {
    const serialized = JSON.stringify(registry.wheatWorkflowCoverage()).toLowerCase();
    for (const forbidden of ["runsql", "rawquery", "executeprisma", "executeshell", "readanyfile", "eval("]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The review's own channels are declared, and both are non-mutating.
    for (const channel of ["wheat:review:run", "wheat:review:coverage", "wheat:journey:state"]) {
      const workflow = registry.getWheatWorkflow(channel);
      expect(workflow, channel).toBeTruthy();
      expect(workflow.mutating, channel).toBe(false);
    }
  });
});
