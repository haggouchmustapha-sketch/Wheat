import fs from "node:fs";
import { createHash } from "node:crypto";
import semver from "semver";
import { UPDATE_SCHEMA_VERSION, type UpdateRelease } from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateReleaseManifest(value: unknown): UpdateRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update metadata must be a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported update metadata schema: ${String(candidate.schemaVersion)}.`);
  }
  if (typeof candidate.version !== "string" || !semver.valid(candidate.version)) {
    throw new Error("Update metadata contains an invalid semantic version.");
  }
  const parsedReleaseDate = typeof candidate.releaseDate === "string" ? new Date(`${candidate.releaseDate}T00:00:00Z`) : null;
  if (typeof candidate.releaseDate !== "string" || !ISO_DAY_PATTERN.test(candidate.releaseDate) || !parsedReleaseDate || Number.isNaN(parsedReleaseDate.getTime()) || parsedReleaseDate.toISOString().slice(0, 10) !== candidate.releaseDate) {
    throw new Error("Update metadata contains an invalid release date.");
  }
  if (!Array.isArray(candidate.notes) || candidate.notes.length < 1 || candidate.notes.length > 100 || candidate.notes.some((note) => typeof note !== "string" || !note.trim() || note.length > 500)) {
    throw new Error("Update metadata must contain between 1 and 100 release notes.");
  }
  if (typeof candidate.artifact !== "string" || !candidate.artifact.trim() || candidate.artifact.length > 240 || pathIsUnsafe(candidate.artifact)) {
    throw new Error("Update metadata contains an unsafe artifact path.");
  }
  if (!candidate.artifact.toLowerCase().endsWith(".exe")) throw new Error("Local Windows updates must use an NSIS .exe artifact.");
  if (!SHA256_PATTERN.test(String(candidate.sha256 ?? ""))) {
    throw new Error("Update metadata contains an invalid SHA-256 checksum.");
  }
  if (candidate.minimumVersion !== undefined && (typeof candidate.minimumVersion !== "string" || !semver.valid(candidate.minimumVersion))) {
    throw new Error("Update metadata contains an invalid minimumVersion.");
  }
  if (candidate.minimumVersion && semver.gt(candidate.minimumVersion, candidate.version as string)) {
    throw new Error("Update minimumVersion cannot be newer than the release itself.");
  }
  if (candidate.artifactSize !== undefined && (!Number.isSafeInteger(candidate.artifactSize) || (candidate.artifactSize as number) < 1)) {
    throw new Error("Update metadata contains an invalid artifactSize.");
  }
  if (candidate.signature !== undefined) {
    if (!candidate.signature || typeof candidate.signature !== "object" || Array.isArray(candidate.signature)) {
      throw new Error("Update signature metadata is malformed.");
    }
    const signature = candidate.signature as Record<string, unknown>;
    if (typeof signature.algorithm !== "string" || !signature.algorithm.trim() || typeof signature.value !== "string" || !signature.value.trim()) {
      throw new Error("Update signature metadata is malformed.");
    }
  }

  return {
    schemaVersion: UPDATE_SCHEMA_VERSION,
    version: candidate.version,
    releaseDate: candidate.releaseDate,
    notes: (candidate.notes as string[]).map((note) => note.trim()),
    artifact: candidate.artifact.replaceAll("/", "\\"),
    sha256: String(candidate.sha256).toLowerCase(),
    ...(candidate.minimumVersion ? { minimumVersion: candidate.minimumVersion as string } : {}),
    ...(candidate.artifactSize ? { artifactSize: candidate.artifactSize as number } : {}),
    ...(candidate.signature ? { signature: candidate.signature as UpdateRelease["signature"] } : {}),
  };
}

function pathIsUnsafe(candidate: string) {
  const normalized = candidate.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => part === ".." || part === "");
}

export async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Confirms staged bytes are exactly the bytes the manifest describes.
 *
 * Shared by every provider: wherever an artifact came from, it is only ever
 * trusted after its size and SHA-256 match the manifest that was accepted.
 */
export async function verifyStagedArtifact(artifactPath: string, release: UpdateRelease) {
  const stat = await fs.promises.stat(artifactPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Staged update artifact is missing.");
    throw error;
  });
  if (!stat.isFile() || stat.size < 1) throw new Error("Staged update artifact is empty or invalid.");
  if (release.artifactSize && stat.size !== release.artifactSize) throw new Error("Staged update artifact size does not match its metadata.");
  const checksum = await sha256File(artifactPath);
  if (checksum !== release.sha256) throw new Error("Update artifact failed SHA-256 verification and was rejected.");
}

export function assertUpdateCompatibility(currentVersion: string, release: UpdateRelease) {
  if (!semver.valid(currentVersion)) throw new Error(`Installed Wheat version is not valid SemVer: ${currentVersion}.`);
  if (!semver.gt(release.version, currentVersion)) {
    if (semver.lt(release.version, currentVersion)) throw new Error(`Downgrade rejected: ${release.version} is older than ${currentVersion}.`);
    return false;
  }
  if (release.minimumVersion && semver.lt(currentVersion, release.minimumVersion)) {
    throw new Error(`Update ${release.version} requires Wheat ${release.minimumVersion} or newer.`);
  }
  return true;
}
