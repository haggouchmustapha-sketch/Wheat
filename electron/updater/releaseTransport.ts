import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UpdateNetworkError, type UpdateDownloadProgress } from "./types";

/**
 * The HTTP half of every network update channel.
 *
 * Both the generic HTTPS feed and the GitHub Releases channel fetch a manifest
 * and stream an installer to disk under a size ceiling, and both must treat
 * every byte as hostile until the manifest signature and the artifact digest
 * say otherwise. That machinery lives here once rather than twice: a redirect
 * rule or a download bound that is right in one copy and wrong in the other is
 * the kind of difference nobody notices until it matters.
 *
 * What differs between the channels is *policy* — which URLs a response may be
 * redirected to — so policy is the parameter, and the transport itself never
 * decides where trust ends.
 */

export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Rather more than an NSIS Wheat, and far less than a disk-filling stream. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
export const MANIFEST_TIMEOUT_MS = 20_000;
export const ARTIFACT_TIMEOUT_MS = 30 * 60_000;
const MAX_REDIRECTS = 5;

export type FetchLike = (url: string, init?: any) => Promise<any>;

export type ReleaseRequestOptions = {
  fetchImpl: FetchLike;
  timeoutMs: number;
  /**
   * Decides whether a redirect may be followed. Called with the destination
   * already resolved against the current URL. Returning false ends the request
   * with a hard error rather than a network error: a release host that sends
   * Wheat somewhere unexpected is a problem to report, not a bad connection to
   * retry quietly.
   */
  allowRedirectTo: (destination: URL, from: URL) => boolean;
};

/**
 * One GET, with redirects followed by hand.
 *
 * `redirect: "manual"` rather than the default, because the default would let a
 * release host hand the next Wheat installer off to any origin it likes — a CDN
 * with a different certificate, an http:// mirror, a captive portal's login
 * page. Each hop is offered to `allowRedirectTo` instead.
 *
 * Returns `null` for 404 so callers can tell "published nothing" from "failed".
 */
export async function requestRelease(url: URL, options: ReleaseRequestOptions): Promise<any> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: any;
    try {
      response = await options.fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/octet-stream, application/json;q=0.9, */*;q=0.1" },
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new UpdateNetworkError("The Wheat update server did not respond in time.", { cause: error });
      throw new UpdateNetworkError(`The Wheat update server could not be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    clearTimeout(timer);

    const status = Number(response.status);
    if (status >= 300 && status < 400) {
      const location = typeof response.headers?.get === "function" ? response.headers.get("location") : null;
      if (!location) throw new Error(`The Wheat update server sent a redirect with no destination (HTTP ${status}).`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch (error) {
        throw new Error("The Wheat update server sent an unusable redirect.", { cause: error });
      }
      if (next.protocol !== "https:" || !options.allowRedirectTo(next, current)) {
        throw new Error("The Wheat update server redirected to a location Wheat does not trust for updates.");
      }
      current = next;
      continue;
    }
    if (status === 404) return null;
    // A server fault or a rate limit is the network having a bad day, not a bad
    // update; it stays soft so an offline-tolerant check stays quiet.
    if (status >= 500 || status === 429) {
      throw new UpdateNetworkError(`The Wheat update server is unavailable (HTTP ${status}).`);
    }
    if (!response.ok) throw new Error(`The Wheat update server refused the request (HTTP ${status}).`);
    return response;
  }
  throw new Error("The Wheat update server redirected too many times.");
}

/** Reads a manifest response as text, refusing anything implausibly large. */
export async function readManifestText(response: any): Promise<string> {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    throw new Error("The Wheat update manifest is too large.");
  }
  const text = String(await response.text());
  if (text.length > MAX_MANIFEST_BYTES) throw new Error("The Wheat update manifest is too large.");
  if (text.trim().length < 2) throw new Error("The Wheat update manifest is empty.");
  return text;
}

export type DownloadOptions = {
  stagingDirectory: string;
  fileName: string;
  maxArtifactBytes: number;
  /** The size the signed manifest declares, when it declares one. */
  expectedSize?: number;
  onProgress?: (progress: UpdateDownloadProgress) => void;
};

/**
 * Streams a response body to a file inside the staging directory.
 *
 * Written to a `.part` file and renamed only on success, so an interrupted
 * download can never be mistaken for a complete artifact by the verification
 * step that follows — the half-written bytes are removed rather than left where
 * a retry might find them.
 */
export async function downloadArtifact(response: any, options: DownloadOptions): Promise<string> {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  const hasDeclared = Number.isFinite(declared) && declared > 0;
  if (hasDeclared) {
    if (declared > options.maxArtifactBytes) throw new Error("The update artifact is larger than Wheat will download.");
    if (options.expectedSize && declared !== options.expectedSize) {
      throw new Error("The update artifact size does not match its metadata.");
    }
  }
  const ceiling = Math.min(options.maxArtifactBytes, options.expectedSize ?? options.maxArtifactBytes);
  const totalBytes = options.expectedSize ?? (hasDeclared ? declared : null);

  await fs.promises.mkdir(options.stagingDirectory, { recursive: true });
  const finalPath = path.join(options.stagingDirectory, options.fileName);
  const temporaryPath = `${finalPath}.${randomUUID()}.part`;
  let written = 0;
  // Progress is reported on a byte budget rather than per chunk: a fast link
  // delivers thousands of chunks a second, and every report crosses the IPC
  // bridge and re-renders the dialog.
  let reportedAt = 0;
  const reportEvery = totalBytes ? Math.max(64 * 1024, Math.floor(totalBytes / 100)) : 512 * 1024;
  const report = () => options.onProgress?.({
    transferredBytes: written,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.round((written / totalBytes) * 100)) : null,
  });

  try {
    const handle = await fs.promises.open(temporaryPath, "wx");
    try {
      report();
      for await (const chunk of streamOf(response)) {
        written += chunk.byteLength;
        // Enforced while writing, not after: a server that ignores its own
        // content-length must not be able to fill the user's disk first.
        if (written > ceiling) throw new Error("The update artifact is larger than its metadata declares.");
        await handle.write(chunk);
        if (written - reportedAt >= reportEvery) {
          reportedAt = written;
          report();
        }
      }
    } finally {
      await handle.close();
    }
    report();
    await fs.promises.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof UpdateNetworkError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A connection that dies mid-download is a network problem, not a bad
    // release, and must not poison the release for the next attempt.
    if (/abort|socket|ECONN|ETIMEDOUT|network|terminated|premature|unexpected end/i.test(message)) {
      throw new UpdateNetworkError(`The update download did not complete: ${message}`, { cause: error });
    }
    throw error;
  }
  return finalPath;
}

/**
 * Iterates a response body as chunks, whichever body shape the runtime gives.
 *
 * `fetch` in Electron's main process yields a web ReadableStream; the test
 * doubles hand back a plain async iterable or a Buffer. Normalising here keeps
 * the download loop above readable and identical in both.
 */
async function* streamOf(response: any): AsyncGenerator<Uint8Array> {
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value as Uint8Array;
    }
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield toBytes(chunk);
    return;
  }
  // No streaming body at all: fall back to the buffered read.
  yield toBytes(await response.arrayBuffer());
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return Buffer.from(String(chunk), "utf8");
}
