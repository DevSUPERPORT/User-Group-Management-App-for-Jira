import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { runIndexStep } from '../src/core/confluenceIndex.js';

const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function setup({ config = {}, confluence = true } = {}) {
  const seed = createSeed(NOW);
  const clock = { now: NOW };
  const store = memoryStore({ ...seed.store, config: { ...seed.store.config, ...config } });
  const audit = memoryAudit([]);
  let n = 0;
  const service = createService({
    jira: memoryJira(seed.jira),
    org: memoryOrg(seed.jira),
    confluence: memoryConfluence(seed.jira, { available: confluence }),
    store,
    audit,
    now: () => clock.now,
    uuid: () => `id-${++n}`,
  });
  const admin = () => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null });
  const member = (accountId = 'u-lena-koch') => ({ accountId, projectId: '10001', surface: 'member', license: null });
  seed.jira.perms['u-lena-koch'] = { browseOf: ['10001'] };
  return { service, store, audit, jira: seed.jira, clock, admin, member };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details?.reason ?? e.code;
  }
  return null;
};

// ---------------------------------------------------------------- UC-06 usage

test('usage: all Jira checks with status, Confluence spaces and indexed pages', async () => {
  const { service, admin } = setup();
  await service.bootstrap(admin());
  await service.runConfluenceIndex({ budget: 100 });
  const u = await service.getUsage(admin(), { groupId: 'g-reviewer' });
  for (const key of ['permissionSchemes', 'workflows', 'projectRoles', 'notificationSchemes', 'issueSecurity', 'filters', 'dashboards']) {
    assert.equal(u[key].status, 'ok', key);
  }
  assert.equal(u.workflows.items[1].transition, 'Backlog');
  assert.deepEqual(u.workflows.items[1].types, ['restrictTransition']);
  assert.equal(u.confluenceSpaces.status, 'ok');
  assert.deepEqual(u.confluenceSpaces.items, [{ spaceKey: 'PROJ', spaceName: 'Superport Plattform Doku', operations: ['create:page', 'read:space'] }]);
  assert.equal(u.confluencePages.status, 'ok');
  assert.deepEqual(u.confluencePages.items.map((p) => [p.title, p.spaceKey, p.ops.join('+')]).sort(), [
    ['Release-Freigaben', 'PROJ', 'update'],
    ['Review-Checkliste', 'PROJ', 'read'],
  ]);
});

test('usage: without Confluence the Confluence checks say "not installed", never "0"', async () => {
  const { service, admin } = setup({ confluence: false });
  await service.bootstrap(admin());
  const u = await service.getUsage(admin(), { groupId: 'g-reviewer' });
  assert.equal(u.confluenceSpaces.status, 'unavailable');
  assert.equal(u.confluencePages.reason, 'NOT_INSTALLED');
});

test('confluence index: scans in batches, finishes a pass and prunes removed restrictions', async () => {
  const { store, jira } = setup();
  const confluence = memoryConfluence(jira);
  let clock = NOW;
  const step = (budget) => runIndexStep({ confluence, store, now: () => clock, budget });

  let r = await step(2);
  assert.equal(r.finished, false);
  assert.equal(r.state.cursor, '2');
  r = await step(10);
  assert.equal(r.finished, true);
  assert.equal(r.state.lastFullScanAt, NOW);
  assert.equal(Object.keys((await store.get('cfidx:g:g-reviewer')) ?? {}).length, 2);

  // The restriction on p5 is removed and p1 is deleted: the next full pass prunes both.
  jira.confluence.pages = jira.confluence.pages.filter((p) => p.id !== 'p1');
  jira.confluence.pages.find((p) => p.id === 'p5').restrictions = [];
  clock = NOW + DAY;
  r = await step(100);
  assert.equal(r.finished, true);
  assert.deepEqual(Object.keys((await store.get('cfidx:g:g-reviewer')) ?? {}), []);
  assert.deepEqual(Object.keys((await store.get('cfidx:g:g-admins')) ?? {}), ['p3']);
});

// ---------------------------------------------------------------- access requests

