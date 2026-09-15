const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * Connecting Wheat Cloud AI to the accountant's own provider account.
 *
 * Nothing here reaches OpenRouter: the browser is a `fetch` against the local
 * callback server, and the token exchange is an injected `fetchImpl`. What is
 * actually being pinned down is the security shape of the flow — PKCE, a
 * loopback-only listener, a nonce in the callback path, and the absence of any
 * Wheat-owned credential anywhere in it.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let authorization;

test.beforeAll(() => {
  authorization = tsxRequire(path.join(root, "electron", "cloudAuthorization.ts"), __filename);
});

/* -------------------------------------------------------------------- PKCE */

test("the verifier is fresh every time and the challenge is its SHA-256", () => {
  const first = authorization.createPkcePair();
  const second = authorization.createPkcePair();
  expect(first.verifier).not.toBe(second.verifier);
  // RFC 7636 permits 43-128 characters; base64url of 32 bytes is 43 with no
  // padding to strip.
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.challenge).toBe(crypto.createHash("sha256").update(first.verifier).digest("base64url"));
  // The challenge is a hash, so it must never be the verifier itself — the
  // whole point is that an intercepted code cannot be exchanged without it.
  expect(first.challenge).not.toBe(first.verifier);
});

test("the authorisation URL is the provider's documented one, with S256", () => {
  const url = new URL(authorization.buildAuthorizationUrl("http://127.0.0.1:51423/abc", "CHALLENGE"));
  expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
  expect(url.searchParams.get("callback_url")).toBe("http://127.0.0.1:51423/abc");
  expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  // No client identifier and no secret: Wheat is not a registered application
  // and holds no credential of its own in this flow.
  expect(url.searchParams.get("client_id")).toBeNull();
  expect(url.searchParams.get("client_secret")).toBeNull();
});

/* -------------------------------------------------------- loopback listener */

test("the callback listens on loopback only, on a random path", async () => {
  const callback = await authorization.startLoopbackCallback(5_000);
  try {
    const url = new URL(callback.callbackUrl);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    // A nonce in the path, so a stray request from another page open in the
    // same browser cannot complete somebody else's authorisation.
    expect(url.pathname).toMatch(/^\/[0-9a-f]{32}$/);
  } finally {
    callback.close();
  }
});

test("only the nonce path completes the authorisation", async () => {
  const callback = await authorization.startLoopbackCallback(5_000);
  const url = new URL(callback.callbackUrl);
  try {
    const wrong = await request(`http://127.0.0.1:${url.port}/not-the-nonce?code=stolen`);
    expect(wrong.status).toBe(404);

    const root = await request(`http://127.0.0.1:${url.port}/?code=stolen`);
    expect(root.status).toBe(404);

    // The real callback is accepted and answers a page, not the code.
    const accepted = await request(`${callback.callbackUrl}?code=the-real-code`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).not.toContain("the-real-code");
    expect(await callback.code).toBe("the-real-code");
  } finally {
    callback.close();
  }
});

test("a provider refusal is reported as a refusal, not as a code", async () => {
  const callback = await authorization.startLoopbackCallback(5_000);
  try {
    await request(`${callback.callbackUrl}?error=access_denied`);
    await expect(callback.code).rejects.toThrow(/refus/i);
  } finally {
    callback.close();
  }
});

test("the listener does not outlive the authorisation", async () => {
  const callback = await authorization.startLoopbackCallback(5_000);
  const { port } = new URL(callback.callbackUrl);
  await request(`${callback.callbackUrl}?code=done`);
  await callback.code;
  // Settling closes the server; a second request finds nothing listening.
  await expect(request(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});

test("an authorisation nobody completes expires instead of waiting forever", async () => {
  const callback = await authorization.startLoopbackCallback(120);
  await expect(callback.code).rejects.toThrow(/expir/i);
  callback.close();
});

/* ------------------------------------------------------------- key exchange */

test("the exchange posts the code and the verifier, and nothing else", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ key: "sk-or-v1-theusersownkey" }) };
  };
  const key = await authorization.exchangeAuthorizationCode(fetchImpl, { code: "CODE", verifier: "VERIFIER" });
  expect(key).toBe("sk-or-v1-theusersownkey");
  expect(seen.url).toBe("https://openrouter.ai/api/v1/auth/keys");
  expect(seen.method).toBe("POST");
  expect(seen.body).toEqual({ code: "CODE", code_verifier: "VERIFIER", code_challenge_method: "S256" });
  // No Authorization header: there is no Wheat credential to present.
  expect(Object.keys(seen.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
});

