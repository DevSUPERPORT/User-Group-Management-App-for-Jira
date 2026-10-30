import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, AuditActions } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { validateNamePart, parseGroupName } from '../src/core/naming.js';
import { isBlocked, isFixedEntry } from '../src/core/blocklist.js';
import { toCsv } from '../src/core/csv.js';

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);

function setup(overrides = {}) {
  const seed = createSeed(NOW);
  const jiraState = { ...seed.jira, ...(overrides.jira ?? {}) };
  const store = memoryStore({ ...seed.store, ...(overrides.store ?? {}) });
  const audit = memoryAudit(seed.audit);
  let n = 0;
  // Writes always go through the Organization API: configured by default.
  const org = overrides.org === null ? null : overrides.org === 'unconfigured' ? memoryOrg(jiraState, { configured: false }) : memoryOrg(jiraState);
  const service = createService({ jira: memoryJira(jiraState), org, store, audit, now: () => NOW, uuid: () => `id-${++n}` });
  const ctx = (extra = {}) => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null, ...extra });
  return { service, store, audit, jiraState, ctx, org };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};

test('naming: validation of the name part', () => {
  assert.equal(validateNamePart('reviewer'), null);
  assert.equal(validateNamePart('reviewer-extern-2'), null);
  assert.equal(validateNamePart(''), 'EMPTY');
  assert.equal(validateNamePart('Reviewer'), 'INVALID_CHARS');
  assert.equal(validateNamePart('a b'), 'INVALID_CHARS');
  assert.equal(validateNamePart('über'), 'INVALID_CHARS');
  assert.equal(validateNamePart('-x'), 'INVALID_EDGES');
  assert.equal(validateNamePart('x-'), 'INVALID_EDGES');
  assert.equal(validateNamePart('a--b'), 'DOUBLE_HYPHEN');
  assert.equal(validateNamePart('a'.repeat(30)), null);
  assert.equal(validateNamePart('a'.repeat(31)), 'TOO_LONG');
  assert.deepEqual(parseGroupName('atlassian-PROJ-qa', ['NEU', 'PROJ']).namePart, 'qa');
  assert.equal(parseGroupName('atlassian-PROJX-qa', ['PROJ']), null);
});

test('blocklist: core and product access groups are always blocked; extras and wildcards apply', () => {
  const none = { blockedGroups: [] };
  // Fixed entries apply even with an empty (or tampered) configuration.
  for (const name of ['site-admins', 'org-admins', 'jira-admins-superport', 'jira-software-users-superport', 'confluence-users', 'jira-servicemanagement-users-x']) {
    assert.ok(isBlocked(name, none), name);
    assert.ok(isBlocked(name, { blockedGroups: [], autoBlockProductGroups: false }), name);
  }
  assert.ok(!isBlocked('atlassian-PROJ-reviewer', none));
  assert.ok(isBlocked('atlassian-PROJ-legacy-x', { blockedGroups: ['atlassian-PROJ-legacy-*'] }));
  assert.ok(isFixedEntry(' Site-Admins '));
  assert.ok(!isFixedEntry('atlassian-PROJ-legacy-*'));
});

test('csv: escaping and formula injection guard', () => {
  const csv = toCsv(['a', 'b'], [['x,y', '=SUM(A1)'], ['"q"', null]]);
  assert.ok(csv.startsWith('﻿a,b\r\n'));
  assert.ok(csv.includes('"x,y",\'=SUM(A1)'));
  assert.ok(csv.includes('"""q""",'));
});

test('bootstrap: detects the key change, discovers groups by name, hides blocked/foreign groups', async () => {
  const { service, ctx, audit, store } = setup();
  const res = await service.bootstrap(ctx());
  assert.equal(res.project.key, 'PROJ');
  assert.deepEqual(res.project.previousKeys, ['PRJ']);
  const names = res.groups.map((g) => g.name);
  assert.ok(names.includes('atlassian-PROJ-externe'), 'IdP group discovered by naming convention');
  assert.ok(names.includes('atlassian-PRJ-qa'), 'group under previous key stays visible');
  assert.ok(!names.includes('atlassian-OPS-oncall'));
  assert.ok(!names.includes('site-admins'));
  const qa = res.groups.find((g) => g.name === 'atlassian-PRJ-qa');
  assert.equal(qa.legacyKey, 'PRJ');
  assert.equal(res.groups.find((g) => g.name === 'atlassian-PROJ-externe').readOnly, true);

  const keyChanges = audit._rows().filter((r) => r.action === AuditActions.PROJECT_KEY_CHANGED);
  assert.equal(keyChanges.length, 1);
  assert.deepEqual(keyChanges[0].details.from, 'PRJ');

  // A second open must not log the change again.
  await service.bootstrap(ctx());
  assert.equal(audit._rows().filter((r) => r.action === AuditActions.PROJECT_KEY_CHANGED).length, 1);
  assert.equal((await store.get('project:10001')).key, 'PROJ');
});

