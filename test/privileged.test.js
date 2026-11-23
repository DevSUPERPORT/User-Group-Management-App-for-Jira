/**
 * Automatic changes (privileged admin, like CSUM's "privileged user"): a Jira admin lets project admins' group changes
 * and the scheduled removals apply at once with their account (Forge offline impersonation). Switching on and off,
 * who may, direct writes with the right account and audit, the scope checks that still apply, pausing when the
 * account can no longer apply changes, and the scheduled jobs.
 *
 * @file        test/privileged.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryJiraUser, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { TRANSFER_PREFIXES } from '../src/core/transfer.js';

const NOW = Date.UTC(2026, 10, 23, 10, 0, 0);
const ANNA = 'u-anna-beispiel'; // in g-reviewer
const LENA = 'u-lena-koch'; // not in g-reviewer
const PA = 'u-pa';
const ADMIN = 'u-me'; // Jira admin

function setup({ consent = [], config = {}, impersonation = true, on = false } = {}) {
  const seed = createSeed(NOW);
  seed.jira.perms[PA] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  seed.jira.users[PA] = { accountId: PA, displayName: 'Pia Projektadmin', email: 'pia@example.com', active: true };
  seed.store.config = { ...seed.store.config, ...config };
  const store = memoryStore(seed.store);
  const audit = memoryAudit([]);
  let n = 0;
  const jiraUser = memoryJiraUser(seed.jira, { needsConsent: consent, impersonation });
  const service = createService({ jira: memoryJira(seed.jira), jiraUser, confluence: memoryConfluence(seed.jira), store, audit, now: () => NOW, uuid: () => `c${++n}` });
  const ctx = (accountId = PA) => ({ accountId, projectId: '10001', surface: 'project', license: null });
  const adminCtx = (accountId = ADMIN) => ({ accountId, projectId: null, surface: 'admin', license: null });
  return { service, store, audit, jira: seed.jira, jiraUser, ctx, adminCtx, ready: on ? service.setPrivilegedAdmin(adminCtx()) : Promise.resolve() };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};
const rows = (audit, action) => audit._rows().filter((r) => r.action === action);
const writes = (jiraUser) => jiraUser.calls.filter((c) => ['createGroup', 'addMember', 'removeMember'].includes(c[0]));

test('automatic changes: off by default, project admins’ changes wait for a Jira admin', async () => {
  const { service, ctx, adminCtx, jira, jiraUser } = setup();
  assert.deepEqual((await service.adminBootstrap(adminCtx())).privileged, { on: false, paused: false });
  assert.equal((await service.bootstrap(ctx())).changeMode.writes, 'pending');
  const res = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  assert.equal(res.pending, true);
  assert.equal(jira.groups['g-reviewer'].members.includes(LENA), false);
  assert.equal(writes(jiraUser).length, 0);
});

test('automatic changes: only a Jira admin switches it on, only for themselves, after checking the app can act for them', async () => {
  const { service, ctx, adminCtx, audit, jiraUser } = setup();
  assert.equal(await codeOf(service.setPrivilegedAdmin({ ...ctx(), surface: 'admin', projectId: null })), 'NOT_ADMIN');
  // Whatever the payload says, the account is the caller's own.
  const { privileged } = await service.setPrivilegedAdmin(adminCtx(), { accountId: 'u-admin' });
  assert.equal(privileged.on, true);
  assert.equal(privileged.accountId, ADMIN);
  assert.ok(jiraUser.calls.some((c) => c[0] === 'checkImpersonation' && c[1] === ADMIN));
  const row = rows(audit, 'CONFIG_CHANGED').at(-1);
  assert.equal(row.actorAccountId, ADMIN);
  assert.equal(row.details.privilegedAdmin, 'on');
  assert.deepEqual(row.details.changed, ['privilegedAdmin']);
  assert.equal((await service.adminBootstrap(adminCtx())).privileged.displayName, row.actorName);
});

test('automatic changes: switching on needs the admin’s own consent and working impersonation', async () => {
  const noConsent = setup({ consent: [ADMIN] });
  assert.equal(await codeOf(noConsent.service.setPrivilegedAdmin(noConsent.adminCtx())), 'USER_CONSENT_REQUIRED');
  assert.equal((await noConsent.service.adminBootstrap(noConsent.adminCtx())).privileged.on, false);

  const blocked = setup({ impersonation: false });
  let err;
  try {
    await blocked.service.setPrivilegedAdmin(blocked.adminCtx());
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'PRIVILEGED_ADMIN_UNAVAILABLE');
  assert.equal(err.details.reason, 'IMPERSONATION');
  assert.equal((await blocked.service.adminBootstrap(blocked.adminCtx())).privileged.on, false);
});

test('automatic changes: project admins’ changes apply at once as the privileged admin, audited with both names', async () => {
  const { service, ctx, jira, jiraUser, audit, ready } = setup({ on: true });
  await ready;
  const boot = await service.bootstrap(ctx());
  assert.equal(boot.changeMode.writes, 'direct');
  assert.equal(boot.changeMode.effective, 'automatic');

  const added = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  assert.equal(added.pending, undefined);
  assert.equal(added.results[0].status, 'added');
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  const removed = await service.removeMember(ctx(), { groupId: 'g-reviewer', accountId: ANNA });
  assert.equal(removed.pending, undefined);
  assert.equal(jira.groups['g-reviewer'].members.includes(ANNA), false);
  const created = await service.createGroup(ctx(), { namePart: 'auto-team', addMe: true });
  assert.equal(created.pending, undefined);
  assert.ok(Object.values(jira.groups).some((g) => g.name === created.name && g.members.includes(PA)));

  // Every Jira write ran as the privileged admin, never as the project admin.
  assert.ok(writes(jiraUser).length >= 4);
  assert.ok(writes(jiraUser).every((c) => c.at(-1) === ADMIN));
  for (const action of ['MEMBER_ADDED', 'MEMBER_REMOVED', 'GROUP_CREATED']) {
    const row = rows(audit, action).at(-1);
    assert.equal(row.actorAccountId, PA, `${action} actor is the project admin`);
    assert.ok(row.details?.appliedAs, `${action} notes the account it was applied with`);
  }
  assert.equal(rows(audit, 'CHANGE_REQUESTED').length, 0, 'nothing waits');
});

test('automatic changes: the project admin’s own limits still apply', async () => {
  const { service, ctx, jira, ready } = setup({ on: true });
  await ready;
  // A group the project does not own (here: site-admins) is not theirs, even with automatic changes on.
  assert.notEqual(await codeOf(service.addMembers(ctx(), { groupId: 'g-site', accountIds: [LENA] })), null);
  assert.equal(jira.groups['g-site'].members.includes(LENA), false);
  // Someone who is not a project admin gets nothing.
  assert.notEqual(await codeOf(service.addMembers(ctx(LENA), { groupId: 'g-reviewer', accountIds: [LENA] })), null);
  assert.equal(jira.groups['g-reviewer'].members.includes(LENA), false);
});

test('automatic changes: pause when the account is no longer a Jira admin; changes wait again until switched on again', async () => {
  const { service, ctx, adminCtx, jira, audit, ready } = setup({ on: true });
  await ready;
  jira.perms[ADMIN].jiraAdmin = false;
  const res = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  assert.equal(res.pending, true, 'waits for a Jira admin instead');
  const paused = rows(audit, 'CONFIG_CHANGED').at(-1);
  assert.equal(paused.details.privilegedAdmin, 'paused');
  assert.equal(paused.details.reason, 'NOT_ADMIN');
  // Rights back: still paused until a Jira admin switches it on again.
  jira.perms[ADMIN].jiraAdmin = true;
  const state = (await service.adminBootstrap(adminCtx())).privileged;
  assert.equal(state.on, false);
  assert.equal(state.paused, true);
  assert.equal(state.pausedReason, 'NOT_ADMIN');
  assert.equal((await service.bootstrap(ctx())).changeMode.writes, 'pending');
  await service.setPrivilegedAdmin(adminCtx());
  assert.equal((await service.bootstrap(ctx())).changeMode.writes, 'direct');
});

test('automatic changes: a withdrawn permission pauses them at the first write, with a clear error', async () => {
  const { service, ctx, adminCtx, jiraUser, ready } = setup({ on: true });
  await ready;
  jiraUser.withdrawConsent(ADMIN);
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })), 'PRIVILEGED_ADMIN_UNAVAILABLE');
  assert.equal((await service.adminBootstrap(adminCtx())).privileged.pausedReason, 'ADMIN_CONSENT');
  const next = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  assert.equal(next.pending, true);
});

test('automatic changes: any Jira admin can switch them off', async () => {
  const { service, ctx, adminCtx, audit, ready } = setup({ on: true });
  await ready;
  const { privileged } = await service.clearPrivilegedAdmin(adminCtx('u-admin'));
  assert.equal(privileged.on, false);
  const row = rows(audit, 'CONFIG_CHANGED').at(-1);
  assert.equal(row.actorAccountId, 'u-admin');
  assert.equal(row.details.privilegedAdmin, 'off');
  assert.equal((await service.bootstrap(ctx())).changeMode.writes, 'pending');
  assert.equal(await codeOf(service.clearPrivilegedAdmin({ ...ctx(), surface: 'admin', projectId: null })), 'NOT_ADMIN');
});

test('automatic changes: ended memberships and deactivated accounts are removed at once by the scheduled jobs', async () => {
  const { service, store, jira, audit, jiraUser, ready } = setup({ on: true, config: { autoRemoveDeactivated: true } });
  await ready;
  await store.set(`expiry:g-reviewer:${ANNA}`, { groupId: 'g-reviewer', accountId: ANNA, projectId: '10001', expiresAt: NOW - 1000, setAt: NOW - 10_000, setBy: { accountId: PA, displayName: 'Pia' } });
  const summary = await service.runExpiry();
  assert.equal(summary.removed, 1);
  assert.equal(summary.queued, 0);
  assert.equal(jira.groups['g-reviewer'].members.includes(ANNA), false);
  assert.equal(await store.get(`expiry:g-reviewer:${ANNA}`), undefined);
  const expired = rows(audit, 'MEMBER_EXPIRED').at(-1);
  assert.equal(expired.actorName, 'system');
  assert.ok(expired.details.appliedAs);

  const member = jira.groups['g-reviewer'].members[0];
  jira.users[member].active = false;
  const auto = await service.runAutomation();
  assert.ok(auto.removed >= 1);
  assert.equal(auto.queued, 0);
  assert.equal(jira.groups['g-reviewer'].members.includes(member), false);
  assert.ok(rows(audit, 'MEMBER_AUTO_REMOVED').every((r) => r.details.appliedAs));
  assert.ok(writes(jiraUser).every((c) => c.at(-1) === ADMIN));
});

test('automatic changes: scheduled removals wait for a Jira admin when they are off or paused', async () => {
  const { service, store, jira, jiraUser, ready } = setup({ on: true });
  await ready;
  jiraUser.withdrawConsent(ADMIN);
  await store.set(`expiry:g-reviewer:${ANNA}`, { groupId: 'g-reviewer', accountId: ANNA, projectId: '10001', expiresAt: NOW - 1000, setAt: NOW - 10_000 });
  const summary = await service.runExpiry();
  assert.equal(summary.removed, 0);
  assert.equal(summary.queued, 1, 'paused at the first write, then queued');
  assert.ok(jira.groups['g-reviewer'].members.includes(ANNA));
  assert.ok((await store.get(`expiry:g-reviewer:${ANNA}`)).pendingChangeRef);
});

test('automatic changes: the designation is never exported (each installation decides itself)', () => {
  assert.ok(!TRANSFER_PREFIXES.some((p) => 'privileged-admin'.startsWith(p) || p === 'privileged-admin'));
});

test('setup checklist: a new site starts open; access, mode and announcement are tracked; hide and reopen', async () => {
  const { service, adminCtx, store } = setup({ consent: [ADMIN] });
  let s = (await service.adminBootstrap(adminCtx())).setup;
  assert.deepEqual([s.dismissed, s.access, s.mode, s.announced, s.complete], [false, false, null, false, false]);
  // Access granted (simulated), then "I'll review each change" and the copied message.
  const fresh = setup();
  s = (await fresh.service.adminBootstrap(fresh.adminCtx())).setup;
  assert.equal(s.access, true);
  s = (await fresh.service.updateSetup(fresh.adminCtx(), { step: 'review' })).setup;
  assert.equal(s.mode, 'review');
  s = (await fresh.service.updateSetup(fresh.adminCtx(), { step: 'announced' })).setup;
  assert.equal(s.complete, true);
  // Automatic changes count as the chosen mode.
  await fresh.service.setPrivilegedAdmin(fresh.adminCtx());
  assert.equal((await fresh.service.adminBootstrap(fresh.adminCtx())).setup.mode, 'automatic');
  s = (await fresh.service.updateSetup(fresh.adminCtx(), { step: 'dismiss' })).setup;
  assert.equal(s.dismissed, true);
  s = (await fresh.service.updateSetup(fresh.adminCtx(), { step: 'reopen' })).setup;
  assert.equal(s.dismissed, false);
  // Jira admins only; unknown steps refused; never exported.
  assert.equal(await codeOf(fresh.service.updateSetup({ ...fresh.adminCtx(PA) }, { step: 'dismiss' })), 'NOT_ADMIN');
  assert.equal(await codeOf(fresh.service.updateSetup(fresh.adminCtx(), { step: 'nope' })), 'BAD_REQUEST');
  assert.ok(!TRANSFER_PREFIXES.some((p) => p === 'setup' || 'setup'.startsWith(p)));
  void store;
});
