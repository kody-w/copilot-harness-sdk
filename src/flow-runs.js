// @ts-check
/**
 * Read what a harness agent's flow tools actually returned, from the Power Automate run history.
 *
 * The /3p route gives back the agent's written reply, which paraphrases tool output. To prove a translated
 * tool equals its original byte for byte, read the run's `Respond to the agent` output instead: list the
 * flow's runs that started after a turn began, then follow each response action's outputs link.
 *
 * Needs a token for https://service.flow.microsoft.com/ as the same user (for example
 * `az account get-access-token --resource https://service.flow.microsoft.com/`).
 */
import { createHash } from 'node:crypto';

const FLOW_API = 'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments';
const API_VERSION = '2016-11-01';

/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The workflow id a tool component's YAML points at (`workflowId: <guid>`), or null.
 * @param {string | null | undefined} data
 */
export function workflowIdFromComponent(data) {
  return (String(data || '').match(/^workflowId:\s*([0-9a-fA-F-]{36})\s*$/m) || [])[1] || null;
}

/**
 * Runs of one flow that started at or after `since`, each with what it returned to the agent.
 *
 * @param {{ environmentId: string, workflowId: string, since: Date | number, getFlowToken: () => Promise<string>,
 *           fetchImpl?: typeof fetch, top?: number, sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<Array<{ runId: string, status: string, startTime: string, inputs: any, output: string | null, sha256: string | null }>>}
 */
export async function flowRunOutputs({ environmentId, workflowId, since, getFlowToken, fetchImpl, top = 20, sleep }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const token = await getFlowToken();
  const auth = { Authorization: `Bearer ${token}` };
  const wait = sleep || ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  // Run history reads retry a dropped connection or a 5xx, like the sign-in does.
  const get = async (/** @type {string} */ url, /** @type {boolean} */ signed) => {
    let last;
    for (let i = 0; i < 4; i++) {
      if (i) await wait(1000 * 2 ** (i - 1));
      let res;
      try { res = await doFetch(url, { headers: signed ? {} : auth }); } catch (e) { last = e; continue; }
      if (res.status >= 500 && i < 3) { last = new Error(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`GET ${url.split('?')[0]} -> HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(`GET ${url.split('?')[0]} failed after 4 attempts: ${last?.message || last}`);
  };
  const base = `${FLOW_API}/${environmentId}/flows/${workflowId}/runs`;
  const after = new Date(since).getTime();
  const runs = ((await get(`${base}?api-version=${API_VERSION}&$top=${top}`, false)).value || [])
    .filter((/** @type {any} */ r) => new Date(r.properties?.startTime).getTime() >= after);
  const out = [];
  for (const r of runs.reverse()) {
    const actions = (await get(`${base}/${r.name}/actions?api-version=${API_VERSION}`, false)).value || [];
    const respond = actions.find((/** @type {any} */ a) => /respond/i.test(a.name) && a.properties?.outputsLink?.uri);
    let output = null;
    if (respond) {
      const body = (await get(respond.properties.outputsLink.uri, true))?.body;
      output = body == null ? null
        : typeof body === 'string' ? body
          : typeof body.result === 'string' && Object.keys(body).length === 1 ? body.result
            : JSON.stringify(body);
    }
    const trigger = r.properties?.trigger?.outputsLink?.uri;
    const inputs = trigger ? (await get(trigger, true))?.body ?? null : null;
    out.push({ runId: r.name, status: r.properties?.status, startTime: r.properties?.startTime, inputs, output,
      sha256: output == null ? null : sha256(output) });
  }
  return out;
}