test('permissions: non project admins are rejected; app can be limited to selected projects', async () => {
  const { service, ctx, jiraState } = setup();
  jiraState.users['u-x'] = { accountId: 'u-x', displayName: 'X' };
  assert.equal(await codeOf(service.bootstrap(ctx({ accountId: 'u-x' }))), 'FORBIDDEN');

  const limited = setup({ store: { config: { projectsMode: 'selected', allowedProjects: [{ id: '10002', key: 'OPS', name: 'Ops' }] } } });
  assert.equal(await codeOf(limited.service.bootstrap(limited.ctx())), 'PROJECT_NOT_ALLOWED');
});

test('UC-01: create group with fixed prefix, name check incl. previous keys, audit entry', async () => {
  const { service, ctx, audit } = setup();
  await service.bootstrap(ctx());

  assert.equal((await service.checkName(ctx(), { namePart: 'Bad Name' })).reason, 'INVALID_CHARS');
  assert.equal((await service.checkName(ctx(), { namePart: 'reviewer' })).reason, 'TAKEN');
  // atlassian-PRJ-qa exists under the previous key
  assert.equal((await service.checkName(ctx(), { namePart: 'qa' })).reason, 'TAKEN_PREVIOUS_KEY');

  const ok = await service.checkName(ctx(), { namePart: 'reviewer-extern' });
  assert.equal(ok.available, true);
  assert.equal(ok.fullName, 'atlassian-PROJ-reviewer-extern');

  const created = await service.createGroup(ctx(), { namePart: 'reviewer-extern', description: 'Externe Reviewer', addMe: true });
  assert.equal(created.name, 'atlassian-PROJ-reviewer-extern');
  assert.equal(created.memberCount, 1);
  const rows = audit._rows().filter((r) => r.groupId === created.groupId);
  assert.deepEqual(rows.map((r) => r.action).sort(), ['GROUP_CREATED', 'MEMBER_ADDED']);

  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'reviewer-extern' })), 'NAME_TAKEN');
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: '-x' })), 'NAME_INVALID');

  const again = await service.bootstrap(ctx());
  assert.ok(again.groups.some((g) => g.groupId === created.groupId));
});

test('UC-02/03: members paging, search, add several, remove, audit', async () => {
  const { service, ctx, audit } = setup();
  await service.bootstrap(ctx());

  const page = await service.getMembers(ctx(), { groupId: 'g-big', startAt: 0, maxResults: 10 });
  assert.equal(page.members.length, 10);
  assert.equal(page.total, 38);
  const search = await service.getMembers(ctx(), { groupId: 'g-big', query: 'yilmaz' });
  assert.equal(search.total, 1, 'search is accent-insensitive');

  const add = await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: ['u-anna-beispiel', 'u-me', 'u-lena-koch'] });
  assert.deepEqual(add.results.map((r) => r.status), ['added', 'already', 'added']);
  assert.equal(add.memberCount, 5);

  await service.removeMember(ctx(), { groupId: 'g-admins', accountId: 'u-anna-beispiel' });
  const actions = audit._rows().filter((r) => r.groupId === 'g-admins' && r.createdAt >= NOW).map((r) => r.action);
  assert.deepEqual(actions, ['MEMBER_ADDED', 'MEMBER_ADDED', 'MEMBER_REMOVED']);
});

test('UC-03: IdP groups are read-only, foreign and blocked groups are untouchable', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-externe', accountIds: ['u-anna-beispiel'] })), 'GROUP_READ_ONLY');
  assert.equal(await codeOf(service.removeMember(ctx(), { groupId: 'g-externe', accountId: 'u-anna-beispiel' })), 'GROUP_READ_ONLY');
  assert.equal(await codeOf(service.getMembers(ctx(), { groupId: 'g-other' })), 'GROUP_NOT_IN_PROJECT');
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-site', accountIds: ['u-me'] })), 'GROUP_NOT_IN_PROJECT');
  // Reading an IdP group is allowed.
  const members = await service.getMembers(ctx(), { groupId: 'g-externe' });
  assert.equal(members.total, 5);
});

