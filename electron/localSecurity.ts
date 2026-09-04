import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const LOCAL_SECURITY_IPC_CHANNELS = {
  status: "wheat:security:status",
  setup: "wheat:security:setup",
  disable: "wheat:security:disable",
  unlock: "wheat:security:unlock",
  lock: "wheat:security:lock",
  touch: "wheat:security:touch",
} as const;

const SETTINGS_ID = "local";
const PIN_MIN_LENGTH = 6;
const PIN_MAX_LENGTH = 64;
const SALT_BYTES = 32;
const DEFAULT_KEY_LENGTH = 64;
const MIN_KEY_LENGTH = 32;
const MAX_KEY_LENGTH = 128;
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const THROTTLE_BASE_MS = 1_000;
const THROTTLE_MAX_MS = 5 * 60 * 1_000;
const MAX_IDLE_MINUTES = 24 * 60;

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;

type RegisterableIpc = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => any): unknown;
};

type SecuritySettings = {
  id: string;
  enabled: boolean;
  pinSalt: string | null;
  pinHash: string | null;
  pinKeyLength: number;
  idleMinutes: number;
  lockOnStartup: boolean;
  failedAttempts: number;
  lockedUntil: Date | string | null;
  updatedAt?: Date | string;
};

export type LocalSecurityStatus = {
  enabled: boolean;
  locked: boolean;
  lockOnStartup: boolean;
  idleMinutes: number;
  failedAttempts: number;
  throttled: boolean;
  retryAfterMs: number;
  lockedUntil: string | null;
  idleDeadline: string | null;
  configurationError: boolean;
  scope: "LOCAL_APP_LOCK";
};

export type LocalSecurityServiceOptions = {
  getPrisma: GetPrisma;
  now?: () => Date;
  random?: (size: number) => Buffer;
};

export type LocalSecurityRegistrationOptions = LocalSecurityServiceOptions & {
  ipcMain: RegisterableIpc;
  serialize?: (value: any) => any;
};

export class LocalSecurityError extends Error {
  code: string;
  retryAfterMs: number;

