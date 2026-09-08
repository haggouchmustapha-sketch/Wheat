import fs from "node:fs";
import path from "node:path";
import type { AcquiredUpdate, UpdateDownloadProgress, UpdateProvider, UpdateRelease } from "./types";
import { MAX_ARTIFACT_BYTES, downloadArtifact } from "./releaseTransport";
import { validateReleaseManifest, verifyStagedArtifact } from "./validation";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export class LocalUpdateProvider implements UpdateProvider {
  readonly name = "local";
  /**
   * A folder inside the user's own profile is already as trusted as Wheat
   * itself, so a signature is not demanded here — requiring one would break
   * every existing local release for no gain against an attacker who can
   * already write to that folder. A signature that *is* present is still
   * verified: the service checks whenever one exists.
   */
  readonly requiresSignature = false;
  readonly description: string;
  private readonly updatesDirectory: string;

  constructor(updatesDirectory: string) {
    this.updatesDirectory = updatesDirectory;
    this.description = updatesDirectory;
  }

  async getLatestRelease() {
    const manifestPath = path.join(this.updatesDirectory, "latest.json");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Local update manifest is missing, empty, or too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error("Local update manifest is not valid JSON.", { cause: error });
    }
    return validateReleaseManifest(parsed);
  }

  private resolveArtifact(release: UpdateRelease) {
    const root = path.resolve(this.updatesDirectory);
    const artifactPath = path.resolve(root, release.artifact);
    if (!artifactPath.startsWith(`${root}${path.sep}`)) throw new Error("Update artifact escapes the configured local update directory.");
    return artifactPath;
  }

  async acquireUpdate(
    release: UpdateRelease,
    stagingDirectory: string,
    onProgress?: (progress: UpdateDownloadProgress) => void,
  ): Promise<AcquiredUpdate> {
    const sourcePath = this.resolveArtifact(release);
    const sourceStat = await fs.promises.stat(sourcePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Update artifact is missing: ${path.basename(sourcePath)}.`);
      throw error;
    });
    if (!sourceStat.isFile()) throw new Error("Update artifact is not a regular file.");
    const [realRoot, realArtifact] = await Promise.all([
      fs.promises.realpath(path.resolve(this.updatesDirectory)),
      fs.promises.realpath(sourcePath),
    ]);
    if (!realArtifact.startsWith(`${realRoot}${path.sep}`)) throw new Error("Update artifact resolves outside the configured local update directory.");
    if (release.artifactSize && sourceStat.size !== release.artifactSize) throw new Error("Update artifact size does not match its metadata.");
    // Staged through the same writer the network channels use: one owner for
    // the `.part` file, the rename on success and the byte-budgeted progress
    // reports. A local installer is a hundred megabytes or so, and reading it
    // as a stream is what lets the dialog show the bytes as they land instead
    // of standing at zero for the whole copy and then jumping to done.
    const artifactPath = await downloadArtifact({ body: fs.createReadStream(sourcePath) }, {
      stagingDirectory,
      fileName: path.basename(sourcePath),
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      expectedSize: sourceStat.size,
      onProgress,
    });
    return { release, artifactPath };
  }

  async validateUpdate(update: AcquiredUpdate) {
    await verifyStagedArtifact(update.artifactPath, update.release);
  }
}
