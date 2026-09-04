import fs from "node:fs";
import path from "node:path";

/**
 * Wheat AI secret storage.
 *
 * API keys are written only through the operating system's own credential
 * encryption (Electron's `safeStorage`, which wraps DPAPI on Windows, Keychain
 * on macOS and the desktop keyring on Linux). The ciphertext lands in a
 * 0600 file inside the application profile directory.
 *
 * Hard rules enforced here:
 *   - a key is NEVER written in plaintext; if `safeStorage` is unavailable the
 *     write is refused with an explicit error rather than silently downgraded;
 *   - a key is NEVER logged, returned to the renderer, or included in an error
 *     message — only a masked fingerprint (`sk-or…4f2a`) ever leaves this file;
 *   - decrypted material stays inside the main process.
 */

export type ProviderId = "openrouter" | "groq";

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type StoredSecretRecord = {
  /** Base64 of the OS-encrypted ciphertext. Never the key itself. */
  ciphertext: string;
  maskedKey: string;
  updatedAt: string;
};

type SecretFile = {
  version: 1;
  secrets: Partial<Record<ProviderId, StoredSecretRecord>>;
};

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      "Le coffre-fort du système d'exploitation n'est pas disponible sur ce poste. Wheat refusé d'enregistrer une clé d'API en clair : réessayez après avoir ouvert une session utilisateur normale.",
    );
    this.name = "SecureStorageUnavailableError";
  }
}

/**
 * A *new* empty vault every time. This must never be a shared constant: a
 * shallow copy would hand every store the same `secrets` object, so writing a
 * key in one store would silently appear in another — and a deleted key could
 * come back.
 */
const emptyFile = (): SecretFile => ({ version: 1, secrets: {} });

/** Masks a key for display: first 5 and last 4 characters, never the middle. */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return `${"•".repeat(Math.max(4, trimmed.length))}`;
  return `${trimmed.slice(0, 5)}${"•".repeat(8)}${trimmed.slice(-4)}`;
}

/**
 * Shape validation only — the key is never sent anywhere at this stage, so a
 * mistyped key is caught before it reaches a provider.
 */
export function validateApiKeyShape(provider: ProviderId, apiKey: string): { ok: true } | { ok: false; message: string } {
  const value = apiKey.trim();
  if (!value) return { ok: false, message: "Entrez une clé d'API." };
  if (/\s/.test(value)) return { ok: false, message: "La clé ne doit pas contenir d'espace. Vérifiez le copier-coller." };
  if (value.length < 20) return { ok: false, message: "Cette clé semble trop courte pour etre valide." };
  if (value.length > 512) return { ok: false, message: "Cette clé est anormalement longue. Vérifiez le copier-coller." };
  if (!/^[\w.-]+$/.test(value)) return { ok: false, message: "Cette clé contient des caracteres inattendus. Vérifiez le copier-coller." };
  if (provider === "openrouter" && !value.startsWith("sk-or-")) {
    return { ok: false, message: "Une clé OpenRouter commence par « sk-or- ». Vérifiez que vous n'avez pas colle la clé d'un autre service." };
  }
  if (provider === "groq" && !value.startsWith("gsk_")) {
    return { ok: false, message: "Une clé Groq commence par « gsk_ ». Vérifiez que vous n'avez pas colle la clé d'un autre service." };
  }
  return { ok: true };
}

export class WheatAiSecretStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorageLike;

  constructor(options: { directory: string; safeStorage: SafeStorageLike; fileName?: string }) {
    this.filePath = path.join(options.directory, options.fileName ?? "wheat-ai-credentials.json");
    this.safeStorage = options.safeStorage;
  }

  isSecureStorageAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private read(): SecretFile {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SecretFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.secrets !== "object" || parsed.secrets === null) return emptyFile();
      return { version: 1, secrets: parsed.secrets };
    } catch {
      // A missing or unreadable vault behaves exactly like an empty one: the
      // user is asked for the key again rather than shown a decryption error.
      return emptyFile();
    }
  }

  private write(file: SecretFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows ignores POSIX modes; the profile directory ACL already applies.
    }
  }

  /** Stores a key. Throws rather than ever writing plaintext. */
  setKey(provider: ProviderId, apiKey: string): StoredSecretRecord {
    if (!this.isSecureStorageAvailable()) throw new SecureStorageUnavailableError();
    const value = apiKey.trim();
    const shape = validateApiKeyShape(provider, value);
    if (!shape.ok) throw new Error(shape.message);

    const ciphertext = this.safeStorage.encryptString(value).toString("base64");
    const record: StoredSecretRecord = {
      ciphertext,
      maskedKey: maskApiKey(value),
      updatedAt: new Date().toISOString(),
    };
    const file = this.read();
    file.secrets[provider] = record;
    this.write(file);
    return record;
  }

  deleteKey(provider: ProviderId): void {
    const file = this.read();
    if (!file.secrets[provider]) return;
    delete file.secrets[provider];
    this.write(file);
  }

  /** Metadata safe to hand to the renderer: masked key and timestamp only. */
  describe(provider: ProviderId): { configured: boolean; maskedKey: string | null; updatedAt: string | null } {
    const record = this.read().secrets[provider];
    if (!record) return { configured: false, maskedKey: null, updatedAt: null };
    return { configured: true, maskedKey: record.maskedKey, updatedAt: record.updatedAt ?? null };
  }

  /**
   * Returns the decrypted key. Main-process callers only — the value must never
   * be serialised across IPC, written to a log, or embedded in an error.
   */
  getKey(provider: ProviderId): string | null {
    const record = this.read().secrets[provider];
    if (!record) return null;
    if (!this.isSecureStorageAvailable()) throw new SecureStorageUnavailableError();
    try {
      const value = this.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64")).trim();
      return value || null;
    } catch {
      throw new Error(
        "La clé enregistrée pour ce fournisseur n'a pas pu etre déchiffrée sur ce poste. Supprimez-la puis saisissez-la a nouveau.",
      );
    }
  }

  configuredProviders(): ProviderId[] {
    const file = this.read();
    return (["openrouter", "groq"] as ProviderId[]).filter((provider) => Boolean(file.secrets[provider]));
  }
}
