/**
 * Derives the runtime Wheat brand assets from the canonical artwork in `Wheat Design/`.
 *
 * The source files in `Wheat Design/` are never modified. Everything written here is a
 * cropped/resized copy, so re-running this script is safe and reproducible.
 *
 * Outputs:
 *   public/brand/wheat-logo-light.png  light-mode mark (from "main light.png")
 *   public/brand/wheat-logo-dark.png   dark-mode mark  (from "Main Dark.png")
 *   public/brand/wheat-ai.png          Wheat AI feature icon (from "Wheat AI.png")
 *   public/brand/wheat-appicon.png     app-icon lockup used for the favicon
 *   build/icon.png                     app-icon lockup consumed by `npm run icon:ico`
 */
const sharp = require("sharp");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "Wheat Design");
const BRAND = path.join(ROOT, "public", "brand");
fs.mkdirSync(BRAND, { recursive: true });

/** Tight bounding box taken from the alpha channel: the artwork keeps colour in transparent pixels. */
async function alphaBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Trim to the artwork, then letterbox into a transparent square so aspect ratio is never distorted. */
async function squareMark(file, out, size) {
  const box = await alphaBox(file);
  await sharp(file)
    .extract(box)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${path.relative(ROOT, out)} (${size}x${size}, source box ${box.width}x${box.height})`);
}

/** App-icon lockup from the brand sheet: the Main Dark mark on a terracotta rounded square. */
async function appIcon(out, size) {
  const pad = Math.round(size * 0.15);
  const inner = size - pad * 2;
  const source = path.join(SRC, "Main Dark.png");
  const box = await alphaBox(source);
  const mark = await sharp(source)
    .extract(box)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const radius = Math.round(size * 0.22);
  const plate = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0" stop-color="#C85A3A"/>
           <stop offset="1" stop-color="#A6402A"/>
         </linearGradient>
       </defs>
       <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#plate)"/>
     </svg>`,
  );
  await sharp(plate)
    .composite([{ input: mark, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${path.relative(ROOT, out)} (${size}x${size})`);
}

async function main() {
  await squareMark(path.join(SRC, "Main Dark.png"), path.join(BRAND, "wheat-logo-dark.png"), 512);
  await squareMark(path.join(SRC, "main light.png"), path.join(BRAND, "wheat-logo-light.png"), 512);
  await squareMark(path.join(SRC, "Wheat AI.png"), path.join(BRAND, "wheat-ai.png"), 256);
  await appIcon(path.join(BRAND, "wheat-appicon.png"), 512);
  await appIcon(path.join(ROOT, "build", "icon.png"), 1024);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
