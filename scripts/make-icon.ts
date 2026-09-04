import fs from "node:fs";
import path from "node:path";
import pngToIco from "png-to-ico";

const root = process.cwd();
const source = path.join(root, "build", "icon.png");
const target = path.join(root, "build", "icon.ico");

if (!fs.existsSync(source)) {
  throw new Error(`Icon source missing: ${source}`);
}

const buffer = await pngToIco(source);
fs.writeFileSync(target, buffer);
console.log(`Wrote ${target}`);
