// @ts-check
/**
 * Power Platform host derivation and the Agentic Runtime URL shapes.
 *
 * The 30/2 GUID split and the `/3p` path come from Microsoft's experimental
 * copilot-studio-plugin (scripts/src/chat-with-agent.js) and were verified
 * live from this repository (README, 5 Aug 2026). The guard mirrors the
 * playground's ghcp3p-url.js so the SDK cannot drift into a weaker check.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA = /^[A-Za-z0-9_-]{1,128}$/;

/** Cloud suffixes as used by the Microsoft plugin. Prod and FirstRelease share a host. */
export const CLOUD_SUFFIX = /** @type {const} */ ({
  Prod: 'api.powerplatform.com',
  FirstRelease: 'api.powerplatform.com',
  Test: 'api.test.powerplatform.com',
  Preprod: 'api.preprod.powerplatform.com',
  Dev: 'api.dev.powerplatform.com',
  Exp: 'api.exp.powerplatform.com',
  Prv: 'api.prv.powerplatform.com'
});

/** @typedef {keyof typeof CLOUD_SUFFIX} SupportedCloud */

/**
 * The environment id is split into a 30-character prefix and a 2-character
 * suffix for the commercial clouds this SDK supports.
 * @param {string} environmentId
 * @param {SupportedCloud} [cloud]
 */
export function environmentHost(environmentId, cloud = 'Prod') {
  if (!GUID.test(environmentId)) throw new Error('environmentId must be a GUID.');
  const suffix = CLOUD_SUFFIX[cloud];
  if (!suffix) throw new Error(`Unsupported cloud "${cloud}". Supported: ${Object.keys(CLOUD_SUFFIX).join(', ')}.`);
  const id = environmentId.toLowerCase().replace(/-/g, '');
  return `${id.slice(0, 30)}.${id.slice(30)}.environment.${suffix}`;
}

/**
 * The token scope for the Power Platform API in the given cloud.
 * @param {SupportedCloud} [cloud]
 */
export function powerPlatformScope(cloud = 'Prod') {
  const suffix = CLOUD_SUFFIX[cloud];
  if (!suffix) throw new Error(`Unsupported cloud "${cloud}".`);
  return `https://${suffix}/.default`;
}

/**
 * Authenticated Agentic Runtime `/3p` Direct-to-Engine base URL for a
 * published GitHub Copilot harness agent. `api-version=1` is pinned because
 * the client library preserves an existing api-version and appends
 * `/conversations[/{id}]`.
 * @param {{ environmentId: string, schemaName: string, cloud?: SupportedCloud }} opts
 */
export function build3pUrl({ environmentId, schemaName, cloud = 'Prod' }) {
  if (!SCHEMA.test(schemaName)) throw new Error('schemaName must be 1-128 characters of A-Z a-z 0-9 _ -.');
  return `https://${environmentHost(environmentId, cloud)}/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots/${schemaName}?api-version=1`;
}

/**
 * No-auth agentic Direct Line token endpoint (diagnostic only; final-only
 * responses were observed).
 * @param {{ environmentId: string, schemaName: string, cloud?: SupportedCloud }} opts
 */
export function buildAgenticDirectLineTokenUrl({ environmentId, schemaName, cloud = 'Prod' }) {
  if (!SCHEMA.test(schemaName)) throw new Error('schemaName must be 1-128 characters of A-Z a-z 0-9 _ -.');
  return `https://${environmentHost(environmentId, cloud)}/copilotstudio/agenticruntime/botsbyschema/${schemaName}/directline/token?api-version=2022-03-01-preview`;
}

const ENVIRONMENT_HOST = /^[a-f0-9]{30}\.[a-f0-9]{2}\.environment\.api(?:\.(?:test|preprod|dev|exp|prv))?\.powerplatform\.com$/i;
const THREE_P_PATH = /^\/copilotstudio\/agenticruntime\/3p\/dataverse-backed\/authenticated\/bots\/[A-Za-z0-9_-]+$/;

/**
 * Strict outbound guard for a `/3p` URL (base or conversation form). Returns
 * the normalized conversations URL. This is the SSRF boundary: https only,
 * default port, no credentials, environment host, exact path, api-version=1.
 * @param {string} directConnectUrl
 * @returns {URL}
 */
export function guard3pUrl(directConnectUrl) {
  const value = String(directConnectUrl || '').trim();
  if (!value) throw new Error('Missing /3p Direct Connect URL.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid /3p Direct Connect URL.');
  }
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/conversations(?:\/[^/]+)?$/i, '');
  const hasEncodedSeparator = /%2f|%5c/i.test(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    hasEncodedSeparator ||
    !ENVIRONMENT_HOST.test(url.hostname) ||
    !THREE_P_PATH.test(basePath) ||
    url.searchParams.get('api-version') !== '1' ||
    [...url.searchParams.keys()].length !== 1
  ) {
    throw new Error('Invalid /3p Direct Connect URL.');
  }
  const result = new URL(url.href);
  result.pathname = `${basePath}/conversations`;
  return result;
}