test('access requests: member requests, admin approves with the requested duration; undo removes again', async () => {
  const { service, admin, member, audit, jira } = setup();
  await service.bootstrap(admin());
  const before = await service.myGroups(member());
  assert.ok(before.requestable.some((g) => g.groupId === 'g-admins'));
  assert.ok(!before.requestable.some((g) => g.groupId === 'g-externe'), 'IdP groups cannot be requested');

  assert.equal(await codeOf(service.requestAccess(member(), { groupId: 'g-admins', reason: '' })), 'REASON_REQUIRED');
  const { request } = await service.requestAccess(member(), { groupId: 'g-admins', reason: 'Release duty in November', durationDays: 30 });
  assert.equal(request.status, 'pending');
  assert.equal(await codeOf(service.requestAccess(member(), { groupId: 'g-admins', reason: 'again' })), 'ALREADY_REQUESTED');
  assert.equal(await codeOf(service.requestAccess(member(), { groupId: 'g-big', reason: 'need it' })), 'ALREADY_MEMBER');
  assert.equal(await codeOf(service.requestAccess(member(), { groupId: 'g-externe', reason: 'need it' })), 'GROUP_READ_ONLY');

  assert.equal((await service.bootstrap(admin())).pendingRequests, 1);
  const pending = await service.listRequests(admin());
  assert.equal(pending.requests.length, 1);

  const decided = await service.decideRequest(admin(), { requestId: request.id, decision: 'approve', note: 'ok for November' });
  assert.equal(decided.request.status, 'approved');
  assert.ok(jira.groups['g-admins'].members.includes('u-lena-koch'));
  assert.equal(decided.member.expiresAt, NOW + 30 * DAY);
  const actions = audit._rows().map((r) => r.action);
  assert.deepEqual(actions.slice(-3), ['ACCESS_REQUESTED', 'MEMBER_ADDED', 'ACCESS_REQUEST_APPROVED']);
  assert.equal(audit._rows().find((r) => r.action === 'MEMBER_ADDED').details.reason, 'request');

  const mine = await service.myGroups(member());
  assert.equal(mine.requests[0].status, 'approved');
  assert.ok(mine.groups.some((g) => g.groupId === 'g-admins' && g.expiresAt === NOW + 30 * DAY));

  // Undo of the approval
  const reopened = await service.reopenRequest(admin(), { requestId: request.id });
  assert.equal(reopened.request.status, 'pending');
  assert.ok(!jira.groups['g-admins'].members.includes('u-lena-koch'));
  assert.equal(audit._rows().at(-1).action, 'ACCESS_REQUEST_REOPENED');
});

test('access requests: deny, withdraw, disabled, outsiders', async () => {
  const { service, admin, member, jira } = setup();
  await service.bootstrap(admin());
  const { request } = await service.requestAccess(member(), { groupId: 'g-reviewer', reason: 'Need review rights' });
  const denied = await service.decideRequest(admin(), { requestId: request.id, decision: 'deny', note: 'Please ask your lead' });
  assert.equal(denied.request.status, 'denied');
  assert.equal(denied.request.note, 'Please ask your lead');
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-lena-koch'));
  assert.equal(await codeOf(service.decideRequest(admin(), { requestId: request.id, decision: 'approve' })), 'NOT_PENDING');

  const second = await service.requestAccess(member(), { groupId: 'g-reviewer', reason: 'Asked my lead' });
  const withdrawn = await service.withdrawRequest(member(), { requestId: second.request.id });
  assert.equal(withdrawn.request.status, 'withdrawn');
  assert.equal(await codeOf(service.withdrawRequest(member('u-anna-beispiel'), { requestId: second.request.id })), 'FORBIDDEN');

  jira.perms['u-outsider'] = {};
  jira.users['u-outsider'] = { accountId: 'u-outsider', displayName: 'Outsider' };
  assert.equal(await codeOf(service.requestAccess(member('u-outsider'), { groupId: 'g-reviewer', reason: 'let me in' })), 'FORBIDDEN');

  const off = setup({ config: { requestsEnabled: false } });
  assert.equal(await codeOf(off.service.requestAccess(off.member(), { groupId: 'g-reviewer', reason: 'x y z' })), 'REQUESTS_DISABLED');
  assert.deepEqual((await off.service.myGroups(off.member())).requestable, []);
});

// ---------------------------------------------------------------- access reviews

test('periodic access review: due after the interval, completing resets it and is audited', async () => {
  const { service, admin, clock, audit } = setup({ config: { reviewIntervalMonths: 3 } });
  let boot = await service.bootstrap(admin());
  const admins = () => boot.groups.find((g) => g.groupId === 'g-admins');
  assert.equal(admins().reviewDue, false, 'created 40 days ago');
  clock.now = NOW + 60 * DAY;
  boot = await service.bootstrap(admin());
  assert.equal(admins().reviewDue, true);
  assert.equal(boot.groups.find((g) => g.groupId === 'g-externe').reviewDue, true, 'never reviewed, no creation date');

  const res = await service.completeReview(admin(), { groupId: 'g-admins', note: 'Q4 review', removed: 1 });
  assert.equal(res.reviewDue, false);
  assert.equal(res.lastReviewedBy, 'George Papasotiriou');
  assert.deepEqual(audit._rows().at(-1).details, { removed: 1, note: 'Q4 review' });

  const off = setup();
  assert.equal((await off.service.bootstrap(off.admin())).groups.every((g) => g.reviewDue === false), true);
});