test('licence: writes are rejected when the Marketplace licence is inactive', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  const unlicensed = ctx({ license: { isActive: false } });
  assert.equal(await codeOf(service.createGroup(unlicensed, { namePart: 'neu' })), 'LICENSE_INACTIVE');
  assert.equal(await codeOf(service.addMembers(unlicensed, { groupId: 'g-admins', accountIds: ['u-anna-beispiel'] })), 'LICENSE_INACTIVE');
});

test('UC-04: project admins only see their project; Jira admins see everything; filters; CSV', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  const mine = await service.queryAudit(ctx(), { filters: { period: 'all' }, page: 0, pageSize: 100 });
  assert.ok(mine.entries.every((e) => e.projectId === '10001'));
  assert.ok(mine.entries.some((e) => e.action === 'PROJECT_KEY_CHANGED'));

  const all = await service.queryAudit(ctx({ surface: 'admin', projectId: null }), { filters: {}, page: 0, pageSize: 100 });
  assert.ok(all.entries.some((e) => e.projectId === '10002'));

  const filtered = await service.queryAudit(ctx(), { filters: { action: 'MEMBER_REMOVED', groupId: 'g-reviewer' } });
  assert.equal(filtered.total, 1);
  const byPerson = await service.queryAudit(ctx(), { filters: { person: 'papadaki' } });
  assert.ok(byPerson.total >= 1);
  const recent = await service.queryAudit(ctx(), { filters: { period: '7d' } });
  assert.ok(recent.entries.every((e) => e.createdAt >= NOW - 7 * 86400000));

  const csv = await service.exportAudit(ctx(), { filters: { groupId: 'g-reviewer' } });
  assert.equal(csv.count, 3);
  assert.match(csv.filename, /^audit-log-2026-10-23\.csv$/);

  // A project admin without Jira admin rights cannot read the global log.
  const { service: s2, ctx: c2, jiraState } = setup();
  jiraState.perms['u-pa'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  jiraState.users['u-pa'] = { accountId: 'u-pa', displayName: 'PA' };
  assert.equal(await codeOf(s2.queryAudit(c2({ accountId: 'u-pa', surface: 'admin', projectId: null }), {})), 'NOT_ADMIN');
});

test('configuration: admin only, sanitised, logged; retention purges old entries', async () => {
  const { service, ctx, audit, jiraState } = setup();
  const admin = ctx({ surface: 'admin', projectId: null });
  const res = await service.saveConfig(admin, {
    config: { retentionMonths: '1', blockedGroups: ['site-admins', ' legacy-* ', 'legacy-*', '', 'JIRA-USERS'], autoBlockProductGroups: false, idpReadOnly: true, projectsMode: 'weird' },
  });
  assert.equal(res.config.retentionMonths, 1);
  // Fixed entries are never stored as removable extras; the toggle no longer exists.
  assert.deepEqual(res.config.blockedGroups, ['legacy-*']);
  assert.equal('autoBlockProductGroups' in res.config, false);
  assert.equal(res.config.projectsMode, 'all');
  assert.ok(audit._rows().some((r) => r.action === 'CONFIG_CHANGED'));
  assert.equal(await codeOf(service.saveConfig(admin, { config: { retentionMonths: 0 } })), 'BAD_REQUEST');

  const before = audit._rows().length;
  const { deleted } = await service.runRetention();
  assert.ok(deleted > 0);
  assert.equal(audit._rows().length, before - deleted);
  assert.ok(audit._rows().every((r) => r.createdAt >= NOW - 31 * 86400000));

  jiraState.perms['u-pa'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  jiraState.users['u-pa'] = { accountId: 'u-pa', displayName: 'PA' };
  assert.equal(await codeOf(service.saveConfig(ctx({ accountId: 'u-pa', surface: 'admin' }), { config: {} })), 'NOT_ADMIN');
});

test('groups deleted natively disappear only after staying missing for the grace period', async () => {
  const seed = createSeed(NOW);
  let clock = NOW;
  const store = memoryStore(seed.store);
  const service = createService({ jira: memoryJira(seed.jira), store, audit: memoryAudit(seed.audit), now: () => clock });
  const ctx = { accountId: 'u-me', projectId: '10001', surface: 'project', license: null };
  await service.bootstrap({ ...ctx });
  delete seed.jira.groups['g-admins'];

  // First miss: kept, flagged as syncing, remembered as missing.
  let res = await service.bootstrap({ ...ctx });
  assert.equal(res.groups.find((g) => g.groupId === 'g-admins').syncing, true);
  assert.equal((await store.get('group:g-admins')).missingSince, NOW);

  // Still missing a day later: forgotten.
  clock = NOW + 25 * 60 * 60 * 1000;
  res = await service.bootstrap({ ...ctx });
  assert.ok(!res.groups.some((g) => g.groupId === 'g-admins'));
  assert.equal(await store.get('group:g-admins'), undefined);
});

test('a group deleted in Atlassian Administration disappears at once when the organization confirms it', async () => {
  const seed = createSeed(NOW);
  const store = memoryStore(seed.store);
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), store, audit: memoryAudit([]), now: () => NOW });
  const ctx = { accountId: 'u-me', projectId: '10001', surface: 'project', license: null };
  await service.bootstrap({ ...ctx });
  delete seed.jira.groups['g-admins'];

  const res = await service.bootstrap({ ...ctx });
  assert.ok(!res.groups.some((g) => g.groupId === 'g-admins'));
  assert.equal(await store.get('group:g-admins'), undefined);
  assert.ok(!(await store.get('project:10001')).groupIds.includes('g-admins'));
});

