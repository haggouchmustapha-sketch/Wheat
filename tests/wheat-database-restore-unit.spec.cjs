const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "databaseRestore.ts");
const temporaryDirectories = [];
let databaseRestore;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-restore-rollback-"));
  temporaryDirectories.push(root);
  return {
    root,
    livePath: path.join(root, "wheat.sqlite"),
    previousPath: path.join(root, ".atlas-previous.sqlite"),
  };
}

test.beforeAll(async () => {
  databaseRestore = tsxRequire(modulePath, __filename);
});

test.afterEach(async () => {
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test.describe.configure({ mode: "serial" });

test("rollback disconnects first, restores the previous database, then reopens it", async () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.livePath, "replacement");
  fs.writeFileSync(fixture.previousPath, "previous");
  fs.writeFileSync(`${fixture.livePath}-wal`, "wal");
  fs.writeFileSync(`${fixture.livePath}-shm`, "shm");
  const calls = [];

  await databaseRestore.rollbackDatabaseReplacement(
    { ...fixture, replacementDone: true, hadLiveDatabase: true },
    {
      disconnect: async () => calls.push("disconnect"),
      reopenAndReset: async () => {
        calls.push("reopen");
        expect(fs.readFileSync(fixture.livePath, "utf8")).toBe("previous");
        expect(fs.existsSync(`${fixture.livePath}-wal`)).toBe(false);
        expect(fs.existsSync(`${fixture.livePath}-shm`)).toBe(false);
      },
    },
  );

  expect(calls).toEqual(["disconnect", "reopen"]);
  expect(fs.readFileSync(fixture.livePath, "utf8")).toBe("previous");
  expect(fs.existsSync(fixture.previousPath)).toBe(false);
  expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith(".wheat-failed-replacement-"))).toEqual([]);
});

test("rollback preserves the displaced replacement when validation or reopening fails", async () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.livePath, "replacement");
  fs.writeFileSync(fixture.previousPath, "previous");
  const calls = [];

  await expect(databaseRestore.rollbackDatabaseReplacement(
    { ...fixture, replacementDone: true, hadLiveDatabase: true },
    {
      disconnect: async () => calls.push("disconnect"),
      reopenAndReset: async () => {
        calls.push("reopen");
        throw new Error("validation failed");
      },
    },
  )).rejects.toThrow(/base précédente a été replacée.*pas pu la valider/i);

  expect(calls).toEqual(["disconnect", "reopen"]);
  expect(fs.readFileSync(fixture.livePath, "utf8")).toBe("previous");
  const displaced = fs.readdirSync(fixture.root).find((name) => name.startsWith(".wheat-failed-replacement-"));
  expect(displaced).toBeTruthy();
  expect(fs.readFileSync(path.join(fixture.root, displaced), "utf8")).toBe("replacement");
});

test("rollback reports a missing previous database without deleting the replacement", async () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.livePath, "replacement");
  const calls = [];

  await expect(databaseRestore.rollbackDatabaseReplacement(
    { ...fixture, replacementDone: true, hadLiveDatabase: true },
    {
      disconnect: async () => calls.push("disconnect"),
      reopenAndReset: async () => calls.push("reopen"),
    },
  )).rejects.toThrow(/base précédente est introuvable/i);

  expect(calls).toEqual(["disconnect"]);
  expect(fs.readFileSync(fixture.livePath, "utf8")).toBe("replacement");
});

test("post-commit cleanup is best-effort and reports its own failure", () => {
  const failures = [];
  expect(() => databaseRestore.runBestEffortCleanup(
    () => { throw new Error("file is locked"); },
    (error) => failures.push(error),
  )).not.toThrow();
  expect(failures).toHaveLength(1);
  expect(failures[0].message).toBe("file is locked");
});
