/**
 * Jira-admin mode plumbing against a mocked @forge/api: the asUser writer's endpoints and error mapping (403, consent,
 * already a member, group exists), the environment type (runtime first, context second), and the resolver wiring in
 * src/index.js (grantAccess passes Forge's consent error through; other resolvers return USER_CONSENT_REQUIRED).
 *
 * @file        test/jiraUserWriter.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

// ---------------------------------------------------------------- mocked Forge runtime

const sent = [];
let respond = () => ({ status: 204 });
let runtimeEnv = null; // what getAppContext().environmentType reports; null = no Forge runtime (throws)
const needsAuth = () => Object.assign(new Error('Authentication Required'), { name: 'NEEDS_AUTHENTICATION_ERR', status: 401 });
const response = ({ status, body }) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

const route = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');
mock.module('@forge/api', {
  namedExports: {
    route,
    asUser: () => ({
      requestJira: async (path, init = {}) => {
        sent.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
        const r = respond(path, init);
        if (r instanceof Error) throw r;
        return response(r);
      },
    }),
    asApp: () => ({ requestJira: async () => response({ status: 200, body: {} }) }),
    getAppContext: () => {
      if (!runtimeEnv) throw new Error('No Forge runtime');
      return { environmentType: runtimeEnv };
    },
    fetch: async () => response({ status: 200, body: {} }),
  },
});

const { jiraUserWriter, isConsentError } = await import('../src/forge/jiraUserWriter.js');
const { environmentTypeOf } = await import('../src/forge/environment.js');

test.beforeEach(() => {
  sent.length = 0;
  respond = () => ({ status: 204 });
});

test('asUser writer: the three Jira REST group endpoints, as documented', async () => {
  respond = (path) => (path === '/rest/api/3/group' ? { status: 201, body: { name: 'atlassian-PROJ-x', groupId: 'gid-1' } } : { status: 201, body: {} });
  assert.deepEqual(await jiraUserWriter.createGroup('atlassian-PROJ-x'), { groupId: 'gid-1', name: 'atlassian-PROJ-x' });
  await jiraUserWriter.addMember('gid-1', 'acc-1');
  respond = () => ({ status: 204 });
  await jiraUserWriter.removeMember('gid-1', 'acc-1');
  assert.deepEqual(sent, [
    { path: '/rest/api/3/group', method: 'POST', body: { name: 'atlassian-PROJ-x' } },
    { path: '/rest/api/3/group/user?groupId=gid-1', method: 'POST', body: { accountId: 'acc-1' } },
    { path: '/rest/api/3/group/user?groupId=gid-1&accountId=acc-1', method: 'DELETE', body: null },
  ]);
});

test('asUser writer: 403 -> JIRA_ADMIN_REQUIRED, consent -> USER_CONSENT_REQUIRED, known 400s mapped', async () => {
  respond = () => ({ status: 403, body: { errorMessages: ['Administrator privileges are required'] } });
  await assert.rejects(jiraUserWriter.addMember('g', 'a'), (e) => e.code === 'JIRA_ADMIN_REQUIRED' && e.details.status === 403);
  respond = () => needsAuth();
  await assert.rejects(jiraUserWriter.addMember('g', 'a'), (e) => e.code === 'USER_CONSENT_REQUIRED' && isConsentError(e) && e.cause.name === 'NEEDS_AUTHENTICATION_ERR');
  respond = () => ({ status: 401, body: { message: 'Unauthorized' } });
  await assert.rejects(jiraUserWriter.removeMember('g', 'a'), (e) => e.code === 'USER_CONSENT_REQUIRED');
  respond = () => ({ status: 400, body: { errorMessages: ["Cannot add user. User is already a member of 'x'"] } });
  await assert.rejects(jiraUserWriter.addMember('g', 'a'), (e) => e.code === 'ALREADY_MEMBER');
  respond = () => ({ status: 400, body: { errorMessages: ['A group with that name already exists.'] } });
  await assert.rejects(jiraUserWriter.createGroup('x'), (e) => e.code === 'GROUP_EXISTS');
  respond = () => ({ status: 404, body: { errorMessages: ['Specified group does not exist.'] } });
  await assert.rejects(jiraUserWriter.addMember('g', 'a'), (e) => e.code === 'GROUP_NOT_FOUND');
  respond = () => ({ status: 500, body: { message: 'boom' } });
  await assert.rejects(jiraUserWriter.addMember('g', 'a'), (e) => e.code === 'JIRA_ERROR');
});

test('asUser writer: requestConsent lets Forge\'s own error through (for the "Allow access" prompt)', async () => {
  respond = () => needsAuth();
  await assert.rejects(jiraUserWriter.requestConsent(), (e) => e.name === 'NEEDS_AUTHENTICATION_ERR');
  respond = () => ({ status: 200, body: { accountId: 'me' } });
  assert.deepEqual(await jiraUserWriter.requestConsent(), { ok: true, status: 200 });
  assert.equal(sent.at(-1).path, '/rest/api/3/myself');
});

test('environment type: the Forge runtime wins; the context is the fallback; nothing else counts', () => {
  runtimeEnv = 'DEVELOPMENT';
  assert.equal(environmentTypeOf({ environmentType: 'PRODUCTION' }), 'DEVELOPMENT');
  runtimeEnv = 'PRODUCTION';
  assert.equal(environmentTypeOf({ environmentType: 'DEVELOPMENT' }), 'PRODUCTION', 'a context value cannot override the runtime');
  runtimeEnv = null;
  assert.equal(environmentTypeOf({ environmentType: 'development' }), 'DEVELOPMENT');
  assert.equal(environmentTypeOf({}), null);
  assert.equal(environmentTypeOf(undefined), null);
});

// ---------------------------------------------------------------- resolver wiring (src/index.js)

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;
const seed = createSeed(Date.now());
seed.store.config = { ...seed.store.config, groupChanges: 'jiraAdmin' };
class FakeResolver {
  constructor() {
    this.fns = new Map();
  }
  define(name, fn) {
    this.fns.set(name, fn);
  }
  getDefinitions() {
    return (event) => this.fns.get(event.call.functionKey)({ payload: event.call.payload, context: event.context });
  }
}
mock.module('@forge/resolver', { defaultExport: FakeResolver });
mock.module(src('forge/jiraClient.js'), { namedExports: { jiraClient: memoryJira(seed.jira) } });
mock.module(src('forge/orgClient.js'), { namedExports: { createOrgClient: () => memoryOrg(seed.jira, { configured: false }) } });
mock.module(src('forge/confluenceClient.js'), { namedExports: { confluenceClient: memoryConfluence(seed.jira) } });
const store = memoryStore(seed.store);
mock.module(src('forge/kvsStore.js'), { namedExports: { kvsStore: store, kvsSecrets: { get: async () => null, set: async () => {}, delete: async () => {} } } });
mock.module(src('forge/sqlAudit.js'), { namedExports: { sqlAudit: memoryAudit([]), runMigrations: async () => [] } });
const { handler } = await import('../src/index.js');
const call = (name, payload, surface = 'project', extra = {}) =>
  handler({
    call: { functionKey: name, payload },
    context: { accountId: 'u-me', moduleKey: surface === 'admin' ? 'gum-admin-page' : 'gum-project-settings', extension: surface === 'admin' ? {} : { project: { id: '10001' } }, ...extra },
  });

test('resolvers: a missing consent is USER_CONSENT_REQUIRED for the UI; grantAccess hands Forge its own error', async () => {
  respond = () => needsAuth();
  const res = await call('addMembers', { groupId: 'g-reviewer', accountIds: ['u-lena-koch'] });
  assert.equal(res.error.code, 'USER_CONSENT_REQUIRED');
  await assert.rejects(call('grantAccess', {}), (e) => e.name === 'NEEDS_AUTHENTICATION_ERR');
  await assert.rejects(call('grantAccess', {}, 'admin'), (e) => e.name === 'NEEDS_AUTHENTICATION_ERR');
  respond = () => ({ status: 200, body: {} });
  assert.deepEqual(await call('grantAccess', {}), { data: { ok: true } });
});

test('resolvers: the queue is on the project page and the admin page, withdrawing only on the project page', async () => {
  assert.ok((await call('listChanges', {}, 'admin')).data);
  assert.ok((await call('listChanges', {})).data);
  assert.equal((await call('withdrawChanges', { refs: ['10001:x'] }, 'admin')).error.message, 'Not available here');
});

test('resolvers: the environment type comes from Forge, never from the payload', async () => {
  runtimeEnv = 'PRODUCTION';
  await store.set('config', { ...(await store.get('config')), testProjectAdmins: ['u-me'] });
  const boot = await call('bootstrap', { environmentType: 'DEVELOPMENT' }, 'project', { environmentType: 'DEVELOPMENT' });
  assert.equal(boot.data.user.isJiraAdmin, true, 'production: the test switch is ignored');
  runtimeEnv = 'DEVELOPMENT';
  assert.equal((await call('bootstrap', {})).data.user.isJiraAdmin, false);
  runtimeEnv = null;
});
