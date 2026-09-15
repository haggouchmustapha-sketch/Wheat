import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Connecting Wheat Cloud AI to the accountant's own provider account.
 *
 * The problem this solves is not technical, it is who pays and who consents.
 * Wheat ships no provider credential — not in the source, not in the installer,
 * not in a resource file, not in CI. There is no Wheat-owned key funding
 * everybody's usage, and there never will be. Equally, an accountant is not a
 * developer: asking them to create an account, find a dashboard, mint an API
 * key and paste it into a settings screen is a requirement most of them would
 * reasonably refuse.
 *
 * OpenRouter's OAuth PKCE flow resolves both. It is the provider's own
 * supported mechanism for desktop and CLI applications, it needs no client
 * secret and no registered application, it accepts a loopback callback on any
 * port, and the key it returns belongs to the user's account and is revocable
 * from it. Wheat opens the system browser, the person authorises, and a key
 * that is theirs comes back.
 *
 *   Wheat                          system browser                  OpenRouter
 *     |  verifier + S256 challenge
 *     |  loopback server on 127.0.0.1:<free port>/<nonce>
 *     |-------- openExternal(/auth?callback_url&code_challenge) ------->|
 *     |                                   user authorises              |
 *     |<---------------- GET /<nonce>?code=... -------------------------|
 *     |-- POST /api/v1/auth/keys { code, code_verifier } ------------->|
 *     |<------------------------ { key } ------------------------------|
 *     |  stored through the OS credential vault, never in the renderer
 *
 * Security properties this file is responsible for:
 *
 *  - **PKCE S256.** The verifier never leaves this process until it is
 *    exchanged, and the challenge is a SHA-256 of it. An authorisation code
 *    intercepted on the way back is useless without the verifier.
 *  - **Loopback only.** The callback server binds 127.0.0.1, never a routable
 *    interface, and lives only for the duration of one authorisation.
 *  - **A nonce in the callback path.** Anything arriving on any other path is
 *    answered 404 and ignored, so a stray request from another page open in the
 *    same browser cannot complete somebody else's flow.
 *  - **Nothing is logged.** The code and the key never reach a log line, an
 *    error message, a diagnostic file or an IPC payload.
 *
 * Nothing here scrapes a page, drives a dashboard, reuses an unrelated token or
 * creates an account on the user's behalf. If a provider ever stops supporting
 * a flow of this shape, the honest answer is to say so — not to automate a
 * browser against it.
 */

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

/** How long the browser round-trip may take before the server is torn down. */
export const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init?: any) => Promise<any>;

export class CloudAuthorizationError extends Error {
  readonly kind: "CANCELLED" | "TIMEOUT" | "PROVIDER_REFUSED" | "NETWORK" | "MALFORMED";

  constructor(kind: CloudAuthorizationError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudAuthorizationError";
    this.kind = kind;
  }
}

export type PkcePair = { verifier: string; challenge: string };

/**
 * A fresh verifier and its S256 challenge.
 *
 * 32 random bytes in base64url is 43 characters — the shortest length RFC 7636
 * permits, and the one with no padding to strip.
 */
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** The page the browser lands on. Deliberately static, and never echoes input. */
const COMPLETION_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Wheat</title>
<style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#f6efe7;color:#241a14;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .6rem}p{margin:0;color:#5d4a3e}</style></head>
<body><main><h1>Wheat Cloud AI est connecté.</h1><p>Vous pouvez fermer cet onglet et revenir à Wheat : votre lecture de document reprend automatiquement.</p></main></body></html>`;

type LoopbackCallback = {
  callbackUrl: string;
  /** Resolves with the authorisation code, or rejects with a typed error. */
  code: Promise<string>;
  close(): void;
};

/**
 * Listens on a free loopback port for exactly one authorisation callback.
 *
 * Started *before* the browser is opened, so there is no window in which the
 * provider could redirect to a port nothing is listening on.
 */
export async function startLoopbackCallback(timeoutMs = AUTHORIZATION_TIMEOUT_MS): Promise<LoopbackCallback> {
  const nonce = crypto.randomBytes(16).toString("hex");
  const path = `/${nonce}`;

  let settle: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });

  const server = http.createServer((request, response) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname !== path) {
      // Anything that is not this authorisation is not answered at all.
      response.writeHead(404).end();
      return;
    }
    const received = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(COMPLETION_PAGE);
    if (received) settle.resolve(received);
    else settle.reject(new CloudAuthorizationError("PROVIDER_REFUSED", error
      ? "L'autorisation a été refusée par le fournisseur."
      : "L'autorisation s'est terminée sans code."));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => {
    settle.reject(new CloudAuthorizationError("TIMEOUT", "La connexion à Wheat Cloud AI a expiré avant votre autorisation."));
  }, timeoutMs);
  timer.unref?.();

  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  // Whatever the outcome, the listener does not outlive the authorisation.
  void code.then(close, close);

  return { callbackUrl: `http://127.0.0.1:${port}${path}`, code, close };
}

/**
 * Exchanges the authorisation code for the user's own API key.
 *
 * Neither the code nor the key is ever included in a thrown message: a failure
 * says what went wrong, never with what value.
 */
export async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  input: { code: string; verifier: string },
  timeoutMs = EXCHANGE_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: any;
  try {
    response = await fetchImpl(KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: input.code, code_verifier: input.verifier, code_challenge_method: "S256" }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CloudAuthorizationError("NETWORK", "Wheat n'a pas pu joindre le service d'autorisation. Vérifiez votre connexion et réessayez.", { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (!response?.ok) {
    throw new CloudAuthorizationError(
      "PROVIDER_REFUSED",
      `Le fournisseur a refusé la demande d'autorisation (code ${Number(response?.status) || 0}). Relancez la connexion depuis Wheat.`,
    );
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CloudAuthorizationError("MALFORMED", "La réponse du service d'autorisation est illisible.", { cause: error });
  }
  const key = typeof payload?.key === "string" ? payload.key.trim() : "";
  if (!key) throw new CloudAuthorizationError("MALFORMED", "Le service d'autorisation n'a pas renvoyé de clé utilisable.");
  return key;
}

export type AuthorizeOptions = {
  /** Opens a URL in the *system* browser. Never a Wheat window. */
  openExternal: (url: string) => Promise<void> | void;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/**
 * Runs the whole authorisation and returns the user's key.
 *
 * The caller stores it — through the OS credential vault, in the main process.
 * This function keeps it in memory for exactly as long as it takes to hand it
 * over, and the value is never returned across IPC.
 */
export async function authorizeCloudProvider(options: AuthorizeOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: any) => (globalThis as any).fetch(url, init));
  const { verifier, challenge } = createPkcePair();
  const callback = await startLoopbackCallback(options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS);
  try {
    await options.openExternal(buildAuthorizationUrl(callback.callbackUrl, challenge));
    const code = await callback.code;
    return await exchangeAuthorizationCode(fetchImpl, { code, verifier }, EXCHANGE_TIMEOUT_MS);
  } finally {
    callback.close();
  }
}
