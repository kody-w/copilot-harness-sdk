// @ts-check
/**
 * Entra token providers for the Copilot Studio modes.
 *
 * A token provider is just `() => Promise<string>`; bring your own (MSAL in a
 * browser, Azure Identity, a relay that forwards a user's delegated token) or
 * use these helpers, which cover the two shapes this repository has exercised:
 *
 *   - delegated user token via device code (public client, no secret)
 *   - app-only token via client credentials (S2S private preview; no-auth agents only)
 */
import { PublicClientApplication, ConfidentialClientApplication } from '@azure/msal-node';
import { powerPlatformScope } from '../url.js';

const REFRESH_SKEW_MS = 60 * 1000;

/**
 * @param {string} token
 * @returns {() => Promise<string>}
 */
export function staticToken(token) {
  if (!token) throw new Error('staticToken requires a non-empty token.');
  return async () => token;
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
 * @returns {() => Promise<string>}
 */
export function createDeviceCodeTokenProvider({ clientId, tenantId, cloud = 'Prod', scopes, onDeviceCode }) {
  if (!clientId || !tenantId) throw new Error('createDeviceCodeTokenProvider requires clientId and tenantId.');
  const requestScopes = scopes || [powerPlatformScope(cloud)];
  const pca = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` }
  });
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;
  /** @type {Promise<string> | undefined} */
  let pending;

  async function acquire() {
    const accounts = await pca.getTokenCache().getAllAccounts();
    if (accounts.length) {
      try {
        const silent = await pca.acquireTokenSilent({ account: accounts[0], scopes: requestScopes });
        if (silent?.accessToken) return remember(silent);
      } catch {
        // fall through to device code
      }
    }
    const result = await pca.acquireTokenByDeviceCode({
      scopes: requestScopes,
      deviceCodeCallback: (info) => (onDeviceCode || ((m) => process.stderr.write(m + '\n')))(info.message)
    });
    if (!result?.accessToken) throw new Error('Device-code sign-in did not return an access token.');
    return remember(result);
  }

  /** @param {{ accessToken: string, expiresOn?: Date | null }} result */
  function remember(result) {
    cached = { value: result.accessToken, expiresAt: result.expiresOn?.getTime() || Date.now() + 5 * 60 * 1000 };
    return cached.value;
  }

  return async () => {
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached.value;
    if (!pending) pending = acquire().finally(() => (pending = undefined));
    return pending;
  };
}

/**
 * App-only token via client credentials. Only meaningful for the S2S
 * private-preview mode against a No Authentication agent.
 *
 * @param {{ clientId: string, tenantId: string, clientSecret: string, cloud?: import('../url.js').SupportedCloud, scopes?: string[] }} opts
 * @returns {() => Promise<string>}
 */
export function createClientCredentialTokenProvider({ clientId, tenantId, clientSecret, cloud = 'Prod', scopes }) {
  if (!clientId || !tenantId || !clientSecret) {
    throw new Error('createClientCredentialTokenProvider requires clientId, tenantId and clientSecret.');
  }
  const requestScopes = scopes || [powerPlatformScope(cloud)];
  const cca = new ConfidentialClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientSecret }
  });
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;
  /** @type {Promise<string> | undefined} */
  let pending;

  async function acquire() {
    const result = await cca.acquireTokenByClientCredential({ scopes: requestScopes });
    if (!result?.accessToken) throw new Error('Entra did not return an app-only access token.');
    cached = { value: result.accessToken, expiresAt: result.expiresOn?.getTime() || Date.now() + 5 * 60 * 1000 };
    return cached.value;
  }

  return async () => {
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached.value;
    if (!pending) pending = acquire().finally(() => (pending = undefined));
    return pending;
  };
}
