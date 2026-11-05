/**
 * Kill switch (APP_MAINTENANCE). Only SUPERPORT can set it (Forge environment variable); nothing a customer or
 * a caller sends can change or bypass it, and while it is on/readonly no group or membership is changed.
 * Runs the real src/index.js wiring: @forge/resolver and the Forge adapters are replaced by the in-memory
 * backends, wrapped so every call and every write is counted.
 *
 * @file        test/maintenance.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

// ---------------------------------------------------------------- counted in-memory backends

const WRITES = {
  jira: ['createGroup', 'addMember', 'removeMember'],
  org: ['connect', 'disconnect', 'createGroup', 'addMember', 'removeMember'],
  store: ['set', 'delete'],
  secrets: ['set', 'delete'],
  audit: ['append', 'purgeOlderThan', 'importRows'],
  confluence: [],
};
let live;
let counts;

function reset() {
  const seed = createSeed(Date.now());
  const secrets = new Map();
  live = {
    jira: memoryJira(seed.jira),
    org: memoryOrg(seed.jira),
    confluence: memoryConfluence(seed.jira),
    store: memoryStore(seed.store),
    audit: memoryAudit([]),
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    data: seed.jira,
  };
  counts = { calls: 0, writes: 0, groupWrites: 0 };
}
reset();

// A stable stand-in (same methods as the in-memory backend) that forwards to the current backend and counts.
function counted(kind) {
  const out = {};
  for (const [name, fn] of Object.entries(live[kind])) {
    if (typeof fn !== 'function') continue;
    out[name] = (...args) => {
      counts.calls++;
      if (WRITES[kind].includes(name)) {
        counts.writes++;
        if (kind === 'org' || kind === 'jira') counts.groupWrites++;
      }
      return live[kind][name](...args);
    };
  }
  return out;
}

let migrations = 0;
const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

class FakeResolver {
  constructor() {
    this.fns = new Map();
  }
  define(name, fn) {
    this.fns.set(name, fn);
  }
  getDefinitions() {
    const handler = (event) => this.fns.get(event.call.functionKey)({ payload: event.call.payload, context: event.context });
    handler.names = () => [...this.fns.keys()];
    return handler;
  }
}

mock.module('@forge/resolver', { defaultExport: FakeResolver });
mock.module(src('forge/jiraClient.js'), { namedExports: { jiraClient: counted('jira') } });
mock.module(src('forge/orgClient.js'), { namedExports: { createOrgClient: () => counted('org') } });
mock.module(src('forge/confluenceClient.js'), { namedExports: { confluenceClient: counted('confluence') } });
mock.module(src('forge/kvsStore.js'), { namedExports: { kvsStore: counted('store'), kvsSecrets: counted('secrets') } });
mock.module(src('forge/sqlAudit.js'), {
  namedExports: {
    sqlAudit: counted('audit'),
    runMigrations: async () => {
      migrations++;
      counts.calls++;
      return [];
    },
  },
});

const index = await import('../src/index.js');
const { maintenanceMode } = await import('../src/core/maintenance.js');
const { handler } = index;

const set = (v) => {
  if (v === undefined) delete process.env.APP_MAINTENANCE;
  else process.env.APP_MAINTENANCE = v;
};

// ---------------------------------------------------------------- calling resolvers like Forge does

const MODULES = { project: 'gum-project-settings', member: 'gum-my-groups', auditor: 'gum-audit', admin: 'gum-admin-page' };
function contextFor(surface, accountId = 'u-me') {
  return { accountId, moduleKey: MODULES[surface], cloudId: 'cloud-1', extension: surface === 'project' || surface === 'member' ? { project: { id: '10001' } } : {} };
}
const call = (name, payload = {}, surface = 'project', accountId) => handler({ call: { functionKey: name, payload }, context: contextFor(surface, accountId) });

// Where each resolver is allowed (mirrors the per-surface lists in src/index.js), and a payload that gets it to
// do real work when the app is up.
const SURFACE = {
  myGroups: 'member', requestAccess: 'member', withdrawRequest: 'member',
  auditorBootstrap: 'auditor',
  adminBootstrap: 'admin', saveConfig: 'admin', exportData: 'admin', importData: 'admin', searchGroups: 'admin', searchProjects: 'admin',
  testOrgApi: 'admin', saveOrgConnection: 'admin', removeOrgConnection: 'admin', previewDeactivatedCleanup: 'admin', rebuildConfluenceIndex: 'admin',
};
const PAYLOAD = {
  checkName: { namePart: 'new-team' },
  createGroup: { namePart: 'new-team', addMe: true },
  applyAccessChanges: { changes: [{ groupId: 'g-reviewer', accountId: 'u-lena-koch', op: 'add' }] },
  getGroup: { groupId: 'g-reviewer' },
  getMembers: { groupId: 'g-reviewer' },
  updateDescription: { groupId: 'g-reviewer', description: 'changed' },
  searchUsers: { query: 'anna' },
  addMembers: { groupId: 'g-reviewer', accountIds: ['u-lena-koch'] },
  removeMember: { groupId: 'g-admins', accountId: 'u-me' },
  removeMembers: { groupId: 'g-admins', accountIds: ['u-me'] },
  setExpiry: { groupId: 'g-admins', accountId: 'u-me', expiresAt: null },
  resolveUsers: { entries: ['anna.beispiel@example.com'] },
  exportMembers: { groupId: 'g-reviewer' },
  getUsage: { groupId: 'g-reviewer' },
  decideRequest: { requestId: 'r1', decision: 'approve' },
  reopenRequest: { requestId: 'r1' },
  completeReview: { groupId: 'g-reviewer' },
  markTutorialSeen: { version: 1 },
  requestAccess: { groupId: 'g-reviewer', reason: 'Need it' },
  withdrawRequest: { requestId: 'r1' },
  saveConfig: { config: { retentionMonths: 1 } },
  exportData: { part: 'meta' },
  importData: { part: 'finish', cloudId: 'cloud-1' },
  saveOrgConnection: { orgId: 'org-x', apiKey: 'key' },
};
// The resolvers that keep working in read-only mode. Kept here on purpose (not imported from src/index.js):
// adding a resolver to READS needs a deliberate change to this test as well.
const EXPECTED_READS = [
  'bootstrap', 'checkName', 'accessMatrix', 'getGroup', 'getMembers', 'searchUsers', 'resolveUsers', 'exportMembers', 'getUsage',
  'listRequests', 'queryAudit', 'auditFilterOptions', 'exportAudit', 'tutorialState', 'myGroups', 'auditorBootstrap',
  'adminBootstrap', 'exportData', 'searchGroups', 'searchProjects', 'testOrgApi', 'previewDeactivatedCleanup',
];

const RESOLVERS = handler.names().filter((n) => n !== 'availability');
const ROVO = Object.keys(index).filter((k) => k.startsWith('rovo'));
const SCHEDULED = ['retentionHandler', 'expiryHandler', 'automationHandler', 'confluenceIndexHandler', 'lifecycleHandler'];
const rovoCaller = { principal: { accountId: 'u-me' } };

// A due membership end and the automatic removal switched on, so the scheduled jobs have something to change.
async function withPendingJobs() {
  await live.store.set('expiry:g-admins:u-me', { groupId: 'g-admins', accountId: 'u-me', projectId: '10001', expiresAt: Date.now() - 60000, setAt: 0, setBy: null });
  await live.store.set('config', { ...(await live.store.get('config')), autoRemoveDeactivated: true, retentionMonths: 1 });
  counts = { calls: 0, writes: 0, groupWrites: 0 };
}

test.afterEach(() => set(undefined));

// ---------------------------------------------------------------- reading the switch

test('kill switch: values map to off/readonly/on and anything unknown fails closed to on', () => {
  assert.equal(maintenanceMode({}), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: '' }), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'off' }), 'off');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: ' ReadOnly ' }), 'readonly');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'read-only' }), 'readonly');
  assert.equal(maintenanceMode({ APP_MAINTENANCE: 'on' }), 'on');
  for (const v of ['of', 'false', '0', 'no', 'maintenance', 'readonly!']) assert.equal(maintenanceMode({ APP_MAINTENANCE: v }), 'on', v);
});

test('kill switch: the click-dummy mirrors the read list of src/index.js', () => {
  const readsIn = (file) => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const block = /const READS = new Set\(\[([\s\S]*?)\]\)/.exec(text)?.[1] ?? '';
    return [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  };
  assert.deepEqual(readsIn('../src/index.js'), [...EXPECTED_READS].sort());
  assert.deepEqual(readsIn('../static/app/src/api/demoBackend.js'), [...EXPECTED_READS].sort());
});

test('kill switch: the test covers every resolver the app defines', () => {
  assert.ok(RESOLVERS.length >= 40, `found ${RESOLVERS.length} resolvers`);
  for (const n of EXPECTED_READS) assert.ok(RESOLVERS.includes(n), `${n} is defined`);
  assert.equal(ROVO.length, 16);
});

// ---------------------------------------------------------------- on

test('APP_MAINTENANCE=on: every resolver is refused for every caller, before anything is read or written', async () => {
  set('on');
  for (const name of RESOLVERS) {
    for (const accountId of ['u-me', 'u-admin', undefined]) {
      reset();
      const res = await call(name, PAYLOAD[name] ?? {}, SURFACE[name] ?? 'project', accountId);
      assert.equal(res.error?.code, 'UNAVAILABLE', name);
      assert.match(res.error.message, /temporarily unavailable/);
      assert.equal(res.error.details.statusUrl, 'https://superapps.statuspage.io');
      assert.equal(counts.calls, 0, `${name}: no Jira, organization, storage or audit access`);
    }
  }
});

test('APP_MAINTENANCE=on: nothing a caller sends can switch it off or get around it', async () => {
  set('on');
  const hostile = { APP_MAINTENANCE: 'off', maintenance: 'off', mode: 'off', env: { APP_MAINTENANCE: 'off' }, __proto__: { APP_MAINTENANCE: 'off' } };
  for (const name of RESOLVERS) {
    reset();
    for (const surface of Object.keys(MODULES)) {
      const res = await handler({ call: { functionKey: name, payload: { ...(PAYLOAD[name] ?? {}), ...hostile } }, context: { ...contextFor(surface), APP_MAINTENANCE: 'off', env: { APP_MAINTENANCE: 'off' } } });
      assert.equal(res.error?.code, 'UNAVAILABLE', `${name} on ${surface}`);
    }
    assert.equal(counts.calls, 0, name);
  }
  assert.equal(process.env.APP_MAINTENANCE, 'on');
});

test('APP_MAINTENANCE=on: the UI is told, Rovo answers "unavailable" and the scheduled jobs do nothing', async () => {
  set('on');
  reset();
  assert.deepEqual(await call('availability'), { data: { mode: 'on', statusUrl: 'https://superapps.statuspage.io' } });
  for (const name of ROVO) {
    reset();
    const res = await index[name]({ projectKey: 'PROJ', groupName: 'reviewer', people: 'Lena Koch', confirm: true }, rovoCaller);
    assert.equal(res.ok, false, name);
    assert.equal(res.nothingChanged, true, name);
    assert.match(res.error, /temporarily unavailable/, name);
    assert.equal(counts.calls, 0, name);
  }
  reset();
  await withPendingJobs();
  const before = migrations;
  for (const job of SCHEDULED) await index[job]();
  assert.equal(counts.calls, 0, 'not even reads');
  assert.equal(migrations, before);
});

test('availability: only for signed-in callers, and it never changes the mode', async () => {
  set('on');
  reset();
  const res = await handler({ call: { functionKey: 'availability', payload: { mode: 'off' } }, context: {} });
  assert.equal(res.error?.code, 'FORBIDDEN');
  assert.equal(process.env.APP_MAINTENANCE, 'on');
  set('readonly');
  assert.equal((await call('availability', { mode: 'off' }, 'member')).data.mode, 'readonly');
  set('banana');
  assert.equal((await call('availability', {}, 'admin')).data.mode, 'on');
});

// ---------------------------------------------------------------- readonly

test('APP_MAINTENANCE=readonly: reads work, every other resolver is refused, nothing in Jira or the organization changes', async () => {
  set('readonly');
  for (const name of RESOLVERS) {
    reset();
    const res = await call(name, PAYLOAD[name] ?? {}, SURFACE[name] ?? 'project');
    if (EXPECTED_READS.includes(name)) {
      assert.notEqual(res.error?.code, 'UNAVAILABLE', `${name} is a read`);
    } else {
      assert.equal(res.error?.code, 'UNAVAILABLE', `${name} is refused`);
      assert.match(res.error.message, /Changes are paused/);
      assert.equal(counts.calls, 0, `${name}: refused before anything is touched`);
    }
    assert.equal(counts.groupWrites, 0, `${name}: no group or membership change`);
  }
});

test('APP_MAINTENANCE=readonly: the main pages still load', async () => {
  set('readonly');
  reset();
  const boot = await call('bootstrap');
  assert.ok(boot.data.groups.some((g) => g.name === 'atlassian-PROJ-reviewer'));
  assert.ok((await call('myGroups', {}, 'member')).data);
  assert.ok((await call('adminBootstrap', {}, 'admin')).data.config);
  assert.ok((await call('queryAudit', {}, 'admin')).data);
  assert.equal(counts.groupWrites, 0);
});

test('APP_MAINTENANCE=readonly: Rovo can answer but not change anything', async () => {
  set('readonly');
  reset();
  const list = await index.rovoListGroups({ projectKey: 'PROJ' }, rovoCaller);
  assert.equal(list.ok, true);
  const reads = ['rovoListGroups', 'rovoGroupDetails', 'rovoWhereUsed', 'rovoAuditLog', 'rovoComplianceCheck', 'rovoPersonAccess'];
  for (const name of ROVO) {
    reset();
    const res = await index[name]({ projectKey: 'PROJ', groupName: 'reviewer', person: 'Lena Koch', people: 'Lena Koch', fromGroup: 'admins', toGroup: 'reviewer', fromPerson: 'Anna Beispiel', toPeople: 'Lena Koch', namePart: 'x', description: 'x', decision: 'approve', endDate: 'none', confirm: true }, rovoCaller);
    if (reads.includes(name)) assert.equal(res.ok, true, `${name}: ${res.error}`);
    else {
      assert.equal(res.ok, false, name);
      assert.match(res.error, /Changes are paused/, name);
      assert.equal(counts.calls, 0, name);
    }
    assert.equal(counts.groupWrites, 0, name);
  }
});

test('APP_MAINTENANCE=readonly: expiry and automatic removal wait; nothing in Jira or the organization changes', async () => {
  set('readonly');
  reset();
  await withPendingJobs();
  for (const job of SCHEDULED) await index[job]();
  assert.equal(counts.groupWrites, 0);
  assert.ok(await live.store.get('expiry:g-admins:u-me'), 'the due end date is kept for when the app is back');
});

// ---------------------------------------------------------------- off

test('APP_MAINTENANCE off or unset: the app works normally (control for the tests above)', async () => {
  for (const v of [undefined, 'off', ' OFF ']) {
    set(v);
    reset();
    assert.equal((await call('availability')).data.mode, 'off');
    const created = await call('createGroup', PAYLOAD.createGroup);
    assert.equal(created.data?.name, 'atlassian-PROJ-new-team', JSON.stringify(created));
    assert.ok(counts.groupWrites > 0);
    assert.equal((await index.rovoListGroups({ projectKey: 'PROJ' }, rovoCaller)).ok, true);
    reset();
    await withPendingJobs();
    await index.expiryHandler();
    assert.ok(counts.groupWrites > 0, 'the due membership is ended');
    assert.equal(await live.store.get('expiry:g-admins:u-me'), undefined);
  }
});
