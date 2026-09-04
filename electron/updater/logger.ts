import fs from "node:fs";
import path from "node:path";

export class UpdateLogger {
  private readonly logPath: string;

  constructor(stateDirectory: string) {
    this.logPath = path.join(stateDirectory, "updater.log");
  }

  async log(event: string, details: Record<string, unknown> = {}) {
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key]) => !/database|document|accounting/i.test(key)));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...safeDetails });
    await fs.promises.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.promises.appendFile(this.logPath, `${line}\n`, "utf8");
  }
}
