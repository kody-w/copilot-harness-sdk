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
 * @param {{ clientId: string, tenantId: string, cloud?: import('../url.js').SupportedCloud, scopes?: string[], onDeviceCode?: (message: string) => void }} opts
 * @param {{ pcaFactory?: (config: any) => any, now?: () => number }} [deps] test seam
 * @returns {() => Promise<string>}
 */
export function createDeviceCodeTokenProvider({ clientId, tenantId, cloud = 'Prod', scopes, onDeviceCode }, deps = {}) {
  if (!clientId || !tenantId) throw new Error('createDeviceCodeTokenProvider requires clientId and tenantId.');
  const requestScopes = scopes || [powerPlatformScope(cloud)];
  const now = deps.now || Date.now;
  /** @type {any} */
  let pca;
  async function getPca() {
    if (pca) return pca;
    if (deps.pcaFactory) {
      pca = deps.pcaFactory({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` } });
    } else {
      const { PublicClientApplication } = await import('@azure/msal-node');
      pca = new PublicClientApplication({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` } });
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
