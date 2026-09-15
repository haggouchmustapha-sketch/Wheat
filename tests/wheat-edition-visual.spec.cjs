const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The visual difference between the editions, and its limits.
 *
 * Wheat Lightweight has to be unmistakably Wheat. It is not a stripped
 * interface: it is the same interface asked to spend less of the machine on
 * drawing itself. So this file checks two things at once — that the economical
 * profile genuinely costs less, and that it takes nothing away that tells
 * somebody what the application is doing.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const tokens = fs.readFileSync(path.join(root, "src", "styles", "tokens.css"), "utf8");

/** The declarations inside one selector's block. */
function block(selector) {
  const index = tokens.indexOf(`${selector} {`);
  if (index < 0) return null;
  const start = tokens.indexOf("{", index);
  return tokens.slice(start + 1, tokens.indexOf("}", start));
}

function declarations(source) {
  const values = new Map();
  for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) values.set(match[1], match[2].trim());
  return values;
}

test("the edition profile exists as one token block, not as scattered conditionals", () => {
  const lightweight = block(':root[data-wheat-edition="lightweight"]');
  expect(lightweight, "no lightweight token block in tokens.css").toBeTruthy();

  // The whole difference is token overrides. A component that compared edition
  // strings for a colour or a shadow would be a second place to maintain, and
  // a new component would not inherit the behaviour.
  const componentSources = [];
  for (const directory of [path.join(root, "src", "components"), path.join(root, "src", "lib")]) {
    for (const entry of fs.readdirSync(directory, { recursive: true })) {
      const file = path.join(directory, String(entry));
      if (fs.statSync(file).isFile() && /\.tsx?$/.test(file)) componentSources.push(file);
    }
  }
  const offenders = componentSources.filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return /WHEAT_EDITION|visualProfile/.test(source);
  }).map((file) => path.relative(root, file));
  // Exactly one component is allowed to ask: the chart, because a library
  // animation flag is not expressible as a CSS token.
  expect(offenders).toEqual(["src\\components\\DashboardCharts.tsx".replaceAll("\\", path.sep)]);
});

test("the economical profile really is cheaper to draw", () => {
  const lightweight = declarations(block(':root[data-wheat-edition="lightweight"]'));

  // No backdrop blur at all: blurring a large translucent area is the single
  // most expensive thing this interface asks of an old integrated GPU.
  for (const token of ["--blur-scrim", "--blur-panel", "--blur-strong"]) {
    expect(lightweight.get(token), `${token} is not neutralised`).toBe("0px");
  }

  // Shorter transitions, and shallower shadows. "Base" is the stylesheet with
  // the edition override and the accessibility override removed, so it is the
  // value Standard actually resolves.
  const base = declarations(tokens.slice(0, tokens.indexOf("EDITION VISUAL PROFILE")));
  for (const token of ["--duration-fast", "--duration-normal", "--duration-slow"]) {
    expect(Number.parseFloat(lightweight.get(token))).toBeLessThan(Number.parseFloat(base.get(token)));
  }
  for (const token of ["--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl"]) {
    const blurRadius = (value) => Math.max(...[...value.matchAll(/(\d+)px/g)].map((match) => Number(match[1])));
    expect(blurRadius(lightweight.get(token))).toBeLessThan(blurRadius(base.get(token)));
  }
});

test("Lightweight keeps every token that tells somebody what is happening", () => {
  const lightweight = declarations(block(':root[data-wheat-edition="lightweight"]'));
  // Colour, contrast, spacing, type, borders, focus and state feedback are not
  // presentation flourishes — they are how the interface communicates. The
  // economical profile must not touch a single one of them.
  const forbidden = [...lightweight.keys()].filter((token) =>
    /color|text|brand|canvas|surface|line|border|focus|radius|space|font|weight|selected|hover|active|danger|warning|success/i.test(token));
  expect(forbidden).toEqual([]);

  // And it never animates nothing at all: a transition of zero reads as a jump.
  expect(Number.parseFloat(lightweight.get("--duration-normal"))).toBeGreaterThan(1);
});

test("reduced motion is honoured in both editions and wins over the edition", () => {
  const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
  // Matching the edition block's specificity and declared after it, so an
  // accessibility preference is never overridden by a build decision.
  expect(reduced).toMatch(/:root,\s*\n?\s*:root\[data-wheat-edition\]/);
  expect(tokens.indexOf("@media (prefers-reduced-motion: reduce)")).toBeGreaterThan(tokens.indexOf(':root[data-wheat-edition="lightweight"]'));
  for (const token of ["--duration-instant", "--duration-fast", "--duration-normal", "--duration-slow"]) {
    expect(reduced).toContain(`${token}: 1ms`);
  }
});

test("every backdrop blur in the application resolves through a token", () => {
  const offenders = [];
  for (const directory of [path.join(root, "src")]) {
    for (const entry of fs.readdirSync(directory, { recursive: true })) {
      const file = path.join(directory, String(entry));
      if (!fs.statSync(file).isFile() || !file.endsWith(".css")) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/backdrop-filter:\s*blur\(([^)]+)\)/g)) {
        if (!match[1].includes("var(--blur-")) offenders.push(`${path.relative(root, file)}: ${match[0]}`);
      }
    }
  }
  // A literal blur radius is a call site the edition profile cannot reach.
  expect(offenders).toEqual([]);
});

test("Framer Motion is configured once, centrally, rather than per component", () => {
  const entry = fs.readFileSync(path.join(root, "src", "main.tsx"), "utf8");
  expect(entry).toMatch(/MotionConfig/);
  // "always" in Lightweight, "user" in Standard: both honour the operating
  // system setting, because "always" is a superset of "user".
  expect(entry).toMatch(/reducedMotion=\{[^}]*'always'[^}]*'user'[^}]*\}/);
  expect(entry).toMatch(/dataset\.wheatEdition/);
});

test("the edition is stamped before the first paint, so no frame shows the wrong profile", () => {
  const entry = fs.readFileSync(path.join(root, "src", "main.tsx"), "utf8");
  expect(entry.indexOf("dataset.wheatEdition")).toBeLessThan(entry.indexOf("createRoot(document"));
});
