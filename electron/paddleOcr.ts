import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { App } from "electron";
import { readWheatEnv, resolveWheatEnv } from "./runtimeEnvironment";

/** Names worker.py reads out of its own environment. */
const PADDLE_WORKER_ENVIRONMENT = [
  "WHEAT_PADDLEOCR_LANG",
  "WHEAT_PADDLEOCR_DEVICE",
  "WHEAT_PADDLEOCR_ORIENTATION",
  "WHEAT_PADDLEOCR_DETECTION_MODEL",
  "WHEAT_PADDLEOCR_RECOGNITION_MODEL",
  "WHEAT_PADDLEOCR_CPU_THREADS",
] as const;

const START_TIMEOUT_MS = 20_000;
const OCR_TIMEOUT_MS = 5 * 60_000;
/** Ceiling on sidecar processes, whatever the machine reports. */
const MAX_POOL_SIZE = 4;
const MAX_PROTOCOL_LINE = 24 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 16_000;

type PaddleMode = "ocr" | "structure" | "vl";

export type PaddleWord = {
  text: string;
  confidence: number;
  page?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
};

export type PaddleOcrResult = {
  text: string;
  confidence: number;
  words: PaddleWord[];
  tables: string[][][];
  engine: string;
  engineVersion: string;
  language: string;
  mode: PaddleMode;
  pageCount: number;
  warnings: string[];
};

export type PaddleOcrStatus = {
  available: boolean;
  local: true;
  engine: "PaddleOCR";
  version: string | null;
  pythonVersion: string | null;
  language: string;
  device: string;
  reason: string | null;
  vl16Installed: boolean;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PythonCandidate = { executable: string; prefixArgs: string[] };

class PaddleOcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaddleOcrUnavailableError";
  }
}

class PaddleOcrClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private pending = new Map<string, PendingRequest>();
  private diagnostics = "";
  private stopped = false;
  private readonly candidate: PythonCandidate;
  private readonly workerPath: string;
  private readonly modelCachePath: string;

  private readonly cpuThreads: number;

  constructor(candidate: PythonCandidate, workerPath: string, modelCachePath: string, cpuThreads: number) {
    this.candidate = candidate;
    this.workerPath = workerPath;
    this.modelCachePath = modelCachePath;
    this.cpuThreads = cpuThreads;
  }

  async start(): Promise<PaddleOcrStatus> {
    if (this.child) throw new Error("PaddleOCR worker is already running.");
    const child = spawn(this.candidate.executable, [...this.candidate.prefixArgs, this.workerPath], {
      cwd: path.dirname(this.workerPath),
      env: {
        ...process.env,
        // worker.py reads these directly, so resolve the legacy ATLAS_* names
        // here rather than teaching the sidecar about them too.
        // Each sidecar gets its own slice of the machine. Left at the worker's
        // own default, several pool members would each claim four threads and
        // spend more time contending for cores than recognising pages.
        WHEAT_PADDLEOCR_CPU_THREADS: String(this.cpuThreads),
        ...resolveWheatEnv(PADDLE_WORKER_ENVIRONMENT),
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK ?? "True",
        PADDLE_PDX_CACHE_HOME: process.env.PADDLE_PDX_CACHE_HOME ?? this.modelCachePath,
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.acceptLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.diagnostics = `${this.diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_CHARS);
    });
    child.once("error", (error) => this.failAll(new PaddleOcrUnavailableError(`Impossible de démarrer PaddleOCR: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.child = null;
      this.lines?.close();
      this.lines = null;
      if (!this.stopped) {
        const detail = this.diagnostics.trim().split(/\r?\n/).slice(-2).join(" ");
        this.failAll(new PaddleOcrUnavailableError(`Le moteur PaddleOCR s'est arrêté (${signal ?? code ?? "inconnu"}).${detail ? ` ${detail}` : ""}`));
      }
    });

    const response = await this.request("health", {}, START_TIMEOUT_MS);
    return normalizeStatus(response);
  }

  async recognize(inputPath: string, mode: PaddleMode): Promise<PaddleOcrResult> {
    const response = await this.request("recognize", { inputPath, mode }, OCR_TIMEOUT_MS);
    return normalizeResult(response, mode);
  }

  /** Builds the recognition pipeline now, so the first document does not. */
  async warmup(): Promise<void> {
    await this.request("warmup", { mode: "ocr" }, OCR_TIMEOUT_MS);
  }

  async stop() {
    this.stopped = true;
    if (!this.child) return;
    const child = this.child;
    try {
      await this.request("shutdown", {}, 2_000);
    } catch {
      // A forceful process stop below is safe: the worker never writes accounting data.
    }
    if (!child.killed) child.kill();
    this.child = null;
    this.lines?.close();
    this.lines = null;
  }

  private request(action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new PaddleOcrUnavailableError("Le moteur PaddleOCR local n'est pas démarré."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PaddleOCR a dépassé le délai autorisé pour ${action}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private acceptLine(line: string) {
    if (!line || line.length > MAX_PROTOCOL_LINE) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.diagnostics = `${this.diagnostics}\n${line}`.slice(-MAX_DIAGNOSTIC_CHARS);
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    if (message.ok === false) {
      request.reject(new Error(typeof message.error === "string" ? message.error : "PaddleOCR n'a pas pu analyser ce document."));
    } else request.resolve(message);
  }

  private failAll(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * The local recognition pool.
 *
 * `worker.py` serves one request at a time: it reads a line, runs inference,
 * writes a line. A single sidecar therefore turned a batch import into a queue
 * — measured on this repository's sample documents, two concurrent requests
 * took exactly as long as two sequential ones — while eleven of the machine's
 * twelve cores sat idle. The pool keeps several sidecars, each holding its own
 * loaded pipeline, and hands a caller the first idle one.
 *
 * Sidecars are started lazily and only as far as there is work for them: a
 * dossier where somebody re-reads one invoice never pays for more than one
 * process, and each process costs real memory.
 */
type PoolMember = { client: PaddleOcrClient; busy: boolean };
/** A caller waiting for a sidecar, and the way to tell it none is coming. */
type PoolWaiter = { grant: (member: PoolMember) => void; abandon: (error: Error) => void };

let poolMembers: PoolMember[] = [];
let poolCandidate: PythonCandidate | null = null;
let poolContext: { workerPath: string; modelCachePath: string; cpuThreads: number } | null = null;
const waiters: PoolWaiter[] = [];
let activeStatus: PaddleOcrStatus | null = null;
let initializing: Promise<PaddleOcrStatus> | null = null;
let growing: Promise<void> | null = null;
let retryAfter = 0;

/**
 * How many sidecars this machine should run.
 *
 * Recognition is CPU-bound and each sidecar holds a loaded model, so the limit
 * is whichever of cores and memory runs out first. `WHEAT_OCR_CONCURRENCY`
 * overrides it, including down to 1 for a machine where the extra memory
 * matters more than the throughput.
 */
export function paddleOcrPoolSize(): number {
  const configured = Number(readWheatEnv("WHEAT_OCR_CONCURRENCY") ?? "");
  if (Number.isInteger(configured) && configured >= 1) return Math.min(MAX_POOL_SIZE, configured);
  const cores = Math.max(1, os.cpus().length);
  const byCore = Math.floor(cores / 4);
  // Roughly a gigabyte per loaded sidecar, and never the last two of the
  // machine's own memory.
  const byMemory = Math.floor((os.totalmem() / 1_073_741_824 - 2) / 2);
  return Math.max(1, Math.min(MAX_POOL_SIZE, byCore, byMemory));
}

function cpuThreadsPerWorker(poolSize: number) {
  return Math.max(1, Math.min(4, Math.floor(Math.max(1, os.cpus().length) / Math.max(1, poolSize))));
}

/** Hands back an idle sidecar, growing the pool first when that is allowed. */
async function acquire(): Promise<PoolMember> {
  const idle = poolMembers.find((member) => !member.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  if (poolMembers.length < paddleOcrPoolSize()) {
    await grow();
    const grown = poolMembers.find((member) => !member.busy);
    if (grown) {
      grown.busy = true;
      return grown;
    }
  }
  if (!poolMembers.length) throw new PaddleOcrUnavailableError(activeStatus?.reason ?? "PaddleOCR local n'est pas disponible.");
  return new Promise<PoolMember>((resolve, reject) => {
    waiters.push({
      grant: (member) => {
        member.busy = true;
        resolve(member);
      },
      // Shutdown has to settle these. A dropped waiter is a promise that never
      // resolves, which would hang the import — and, because the pool is closed
      // on quit, the quit itself.
      abandon: reject,
    });
  });
}

function release(member: PoolMember) {
  member.busy = false;
  const waiter = waiters.shift();
  if (waiter) waiter.grant(member);
}

/**
 * Starts one more sidecar, when one is wanted and the first one already proved
 * this Python works. A failure to grow is not a failure to recognise: the
 * caller falls back to the members that are already running.
 */
async function grow(): Promise<void> {
  if (growing) return growing;
  if (!poolCandidate || !poolContext) return;
  if (poolMembers.length >= paddleOcrPoolSize()) return;
  growing = (async () => {
    const client = new PaddleOcrClient(poolCandidate!, poolContext!.workerPath, poolContext!.modelCachePath, poolContext!.cpuThreads);
    try {
      const status = await client.start();
      if (!status.available) {
        await client.stop();
        return;
      }
      poolMembers.push({ client, busy: false });
    } catch {
      await client.stop();
    }
  })();
  try {
    await growing;
  } finally {
    growing = null;
  }
}

function resolveWorkerPath(app: App): string {
  const explicit = readWheatEnv("WHEAT_PADDLEOCR_WORKER");
  const candidates = [
    explicit,
    app.isPackaged ? path.join(process.resourcesPath, "paddleocr", "worker.py") : "",
    path.join(process.cwd(), "resources", "paddleocr", "worker.py"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? "";
}

function pythonCandidates(app: App): PythonCandidate[] {
  const values: PythonCandidate[] = [];
  const add = (executable: string | undefined, prefixArgs: string[] = []) => {
    if (!executable) return;
    const key = `${executable.toLowerCase()}|${prefixArgs.join("|")}`;
    if (!values.some((candidate) => `${candidate.executable.toLowerCase()}|${candidate.prefixArgs.join("|")}` === key)) {
      values.push({ executable, prefixArgs });
    }
  };
  add(readWheatEnv("WHEAT_PADDLEOCR_PYTHON"));
  add(path.join(app.getPath("userData"), "paddleocr", "runtime", "Scripts", "python.exe"));
  add(path.join(app.getPath("userData"), "paddleocr", "runtime", "bin", "python3"));
  add(app.isPackaged ? path.join(process.resourcesPath, "paddleocr", "runtime", "python.exe") : "");
  add(path.join(process.cwd(), "resources", "paddleocr", "runtime", "python.exe"));
  add(path.join(process.cwd(), "resources", "paddleocr", "runtime", "Scripts", "python.exe"));
  if (process.platform === "win32") add("py", ["-3.12"]);
  add(process.platform === "win32" ? "python" : "python3");
  return values.filter((candidate) => !path.isAbsolute(candidate.executable) || fs.existsSync(candidate.executable));
}

async function initialize(app: App, force = false): Promise<PaddleOcrStatus> {
  if (poolMembers.length && activeStatus?.available) return activeStatus;
  if (!force && activeStatus && Date.now() < retryAfter) return activeStatus;
  if (initializing) return initializing;
  initializing = (async () => {
    const workerPath = resolveWorkerPath(app);
    if (!workerPath || !fs.existsSync(workerPath)) {
      return unavailableStatus("Le worker PaddleOCR n'est pas présent dans les ressources Wheat.");
    }
    let lastReason = "Python ou PaddleOCR n'est pas installé.";
    const bundledModelCache = path.join(path.dirname(workerPath), "models");
    const modelCachePath = fs.existsSync(path.join(bundledModelCache, "official_models"))
      ? bundledModelCache
      : path.join(app.getPath("userData"), "paddleocr", "models");
    await fs.promises.mkdir(modelCachePath, { recursive: true });
    const cpuThreads = cpuThreadsPerWorker(paddleOcrPoolSize());
    for (const candidate of pythonCandidates(app)) {
      const client = new PaddleOcrClient(candidate, workerPath, modelCachePath, cpuThreads);
      try {
        const status = await client.start();
        if (status.available) {
          // The candidate that worked is remembered, so growing the pool later
          // never re-walks the list of Pythons that did not.
          poolCandidate = candidate;
          poolContext = { workerPath, modelCachePath, cpuThreads };
          poolMembers = [{ client, busy: false }];
          activeStatus = status;
          retryAfter = 0;
          return status;
        }
        lastReason = status.reason ?? lastReason;
        await client.stop();
      } catch (error) {
        lastReason = error instanceof Error ? error.message : lastReason;
        await client.stop();
      }
    }
    activeStatus = unavailableStatus(lastReason);
    retryAfter = Date.now() + 60_000;
    return activeStatus;
  })();
  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

/**
 * Loads the models before anybody is waiting on them.
 *
 * The first recognition of a session paid roughly thirteen seconds of model
 * loading on this repository's samples, and that time landed on whichever
 * document the user happened to import first. Called at startup, it is spent
 * while nobody is watching. It never throws: a machine without the local
 * runtime simply stays as it was, and the status call reports why.
 */
export async function warmPaddleOcr(app: App): Promise<PaddleOcrStatus> {
  const status = await initialize(app);
  if (!status.available || !poolMembers.length) return status;
  // Every member loads its own copy of the models, so warming only the first
  // one would simply move the cost onto the second and third documents of the
  // batch instead of removing it. Nobody is waiting at startup, so they are
  // grown and warmed together.
  while (poolMembers.length < paddleOcrPoolSize()) {
    const before = poolMembers.length;
    await grow();
    if (poolMembers.length === before) break;
  }
  await Promise.all(poolMembers.map(async (member) => {
    if (member.busy) return;
    member.busy = true;
    try {
      await member.client.warmup();
    } catch {
      // A warm-up failure is not an availability failure: the next real
      // recognition loads the pipeline itself and reports its own error.
    } finally {
      release(member);
    }
  }));
  return status;
}

export async function getPaddleOcrStatus(app: App, force = false): Promise<PaddleOcrStatus> {
  const status = await initialize(app, force);
  return { ...status, vl16Installed: isPaddleOcrVl16Installed(app) };
}

export function isPaddleOcrVl16Installed(app: App) {
  const roots = [
    app.isPackaged ? path.join(process.resourcesPath, "paddleocr", "models", "official_models") : "",
    path.join(process.cwd(), "resources", "paddleocr", "models", "official_models"),
    path.join(app.getPath("userData"), "paddleocr", "models", "official_models"),
  ].filter(Boolean);
  return roots.some((root) => fs.existsSync(root) && fs.readdirSync(root).some((name) => name.toLowerCase().includes("paddleocr-vl-1.6")));
}

export async function recognizeWithPaddle(app: App, input: string | Buffer, options?: { mode?: PaddleMode; extension?: string }): Promise<PaddleOcrResult> {
  const status = await initialize(app);
  if (!status.available || !poolMembers.length) throw new PaddleOcrUnavailableError(status.reason ?? "PaddleOCR local n'est pas disponible.");
  let inputPath = typeof input === "string" ? input : "";
  let temporaryPath = "";
  if (Buffer.isBuffer(input)) {
    const temporaryDirectory = path.join(app.getPath("userData"), "ocr-temp");
    await fs.promises.mkdir(temporaryDirectory, { recursive: true });
    const extension = /^\.[a-z0-9]{2,5}$/i.test(options?.extension ?? "") ? options!.extension! : ".png";
    temporaryPath = path.join(temporaryDirectory, `paddle-${crypto.randomUUID()}${extension}`);
    await fs.promises.writeFile(temporaryPath, input, { flag: "wx", mode: 0o600 });
    inputPath = temporaryPath;
  }
  const member = await acquire();
  try {
    if (!path.isAbsolute(inputPath) || !fs.existsSync(inputPath)) throw new Error("Le fichier OCR local est introuvable.");
    return await member.client.recognize(inputPath, options?.mode ?? "ocr");
  } finally {
    release(member);
    if (temporaryPath) await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function closePaddleOcrWorker() {
  const members = poolMembers;
  poolMembers = [];
  poolCandidate = null;
  poolContext = null;
  // Whoever was queued for a sidecar is told there will not be one, so their
  // document falls back to Tesseract instead of waiting for a stopped process.
  for (const waiter of waiters.splice(0)) {
    waiter.abandon(new PaddleOcrUnavailableError("Le moteur PaddleOCR local a été arrêté."));
  }
  activeStatus = null;
  initializing = null;
  growing = null;
  retryAfter = 0;
  await Promise.all(members.map((member) => member.client.stop()));
}

function unavailableStatus(reason: string): PaddleOcrStatus {
  return {
    available: false,
    local: true,
    engine: "PaddleOCR",
    version: null,
    pythonVersion: null,
    language: readWheatEnv("WHEAT_PADDLEOCR_LANG") ?? "fr",
    device: readWheatEnv("WHEAT_PADDLEOCR_DEVICE") ?? "cpu",
    reason,
    vl16Installed: false,
  };
}

function normalizeStatus(value: Record<string, unknown>): PaddleOcrStatus {
  return {
    available: value.available === true,
    local: true,
    engine: "PaddleOCR",
    version: typeof value.version === "string" ? value.version : null,
    pythonVersion: typeof value.pythonVersion === "string" ? value.pythonVersion : null,
    language: typeof value.language === "string" ? value.language : "fr",
    device: typeof value.device === "string" ? value.device : "cpu",
    reason: typeof value.reason === "string" && value.reason ? value.reason : null,
    vl16Installed: value.vl16Installed === true,
  };
}

function normalizeResult(value: Record<string, unknown>, mode: PaddleMode): PaddleOcrResult {
  const tables = Array.isArray(value.tables)
    ? value.tables.map((table) => Array.isArray(table)
      ? table.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : [])
      : []).filter((table) => table.length > 0)
    : [];
  const words: PaddleWord[] = Array.isArray(value.words) ? value.words.map((word) => {
    const item = word && typeof word === "object" ? word as Record<string, unknown> : {};
    const bbox = item.bbox && typeof item.bbox === "object" ? item.bbox as Record<string, unknown> : null;
    return {
      text: String(item.text ?? "").trim(),
      confidence: boundedConfidence(item.confidence),
      page: Math.max(1, Math.round(Number(item.page ?? 1)) || 1),
      bbox: bbox ? {
        x0: Number(bbox.x0 ?? 0), y0: Number(bbox.y0 ?? 0), x1: Number(bbox.x1 ?? 0), y1: Number(bbox.y1 ?? 0),
      } : undefined,
    };
  }).filter((word) => word.text) : [];
  return {
    text: typeof value.text === "string" ? value.text.trim() : "",
    confidence: boundedConfidence(value.confidence),
    words,
    tables,
    engine: typeof value.engine === "string" ? value.engine : mode === "vl" ? "PaddleOCR-VL-1.6" : mode === "structure" ? "PaddleOCR PP-StructureV3" : "PaddleOCR PP-OCR",
    engineVersion: typeof value.engineVersion === "string" ? value.engineVersion : "unknown",
    language: typeof value.language === "string" ? value.language : "fr",
    mode,
    pageCount: Math.max(1, Math.round(Number(value.pageCount ?? 1)) || 1),
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String).slice(0, 50) : [],
  };
}

function boundedConfidence(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}
