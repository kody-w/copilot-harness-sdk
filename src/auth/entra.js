// @ts-check
/**
 * Entra token providers for the Copilot Studio modes.
 *
 * A token provider is just `() => Promise<string>`; bring your own (MSAL in a
 * browser, Azure Identity, a relay that forwards a user's delegated token) or
 * use these helpers, which cover the two shapes the playground exercised:
 *
 *   - delegated user token via device code (public client, no secret)
 *   - app-only token via client credentials (S2S private preview; no-auth agents only)
 *
 * Both cache the token, refresh 60 s before expiry, and share one in-flight
 * acquisition between concurrent callers.
 */
import { powerPlatformScope } from '../url.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REFRESH_SKEW_MS = 60 * 1000;
const FALLBACK_TTL_MS = 5 * 60 * 1000;

/**
 * @param {string} token
 * @returns {() => Promise<string>}
 */
export function staticToken(token) {
  if (!token) throw new Error('staticToken requires a non-empty token.');
  return async () => token;
}

/**
 * Shared cache/dedupe wrapper around an acquire function.
 * @param {() => Promise<{ accessToken: string, expiresOn?: Date | null }>} acquire
 * @param {() => number} now
 */
function cachedProvider(acquire, now) {
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;
  /** @type {Promise<string> | undefined} */
  let pending;
  return async () => {
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > now()) return cached.value;
    if (!pending) {
      pending = acquire()
        .then((result) => {
          if (!result?.accessToken) throw new Error('Entra did not return an access token.');
          cached = { value: result.accessToken, expiresAt: result.expiresOn?.getTime() || now() + FALLBACK_TTL_MS };
          return cached.value;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}

/**
 * Delegated token for the signed-in user via the device-code flow. Silent
 * acquisition is attempted first on later calls (MSAL in-memory cache).
 *
 * The app registration must be a public client (Mobile and desktop
 * applications platform, redirect http://localhost) holding the Power
 * Platform API delegated permission CopilotStudio.Copilots.Invoke.
 *
 * Pass `cacheFile` to persist MSAL's token cache (refresh token included) to that path, so later
 * processes acquire silently instead of asking the user to sign in again; the file is written with
 * owner-only permissions and holds credentials, so keep it out of repositories.
 *
 * @param {{ clientId: string, tenantId: string, cloud?: import('../url.js').SupportedCloud, scopes?: string[], onDeviceCode?: (message: string) => void, cacheFile?: string }} opts
 * Network calls retry transient failures (`retryingNetworkClient`), so a dropped connection while the user is
 * signing in does not end the sign-in.
 *
 * @param {{ pcaFactory?: (config: any) => any, now?: () => number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps] test seam
 * @returns {() => Promise<string>}
 */
export function createDeviceCodeTokenProvider({ clientId, tenantId, cloud = 'Prod', scopes, onDeviceCode, cacheFile }, deps = {}) {
  if (!clientId || !tenantId) throw new Error('createDeviceCodeTokenProvider requires clientId and tenantId.');
  const requestScopes = scopes || [powerPlatformScope(cloud)];
  const now = deps.now || Date.now;
  /** @type {any} */
  let pca;
  async function getPca() {
    if (pca) return pca;
    const config = { auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
      system: { networkClient: retryingNetworkClient({ fetchImpl: deps.fetchImpl, sleep: deps.sleep }) } };
    if (cacheFile) config.cache = { cachePlugin: fileCachePlugin(cacheFile) };
    if (deps.pcaFactory) {
      pca = deps.pcaFactory(config);
    } else {
      const { PublicClientApplication } = await import('@azure/msal-node');
      pca = new PublicClientApplication(config);
    }
    return pca;
  }

  return cachedProvider(async () => {
    const app = await getPca();
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length) {
      try {
        const silent = await app.acquireTokenSilent({ account: accounts[0], scopes: requestScopes });
        if (silent?.accessToken) return silent;
      } catch {
        // fall through to device code
      }
    }
    const result = await app.acquireTokenByDeviceCode({
      scopes: requestScopes,
      deviceCodeCallback: (/** @type {{ message: string }} */ info) => (onDeviceCode || ((m) => process.stderr.write(m + '\n')))(info.message)
    });
    if (!result?.accessToken) throw new Error('Device-code sign-in did not return an access token.');
    return result;
  }, now);
}

const TRANSIENT_STATUS = new Set([502, 503, 504]);

/**
 * MSAL network client that retries transient failures (a dropped connection, 502/503/504) with backoff.
 * MSAL's own client gives up on the first `fetch failed`, which ends a device-code sign-in the user may be
 * completing at that moment; the device code itself stays valid, so retrying the poll loses nothing.
 * HTTP answers (including the 400 `authorization_pending` polls) pass through untouched.
 *
 * @param {{ attempts?: number, baseDelayMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [opts]
 */
export function retryingNetworkClient({ attempts = 5, baseDelayMs = 1000, fetchImpl, sleep } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** @param {string} method @param {string} url @param {{ headers?: Record<string, string>, body?: string }} [options] */
  async function send(method, url, options = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      if (i) await wait(baseDelayMs * 2 ** (i - 1));
      let res;
      try {
        res = await doFetch(url, { method, headers: options.headers, body: method === 'POST' ? options.body : undefined });
      } catch (e) {
        lastError = e;
        continue;
      }
      if (TRANSIENT_STATUS.has(res.status) && i < attempts - 1) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { error: 'invalid_json', error_description: text.slice(0, 500) }; }
      /** @type {Record<string, string>} */
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { headers, body, status: res.status };
    }
    throw new Error(`network request failed after ${attempts} attempts: ${lastError?.message || lastError}`);
  }
  return {
    /** @param {string} url @param {any} [options] */
    sendGetRequestAsync: (url, options) => send('GET', url, options),
    /** @param {string} url @param {any} [options] */
    sendPostRequestAsync: (url, options) => send('POST', url, options)
  };
}