  constructor(code: string, message: string, retryAfterMs = 0) {
    super(message);
    this.name = "LocalSecurityError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  return value as Record<string, unknown>;
}

function normalizedPin(value: unknown, label = "Le code PIN"): string {
  if (typeof value !== "string") throw new Error(`${label} est obligatoire.`);
  if (value !== value.trim()) throw new Error(`${label} ne peut pas commencer ou finir par un espace.`);
  const normalized = value.normalize("NFKC");
  const length = [...normalized].length;
  if (length < PIN_MIN_LENGTH || length > PIN_MAX_LENGTH) {
    throw new Error(`${label} doit contenir entre ${PIN_MIN_LENGTH} et ${PIN_MAX_LENGTH} caractères.`);
  }
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} contient un caractère de contrôle interdit.`);
  return normalized;
}

function idleMinutes(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_IDLE_MINUTES) {
    throw new Error(`Le délai d'inactivité doit être un nombre entier compris entre 0 et ${MAX_IDLE_MINUTES} minutes.`);
  }
  return value;
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} est invalide.`);
  return value;
}

function dateMilliseconds(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : null;
  } catch {
    return null;
  }
}

function configuration(settings: SecuritySettings): { valid: boolean; salt: Buffer | null; hash: Buffer | null } {
  if (!settings.enabled) return { valid: true, salt: null, hash: null };
  if (!Number.isSafeInteger(settings.pinKeyLength) || settings.pinKeyLength < MIN_KEY_LENGTH || settings.pinKeyLength > MAX_KEY_LENGTH) {
    return { valid: false, salt: null, hash: null };
  }
  if (!settings.pinSalt || !settings.pinHash) return { valid: false, salt: null, hash: null };
  const salt = decodeBase64(settings.pinSalt);
  const hash = decodeBase64(settings.pinHash);
  if (!salt || salt.length < 16 || !hash || hash.length !== settings.pinKeyLength) {
    return { valid: false, salt: null, hash: null };
  }
  return { valid: true, salt, hash };
}

function scryptHash(pin: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, keyLength, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function throttleDelay(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(20, failedAttempts - 1));
  return Math.min(THROTTLE_MAX_MS, THROTTLE_BASE_MS * 2 ** exponent);
}

async function ensureSettings(prisma: PrismaLike): Promise<SecuritySettings> {
  return prisma.localAppSecurity.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: {
      id: SETTINGS_ID,
      enabled: false,
      pinKeyLength: DEFAULT_KEY_LENGTH,
      idleMinutes: 15,
      lockOnStartup: false,
      failedAttempts: 0,
    },
  });
}

export function createLocalSecurityService(options: LocalSecurityServiceOptions) {
  const now = () => options.now?.() ?? new Date();
  const secureRandom = options.random ?? randomBytes;
  let initialized = false;
  let sessionLocked = false;
  let lastActivityAt = 0;

  function initializeSession(settings: SecuritySettings, currentTime: number) {
    if (!initialized) {
      const persistedFailure = settings.failedAttempts > 0 || (dateMilliseconds(settings.lockedUntil) ?? 0) > currentTime;
      sessionLocked = settings.enabled && (settings.lockOnStartup || persistedFailure);
      lastActivityAt = currentTime;
      initialized = true;
    }
    if (!settings.enabled) sessionLocked = false;
  }

  function applyIdleLock(settings: SecuritySettings, currentTime: number) {
    if (!settings.enabled || sessionLocked || settings.idleMinutes <= 0) return;
    if (currentTime - lastActivityAt >= settings.idleMinutes * 60_000) sessionLocked = true;
  }

  function publicStatus(settings: SecuritySettings, currentTime: number): LocalSecurityStatus {
    const lockedUntilMs = dateMilliseconds(settings.lockedUntil);
    const retryAfterMs = lockedUntilMs ? Math.max(0, Math.ceil(lockedUntilMs - currentTime)) : 0;
    const config = configuration(settings);
    const locked = settings.enabled && (sessionLocked || !config.valid);
    return {
      enabled: settings.enabled,
      locked,
      lockOnStartup: settings.lockOnStartup,
      idleMinutes: settings.idleMinutes,
      failedAttempts: settings.failedAttempts,
      throttled: retryAfterMs > 0,
      retryAfterMs,
      lockedUntil: retryAfterMs > 0 && lockedUntilMs ? new Date(lockedUntilMs).toISOString() : null,
      idleDeadline: settings.enabled && !locked && settings.idleMinutes > 0
        ? new Date(lastActivityAt + settings.idleMinutes * 60_000).toISOString()
        : null,
      configurationError: settings.enabled && !config.valid,
      scope: "LOCAL_APP_LOCK",
    };
  }

  async function readState() {
    const prisma = await options.getPrisma();
    const settings = await ensureSettings(prisma);
    const currentTime = now().getTime();
    initializeSession(settings, currentTime);
    applyIdleLock(settings, currentTime);
    return { prisma, settings, currentTime };
  }

  async function recordFailedPin(prisma: PrismaLike, settings: SecuritySettings, currentTime: number): Promise<never> {
    const attempts = Math.min(1_000_000, settings.failedAttempts + 1);
    const retryAfterMs = throttleDelay(attempts);
    const lockedUntil = new Date(currentTime + retryAfterMs);
    const result = await prisma.localAppSecurity.updateMany({
      where: {
        id: SETTINGS_ID,
        enabled: true,
        failedAttempts: settings.failedAttempts,
        pinHash: settings.pinHash,
      },
      data: { failedAttempts: attempts, lockedUntil },
    });
    sessionLocked = true;
    if (result.count !== 1) {
      throw new LocalSecurityError("WHEAT_SECURITY_RETRY", "L'état du verrou a changé. Réessayez.", THROTTLE_BASE_MS);
    }
    throw new LocalSecurityError("WHEAT_PIN_INVALID", "Code PIN incorrect.", retryAfterMs);
  }

  async function verifyCurrentPin(prisma: PrismaLike, settings: SecuritySettings, pin: string, currentTime: number) {
    const lockedUntilMs = dateMilliseconds(settings.lockedUntil);
    if (lockedUntilMs && lockedUntilMs > currentTime) {
      throw new LocalSecurityError(
        "WHEAT_SECURITY_THROTTLED",
        "Trop de tentatives. Attendez avant de réessayer.",
        Math.ceil(lockedUntilMs - currentTime),
      );
    }
    const config = configuration(settings);
    if (!config.valid || !config.salt || !config.hash) {
      sessionLocked = true;
      throw new LocalSecurityError("WHEAT_SECURITY_CONFIGURATION", "La configuration du verrou local est invalide. Restaurez une sauvegarde fiable.");
    }
    const candidate = await scryptHash(pin, config.salt, settings.pinKeyLength);
    if (candidate.length !== config.hash.length || !timingSafeEqual(candidate, config.hash)) {
      return recordFailedPin(prisma, settings, currentTime);
    }
    const reset = await prisma.localAppSecurity.updateMany({
      where: { id: SETTINGS_ID, enabled: true, pinHash: settings.pinHash },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    if (reset.count !== 1) {
      sessionLocked = true;
      throw new LocalSecurityError("WHEAT_SECURITY_RETRY", "La configuration du verrou a changé. Réessayez.");
    }
  }

  const service = {
    async status(): Promise<LocalSecurityStatus> {
      const { settings, currentTime } = await readState();
      return publicStatus(settings, currentTime);
    },

    async setup(payload: unknown): Promise<LocalSecurityStatus> {
      const input = inputRecord(payload, "La configuration du verrou");
      const pin = normalizedPin(input.newPin ?? input.pin, "Le nouveau code PIN");
      const prisma = await options.getPrisma();
      const settings = await ensureSettings(prisma);
      const currentTime = now().getTime();
      initializeSession(settings, currentTime);

      if (settings.enabled) {
        const currentPin = normalizedPin(input.currentPin, "Le code PIN actuel");
        await verifyCurrentPin(prisma, settings, currentPin, currentTime);
      }

      const configuredIdleMinutes = idleMinutes(input.idleMinutes, settings.idleMinutes);
      const configuredLockOnStartup = booleanValue(input.lockOnStartup, settings.lockOnStartup, "Le verrouillage au démarrage");
      const salt = secureRandom(SALT_BYTES);
      if (!Buffer.isBuffer(salt) || salt.length < 16) throw new Error("La source aléatoire du verrou local est invalide.");
      const hash = await scryptHash(pin, salt, DEFAULT_KEY_LENGTH);
      await prisma.localAppSecurity.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          enabled: true,
          pinSalt: salt.toString("base64"),
          pinHash: hash.toString("base64"),
          pinKeyLength: DEFAULT_KEY_LENGTH,
          idleMinutes: configuredIdleMinutes,
          lockOnStartup: configuredLockOnStartup,
          failedAttempts: 0,
          lockedUntil: null,
        },
        update: {
          enabled: true,
          pinSalt: salt.toString("base64"),
          pinHash: hash.toString("base64"),
          pinKeyLength: DEFAULT_KEY_LENGTH,
          idleMinutes: configuredIdleMinutes,
          lockOnStartup: configuredLockOnStartup,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      initialized = true;
      sessionLocked = false;
      lastActivityAt = currentTime;
      return service.status();
    },

    async disable(payload: unknown): Promise<LocalSecurityStatus> {
      const input = inputRecord(payload, "La demande de désactivation");
      const prisma = await options.getPrisma();
      const settings = await ensureSettings(prisma);
      const currentTime = now().getTime();
      initializeSession(settings, currentTime);
      if (!settings.enabled) return publicStatus(settings, currentTime);
      const pin = normalizedPin(input.pin, "Le code PIN actuel");
      await verifyCurrentPin(prisma, settings, pin, currentTime);
      const result = await prisma.localAppSecurity.updateMany({
        where: { id: SETTINGS_ID, enabled: true, pinHash: settings.pinHash },
        data: {
          enabled: false,
          pinSalt: null,
          pinHash: null,
          pinKeyLength: DEFAULT_KEY_LENGTH,
          lockOnStartup: false,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      if (result.count !== 1) throw new LocalSecurityError("WHEAT_SECURITY_RETRY", "La configuration du verrou a changé. Réessayez.");
      initialized = true;
      sessionLocked = false;
      lastActivityAt = currentTime;
      return service.status();
    },

    async unlock(payload: unknown): Promise<LocalSecurityStatus> {
      const input = inputRecord(payload, "La demande de déverrouillage");
      const { prisma, settings, currentTime } = await readState();
      if (!settings.enabled) return publicStatus(settings, currentTime);
      if (!sessionLocked && configuration(settings).valid) {
        lastActivityAt = currentTime;
        return publicStatus(settings, currentTime);
      }
      const pin = normalizedPin(input.pin);
      await verifyCurrentPin(prisma, settings, pin, currentTime);
      sessionLocked = false;
      lastActivityAt = currentTime;
      return service.status();
    },

    async lock(): Promise<LocalSecurityStatus> {
      const { settings, currentTime } = await readState();
      if (settings.enabled) sessionLocked = true;
      return publicStatus(settings, currentTime);
    },

    async touch(): Promise<LocalSecurityStatus> {
      const { settings, currentTime } = await readState();
      if (settings.enabled && !sessionLocked && configuration(settings).valid) lastActivityAt = currentTime;
      return publicStatus(settings, currentTime);
    },

    async assertUnlocked(): Promise<LocalSecurityStatus> {
      const status = await service.status();
      if (status.enabled && status.locked) {
        const code = status.throttled ? "WHEAT_SECURITY_THROTTLED" : "WHEAT_APP_LOCKED";
        throw new LocalSecurityError(code, "Wheat est verrouillé localement.", status.retryAfterMs);
      }
      return status;
    },

    async resetAfterDatabaseReplacement(): Promise<LocalSecurityStatus> {
      const prisma = await options.getPrisma();
      const settings = await ensureSettings(prisma);
      const currentTime = now().getTime();
      initialized = true;
      sessionLocked = settings.enabled;
      lastActivityAt = currentTime;
      return publicStatus(settings, currentTime);
    },

    guard<T extends (...args: any[]) => any>(handler: T) {
      return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
        await service.assertUnlocked();
        await service.touch();
        return handler(...args);
      };
    },
  };

  return service;
}

export type LocalSecurityService = ReturnType<typeof createLocalSecurityService>;

export async function assertUnlocked(service: Pick<LocalSecurityService, "assertUnlocked">) {
  return service.assertUnlocked();
}

export function guard<T extends (...args: any[]) => any>(service: Pick<LocalSecurityService, "guard">, handler: T) {
  return service.guard(handler);
}

export function registerLocalSecurityIpc(options: LocalSecurityRegistrationOptions) {
  const service = createLocalSecurityService(options);
  const serialize = options.serialize ?? ((value: any) => value);
  const bind = (channel: string, handler: (payload?: unknown) => Promise<unknown>) => {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  };
  bind(LOCAL_SECURITY_IPC_CHANNELS.status, () => service.status());
  bind(LOCAL_SECURITY_IPC_CHANNELS.setup, (payload) => service.setup(payload));
  bind(LOCAL_SECURITY_IPC_CHANNELS.disable, (payload) => service.disable(payload));
  bind(LOCAL_SECURITY_IPC_CHANNELS.unlock, (payload) => service.unlock(payload));
  bind(LOCAL_SECURITY_IPC_CHANNELS.lock, () => service.lock());
  bind(LOCAL_SECURITY_IPC_CHANNELS.touch, () => service.touch());
  return service;
}
