import fs from "node:fs";
import path from "node:path";

for (const relative of ["dist", "dist-electron"]) {
  const target = path.resolve(process.cwd(), relative);
  if (path.dirname(target) !== process.cwd()) {
    throw new Error(`Refusing to clean unexpected build path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
