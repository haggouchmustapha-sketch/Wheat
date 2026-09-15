const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The cloud trust boundary.
 *
 * Wheat Cloud AI adds a credential and a network call to an application that
 * previously had neither in its document pipeline. This file pins down where
 * that credential is allowed to exist and what the renderer is allowed to
 * learn — because "the key stayed in the main process" is a property that
 * quietly stops being true the first time somebody adds a convenient getter.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let service;
let registry;

test.beforeAll(() => {
  service = tsxRequire(path.join(root, "electron", "wheatAiProviderService.ts"), __filename);
  registry = tsxRequire(path.join(root, "electron", "wheatWorkflowRegistry.ts"), __filename);
});

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  };
}

function temporaryService(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-cloud-security-"));
  return {
    directory,
    service: new service.WheatAiProviderService({
      directory,
      safeStorage: fakeSafeStorage(options),
      fetchImpl: async () => { throw new Error("no test may reach the network"); },
    }),
  };
}

const KEY = "sk-or-v1-thisisatestkeyvaluethatmustnevertravel";

/* ---------------------------------------------------- the renderer's view */

test("the cloud status the renderer receives contains no credential", () => {
  const { service: instance, directory } = temporaryService();
  try {
    instance.setKey("openrouter", KEY);
    const status = instance.getCloudStatus();
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain(KEY);
    // Not even the masked form belongs on this surface: the panel an accountant
    // sees answers "connected or not", and nothing about a key.
    expect(serialised).not.toMatch(/sk-or/);
    expect(status.connected).toBe(true);
    expect(status.providers).toEqual(["OpenRouter"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the full provider status carries a mask, never the key", async () => {
  const { service: instance, directory } = temporaryService();
  try {
    instance.setKey("openrouter", KEY);
    const status = await instance.getStatus();
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain(KEY);
    const row = status.providers.find((entry) => entry.id === "openrouter");
    expect(row.configured).toBe(true);
    expect(row.maskedKey).toMatch(/^sk-or•{8}.{4}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("nothing on the preload bridge can return a credential", () => {
  const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  // The key travels one way only: renderer → main, inside setWheatAiProviderKey.
  expect(preload).toMatch(/setWheatAiProviderKey/);
  expect(preload).not.toMatch(/getWheatAiProviderKey|readProviderKey|:key\b|apiKey\s*:/);
  // And the cloud surface exposes a status, a connect and a disconnect — no
  // method whose name suggests it hands anything back.
  expect(preload).toMatch(/getCloudStatus|authorizeCloud|disconnectCloud/);
  expect(preload).not.toMatch(/cloudKey|getCloudKey|cloudCredential/);
});

/* --------------------------------------------------- storage at rest ----- */

test("a key is never written in plaintext, and is refused rather than downgraded", () => {
  const { service: instance, directory } = temporaryService();
  try {
    instance.setKey("openrouter", KEY);
    for (const entry of fs.readdirSync(directory)) {
      const contents = fs.readFileSync(path.join(directory, entry), "utf8");
      expect(contents).not.toContain(KEY);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const insecure = temporaryService({ available: false });
  try {
    // No vault means no write. Wheat does not fall back to a plaintext file.
    expect(() => insecure.service.setKey("openrouter", KEY)).toThrow(/coffre-fort/i);
    const files = fs.readdirSync(insecure.directory);
    for (const entry of files) {
      expect(fs.readFileSync(path.join(insecure.directory, entry), "utf8")).not.toContain(KEY);
    }
  } finally {
    fs.rmSync(insecure.directory, { recursive: true, force: true });
  }
});

test("authorising without a working vault is refused before the browser opens", async () => {
  const insecure = temporaryService({ available: false });
  let opened = false;
  try {
    await expect(insecure.service.authorizeCloud({ openExternal: () => { opened = true; } })).rejects.toThrow(/coffre-fort/i);
    expect(opened).toBe(false);
  } finally {
    fs.rmSync(insecure.directory, { recursive: true, force: true });
  }
});

test("disconnecting forgets the credential on this machine", () => {
  const { service: instance, directory } = temporaryService();
  try {
    instance.setKey("openrouter", KEY);
    expect(instance.getCloudStatus().connected).toBe(true);
    expect(instance.disconnectCloud().connected).toBe(false);
    expect(instance.configuredProviders()).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- the OCR runtime */

test("the recognition runtime exposes a connection test and one call, and no key", () => {
  const { service: instance, directory } = temporaryService();
  try {
    const runtime = instance.cloudOcrRuntime();
    expect(Object.keys(runtime).sort()).toEqual(["isConnected", "runVision"]);
    expect(runtime.isConnected()).toBe(false);
    instance.setKey("openrouter", KEY);
    expect(instance.cloudOcrRuntime().isConnected()).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the renderer cannot choose the page the system browser opens", () => {
  /*
   * `wheat:cloud:authorize` takes no payload at all. The authorisation URL is
   * built inside the flow from the provider constant and a freshly generated
   * challenge, so a compromised renderer cannot make Wheat open an address of
   * its choosing in the user's browser.
   */
  const source = fs.readFileSync(path.join(root, "electron", "wheatAiProviderService.ts"), "utf8");
  const handler = source.slice(source.indexOf("CHANNELS.cloudAuthorize"), source.indexOf("CHANNELS.cloudDisconnect"));
  expect(handler).toMatch(/async \(\) =>/);
  expect(handler).not.toMatch(/payload/);

  const authorization = fs.readFileSync(path.join(root, "electron", "cloudAuthorization.ts"), "utf8");
  expect(authorization).toMatch(/const AUTHORIZE_URL = "https:\/\/openrouter\.ai\/auth"/);
  expect(authorization).toMatch(/server\.listen\(0, "127\.0\.0\.1"/);
});

test("every cloud channel passes the trusted-sender check", () => {
  const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  // Every channel is registered through the local `ipcMain` wrapper, and that
  // wrapper calls assertTrustedIpcSender before any listener runs. A channel
  // registered on Electron's ipcMain directly would bypass it.
  expect(main).toMatch(/handle\(channel: string[\s\S]{0,240}assertTrustedIpcSender/);
  expect(main.match(/electronIpcMain\.handle/g) ?? []).toHaveLength(1);

  // Authorisation waits on a human in a browser, so it must not count as an
  // active business operation — the quit path drains those before closing, and
  // an unfinished authorisation would otherwise hold Wheat open for minutes.
  const unguarded = main.slice(main.indexOf("UNGUARDED_IPC_CHANNELS"), main.indexOf("const ipcMain = {"));
  expect(unguarded).toContain("wheat:cloud:authorize");
  // The quick ones stay inside the normal operation accounting.
  for (const channel of ["wheat:cloud:status", "wheat:cloud:disconnect", "wheat:cloud:preferences"]) {
    expect(unguarded).not.toContain(channel);
  }
});

/* ------------------------------------------------------------ redaction */

test("anything shaped like a credential is stripped before it can be shown or logged", () => {
  const providers = tsxRequire(path.join(root, "electron", "wheatAiProviders.ts"), __filename);
  const leaky = `Request failed with Authorization: Bearer ${KEY} and key ${KEY} (gsk_abcdefghijklmnopqrstuvwx)`;
  const redacted = providers.redactSecrets(leaky);
  expect(redacted).not.toContain(KEY);
  expect(redacted).not.toContain("gsk_abcdefghijklmnopqrstuvwx");
  expect(redacted).toMatch(/clé masquée/);
});

test("the authorisation code and the key never reach a diagnostic line", () => {
  const authorization = fs.readFileSync(path.join(root, "electron", "cloudAuthorization.ts"), "utf8");
  // No logging at all in the authorisation path: the simplest way to be sure a
  // one-time code and a user's key never land in a file somebody later shares
  // in a support request.
  expect(authorization).not.toMatch(/console\.(log|info|warn|error)|wheatAiDiagnostic|logger\./);
});

/* --------------------------------------------------- workflow classification */

test("every new cloud channel is classified, and none of them touches accounting", () => {
  const byChannel = new Map(registry.WHEAT_WORKFLOW_REGISTRY.map((workflow) => [workflow.channel, workflow]));
  for (const channel of ["wheat:cloud:status", "wheat:cloud:authorize", "wheat:cloud:disconnect", "wheat:cloud:preferences", "wheat:app:edition"]) {
    const workflow = byChannel.get(channel);
    expect(workflow, `${channel} is not classified`).toBeTruthy();
    // Credential and identity operations are exempt from accounting review
    // because they are not accounting: they must never be able to write a
    // ledger, and the classification is where that is stated.
    expect(workflow.classification).toBe("EXEMPT");
    expect(workflow.reason.length).toBeGreaterThan(10);
  }
});
