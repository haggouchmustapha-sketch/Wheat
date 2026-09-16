import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertEdition, editionBuilderConfig, readPackageBuildConfig, wheatInstallerFileName } from "./lib/wheatEditions.mjs";
import { buildSigningReport, resolveSigningMode, signingChildEnvironment } from "./lib/wheatSigning.mjs";

/**
 * Packages one edition of the Wheat that is already built in `dist/` and
 * `dist-electron/`.
 *
 * The configuration in package.json stays the base for both editions;
 * `editionBuilderConfig` applies the edition's difference to a copy of it and
 * this script hands the result to electron-builder. Nothing about the
 * repository layout changes per edition, and a future change to signing, NSIS
 * behaviour or the packaged file list is inherited by both without being
 * written twice.
 *
 *   WHEAT_EDITION=lightweight node scripts/package-edition.mjs
 *   node scripts/package-edition.mjs --edition standard
 *
 * The renderer and main process must already have been built *for the same
 * edition* — `npm run dist:standard` / `dist:lightweight` do both in order.
 * This script refuses to package a build whose compiled edition does not match,
 * because a Lightweight installer wrapped around a Standard main process would
 * look for a recognition runtime its own installer left out.
 */

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flagIndex = args.indexOf("--edition");
const edition = assertEdition(flagIndex >= 0 ? args[flagIndex + 1] : process.env.WHEAT_EDITION ?? "standard");

const { version, build } = readPackageBuildConfig(root);
const signing = resolveSigningMode();
const config = editionBuilderConfig(build, edition, version, { root });

// ---------------------------------------------------------------- build check
if (!fs.existsSync(path.join(root, "dist-electron", "main.js"))) {
  throw new Error("dist-electron/main.js is missing. Run the edition's build before packaging it.");
}
const compiledEdition = readBuiltEdition(root);
if (compiledEdition !== edition) {
  throw new Error(
    `The build in dist-electron/ was compiled as "${compiledEdition ?? "unknown"}" but this is the ${edition} package. ` +
    `Run: npm run build:${edition}`,
  );
}

// --------------------------------------------------------------- builder run
const configDirectory = path.join(root, "node_modules", ".wheat-build");
fs.mkdirSync(configDirectory, { recursive: true });
const configPath = path.join(configDirectory, `electron-builder.${edition}.json`);
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const artifact = path.join(root, "release", version, wheatInstallerFileName(edition, version));
console.log(`Packaging Wheat ${version} — ${edition}`);
console.log(`  config   ${path.relative(root, configPath)}`);
console.log(`  artifact ${path.relative(root, artifact)}`);
console.log(`  resources ${config.extraResources.length} entr${config.extraResources.length === 1 ? "y" : "ies"}`);
console.log(`  signing  ${signing.mode} — ${signing.detail}`);

/**
 * electron-builder's own entry point, run by this Node.
 *
 * Not `npx` and not a shell: the repository path may contain spaces, and a
 * shell splits it into arguments electron-builder then rejects. Spawning the
 * CLI module directly has no quoting layer to get wrong, and needs no
 * `shell: true` exemption to the CVE-2024-27980 rule.
 *
 * `projectDir` is left implicit — it defaults to the working directory, which
 * is the repository root — and the config is passed relative to it, so no
 * absolute path reaches the argument list at all.
 */
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
execFileSync(
  process.execPath,
  [builderCli, "--win", "nsis", "--x64", "--config", path.relative(root, configPath).replaceAll("\\", "/")],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    // The PFX password, when there is one, reaches electron-builder only as an
    // environment variable of this child process. It is never written into the
    // generated config, never logged, and never leaves this process tree.
    env: { ...process.env, ...signingChildEnvironment() },
  },
);

if (!fs.existsSync(artifact)) throw new Error(`electron-builder did not produce ${artifact}.`);
console.log(`\n${path.relative(root, artifact)}  ${(fs.statSync(artifact).size / (1024 * 1024)).toFixed(1)} MB`);

/*
 * Authenticode, checked here rather than only at release time.
 *
 * Both editions build into the same `release/<version>/win-unpacked`, so the
 * second one overwrites the first: by the time `release-prepare.mjs` looks,
 * `Wheat.exe` belongs to whichever edition was packaged last. The only moment
 * this edition's own application binary and uninstaller exist on disk is right
 * now, so this is where they are verified.
 *
 * Silent when signing is off, which is every ordinary development build.
 */
if (signing.mode !== "off") {
  const report = buildSigningReport(root, version, { fileNames: [path.basename(artifact)] });
  for (const entry of report.artifacts) console.log(`  ${entry.role.padEnd(18)} ${entry.summary}`);
  if (report.verdict !== "PASS") {
    throw new Error(`The ${edition} package is configured to be signed but does not verify: ${report.failure}`);
  }
  console.log(`  AUTHENTICODE PASS — ${report.publishers.join(", ")}`);
}

/**
 * Reads the edition the build actually declared.
 *
 * The Vite build writes `dist-electron/wheat-edition.json` beside the bundle it
 * compiled the edition into, so the packaging step proves it is wrapping the
 * build it thinks it is rather than trusting that whoever ran the two commands
 * ran them with the same variable.
 */
export function readBuiltEdition(projectRoot) {
  const stampPath = path.join(projectRoot, "dist-electron", "wheat-edition.json");
  if (!fs.existsSync(stampPath)) return null;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    return typeof stamp.edition === "string" ? stamp.edition : null;
  } catch {
    return null;
  }
}
