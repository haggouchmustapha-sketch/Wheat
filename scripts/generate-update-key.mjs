import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

/**
 * Creates the Ed25519 key pair Wheat releases are signed with.
 *
 * Run once. The public half is compiled into Wheat; the private half signs
 * manifests and must never be committed, shipped, or copied onto a machine that
 * does not build releases. Anyone holding it can make an installed Wheat
 * download and run an executable of their choosing.
 *
 *   node scripts/generate-update-key.mjs --out ../wheat-release-key.pem
 *
 * The default output sits outside the repository on purpose.
 */

const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--out" || argument === "--force") {
    if (argument === "--force") { values.set("--force", true); continue; }
    const value = args[++index]?.trim();
    if (!value) throw new Error("--out requires a path.");
    values.set("--out", value);
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");
const outPath = path.resolve(root, values.get("--out") ?? path.join("..", "wheat-release-key.pem"));
if (fs.existsSync(outPath) && !values.get("--force")) {
  throw new Error(`${outPath} already exists. Refusing to overwrite a release signing key; pass --force only if you are certain.`);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// 0o600 is advisory on Windows but correct wherever it is honoured, and costs
// nothing where it is not.
fs.writeFileSync(outPath, privatePem, { encoding: "utf8", mode: 0o600, flag: "wx" });

const relativeSignature = path.join("electron", "updater", "signature.ts");
console.log(`Private signing key written to ${outPath}`);
console.log("Keep it out of the repository, out of backups that leave your control, and off any machine that does not build releases.\n");
console.log(`Paste this public key into WHEAT_UPDATE_PUBLIC_KEY in ${relativeSignature}:\n`);
console.log(`export const WHEAT_UPDATE_PUBLIC_KEY = \`${String(publicPem).trim()}\`;\n`);
console.log("Then rebuild Wheat. Only builds carrying this key will accept releases signed with the private half.");