/**
 * MSAL cache plugin backed by one JSON file (owner read/write only).
 * @param {string} file
 */
export function fileCachePlugin(file) {
  return {
    /** @param {{ tokenCache: { deserialize: (s: string) => void } }} ctx */
    async beforeCacheAccess(ctx) {
      try { ctx.tokenCache.deserialize(readFileSync(file, 'utf8')); } catch { /* first run: no cache yet */ }
    },
    /** @param {{ cacheHasChanged: boolean, tokenCache: { serialize: () => string } }} ctx */
    async afterCacheAccess(ctx) {
      if (!ctx.cacheHasChanged) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, ctx.tokenCache.serialize(), { mode: 0o600 });
    }
  };
}

/**
 * Delegated token for the signed-in user through the browser (authorization code + PKCE on a loopback redirect).
 * Silent first, from the file cache, so only the first run shows a sign-in. For public clients whose registration
 * allows a loopback redirect (http://localhost), such as the managed apps git client the ms CLI configures.
 *
 * `openBrowser(url)` receives the sign-in URL: open it in any browser (or hand it to a browser driver).
 *
 * @param {{ clientId: string, tenantId: string, scopes: string[], loginHint?: string, cacheFile?: string, openBrowser?: (url: string) => Promise<void> }} opts
 * @param {{ pcaFactory?: (config: any) => any, now?: () => number }} [deps] test seam
 * @returns {() => Promise<string>}
 */
export function createInteractiveTokenProvider({ clientId, tenantId, scopes, loginHint, cacheFile, openBrowser }, deps = {}) {
  if (!clientId || !tenantId || !scopes?.length) throw new Error('createInteractiveTokenProvider requires clientId, tenantId and scopes.');
  const now = deps.now || Date.now;
  /** @type {any} */
  let pca;
  async function getPca() {
    if (pca) return pca;
    const config = { auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` } };
    if (cacheFile) config.cache = { cachePlugin: fileCachePlugin(cacheFile) };
    if (deps.pcaFactory) pca = deps.pcaFactory(config);
    else {
      const { PublicClientApplication } = await import('@azure/msal-node');
      pca = new PublicClientApplication(config);
    }
    return pca;
  }
  return cachedProvider(async () => {
    const app = await getPca();
    const accounts = await app.getTokenCache().getAllAccounts();
    const account = accounts.find((/** @type {any} */ a) => !loginHint || a.username?.toLowerCase() === loginHint.toLowerCase());
    if (account) {
      try {
        const silent = await app.acquireTokenSilent({ account, scopes });
        if (silent?.accessToken) return silent;
      } catch {
        // fall through to the browser
      }
    }
    const open = openBrowser || (async (/** @type {string} */ url) => {
      const { spawn } = await import('node:child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    });
    const result = await app.acquireTokenInteractive({
      scopes, loginHint, openBrowser: open,
      successTemplate: 'Signed in. You can close this tab.',
      errorTemplate: 'Sign-in failed. You can close this tab and try again.'
    });
    if (!result?.accessToken) throw new Error('Interactive sign-in did not return an access token.');
    return result;
  }, now);
}

/**
 * App-only token via client credentials. Only meaningful for the S2S
 * private-preview mode against a No Authentication agent.
 *
 * @param {{ clientId: string, tenantId: string, clientSecret: string, cloud?: import('../url.js').SupportedCloud, scopes?: string[] }} opts
 * @param {{ ccaFactory?: (config: any) => any, now?: () => number }} [deps] test seam
 * @returns {() => Promise<string>}
 */
export function createClientCredentialTokenProvider({ clientId, tenantId, clientSecret, cloud = 'Prod', scopes }, deps = {}) {
  if (!clientId || !tenantId || !clientSecret) {
    throw new Error('createClientCredentialTokenProvider requires clientId, tenantId and clientSecret.');
  }
  const requestScopes = scopes || [powerPlatformScope(cloud)];
  const now = deps.now || Date.now;
  /** @type {any} */
  let cca;
  async function getCca() {
    if (cca) return cca;
    const authConfig = { auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientSecret } };
    if (deps.ccaFactory) {
      cca = deps.ccaFactory(authConfig);
    } else {
      const { ConfidentialClientApplication } = await import('@azure/msal-node');
      cca = new ConfidentialClientApplication(authConfig);
    }
    return cca;
  }

  return cachedProvider(async () => {
    const app = await getCca();
    const result = await app.acquireTokenByClientCredential({ scopes: requestScopes });
    if (!result?.accessToken) throw new Error('Entra did not return an app-only access token.');
    return result;
  }, now);
}
