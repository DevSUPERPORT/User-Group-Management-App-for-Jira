/**
 * Project roles: project admins add and remove people in their own project's roles, at once and with their own Jira
 * rights (asUser, like Jira's project settings). Groups in roles are read-only. Also the cross-project waiting count
 * that Jira admins see on project pages.
 *
 * @file        test/roles.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryJiraUser, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

const NOW = Date.UTC(2026, 10, 23, 10, 0, 0);
const PA = 'u-pa';
const ANNA = 'u-anna-beispiel';
const MAX = 'u-max-muster';

function setup({ consent = [], config = {} } = {}) {
  const seed = createSeed(NOW);
  seed.jira.perms[PA] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  seed.jira.users[PA] = { accountId: PA, displayName: 'Pia Projektadmin', email: null };
  seed.store.config = { ...seed.store.config, ...config };
  const audit = memoryAudit([]);
  const jiraUser = memoryJiraUser(seed.jira, { needsConsent: consent });
  const service = createService({ jira: memoryJira(seed.jira), jiraUser, store: memoryStore(seed.store), audit, now: () => NOW });
  const ctx = (accountId = PA, extra = {}) => ({ accountId, projectId: '10001', surface: 'project', license: null, ...extra });
  const roleOf = (name) => seed.jira.roles['10001'].find((r) => r.name === name);
  return { service, audit, jiraUser, jira: seed.jira, ctx, roleOf };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details?.reason ?? e.code;
  }
  return null;
};

test('roles: a project admin sees the roles of the project, people and groups; Jira\'s app role is hidden', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  const { roles } = await service.listRoles(ctx());
  assert.deepEqual(roles.map((r) => r.name), ['Administrators', 'Developers', 'Viewers']);
  const dev = roles.find((r) => r.name === 'Developers');
  assert.deepEqual(dev.people.map((p) => p.accountId).sort(), [ANNA, 'u-lena-koch']);
  assert.deepEqual(dev.groups.map((g) => [g.groupId, g.managed]), [['g-big', true]]);
});

test('roles: adding people applies at once with the project admin\'s own rights, audited; already in -> "already"', async () => {
  const { service, ctx, jiraUser, audit, roleOf } = setup();
  const res = await service.addRoleMembers(ctx(), { roleId: '10001', accountIds: [MAX, ANNA] });
  assert.deepEqual(res.results.map((r) => [r.accountId, r.status]), [[MAX, 'added'], [ANNA, 'already']]);
  assert.ok(roleOf('Developers').users.includes(MAX), 'in the role at once, no Jira admin needed');
  assert.deepEqual(jiraUser.calls.find((c) => c[0] === 'addRoleActor'), ['addRoleActor', '10001', '10001', MAX, PA], 'written as the project admin');
  const row = audit._rows().find((r) => r.action === 'ROLE_MEMBER_ADDED');
  assert.deepEqual([row.targetAccountId, row.actorAccountId, row.groupName, row.details.role, row.projectKey], [MAX, PA, 'Developers (project role)', 'Developers', 'PROJ']);
  assert.equal(audit._rows().filter((r) => r.action === 'CHANGE_REQUESTED').length, 0, 'nothing waits for a Jira admin');
});

test('roles: removing applies at once; not in the role -> already done; removing yourself is refused', async () => {
  const { service, ctx, roleOf, audit } = setup();
  const res = await service.removeRoleMember(ctx(), { roleId: '10001', accountId: ANNA });
  assert.equal(res.alreadyDone, false);
  assert.ok(!roleOf('Developers').users.includes(ANNA));
  assert.ok(audit._rows().some((r) => r.action === 'ROLE_MEMBER_REMOVED' && r.targetAccountId === ANNA));
  assert.equal((await service.removeRoleMember(ctx(), { roleId: '10001', accountId: ANNA })).alreadyDone, true);
  roleOf('Administrators').users.push(PA);
  assert.equal(await codeOf(service.removeRoleMember(ctx(), { roleId: '10002', accountId: PA })), 'SELF');
  assert.ok(roleOf('Administrators').users.includes(PA));
  // Undo puts the person back.
  await service.addRoleMembers(ctx(), { roleId: '10001', accountIds: [ANNA], reason: 'undo' });
  assert.ok(roleOf('Developers').users.includes(ANNA));
  assert.equal(audit._rows().find((r) => r.action === 'ROLE_MEMBER_ADDED').details.reason, 'undo');
});

test('roles: only the project\'s admins; hidden or foreign roles, licence and the Jira admin switch are enforced', async () => {
  const { service, ctx, jira } = setup();
  jira.perms['u-lena-koch'] = { projectAdminOf: [] };
  assert.equal(await codeOf(service.listRoles(ctx('u-lena-koch'))), 'FORBIDDEN');
  assert.equal(await codeOf(service.addRoleMembers(ctx('u-lena-koch'), { roleId: '10001', accountIds: [MAX] })), 'FORBIDDEN');
  assert.equal(await codeOf(service.addRoleMembers(ctx(), { roleId: '10004', accountIds: [MAX] })), 'ROLE_NOT_FOUND', 'app role hidden');
  assert.equal(await codeOf(service.addRoleMembers(ctx(), { roleId: '99999', accountIds: [MAX] })), 'ROLE_NOT_FOUND');
  assert.equal(await codeOf(service.addRoleMembers(ctx(), { roleId: '10001', accountIds: [] })), 'BAD_REQUEST');
  assert.equal(await codeOf(service.addRoleMembers(ctx(PA, { license: { isActive: false } }), { roleId: '10001', accountIds: [MAX] })), 'LICENSE_INACTIVE');
  const off = setup({ config: { rolesEnabled: false } });
  assert.equal(await codeOf(off.service.listRoles(off.ctx())), 'ROLES_OFF');
  assert.equal((await off.service.bootstrap(off.ctx())).rolesEnabled, false);
});

test('roles: a missing consent stops the batch with USER_CONSENT_REQUIRED and changes nothing', async () => {
  const { service, ctx, roleOf } = setup({ consent: [PA] });
  const res = await service.addRoleMembers(ctx(), { roleId: '10001', accountIds: [MAX, 'u-jonas-weber'] });
  assert.equal(res.consentRequired, true);
  assert.deepEqual(res.results.map((r) => [r.status, r.code]), [['failed', 'USER_CONSENT_REQUIRED'], ['failed', 'USER_CONSENT_REQUIRED']]);
  assert.ok(!roleOf('Developers').users.includes(MAX));
});

test('roles: the switch is saved and sanitised (on unless turned off)', async () => {
  const { service } = setup();
  const admin = { accountId: 'u-me', projectId: null, surface: 'admin', license: null };
  const boot = await service.adminBootstrap(admin);
  assert.equal(boot.config.rolesEnabled, true);
  const saved = await service.saveConfig(admin, { config: { ...boot.config, rolesEnabled: false } });
  assert.equal(saved.config.rolesEnabled, false);
  assert.ok(saved.changed.includes('rolesEnabled'));
  assert.equal((await service.saveConfig(admin, { config: { ...boot.config, rolesEnabled: 'yes' } })).config.rolesEnabled, true);
});

test('queue: Jira admins see everything that waits across projects on a project page; project admins do not', async () => {
  const { service, ctx, jira } = setup();
  await service.bootstrap(ctx());
  const outsider = Object.keys(jira.users).find((id) => id !== PA && jira.users[id].active !== false && !jira.groups['g-reviewer'].members.includes(id));
  const res = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [outsider] });
  assert.equal(res.results[0].status, 'pending');
  const asAdmin = await service.bootstrap(ctx('u-me'));
  assert.equal(asAdmin.changes.pendingAll, 1);
  assert.equal((await service.bootstrap(ctx())).changes.pendingAll, undefined);
});

test('roles: groups can be added and removed at once with the project admin\'s own rights, audited', async () => {
  const { service, ctx, jiraUser, audit, roleOf } = setup();
  await service.bootstrap(ctx());
  const res = await service.addRoleGroups(ctx(), { roleId: '10003', groupIds: ['g-qa', 'g-reviewer'] });
  assert.deepEqual(res.results.map((r) => [r.groupId, r.status]), [['g-qa', 'added'], ['g-reviewer', 'already']]);
  assert.ok(roleOf('Viewers').groups.includes('g-qa'));
  assert.ok(jiraUser.calls.some((c) => c[0] === 'addRoleGroup' && c.at(-1) === PA), 'runs as the project admin');
  const added = audit._rows().find((r) => r.action === 'ROLE_MEMBER_ADDED');
  assert.equal(added.targetName, 'atlassian-PRJ-qa');
  assert.equal(added.details.actorType, 'group');

  const removed = await service.removeRoleGroup(ctx(), { roleId: '10003', groupId: 'g-qa' });
  assert.equal(removed.alreadyDone, false);
  assert.equal(roleOf('Viewers').groups.includes('g-qa'), false);
  assert.equal((await service.removeRoleGroup(ctx(), { roleId: '10003', groupId: 'g-qa' })).alreadyDone, true);
  assert.ok(audit._rows().some((r) => r.action === 'ROLE_MEMBER_REMOVED' && r.details.actorGroupId === 'g-qa'));
});

test('roles: protected groups (admin, product access, blocked list) cannot be added or removed here', async () => {
  const { service, ctx, roleOf } = setup();
  await service.bootstrap(ctx());
  const res = await service.addRoleGroups(ctx(), { roleId: '10003', groupIds: ['g-site'] });
  assert.equal(res.results[0].status, 'failed');
  assert.equal(res.results[0].code, 'GROUP_BLOCKED');
  assert.equal(roleOf('Viewers').groups.includes('g-site'), false);
  roleOf('Viewers').groups.push('g-site');
  assert.equal(await codeOf(service.removeRoleGroup(ctx(), { roleId: '10003', groupId: 'g-site' })), 'ROLE_GROUP_LOCKED');
  const listed = (await service.listRoles(ctx())).roles.find((r) => r.name === 'Viewers').groups.find((g) => g.groupId === 'g-site');
  assert.equal(listed.locked, true);
});

test('roles: group search suggests the project\'s own groups first and leaves protected groups out', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  const empty = await service.searchRoleGroups(ctx(), { query: '' });
  assert.ok(empty.groups.length > 0 && empty.groups.every((g) => g.own), 'without a query: own groups');
  const all = await service.searchRoleGroups(ctx(), { query: 'ad' });
  assert.ok(!all.groups.some((g) => g.name === 'site-admins'), 'protected group left out');
  assert.ok(all.groups.some((g) => g.name === 'atlassian-PROJ-admins' && g.own));
  // Not a project admin: nothing.
  assert.notEqual(await codeOf(service.searchRoleGroups(ctx('u-lena-koch'), { query: 'ad' })), null);
});