test('a freshly created group that Jira does not know yet stays listed and reports syncing', async () => {
  const seed = createSeed(NOW);
  const jira = memoryJira(seed.jira);
  const org = memoryOrg(seed.jira);
  const service = createService({ jira, org, store: memoryStore(seed.store), audit: memoryAudit([]), now: () => NOW });
  const ctx = () => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null });
  await service.bootstrap(ctx());
  const created = await service.createGroup(ctx(), { namePart: 'lagging', addMe: true });
  // Simulate Jira lag: Jira does not know the new group yet.
  const hidden = seed.jira.groups[created.groupId];
  delete seed.jira.groups[created.groupId];
  const members = await service.getMembers(ctx(), { groupId: created.groupId });
  assert.deepEqual(members, { members: [], total: null, startAt: 0, syncing: true });
  const boot = await service.bootstrap(ctx());
  assert.equal(boot.groups.find((g) => g.groupId === created.groupId).syncing, true);
  // Jira catches up: back to normal, missing flag cleared.
  seed.jira.groups[created.groupId] = hidden;
  const again = await service.bootstrap(ctx());
  assert.equal(again.groups.find((g) => g.groupId === created.groupId).memberCount, 1);
});

const ORG_CONFIG = (extra = {}) => ({ config: { ...createSeed(NOW).store.config, ...extra } });

test('Org API: selected but not configured -> writes fail with a clear code, reads still work', async () => {
  for (const org of [null, 'unconfigured']) {
    const { service, ctx } = setup({ org, store: ORG_CONFIG() });
    await service.bootstrap(ctx());
    assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'neu' })), 'ORG_API_NOT_CONFIGURED');
    assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-admins', accountIds: ['u-anna-beispiel'] })), 'ORG_API_NOT_CONFIGURED');
    assert.equal((await service.getMembers(ctx(), { groupId: 'g-admins' })).total, 3);
  }
});

test('Org API: create, add and remove go through the Organization API with the group name', async () => {
  const { service, ctx, org, audit } = setup({ org: 'configured', store: ORG_CONFIG() });
  await service.bootstrap(ctx());
  const created = await service.createGroup(ctx(), { namePart: 'via-org', description: 'Org path', addMe: true });
  assert.equal(created.memberCount, 1);
  await service.addMembers(ctx(), { groupId: created.groupId, accountIds: ['u-anna-beispiel'] });
  await service.removeMember(ctx(), { groupId: created.groupId, accountId: 'u-anna-beispiel' });
  assert.deepEqual(
    org.calls.map((c) => c[0]),
    ['createGroup', 'addMember', 'addMember', 'removeMember'],
  );
  assert.deepEqual(org.calls[0], ['createGroup', 'atlassian-PROJ-via-org', 'Org path']);
  assert.equal(org.calls[3][3], 'atlassian-PROJ-via-org');
  assert.equal(audit._rows().filter((r) => r.groupId === created.groupId).length, 4);
});

test('Org API: externalSynced groups become read-only even without an admin pattern', async () => {
  const { service, ctx } = setup({ org: 'configured', store: ORG_CONFIG({ idpGroups: [] }) });
  const boot = await service.bootstrap(ctx());
  assert.equal(boot.groups.find((g) => g.groupId === 'g-externe').readOnly, false);
  const detail = await service.getGroup(ctx(), { groupId: 'g-externe' });
  assert.equal(detail.readOnly, true);
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-externe', accountIds: ['u-anna-beispiel'] })), 'GROUP_READ_ONLY');
});

