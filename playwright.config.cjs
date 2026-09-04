const { defineConfig } = require("@playwright/test");

/**
 * Wheat's Playwright specs drive the built Electron application, so they run
 * one at a time against a single SQLite profile.
 *
 * `testDir` matters as much as the rest: without it Playwright walks the whole
 * working directory and picks up any copy of the project that happens to sit
 * beside it (a `Wheat 2` backup folder, an unpacked release), then fails at
 * load time because two different Playwright installations end up in one
 * process. Scoping collection to this repository's `tests/` directory keeps a
 * spec path meaning exactly one file.
 */
module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.cjs$/,
  // Electron specs each own a temporary profile and a real window; running two
  // at once makes both flaky for reasons that have nothing to do with the code.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["line"]],
});
