const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The promise the whole edition system rests on: **the edition never changes
 * accounting.**
 *
 * `wheat-edition-unit.spec.cjs` proves structurally that no accounting module
 * even mentions the edition. This file proves it behaviourally, and in the only
 * way that actually settles the question: it runs Wheat's own accounting suites
 * twice — once as Standard, once as Lightweight — and requires the same
 * outcome, test for test.
 *
 * `src/wheatEdition.ts` honours `WHEAT_EDITION` in an unbundled run, which is
 * exactly what a `tsx`-loaded spec is, so the child processes below really do
 * execute the accounting engine under two different editions.
 *
 * It is slower than the rest of the suite because it is two full runs of
 * several suites. That is the price of the assertion, and the assertion is
 * worth it: an edition that quietly changed a VAT rounding rule would be the
 * most damaging bug this repository could ship.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

/**
 * The suites that compute accounting answers.
 *
 * Deliberately the arithmetic and the domain rules rather than the interface:
 * posting, subledger, reconciliation, reporting, VAT and compliance, fiscal
 * workpapers, operations, credit notes, opening balances and the audit chain.
 */
const ACCOUNTING_SUITES = [
  "tests/wheat-entry-commands-unit.spec.cjs",
  "tests/wheat-subledger-unit.spec.cjs",
  "tests/wheat-reconciliation-unit.spec.cjs",
  "tests/wheat-reporting-unit.spec.cjs",
  "tests/wheat-compliance-unit.spec.cjs",
  "tests/wheat-operations-unit.spec.cjs",
  "tests/wheat-credit-artifacts-unit.spec.cjs",
  "tests/wheat-audit-unit.spec.cjs",
  "tests/wheat-accounting-dates.spec.cjs",
  "tests/wheat-debours.spec.cjs",
].filter((suite) => fs.existsSync(path.join(root, suite)));

test.describe.configure({ timeout: 900_000 });

test("the accounting engine produces the same result in both editions", () => {
  expect(ACCOUNTING_SUITES.length, "no accounting suites were found to compare").toBeGreaterThan(4);

  const outcomes = {};
  for (const edition of ["standard", "lightweight"]) {
    outcomes[edition] = runSuites(edition);
  }

  // Test for test, not merely "both passed": a suite that silently stopped
  // running under one edition would otherwise look like agreement.
  expect(outcomes.lightweight.titles).toEqual(outcomes.standard.titles);
  expect(outcomes.lightweight.statuses).toEqual(outcomes.standard.statuses);
  expect(outcomes.standard.failed).toEqual([]);
  expect(outcomes.lightweight.failed).toEqual([]);
  expect(outcomes.standard.titles.length).toBeGreaterThan(20);
  console.log(`  ${outcomes.standard.titles.length} accounting tests compared, Standard against Lightweight, all identical.`);
});

/**
 * Runs the accounting suites in a child Playwright process under one edition
 * and returns every test's title and status.
 */
function runSuites(edition) {
  // Outside `test-results`, which a Playwright run empties on start: the
  // second child would otherwise delete the first child's report.
  const reportDirectory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `wheat-parity-${edition}-`));
  const reportPath = path.join(reportDirectory, "report.json");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules", "@playwright", "test", "cli.js"), "test", ...ACCOUNTING_SUITES,
        "--reporter=json",
        // Its own artifact directory. A Playwright run empties `test-results`
        // on start, and this spec runs *inside* a Playwright run: left at the
        // default, each child would wipe the parent's artifacts mid-suite.
        "--output", path.join(reportDirectory, "artifacts"),
      ],
      {
        cwd: root,
        // The one variable under test. Everything else about the two runs is
        // identical, including the working tree they read.
        env: { ...process.env, WHEAT_EDITION: edition, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
        stdio: ["ignore", "ignore", "inherit"],
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    // A failing child still wrote its report; the comparison below says which
    // tests failed and under which edition, which is the useful message.
    if (!fs.existsSync(reportPath)) throw error;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const titles = [];
  const statuses = [];
  const failed = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const status = spec.tests?.[0]?.results?.[0]?.status ?? "missing";
      titles.push(`${path.basename(spec.file ?? suite.file ?? "?")} › ${spec.title}`);
      statuses.push(status);
      if (status !== "passed" && status !== "skipped") failed.push(`${edition}: ${spec.title} (${status})`);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);

  titles.sort();
  statuses.sort();
  fs.rmSync(reportDirectory, { recursive: true, force: true });
  return { titles, statuses, failed };
}
