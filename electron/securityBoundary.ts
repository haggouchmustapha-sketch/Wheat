import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { deleteWheatEnv, readWheatEnv } from "./runtimeEnvironment";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type TrustedRendererLocation = {
  mode: "development" | "file";
  url: string;
  origin: string;
};

type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Production must never accept environment-controlled storage or renderer
 * locations. Unpackaged runs retain an explicit, isolated profile for local
 * development and Electron tests.
 */
export function prepareRuntimeEnvironment(options: {
  isPackaged: boolean;
  env: RuntimeEnvironment;
}) {
  if (options.isPackaged) {
    delete options.env.VITE_DEV_SERVER_URL;
    deleteWheatEnv(options.env, "WHEAT_USER_DATA_DIR");
    return null;
  }

  const requestedProfile = readWheatEnv("WHEAT_USER_DATA_DIR", options.env)?.trim();
  if (!requestedProfile) return null;
  const resolvedProfile = path.resolve(requestedProfile);
  deleteWheatEnv(options.env, "WHEAT_USER_DATA_DIR");
  options.env.WHEAT_USER_DATA_DIR = resolvedProfile;
  return resolvedProfile;
}

function parseLoopbackDevelopmentOrigin(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("VITE_DEV_SERVER_URL doit être une origine HTTP locale valide.");
  }

  const hasExactOriginShape = parsed.pathname === "/" && !parsed.search && !parsed.hash;
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLocaleLowerCase("en-US"));
  if (
    parsed.protocol !== "http:" ||
    !isLoopback ||
    parsed.username ||
    parsed.password ||
    !hasExactOriginShape
  ) {
    throw new Error("Wheat refuse un serveur de développement qui n'est pas une origine HTTP loopback exacte.");
  }

  return parsed.origin;
}

export function resolveTrustedRendererLocation(options: {
  isPackaged: boolean;
  devServerUrl?: string;
  rendererFilePath: string;
}): TrustedRendererLocation {
  const requestedDevUrl = options.devServerUrl?.trim();
  if (!options.isPackaged && requestedDevUrl) {
    const origin = parseLoopbackDevelopmentOrigin(requestedDevUrl);
    return { mode: "development", origin, url: `${origin}/` };
  }

  const url = pathToFileURL(path.resolve(options.rendererFilePath)).href;
  return { mode: "file", origin: "null", url };
}

export function isTrustedRendererUrl(candidate: string, trusted: TrustedRendererLocation) {
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) return false;
    return parsed.href === trusted.url;
  } catch {
    return false;
  }
}

type IpcEventLike = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
type TrustedWindowLike = Pick<BrowserWindow, "isDestroyed" | "webContents">;

export function isTrustedIpcSender(
  event: IpcEventLike,
  trustedWindow: TrustedWindowLike | null,
  trustedLocation: TrustedRendererLocation | null,
) {
  if (!trustedWindow || trustedWindow.isDestroyed() || !trustedLocation) return false;
  const trustedContents = trustedWindow.webContents;
  const frame = event.senderFrame;
  if (event.sender !== trustedContents || !frame || frame !== trustedContents.mainFrame) return false;
  return isTrustedRendererUrl(frame.url, trustedLocation);
}

export function assertTrustedIpcSender(
  event: IpcEventLike,
  trustedWindow: TrustedWindowLike | null,
  trustedLocation: TrustedRendererLocation | null,
) {
  if (!isTrustedIpcSender(event, trustedWindow, trustedLocation)) {
    throw new Error("Wheat a refusé un appel IPC provenant d'un contenu non approuvé.");
  }
}

export function installBrowserWindowSecurity(win: BrowserWindow, trusted: TrustedRendererLocation) {
  const contents = win.webContents;

  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, trusted)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, trusted)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, trusted)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());

  // Wheat does not need browser-granted device, media, location, notification,
  // storage-access, or external-open permissions. Both handlers are required by
  // Electron for a complete fail-closed permission policy.
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_requestingContents, _permission, callback) => callback(false));
}

