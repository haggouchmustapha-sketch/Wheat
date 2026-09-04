const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(cwd, "electron", "securityBoundary.ts");
let security;

test.beforeAll(async () => {
  security = tsxRequire(modulePath, __filename);
});

test("packaged runtime removes environment-controlled renderer and data paths", () => {
  const env = {
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173/",
    WHEAT_USER_DATA_DIR: "relative-test-profile",
    APPDATA: "C:\\isolated-app-data",
    LOCALAPPDATA: "C:\\isolated-local-app-data",
    KEEP_ME: "yes",
  };
  expect(security.prepareRuntimeEnvironment({ isPackaged: true, env })).toBeNull();
  expect(env).toEqual({ APPDATA: "C:\\isolated-app-data", LOCALAPPDATA: "C:\\isolated-local-app-data", KEEP_ME: "yes" });
});

test("unpackaged runtime preserves an absolute isolated test profile", () => {
  const env = { WHEAT_USER_DATA_DIR: "relative-test-profile" };
  const profile = security.prepareRuntimeEnvironment({ isPackaged: false, env });
  expect(profile).toBe(path.resolve("relative-test-profile"));
  expect(env.WHEAT_USER_DATA_DIR).toBe(profile);
});

test("development renderer accepts only an exact loopback HTTP origin", () => {
  for (const url of ["http://127.0.0.1:5173", "http://localhost:5173/", "http://[::1]:5173/"]) {
    const trusted = security.resolveTrustedRendererLocation({
      isPackaged: false,
      devServerUrl: url,
      rendererFilePath: "ignored.html",
    });
    expect(trusted).toMatchObject({ mode: "development" });
    expect(trusted.url.endsWith("/")).toBe(true);
  }

  for (const url of [
    "https://127.0.0.1:5173/",
    "http://127.0.0.1.evil.test:5173/",
    "http://192.168.1.20:5173/",
    "http://127.0.0.1:5173/app",
    "http://user:password@127.0.0.1:5173/",
    "javascript:alert(1)",
  ]) {
    expect(() => security.resolveTrustedRendererLocation({
      isPackaged: false,
      devServerUrl: url,
      rendererFilePath: "ignored.html",
    })).toThrow(/loopback|locale valide/);
  }
});

test("packaged renderer always resolves to its local file", () => {
  const rendererFilePath = path.join(cwd, "dist", "index.html");
  const trusted = security.resolveTrustedRendererLocation({
    isPackaged: true,
    devServerUrl: "http://127.0.0.1:5173/",
    rendererFilePath,
  });
  expect(trusted.mode).toBe("file");
  expect(trusted.url).toMatch(/^file:\/\/\//);
  expect(trusted.url).toContain("dist/index.html");
});

test("IPC trust requires the exact main webContents, main frame, and renderer URL", () => {
  const trusted = security.resolveTrustedRendererLocation({
    isPackaged: false,
    devServerUrl: "http://127.0.0.1:5173/",
    rendererFilePath: "ignored.html",
  });
  const mainFrame = { url: trusted.url };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents };

  expect(security.isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, win, trusted)).toBe(true);
  expect(security.isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, win, trusted)).toBe(false);
  expect(security.isTrustedIpcSender({ sender: webContents, senderFrame: { url: trusted.url } }, win, trusted)).toBe(false);

  mainFrame.url = "http://127.0.0.1:5173/other";
  expect(security.isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, win, trusted)).toBe(false);
  expect(() => security.assertTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, win, trusted)).toThrow(/contenu non approuvé/);
});

test("window security denies popups, subframes, external navigation, webviews, and permissions", () => {
  const trusted = security.resolveTrustedRendererLocation({
    isPackaged: false,
    devServerUrl: "http://127.0.0.1:5173/",
    rendererFilePath: "ignored.html",
  });
  const listeners = new Map();
  let openHandler;
  let permissionCheck;
  let permissionRequest;
  const win = {
    webContents: {
      setWindowOpenHandler(handler) { openHandler = handler; },
      on(event, handler) { listeners.set(event, handler); },
      session: {
        setPermissionCheckHandler(handler) { permissionCheck = handler; },
        setPermissionRequestHandler(handler) { permissionRequest = handler; },
      },
    },
  };
  security.installBrowserWindowSecurity(win, trusted);

  expect(openHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
  expect(permissionCheck()).toBe(false);
  let permissionGranted = true;
  permissionRequest({}, "geolocation", (allowed) => { permissionGranted = allowed; });
  expect(permissionGranted).toBe(false);

  const external = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-navigate")(external, "https://example.com");
  expect(external.prevented).toBe(true);

  const trustedNavigation = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-navigate")(trustedNavigation, trusted.url);
  expect(trustedNavigation.prevented).toBe(false);

  const subframe = { url: trusted.url, isMainFrame: false, prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-frame-navigate")(subframe);
  expect(subframe.prevented).toBe(true);

  const webview = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("will-attach-webview")(webview);
  expect(webview.prevented).toBe(true);
});
