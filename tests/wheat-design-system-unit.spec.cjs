const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Wheat 2.0 design-system contracts.
 *
 * These are source-level guards, not screenshots: they keep the rules that are
 * easy to break silently — a hard-coded colour, a large dropdown without a
 * search bar, a feature quietly dropped from the navigation — from regressing.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const NEWLINE = String.fromCharCode(10);
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const STYLE_FILES = ["tokens.css", "components.css", "shell.css"];

test("the design system exists as three ordered layers loaded before any screen style", () => {
  for (const file of STYLE_FILES) {
    expect(fs.existsSync(path.join(root, "src", "styles", file)), file).toBe(true);
  }
  const app = read("src", "App.tsx");
  const tokensAt = app.indexOf('import "./styles/tokens.css"');
  const componentsAt = app.indexOf('import "./styles/components.css"');
  const shellAt = app.indexOf('import "./styles/shell.css"');
  const legacyAt = app.indexOf('import "./App.css"');
  expect(tokensAt).toBeGreaterThan(-1);
  expect(tokensAt).toBeLessThan(componentsAt);
  expect(componentsAt).toBeLessThan(shellAt);
  // Screen styles load last so a token can always be overridden by nothing.
  expect(shellAt).toBeLessThan(legacyAt);
});

test("tokens define both themes, and no other stylesheet hard-codes a colour", () => {
  const tokens = read("src", "styles", "tokens.css");
  expect(tokens).toContain(":root {");
  expect(tokens).toContain(".dark {");
  for (const name of ["--brand", "--canvas", "--surface", "--text", "--line", "--danger", "--success", "--warning", "--focus-ring"]) {
    expect(tokens.split(name).length, `${name} must be defined for both themes`).toBeGreaterThanOrEqual(3);
  }

  const colour = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/;
  const offenders = [];
  const check = (relative) => {
    const text = read(...relative);
    text.split("\n").forEach((line, index) => {
      if (line.trim().startsWith("/*") || line.trim().startsWith("*")) return;
      if (colour.test(line)) offenders.push(`${relative.join("/")}:${index + 1}: ${line.trim()}`);
    });
  };
  check(["src", "App.css"]);
  for (const name of fs.readdirSync(path.join(root, "src", "components")).filter((file) => file.endsWith(".css"))) {
    check(["src", "components", name]);
  }
  // components.css and shell.css may only use tokens; tokens.css owns the literals.
  check(["src", "styles", "components.css"]);
  check(["src", "styles", "shell.css"]);
  expect(offenders).toEqual([]);
});

test("low-emphasis text keeps accessible contrast on Wheat surfaces", () => {
  const tokens = read("src", "styles", "tokens.css");
  const light = tokens.slice(0, tokens.indexOf("/* ---- 3. Semantic tokens"));
  const dark = tokens.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const value = (scope, name) => scope.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground, background) => {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };

  expect(contrast(value(light, "text-faint"), value(light, "surface-muted"))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(value(dark, "text-faint"), value(dark, "surface-raised"))).toBeGreaterThanOrEqual(4.5);
});

