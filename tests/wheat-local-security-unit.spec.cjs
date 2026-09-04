const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "localSecurity.ts");
let localSecurity;

function cloneRow(row) {
  if (!row) return null;
  return {
    ...row,
    lockedUntil: row.lockedUntil ? new Date(row.lockedUntil) : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
  };
}

function createFakePrisma() {
  let row = null;
  const delegate = {
    async findUnique({ where }) {
      return where.id === "local" ? cloneRow(row) : null;
    },
    async upsert({ where, create, update }) {
      if (where.id !== "local") throw new Error("unexpected id");
      if (!row) {
        row = {
          id: "local",
          enabled: false,
          pinSalt: null,
          pinHash: null,
          pinKeyLength: 64,
          idleMinutes: 15,
          lockOnStartup: false,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          ...create,
        };
      } else {
        row = { ...row, ...update, updatedAt: new Date() };
      }
      return cloneRow(row);
    },
    async updateMany({ where, data }) {
      if (!row) return { count: 0 };
      for (const [key, expected] of Object.entries(where)) {
        if (row[key] !== expected) return { count: 0 };
      }
      row = { ...row, ...data, updatedAt: new Date() };
      return { count: 1 };
    },
  };
  return {
    localAppSecurity: delegate,
    inspect() {
      return cloneRow(row);
    },
    tamper(data) {
      row = { ...row, ...data };
    },
  };
}

function createClock(iso = "2026-08-12T12:00:00.000Z") {
  let milliseconds = new Date(iso).getTime();
  return {
    now: () => new Date(milliseconds),
    advance(amount) {
      milliseconds += amount;
    },
  };
}

function expectNoSecrets(status) {
  expect(status).not.toHaveProperty("pinSalt");
  expect(status).not.toHaveProperty("pinHash");
  expect(status).not.toHaveProperty("pinKeyLength");
  expect(JSON.stringify(status)).not.toContain("secret-pin");
}

test.beforeAll(async () => {
  localSecurity = tsxRequire(modulePath, __filename);
});

test("setup stores a salted scrypt result and never returns its secrets", async () => {
  const firstDb = createFakePrisma();
  const secondDb = createFakePrisma();
  const first = localSecurity.createLocalSecurityService({ getPrisma: async () => firstDb });
  const second = localSecurity.createLocalSecurityService({ getPrisma: async () => secondDb });

  const firstStatus = await first.setup({ pin: "secret-pin-123", idleMinutes: 30, lockOnStartup: true });
  const secondStatus = await second.setup({ pin: "secret-pin-123", idleMinutes: 30, lockOnStartup: true });
  const firstRow = firstDb.inspect();
  const secondRow = secondDb.inspect();

  expect(firstStatus).toMatchObject({ enabled: true, locked: false, idleMinutes: 30, lockOnStartup: true, scope: "LOCAL_APP_LOCK" });
  expectNoSecrets(firstStatus);
  expectNoSecrets(secondStatus);
  expect(Buffer.from(firstRow.pinSalt, "base64").length).toBeGreaterThanOrEqual(16);
  expect(Buffer.from(firstRow.pinHash, "base64").length).toBe(64);
  expect(firstRow.pinHash).not.toContain("secret-pin-123");
  expect(firstRow.pinSalt).not.toBe(secondRow.pinSalt);
  expect(firstRow.pinHash).not.toBe(secondRow.pinHash);

  await expect(first.setup({ pin: "short" })).rejects.toThrow(/6.*64/);
  await expect(first.setup({ pin: "x".repeat(65), currentPin: "secret-pin-123" })).rejects.toThrow(/6.*64/);
});

test("failed PIN attempts use persisted exponential throttling and reset after success", async () => {
  const db = createFakePrisma();
  const clock = createClock();
  const service = localSecurity.createLocalSecurityService({ getPrisma: async () => db, now: clock.now });
  await service.setup({ pin: "correct-pin", lockOnStartup: true });
  await service.lock();

  await expect(service.unlock({ pin: "wrong-pin" })).rejects.toMatchObject({
    code: "WHEAT_PIN_INVALID",
    retryAfterMs: 1_000,
  });
  expect(db.inspect().failedAttempts).toBe(1);
  await expect(service.unlock({ pin: "correct-pin" })).rejects.toMatchObject({
    code: "WHEAT_SECURITY_THROTTLED",
    retryAfterMs: 1_000,
  });

  clock.advance(1_001);
  await expect(service.unlock({ pin: "still-wrong" })).rejects.toMatchObject({
    code: "WHEAT_PIN_INVALID",
    retryAfterMs: 2_000,
  });
  expect(db.inspect().failedAttempts).toBe(2);

  clock.advance(2_001);
  const status = await service.unlock({ pin: "correct-pin" });
  expect(status).toMatchObject({ locked: false, failedAttempts: 0, throttled: false, retryAfterMs: 0 });
  expect(db.inspect().lockedUntil).toBeNull();
});