test('Org API: connection test is admin-only and reports configuration; config switch is sanitised', async () => {
  const admin = (c) => c({ surface: 'admin', projectId: null });
  const none = setup({ org: null });
  assert.deepEqual(await none.service.testOrgApi(admin(none.ctx)), { configured: false, ok: false });
  const withOrg = setup({ org: 'configured' });
  const res = await withOrg.service.testOrgApi(admin(withOrg.ctx));
  assert.equal(res.ok, true);
  assert.equal(res.directoryId, 'dir-1');
  assert.equal((await withOrg.service.adminBootstrap(admin(withOrg.ctx))).orgApi.configured, true);
  const saved = await withOrg.service.saveConfig(admin(withOrg.ctx), { config: { groupWriteApi: 'jira' } });
  assert.equal('groupWriteApi' in saved.config, false, 'the Jira REST write option is gone');

  withOrg.jiraState.perms['u-pa'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  withOrg.jiraState.users['u-pa'] = { accountId: 'u-pa', displayName: 'PA' };
  assert.equal(await codeOf(withOrg.service.testOrgApi(withOrg.ctx({ accountId: 'u-pa', surface: 'admin' }))), 'NOT_ADMIN');
});

test('Org connection: per site, Jira admins only, validated, audited without the key', async () => {
  const admin = (c) => c({ surface: 'admin', projectId: null });
  const { service, ctx, jiraState, audit } = setup({ org: 'unconfigured', store: ORG_CONFIG() });
  assert.deepEqual((await service.adminBootstrap(admin(ctx))).orgApi, { configured: false });
  await service.bootstrap(ctx());
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'neu' })), 'ORG_API_NOT_CONFIGURED');

  jiraState.perms['u-pa'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  jiraState.users['u-pa'] = { accountId: 'u-pa', displayName: 'PA' };
  assert.equal(await codeOf(service.saveOrgConnection(ctx({ accountId: 'u-pa', surface: 'admin' }), { orgId: 'org-x', apiKey: 'k' })), 'NOT_ADMIN');
  assert.equal(await codeOf(service.saveOrgConnection(admin(ctx), { orgId: 'org-x', apiKey: 'invalid' })), 'ORG_API_UNAUTHORIZED');
  const multi = await service.saveOrgConnection(admin(ctx), { orgId: 'org-multi', apiKey: 'k' }).catch((e) => e);
  assert.equal(multi.code, 'ORG_DIRECTORY_REQUIRED');
  assert.equal(multi.details.directories.length, 2);

  const status = await service.saveOrgConnection(admin(ctx), { orgId: 'org-multi', apiKey: 'top-secret', directoryId: 'dir-2' });
  assert.equal(status.configured, true);
  assert.equal(status.directoryName, 'Partners');
  assert.equal(JSON.stringify(status).includes('top-secret'), false);
  assert.equal((await service.adminBootstrap(admin(ctx))).orgApi.orgId, 'org-multi');
  const rows = (await audit.query({ action: 'CONFIG_CHANGED' })).entries;
  assert.ok(rows.some((e) => e.details?.changed?.includes('orgConnection')));
  assert.equal(JSON.stringify(rows).includes('top-secret'), false);

  assert.equal((await service.createGroup(ctx(), { namePart: 'neu' })).name, 'atlassian-PROJ-neu');

  assert.equal(await codeOf(service.removeOrgConnection(ctx({ accountId: 'u-pa', surface: 'admin' }))), 'NOT_ADMIN');
  assert.deepEqual(await service.removeOrgConnection(admin(ctx)), { configured: false });
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'noch-eine' })), 'ORG_API_NOT_CONFIGURED');
});

test('UC-01: a failed "add me" after creating the group is reported, not swallowed', async () => {
  const { service, ctx, org } = setup({ org: 'configured', store: ORG_CONFIG() });
  await service.bootstrap(ctx());
  org.addMember = async () => {
    throw Object.assign(new Error('Group Not Found'), { code: 'GROUP_NOT_FOUND' });
  };
  const created = await service.createGroup(ctx(), { namePart: 'flaky', addMe: true });
  assert.equal(created.name, 'atlassian-PROJ-flaky');
  assert.equal(created.memberCount, 0);
  assert.deepEqual(created.addMeError, { code: 'GROUP_NOT_FOUND', message: 'Group Not Found' });
  const plain = await service.createGroup(ctx(), { namePart: 'no-add-me' });
  assert.equal(plain.addMeError, null);
});