test("a refused exchange never echoes the code back in its message", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "code expired" }) });
  const error = await exchangeError(fetchImpl, { code: "SECRET-CODE-VALUE", verifier: "SECRET-VERIFIER" });
  expect(error.kind).toBe("PROVIDER_REFUSED");
  expect(error.message).not.toContain("SECRET-CODE-VALUE");
  expect(error.message).not.toContain("SECRET-VERIFIER");
});

test("a reply with no key is malformed, not a successful connection", async () => {
  for (const payload of [{}, { key: "" }, { key: 42 }, { token: "x" }]) {
    const error = await exchangeError(async () => ({ ok: true, status: 200, json: async () => payload }), { code: "c", verifier: "v" });
    expect(error.kind).toBe("MALFORMED");
  }
});

test("an unreachable provider is a network failure the user can retry", async () => {
  const error = await exchangeError(async () => { throw new Error("getaddrinfo ENOTFOUND"); }, { code: "c", verifier: "v" });
  expect(error.kind).toBe("NETWORK");
  expect(error.message).toMatch(/connexion/i);
});

/* ----------------------------------------------------- the whole flow ------ */

test("the flow opens the system browser and returns the user's own key", async () => {
  let opened = "";
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ key: "sk-or-v1-abcdefghijklmnop" }) });
  const key = await authorization.authorizeCloudProvider({
    fetchImpl,
    timeoutMs: 5_000,
    openExternal: async (url) => {
      opened = url;
      // Stand in for the browser: the provider redirects to the callback.
      const callbackUrl = new URL(url).searchParams.get("callback_url");
      await request(`${callbackUrl}?code=returned-code`);
    },
  });
  expect(key).toBe("sk-or-v1-abcdefghijklmnop");
  expect(opened.startsWith("https://openrouter.ai/auth?")).toBe(true);
  expect(new URL(opened).searchParams.get("code_challenge_method")).toBe("S256");
});

/* -------------------------------------------------- no shipped credential -- */

test("no provider credential is present anywhere in the shipped source", () => {
  /*
   * The non-negotiable one. Wheat must never ship a key that funds everybody's
   * usage: not in source, not in a resource, not in an env file that travels
   * with the build. Cloud usage is the user's own account, or it does not
   * happen.
   */
  const searched = [
    path.join(root, "electron"),
    path.join(root, "src"),
    path.join(root, "scripts"),
    path.join(root, "resources", "models"),
  ];
  const patterns = [/sk-or-v1-[A-Za-z0-9]{16,}/, /gsk_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{32,}/];
  const offenders = [];
  for (const directory of searched) {
    for (const file of walk(directory)) {
      const source = fs.readFileSync(file, "utf8");
      if (patterns.some((pattern) => pattern.test(source))) offenders.push(path.relative(root, file));
    }
  }
  expect(offenders).toEqual([]);

  // And the packaging config ships no environment file that could carry one.
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packaged = JSON.stringify(packageJson.build.files) + JSON.stringify(packageJson.build.extraResources);
  expect(packaged).not.toMatch(/\.env/);
});

function walk(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (/\.(ts|tsx|mjs|cjs|js|json)$/.test(entry.name)) files.push(target);
  }
  return files;
}

async function exchangeError(fetchImpl, input) {
  try {
    await authorization.exchangeAuthorizationCode(fetchImpl, input);
  } catch (error) {
    return error;
  }
  throw new Error("exchangeAuthorizationCode resolved where it should have refused.");
}

function request(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.get({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}` }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
  });
}