// ---------------------------------------------------------------- automation & compliance

test('deactivated accounts: preview lists them; automation only runs when switched on and never touches IdP groups', async () => {
  const { service, admin, store, audit, jira } = setup();
  await service.bootstrap(admin());
  const adminCtx = { accountId: 'u-me', projectId: null, surface: 'admin', license: null };
  const preview = await service.previewDeactivatedCleanup(adminCtx);
  assert.deepEqual([...new Set(preview.items.map((i) => i.groupId))], ['g-big']);
  assert.equal(preview.items.length, 2);

  assert.deepEqual(await service.runAutomation(), { removed: 0, skipped: 'disabled' });
  assert.equal(jira.groups['g-big'].members.length, 38);

  await store.set('config', { ...(await store.get('config')), autoRemoveDeactivated: true });
  jira.groups['g-externe'].members.push('u-tom-fischer');
  const res = await service.runAutomation();
  assert.equal(res.removed, 2);
  assert.equal(jira.groups['g-big'].members.length, 36);
  assert.ok(jira.groups['g-externe'].members.includes('u-tom-fischer'), 'IdP group untouched');
  const auto = audit._rows().filter((r) => r.action === 'MEMBER_AUTO_REMOVED');
  assert.equal(auto.length, 2);
  assert.equal(auto[0].actorName, 'system');
  assert.equal(auto[0].projectKey, 'PROJ');

  const notAdmin = { accountId: 'u-lena-koch', projectId: null, surface: 'admin', license: null };
  assert.equal(await codeOf(service.previewDeactivatedCleanup(notAdmin)), 'NOT_ADMIN');
});

test('compliance overview for Jira admins: reviews due, expiring soon, pending requests, index state', async () => {
  const { service, admin, member, clock } = setup({ config: { reviewIntervalMonths: 3 } });
  await service.bootstrap(admin());
  await service.requestAccess(member(), { groupId: 'g-admins', reason: 'Release duty' });
  clock.now = NOW + 60 * DAY;
  const boot = await service.adminBootstrap({ accountId: 'u-me', projectId: null, surface: 'admin', license: null });
  assert.equal(boot.compliance.pendingRequests, 1);
  assert.ok(boot.compliance.reviewsDue.some((r) => r.groupId === 'g-admins' && r.projectKey === 'PROJ'));
  assert.ok(boot.compliance.expiringSoon.length >= 1, 'seeded expiry within 14 days');
  assert.equal(boot.confluence.available, true);
});

test('config: new switches are sanitised', async () => {
  const { service } = setup();
  const res = await service.saveConfig(
    { accountId: 'u-me', projectId: null, surface: 'admin', license: null },
    { config: { reviewIntervalMonths: '6', requestsEnabled: false, autoRemoveDeactivated: 'yes' } },
  );
  assert.equal(res.config.reviewIntervalMonths, 6);
  assert.equal(res.config.requestsEnabled, false);
  assert.equal(res.config.autoRemoveDeactivated, false, 'only an explicit true switches automation on');
  const bad = await service.saveConfig({ accountId: 'u-me', projectId: null, surface: 'admin', license: null }, { config: { reviewIntervalMonths: 5 } });
  assert.equal(bad.config.reviewIntervalMonths, null);
});

// ---------------------------------------------------------------- Rovo helpers

test('Rovo helpers: project key resolution and group lookup by short or full name, with permission checks', async () => {
  const { service, admin } = setup();
  await service.bootstrap(admin());
  const project = await service.resolveProjectKey('PROJ');
  assert.equal(project.id, '10001');
  assert.equal(await codeOf(service.resolveProjectKey('NOPE')), 'PROJECT_NOT_FOUND');
  assert.equal((await service.findOwnedGroup(admin(), 'reviewer')).groupId, 'g-reviewer');
  assert.equal((await service.findOwnedGroup(admin(), 'ATLASSIAN-PROJ-REVIEWER')).groupId, 'g-reviewer');
  assert.equal(await codeOf(service.findOwnedGroup(admin(), 'oncall')), 'GROUP_NOT_IN_PROJECT');
  assert.equal(await codeOf(service.findOwnedGroup({ ...admin(), accountId: 'u-lena-koch' }, 'reviewer')), 'FORBIDDEN');
});
