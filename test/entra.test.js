import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCodeTokenProvider, createClientCredentialTokenProvider, staticToken } from '../src/auth/entra.js';

const IDS = { clientId: '11111111-2222-3333-4444-555555555555', tenantId: '22222222-2222-3333-4444-555555555555' };

test('staticToken returns the token and rejects empty values', async () => {
  assert.equal(await staticToken('abc')(), 'abc');
  assert.throws(() => staticToken(''), /non-empty/);
});

test('client-credential provider caches, dedupes concurrent acquisitions, and refreshes before expiry', async () => {
  let now = 1_000_000;
  let acquisitions = 0;
  const ccaFactory = (config) => {
    assert.equal(config.auth.clientSecret, 'secret');
    return {
      async acquireTokenByClientCredential({ scopes }) {
        assert.deepEqual(scopes, ['https://api.powerplatform.com/.default']);
        acquisitions += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { accessToken: `tok-${acquisitions}`, expiresOn: new Date(now + 10 * 60_000) };
      }
    };
  };
  const provider = createClientCredentialTokenProvider({ ...IDS, clientSecret: 'secret' }, { ccaFactory, now: () => now });
  const [a, b] = await Promise.all([provider(), provider()]);
  assert.equal(a, 'tok-1');
  assert.equal(b, 'tok-1');
  assert.equal(acquisitions, 1, 'concurrent callers share one acquisition');
  assert.equal(await provider(), 'tok-1', 'cached within expiry');
  now += 9 * 60_000 + 30_000; // inside the 60 s refresh skew
  assert.equal(await provider(), 'tok-2', 're-acquired before expiry');
  assert.equal(acquisitions, 2);
});

test('client-credential provider clears the in-flight acquisition after a failure', async () => {
  let fail = true;
  const ccaFactory = () => ({
    async acquireTokenByClientCredential() {
      if (fail) throw new Error('AADSTS7000215');
      return { accessToken: 'ok', expiresOn: new Date(Date.now() + 60_000 * 10) };
    }
  });
  const provider = createClientCredentialTokenProvider({ ...IDS, clientSecret: 's' }, { ccaFactory });
  await assert.rejects(provider(), /AADSTS7000215/);
  fail = false;
  assert.equal(await provider(), 'ok');
});

test('device-code provider prefers a silent token and falls back to the device-code flow once', async () => {
  const messages = [];
  let silentCalls = 0;
  let deviceCalls = 0;
  const pcaFactory = () => ({
    getTokenCache: () => ({ getAllAccounts: async () => (deviceCalls ? [{ homeAccountId: 'acct' }] : []) }),
    async acquireTokenSilent({ account }) {
      silentCalls += 1;
      assert.equal(account.homeAccountId, 'acct');
      return { accessToken: 'silent-tok', expiresOn: new Date(Date.now() + 10 * 60_000) };
    },
    async acquireTokenByDeviceCode({ deviceCodeCallback }) {
      deviceCalls += 1;
      deviceCodeCallback({ message: 'go to https://microsoft.com/devicelogin' });
      return { accessToken: 'device-tok', expiresOn: new Date(Date.now() + 60_000 + 30_000) };
    }
  });
  const provider = createDeviceCodeTokenProvider({ ...IDS, onDeviceCode: (m) => messages.push(m) }, { pcaFactory });
  assert.equal(await provider(), 'device-tok');
  assert.equal(deviceCalls, 1);
  assert.equal(messages.length, 1);
  assert.equal(await provider(), 'device-tok', 'cached while valid');
  // Expire the cache by faking time: create a provider with now() past expiry.
  const providerLate = createDeviceCodeTokenProvider(IDS, { pcaFactory, now: () => Date.now() + 5 * 60_000 });
  assert.equal(await providerLate(), 'silent-tok', 'later acquisitions go silent when an account exists');
  assert.equal(silentCalls, 1);
  assert.equal(deviceCalls, 1, 'device code was not prompted again');
});
