import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentHost, build3pUrl, buildAgenticDirectLineTokenUrl, guard3pUrl, powerPlatformScope } from '../src/url.js';

const ENV = '11111111-2222-3333-4444-555555555555';

test('environmentHost splits the GUID 30/2 for Prod (documented example)', () => {
  assert.equal(environmentHost(ENV), '111111112222333344445555555555.55.environment.api.powerplatform.com');
});

test('environmentHost uses the cloud suffix and rejects unknown clouds', () => {
  assert.equal(environmentHost(ENV, 'Test'), '111111112222333344445555555555.55.environment.api.test.powerplatform.com');
  assert.throws(() => environmentHost(ENV, /** @type {any} */ ('Gov')), /Unsupported cloud/);
  assert.throws(() => environmentHost('not-a-guid'), /GUID/);
});

test('build3pUrl matches the verified /3p shape with api-version=1 pinned', () => {
  assert.equal(
    build3pUrl({ environmentId: ENV, schemaName: 'cr123_myAgent_aB3xY' }),
    'https://111111112222333344445555555555.55.environment.api.powerplatform.com/copilotstudio/agenticruntime/3p/dataverse-backed/authenticated/bots/cr123_myAgent_aB3xY?api-version=1'
  );
  assert.throws(() => build3pUrl({ environmentId: ENV, schemaName: 'bad name' }), /schemaName/);
});

test('buildAgenticDirectLineTokenUrl targets botsbyschema on the environment host', () => {
  const url = buildAgenticDirectLineTokenUrl({ environmentId: ENV, schemaName: 'cr123_agent' });
  assert.match(url, /^https:\/\/111111112222333344445555555555\.55\.environment\.api\.powerplatform\.com\/copilotstudio\/agenticruntime\/botsbyschema\/cr123_agent\/directline\/token/);
});

test('powerPlatformScope is the Power Platform API .default scope', () => {
  assert.equal(powerPlatformScope(), 'https://api.powerplatform.com/.default');
  assert.equal(powerPlatformScope('Preprod'), 'https://api.preprod.powerplatform.com/.default');
});

test('guard3pUrl accepts the base URL and a conversation URL, normalizing to /conversations', () => {
  const base = build3pUrl({ environmentId: ENV, schemaName: 'cr123_agent' });
  assert.equal(guard3pUrl(base).href, base.replace('?api-version=1', '/conversations?api-version=1'));
  assert.equal(guard3pUrl(base.replace('?api-version=1', '/conversations/abc?api-version=1')).href, base.replace('?api-version=1', '/conversations?api-version=1'));
});

test('guard3pUrl is the SSRF boundary', () => {
  const base = build3pUrl({ environmentId: ENV, schemaName: 'cr123_agent' });
  for (const bad of [
    base.replace('https://', 'http://'),
    base.replace('api-version=1', 'api-version=2'),
    base + '&x=1',
    base.replace('environment.api.powerplatform.com', 'evil.example.com'),
    base.replace('environment.api.powerplatform.com/', 'environment.api.powerplatform.com.evil.example/'),
    base.replace('https://', 'https://evil.example.'),
    base.replace('111111112222333344445555555555.55.', '11111111222233334444555555555.555.'),
    base.replace('?api-version=1', '/conversations/a/b?api-version=1'),
    base.replace('/bots/cr123_agent', '/bots/cr123_agent/extra'),
    base.replace('/3p/', '/%2f3p/'),
    base.replace('https://', 'https://user:pw@'),
    base.replace('.com/', '.com:8443/'),
    base + '#frag',
    'not a url',
    ''
  ]) {
    assert.throws(() => guard3pUrl(bad), /Invalid|Missing/, `should reject ${bad}`);
  }
});
