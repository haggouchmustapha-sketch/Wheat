import fs from "node:fs";
import path from "node:path";
import { editionArtifactPaths, readPackageBuildConfig } from "./lib/wheatEditions.mjs";
import { buildSigningReport } from "./lib/wheatSigning.mjs";

/**
 * Reports, and optionally enforces, the real Authenticode state of a built
 * Wheat release.
 *
 *   npm run sign:verify                      report on the version in package.json
 *   npm run sign:verify -- --version 2.1.x   report on a specific built version
 *   npm run sign:verify -- --require         exit non-zero unless everything is validly signed
 *
 * "signtool returned 0" is not evidence. This asks Windows the same question
 * Explorer's Digital Signatures tab and SmartScreen ask, so a PASS here is what
 * a user will actually see — and a signature without a trusted timestamp is
 * reported as the incomplete thing it is, because it stops verifying the day the
 * certificate expires.
 *
 * `release-prepare.mjs` runs the same check on the same artifacts; this exists so
 * it can also be run by hand, on an installed copy, or in CI.
 */

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const versionIndex = args.indexOf("--version");
const { version: packageVersion } = readPackageBuildConfig(root);
const version = versionIndex >= 0 ? args[versionIndex + 1] : packageVersion;

const fileNames = editionArtifactPaths(root, version).map((entry) => entry.fileName);
const report = buildSigningReport(root, version, { fileNames });

console.log(`Wheat ${version} — Windows Authenticode`);
console.log(`  signing mode   ${report.mode}`);
console.log(`  ${report.modeDetail}`);
if (!report.artifacts.length) {
  console.log(`\n  No built artifacts found in release/${version}. Build the release first.`);
  process.exit(flags.has("--require") ? 1 : 0);
}
console.log("");
for (const artifact of report.artifacts) {
  console.log(`  ${artifact.role.padEnd(18)} ${artifact.name}`);
  console.log(`  ${"".padEnd(18)} ${artifact.summary}`);
}

console.log(`\n  AUTHENTICODE: ${report.verdict}`);
if (report.publishers.length) console.log(`  PUBLISHER DISPLAY: ${report.publishers.join(", ")}`);
if (report.publishers.length > 1) {
  console.log("  WARNING: the artifacts of one release carry more than one publisher. Standard and Lightweight are one product and must not.");
}

if (flags.has("--require") && report.verdict !== "PASS") {
  console.error(`\nRefusing: ${report.failure}`);
  process.exit(1);
}
