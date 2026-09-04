import path from "node:path";
import { readWheatEnv } from "../runtimeEnvironment";

type AppPaths = {
  isPackaged: boolean;
  getPath(name: "userData"): string;
};

export function resolveLocalUpdateDirectory(app: AppPaths, projectDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  if (app.isPackaged) return path.join(app.getPath("userData"), "updates");
  const explicit = readWheatEnv("WHEAT_UPDATES_DIR", env)?.trim();
  return explicit ? path.resolve(explicit) : path.resolve(projectDirectory, "updates");
}

export function resolveUpdaterStateDirectory(app: AppPaths) {
  return path.join(app.getPath("userData"), "updater");
}