test("every navigation entry is grouped, described and reachable", () => {
  const app = read("src", "App.tsx");

  const pages = [...app.matchAll(/\{ page: "([a-z0-9-]+)", label: "[^"]+", icon: \w+ \}/g)].map((match) => match[1]);
  expect(pages.length).toBeGreaterThanOrEqual(18);

  // Each page belongs to exactly one visible rail group.
  const groupBlock = app.slice(app.indexOf("const navGroups: NavGroup[]"), app.indexOf("const pagePurpose"));
  const grouped = [...groupBlock.matchAll(/pages: \[([^\]]+)\]/g)].flatMap((match) =>
    match[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean),
  );
  for (const page of pages) {
    expect(grouped.filter((entry) => entry === page), `${page} must appear in exactly one navigation group`).toHaveLength(1);
  }

  // Each page states, in plain language, what it is for and what it does.
  const purposeBlock = app.slice(app.indexOf("const pagePurpose"), app.indexOf("const pageShortHelp"));
  const shortBlock = app.slice(app.indexOf("const pageShortHelp"), app.indexOf("const languageStorageKey"));
  for (const page of pages) {
    const key = /^[a-z]+$/.test(page) ? page : `"${page}"`;
    expect(purposeBlock, `${page} needs a purpose sentence`).toContain(`${key}:`);
    expect(shortBlock, `${page} needs a short help label`).toContain(`${key}:`);
  }

  // And each page actually renders something.
  for (const page of pages) {
    expect(app, `${page} must be rendered`).toContain(`page === "${page}"`);
  }
});

test("no feature was dropped: every pre-2.0 destination still has an entry", () => {
  const app = read("src", "App.tsx");
  // "atlas21" became "statements" and "atlas-ai" became "wheat-ai"; everything
  // else keeps its identifier. Nothing was removed.
  const required = [
    "home", "production", "dashboard", "companies", "entries", "documents",
    "billing", "payroll", "reconciliation", "vat", "statements", "fiscal",
    "reports", "books", "sage", "assistant", "wheat-ai", "settings",
  ];
  for (const page of required) {
    expect(app, `${page} must stay in the navigation`).toContain(`page: "${page}"`);
  }
});

test("the shared dropdown is searchable, keyboard-driven and carries every state", () => {
  const select = read("src", "components", "ui", "WheatSelect.tsx");

  // Search is automatic above the threshold, and can be forced either way.
  expect(select).toContain("const SEARCH_THRESHOLD = 8;");
  expect(select).toContain("searchable ?? (options.length >= SEARCH_THRESHOLD");

  // Accessible combobox semantics.
  for (const attribute of ['role="combobox"', 'aria-haspopup="listbox"', "aria-expanded={open}", 'role="listbox"', 'role="option"', "aria-activedescendant", "aria-selected"]) {
    expect(select, attribute).toContain(attribute);
  }
  expect(select).toContain('aria-autocomplete="list"');
  expect(select).not.toMatch(/<button[\s\S]{0,2000}?role="button"/);
  expect(select).toContain("window.innerWidth - viewportPadding * 2");
  expect(select).toContain("nextVisible.findIndex((option) => !option.disabled)");

  // Keyboard navigation.
  for (const key of ['case "ArrowDown"', 'case "ArrowUp"', 'case "Home"', 'case "End"', 'case "Enter"', 'case "Escape"', 'case "Tab"']) {
    expect(select, key).toContain(key);
  }

  // Every required state has a dedicated branch.
  expect(select).toContain("wt-select__state--error");
  expect(select).toContain("loadingLabel");
  expect(select).toContain("noOptionsLabel");
  expect(select).toContain("emptyLabel");
  expect(select).toContain("onRetry");
  expect(select).toContain("allowClear");

  // Large lists stay responsive: rendering is capped, the rest reachable by search.
  expect(select).toContain("maxVisible = 120");
  expect(select).toContain("hiddenCount");

  // The submitted value is never transformed.
  expect(select).toContain("onChange(option.value)");
});

test("account, counterparty, journal, document and model pickers all use the searchable dropdown", () => {
  const expectations = [
    ["src/components/OperationalAccounting.tsx", ["Tiers de la facture", "Compte de produit ou de charge", "Facture à solder", "Tiers du règlement"]],
    ["src/components/BooksWorkspace13.tsx", ["Compte à consulter", "Journal à éditer", "Tiers à consulter", "Colonne source pour"]],
    ["src/components/ComplianceWorkspace14.tsx", ["Configuration TVA active", "Document justificatif"]],
    ["src/components/FiscalWorkspace.tsx", ["Compte parent", "Vue de balance", "Exercice cible", "Numéro ou nom du tableau", "Modèle Wheat AI"]],
    ["src/App.tsx", ["Journal", "Compte de la ligne", "Filtrer par journal"]],
  ];
  for (const [relative, labels] of expectations) {
    const source = read(...relative.split("/"));
    expect(source, `${relative} must import WheatSelect`).toMatch(/from "\.[./]*(components\/)?ui\/WheatSelect"/);
    for (const label of labels) {
      expect(source, `${relative} should offer a searchable ${label}`).toContain(label);
    }
  }
});

test("only small fixed-option selectors are left native, and they are still styled", () => {
  const components = read("src", "styles", "components.css");
  expect(components).toContain("#root select:not(.wt-native-select)");
  expect(components).toContain("--focus-ring-soft");

  // Any remaining native <select> must be a short, fixed list. A select built
  // from a `.map(` over dossier data is by definition expandable and must have
  // been converted.
  const offenders = [];
  for (const relative of [
    ["src", "App.tsx"],
    ["src", "components", "OperationalAccounting.tsx"],
    ["src", "components", "BooksWorkspace13.tsx"],
    ["src", "components", "ComplianceWorkspace14.tsx"],
    ["src", "components", "FiscalWorkspace.tsx"],
  ]) {
    const source = read(...relative);
    const pattern = /<select[\s\S]{0,2000}?<\/select>/g;
    for (const match of source.match(pattern) ?? []) {
      if (/className="wt-native-select"/.test(match)) continue; // explicit small-list opt-out
      const optionCount = (match.match(/<option/g) ?? []).length;
      const isDataDriven = /<option[^>]*>\{|\.map\(\((\w+)[^)]*\) =>\s*<option/.test(match);
      if (isDataDriven || optionCount >= 8) offenders.push(`${relative.join("/")}: ${match.slice(0, 90)}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("every screen opens with a purpose, and dialogs explain what they do", () => {
  const app = read("src", "App.tsx");
  const ui = read("src", "components", "ui", "index.tsx");

  // The page header always carries a purpose sentence.
  expect(ui).toContain("purpose: ReactNode");
  expect(app.match(/<PageHeader/g) ?? []).not.toHaveLength(0);
  const headers = app.match(/<PageHeader[\s\S]{0,400}?purpose=/g) ?? [];
  expect(headers.length, "every PageHeader must set a purpose").toBe((app.match(/<PageHeader/g) ?? []).length);

  // Confirmations state the question, the consequence and reversibility.
  expect(ui).toContain("question: ReactNode");
  expect(ui).toContain("consequence?: ReactNode");
  expect(ui).toContain("reversible?: string");

  // Errors explain the cause and the fix rather than dumping a stack trace.
  expect(ui).toContain("cause?: ReactNode");
  expect(ui).toContain("fix?: ReactNode");
});

/**
 * Focus containment, Escape and focus restoration now live in one place.
 *
 * The `Dialog` primitive used to carry a private copy of them, which meant
 * two independent dialog stacks: with a second dialog open over a form, both
 * handled Escape and the one registered first won. The guarantees are the
 * same; they are asserted where they are implemented.
 */
test("dialogs trap focus, restore it and close on Escape", () => {
  const ui = read("src", "components", "ui", "index.tsx");
  expect(ui).toContain("useAccessibleDialog<HTMLDivElement>(onClose)");
  expect(ui).toContain('aria-modal="true"');

  const helper = read("src", "lib", "useAccessibleDialog.ts");
  expect(helper).toContain('if (event.key === "Escape")');
  expect(helper).toContain("previousFocus?.isConnected");
  expect(helper).toContain("previousFocus.focus()");
  expect(helper).toContain("event.shiftKey && (focused === first");
  // Only the dialog on top of the stack owns the keyboard.
  expect(helper).toContain("dialogStack.at(-1) !== dialog");
});

test("the brand assets are used as supplied, with a light and a dark mark", () => {
  const brand = read("src", "components", "ui", "brand.tsx");
  expect(brand).toContain("brand/wheat-logo-light.png");
  expect(brand).toContain("brand/wheat-logo-dark.png");
  expect(brand).toContain("brand/wheat-ai.png");
  // Nothing recolours or distorts the artwork.
  const code = brand.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(code).not.toMatch(/filter:|transform: scale/);

  const shell = read("src", "styles", "shell.css");
  expect(shell).toContain(".wt-mark img");
  expect(shell).toContain("object-fit: contain");
  expect(shell).toContain(".dark .wt-mark__dark");

  for (const asset of ["wheat-logo-light.png", "wheat-logo-dark.png", "wheat-ai.png", "wheat-appicon.png"]) {
    expect(fs.existsSync(path.join(root, "public", "brand", asset)), asset).toBe(true);
  }
});

test("the interface carries no Atlas branding", () => {
  // The whole renderer tree, so a new screen cannot reintroduce the old name
  // without this failing. The generated Prisma client is not our source.
  const renderer = path.join(root, "src");
  const sources = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(full);
      } else if (/\.(tsx?|css)$/.test(entry.name)) {
        sources.push(full);
      }
    }
  })(renderer);
  expect(sources.length).toBeGreaterThan(20);

  const offenders = [];
  for (const file of sources) {
    fs.readFileSync(file, "utf8").split(NEWLINE).forEach((line, index) => {
      // The only permitted mentions are the pre-rename localStorage keys, which
      // are read once so an existing install keeps its saved settings. They are
      // never written and never displayed.
      const withoutLegacyKeys = line
        .replace(/atlas-ledger-sage-profile-|atlas-ledger-language|atlas:fiscal:view:/g, "")
        .replace(/Pre-rename key.*/g, "");
      if (/atlas/i.test(withoutLegacyKeys)) {
        offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

test("the renderer bridge is published only as window.wheat", () => {
  const preload = read("electron", "preload.ts");
  expect(preload).toContain('contextBridge.exposeInMainWorld("wheat", wheat);');
  // The hidden window.atlas alias is gone, and no test may depend on it.
  expect(preload).not.toContain('exposeInMainWorld("atlas"');
  const typings = read("src", "types", "electron.d.ts");
  expect(typings).not.toMatch(/atlas/i);
});