test("lock-on-startup and idle expiry fail closed until the PIN is verified", async () => {
  const db = createFakePrisma();
  const clock = createClock();
  const setupSession = localSecurity.createLocalSecurityService({ getPrisma: async () => db, now: clock.now });
  await setupSession.setup({ pin: "atlas-local-pin", idleMinutes: 1, lockOnStartup: true });

  const restartedSession = localSecurity.createLocalSecurityService({ getPrisma: async () => db, now: clock.now });
  expect(await restartedSession.status()).toMatchObject({ enabled: true, locked: true });
  await expect(restartedSession.assertUnlocked()).rejects.toMatchObject({ code: "WHEAT_APP_LOCKED" });
  expect(await restartedSession.unlock({ pin: "atlas-local-pin" })).toMatchObject({ locked: false });

  clock.advance(59_999);
  expect(await restartedSession.status()).toMatchObject({ locked: false });
  clock.advance(1);
  expect(await restartedSession.status()).toMatchObject({ locked: true });
  await expect(restartedSession.assertUnlocked()).rejects.toMatchObject({ code: "WHEAT_APP_LOCKED" });
});

test("disable erases verifier material and corrupt configuration remains locked", async () => {
  const db = createFakePrisma();
  const service = localSecurity.createLocalSecurityService({ getPrisma: async () => db });
  await service.setup({ pin: "remove-this-pin", lockOnStartup: true });
  const disabled = await service.disable({ pin: "remove-this-pin" });

  expect(disabled).toMatchObject({ enabled: false, locked: false, lockOnStartup: false });
  expectNoSecrets(disabled);
  expect(db.inspect()).toMatchObject({ enabled: false, pinSalt: null, pinHash: null, failedAttempts: 0, lockedUntil: null });
  await expect(service.assertUnlocked()).resolves.toMatchObject({ enabled: false });

  await service.setup({ pin: "new-safe-pin", lockOnStartup: true });
  db.tamper({ pinHash: "not-valid-base64" });
  const restarted = localSecurity.createLocalSecurityService({ getPrisma: async () => db });
  const status = await restarted.status();
  expect(status).toMatchObject({ enabled: true, locked: true, configurationError: true });
  expectNoSecrets(status);
  await expect(restarted.unlock({ pin: "new-safe-pin" })).rejects.toMatchObject({ code: "WHEAT_SECURITY_CONFIGURATION" });
});

test("IPC registration is complete and guards block business handlers while locked", async () => {
  const db = createFakePrisma();
  const registrations = new Map();
  const ipcMain = {
    handle(channel, listener) {
      if (registrations.has(channel)) throw new Error(`duplicate channel ${channel}`);
      registrations.set(channel, listener);
    },
  };
  const service = localSecurity.registerLocalSecurityIpc({
    ipcMain,
    getPrisma: async () => db,
    serialize: (value) => value,
  });
  expect(registrations.size).toBe(Object.keys(localSecurity.LOCAL_SECURITY_IPC_CHANNELS).length);
  expect(registrations.has("wheat:security:unlock")).toBe(true);
  expect(registrations.has("wheat:security:touch")).toBe(true);

  await registrations.get("wheat:security:setup")({}, { pin: "guarded-pin", idleMinutes: 15 });
  let calls = 0;
  const guarded = service.guard(async (value) => {
    calls += 1;
    return `handled:${value}`;
  });
  expect(await guarded("open")).toBe("handled:open");
  await service.lock();
  await expect(guarded("closed")).rejects.toMatchObject({ code: "WHEAT_APP_LOCKED" });
  expect(calls).toBe(1);
  await service.unlock({ pin: "guarded-pin" });
  expect(await localSecurity.guard(service, async () => "open-again")()).toBe("open-again");
});
