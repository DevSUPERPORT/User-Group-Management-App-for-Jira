/**
 * Jira-admin mode ("How group changes are made"): mode resolution and back-compat, project admins' changes as pending
 * changes, Jira admins writing as themselves (asUser), the queue (apply, reject, withdraw; idempotent, re-validated,
 * 403 and consent handling, partial failures), access requests, the scheduled jobs, Rovo, the development-only test
 * switch and the data export.
 *
 * @file        test/jiraAdminMode.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryJiraUser, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { createRovoActions } from '../src/rovoActions.js';
import { AppError } from '../src/core/errors.js';

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ANNA = 'u-anna-beispiel'; // in g-reviewer
const LENA = 'u-lena-koch'; // in no PROJ group except g-big
const PA = 'u-pa';

// mode: the stored setting, or undefined (never saved).
function setup({ consent = [], config = {}, clock, secrets = null } = {}) {
  const seed = createSeed(NOW);
  seed.jira.perms[PA] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  seed.jira.users[PA] = { accountId: PA, displayName: 'Pia Projektadmin', email: 'pia@example.com' };
  seed.store.config = { ...seed.store.config, ...config };
  const store = memoryStore(seed.store);
  const audit = memoryAudit([]);
  const time = clock ?? { now: NOW };
  let n = 0;
  const jiraUser = memoryJiraUser(seed.jira, { needsConsent: consent });
  const service = createService({ jira: memoryJira(seed.jira), secrets, jiraUser, confluence: memoryConfluence(seed.jira), store, audit, now: () => time.now, uuid: () => `c${++n}` });
  const ctx = (accountId = PA, extra = {}) => ({ accountId, projectId: '10001', surface: 'project', license: null, ...extra });
  const adminCtx = (accountId = 'u-me', extra = {}) => ({ accountId, projectId: null, surface: 'admin', license: null, ...extra });
  return { service, store, audit, jira: seed.jira, jiraUser, ctx, adminCtx, time };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};
const actions = (audit) => audit._rows().map((r) => r.action).filter((a) => a !== 'PROJECT_KEY_CHANGED');

// ---------------------------------------------------------------- mode resolution


// ---------------------------------------------------------------- no organization API keys

// A fake Forge secret store holding what versions up to 3.17 could keep for the organization connection.
function legacySecrets(stored = { orgId: 'org-1', apiKey: 'secret-key-value', directoryId: 'dir-1' }) {
  const map = new Map(stored ? [['org-connection', stored]] : []);
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

test('no org keys: a key stored by an older version is deleted, audited without key material, and only once', async () => {
  const secrets = legacySecrets();
  const { service, store, audit } = setup({ secrets, config: { groupChanges: 'org' } });
  assert.deepEqual(await service.purgeLegacyOrgConnection(), { removed: true });
  assert.equal(secrets.map.size, 0, 'secret deleted');
  assert.equal('groupChanges' in (await store.get('config')), false, 'old mode setting dropped');
  const row = audit._rows().find((r) => r.action === 'CONFIG_CHANGED');
  assert.deepEqual(row.details, { changed: ['orgConnection'], removed: true, reason: 'unsupported' });
  assert.equal(row.actorName, 'system');
  assert.ok(!JSON.stringify(audit._rows()).includes('secret-key-value'), 'the key never reaches the audit log');
  assert.deepEqual(await service.purgeLegacyOrgConnection(), { removed: false }, 'idempotent');
  assert.equal(audit._rows().filter((r) => r.action === 'CONFIG_CHANGED').length, 1);
});

test('no org keys: nothing stored or no secret store -> nothing happens', async () => {
  assert.deepEqual(await setup({ secrets: legacySecrets(null) }).service.purgeLegacyOrgConnection(), { removed: false });
  assert.deepEqual(await setup().service.purgeLegacyOrgConnection(), { removed: false });
});

test('no org keys: the admin page has no connection or mode switch; the old setting is ignored and not saved again', async () => {
  const { service, adminCtx, store, ctx } = setup({ config: { groupChanges: 'org' } });
  const boot = await service.adminBootstrap(adminCtx());
  assert.equal(boot.orgApi, undefined);
  assert.equal(boot.changeMode, undefined);
  assert.equal(boot.config.groupChanges, undefined);
  for (const fn of ['testOrgApi', 'saveOrgConnection', 'removeOrgConnection']) assert.equal(service[fn], undefined, fn);
  const saved = await service.saveConfig(adminCtx(), { config: { ...boot.config, groupChanges: 'org' } });
  assert.equal(saved.config.groupChanges, undefined);
  assert.equal('groupChanges' in (await store.get('config')), false);
  // Even with the old setting stored, project admins' changes wait and Jira admins write as themselves.
  const project = await service.bootstrap(ctx());
  assert.deepEqual(project.changeMode, { effective: 'jiraAdmin', writes: 'pending' });
  assert.equal((await service.bootstrap(ctx('u-me'))).changeMode.writes, 'direct');
});

test('Jira admin: changes apply at once through Jira REST as the signed-in user', async () => {
  const { service, ctx, jira, jiraUser, audit } = setup();
  await service.bootstrap(ctx('u-me'));
  const created = await service.createGroup(ctx('u-me'), { namePart: 'direkt', addMe: true, copyFromGroupId: 'g-admins' });
  assert.equal(created.pending, undefined);
  assert.equal(created.name, 'atlassian-PROJ-direkt');
  assert.equal(created.memberCount, 3); // u-me + the other two admins
  await service.addMembers(ctx('u-me'), { groupId: 'g-reviewer', accountIds: [LENA], expiresAt: NOW + 10 * DAY });
  await service.removeMember(ctx('u-me'), { groupId: 'g-reviewer', accountId: ANNA });
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  assert.ok(!jira.groups['g-reviewer'].members.includes(ANNA));
  assert.ok(jiraUser.calls.every((c) => c.at(-1) === 'u-me'), 'every write as the signed-in Jira admin');
  assert.ok(!actions(audit).includes('CHANGE_REQUESTED'));
});

test('Jira admin: a missing consent comes back as USER_CONSENT_REQUIRED and nothing changes; grantAccess asks Forge', async () => {
  const { service, ctx, jira, jiraUser } = setup({ consent: ['u-me'] });
  await service.bootstrap(ctx('u-me'));
  const err = await service.addMembers(ctx('u-me'), { groupId: 'g-reviewer', accountIds: [LENA, 'u-mia-becker'] }).catch((e) => e);
  assert.equal(err.code, 'USER_CONSENT_REQUIRED');
  assert.equal(err.cause.name, 'NEEDS_AUTHENTICATION_ERR');
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
  // grantAccess lets Forge's own error through (src/index.js rethrows it so Forge shows "Allow access").
  await assert.rejects(service.grantAccess(ctx('u-me')), (e) => e.name === 'NEEDS_AUTHENTICATION_ERR');
  jiraUser.grantConsent('u-me');
  assert.deepEqual(await service.grantAccess(ctx('u-me')), { ok: true });
  assert.equal((await service.addMembers(ctx('u-me'), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].status, 'added');
});

// ---------------------------------------------------------------- project admins: pending changes

test('project admin: create, add, remove and undo become pending changes; nothing changes in Jira', async () => {
  const { service, ctx, jira, jiraUser, audit } = setup();
  const boot = await service.bootstrap(ctx());
  assert.deepEqual(boot.changeMode, { effective: 'jiraAdmin', writes: 'pending' });
  assert.equal(boot.changes.canApply, false);

  const created = await service.createGroup(ctx(), { namePart: 'neu', description: 'Neue Gruppe', addMe: true, copyFromGroupId: 'g-admins' });
  assert.equal(created.pending, true);
  assert.equal(created.change.type, 'create');
  assert.deepEqual(created.change.create.members.map((m) => m.accountId).sort(), [PA, ...jira.groups['g-admins'].members].sort());
  // The name is reserved while it waits.
  assert.equal((await service.checkName(ctx(), { namePart: 'neu' })).reason, 'PENDING');
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'neu' })), 'NAME_TAKEN');

  const added = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA, ANNA], expiresAt: NOW + 30 * DAY });
  assert.deepEqual(added.results.map((r) => r.status), ['pending', 'already']);
  assert.equal(added.pending, true);
  // Asking again does not queue twice.
  assert.equal((await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].changeRef, added.results[0].changeRef);

  const removed = await service.removeMember(ctx(), { groupId: 'g-reviewer', accountId: ANNA });
  assert.equal(removed.pending, true);
  assert.equal(removed.result.status, 'pending');
  const undo = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [ANNA], reason: 'undo' });
  assert.equal(undo.results[0].status, 'withdrawn', 'undoing your own waiting removal withdraws it');
  const undoAdd = await service.removeMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA], reason: 'undo' });
  assert.equal(undoAdd.results[0].status, 'withdrawn');

  assert.equal(jiraUser.calls.length, 0);
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
  assert.ok(jira.groups['g-reviewer'].members.includes(ANNA));
  assert.ok(!Object.values(jira.groups).some((g) => g.name === 'atlassian-PROJ-neu'));
  assert.deepEqual([...new Set(actions(audit))].sort(), ['CHANGE_REQUESTED', 'CHANGE_WITHDRAWN']);

  const after = await service.bootstrap(ctx());
  assert.equal(after.pendingGroups.length, 1);
  assert.equal(after.pendingGroups[0].name, 'atlassian-PROJ-neu');
  assert.equal(after.changes.pending, 1);
  const members = await service.getMembers(ctx(), { groupId: 'g-reviewer' });
  assert.deepEqual(members.pendingChanges, []);
});

test('project admin: every guardrail runs when the change is requested', async () => {
  const { service, ctx, store } = setup();
  await service.bootstrap(ctx());
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'a'.repeat(31) })), 'NAME_INVALID');
  assert.equal(await codeOf(service.createGroup(ctx(), { namePart: 'legacy-x' })), 'NAME_INVALID'); // blocked pattern
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-externe', accountIds: [LENA] })), 'GROUP_READ_ONLY');
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-big', accountIds: ['u-me'] })), 'GROUP_USED_ELSEWHERE');
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-other', accountIds: [LENA] })), 'GROUP_NOT_IN_PROJECT');
  assert.equal(await codeOf(service.addMembers(ctx(PA, { license: { isActive: false } }), { groupId: 'g-reviewer', accountIds: [LENA] })), 'LICENSE_INACTIVE');
  assert.equal((await store.list('change:')).length, 0);
});

test('project admin: can withdraw only their own waiting changes; cannot apply or reject', async () => {
  const { service, ctx, jira } = setup();
  jira.perms['u-pb'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  jira.users['u-pb'] = { accountId: 'u-pb', displayName: 'Paul B' };
  await service.bootstrap(ctx());
  const { results } = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  const ref = results[0].changeRef;
  assert.equal(await codeOf(service.applyChanges(ctx(), { refs: [ref] })), 'JIRA_ADMIN_REQUIRED');
  assert.equal(await codeOf(service.rejectChanges(ctx(), { refs: [ref] })), 'JIRA_ADMIN_REQUIRED');
  assert.equal((await service.withdrawChanges(ctx('u-pb'), { refs: [ref] })).results[0].reason, 'NOT_YOURS');
  const listed = await service.listChanges(ctx('u-pb'));
  assert.equal(listed.canApply, false);
  assert.equal(listed.changes.length, 1);
  assert.equal((await service.withdrawChanges(ctx(), { refs: [ref] })).results[0].status, 'withdrawn');
  assert.equal((await service.listChanges(ctx())).changes.length, 0);
});

// ---------------------------------------------------------------- the queue: apply and reject

test('queue: a Jira admin applies waiting changes as themselves; everything is audited', async () => {
  const { service, ctx, adminCtx, jira, jiraUser, audit, store } = setup();
  await service.bootstrap(ctx());
  const created = await service.createGroup(ctx(), { namePart: 'release', addMe: true });
  const added = await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA], expiresAt: NOW + 30 * DAY });
  const removed = await service.removeMember(ctx(), { groupId: 'g-reviewer', accountId: ANNA });

  const queue = await service.listChanges(adminCtx());
  assert.equal(queue.canApply, true);
  assert.equal(queue.changes.length, 3);
  assert.equal(await codeOf(service.applyChanges(adminCtx(PA), { refs: [created.change.ref] })), 'NOT_ADMIN');

  const res = await service.applyChanges(adminCtx(), { refs: queue.changes.map((c) => c.ref) });
  assert.deepEqual(res.results.map((r) => r.status), ['applied', 'applied', 'applied']);
  assert.equal(res.pendingCount, 0);
  const group = Object.values(jira.groups).find((g) => g.name === 'atlassian-PROJ-release');
  assert.deepEqual(group.members, [PA]);
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  assert.ok(!jira.groups['g-reviewer'].members.includes(ANNA));
  assert.equal((await store.get(`expiry:g-reviewer:${LENA}`)).expiresAt, NOW + 30 * DAY);
  assert.ok(jiraUser.calls.every((c) => c.at(-1) === 'u-me'));
  // The group belongs to the project; the creator shown is the project admin who asked.
  const boot = await service.bootstrap(ctx());
  const g = boot.groups.find((x) => x.name === 'atlassian-PROJ-release');
  assert.equal(g.createdBy.accountId, PA);
  assert.equal(boot.pendingGroups.length, 0);
  const rows = audit._rows();
  for (const a of ['CHANGE_REQUESTED', 'CHANGE_APPLIED', 'GROUP_CREATED', 'MEMBER_ADDED', 'MEMBER_REMOVED']) assert.ok(rows.some((r) => r.action === a), a);
  const applied = rows.filter((r) => r.action === 'CHANGE_APPLIED');
  assert.ok(applied.every((r) => r.actorAccountId === 'u-me' && r.details.requestedBy === 'Pia Projektadmin'));
  assert.ok(rows.find((r) => r.action === 'MEMBER_ADDED' && r.targetAccountId === LENA).details.changeRef, 'the member entry names the change');
  assert.ok(removed.pending && added.pending);
});

test('queue: applying is idempotent (already in / out / group already there) and a second apply is harmless', async () => {
  const { service, ctx, adminCtx, jira } = setup();
  await service.bootstrap(ctx());
  const add = (await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].changeRef;
  const remove = (await service.removeMember(ctx(), { groupId: 'g-reviewer', accountId: ANNA })).result.changeRef;
  const create = (await service.createGroup(ctx(), { namePart: 'schon-da', addMe: true })).change.ref;
  // Meanwhile somebody did it natively.
  jira.groups['g-reviewer'].members.push(LENA);
  jira.groups['g-reviewer'].members = jira.groups['g-reviewer'].members.filter((m) => m !== ANNA);
  jira.groups['g-native'] = { groupId: 'g-native', name: 'atlassian-PROJ-schon-da', members: [] };
  const first = await service.applyChanges(adminCtx(), { refs: [add, remove, create] });
  assert.deepEqual(first.results.map((r) => [r.status, r.alreadyDone]), [['applied', true], ['applied', true], ['applied', false]]);
  assert.deepEqual(jira.groups['g-native'].members, [PA], 'the existing group is reused and gets its first member');
  const again = await service.applyChanges(adminCtx(), { refs: [add, remove, create] });
  assert.ok(again.results.every((r) => r.status === 'applied' && r.alreadyDone));
});

test('queue: guardrails run again when applying; partial failures are reported per change, never dropped', async () => {
  const { service, ctx, adminCtx, store, jira, time } = setup();
  await service.bootstrap(ctx());
  const toIdp = (await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [LENA] })).results[0].changeRef;
  const ok = (await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].changeRef;
  const dated = (await service.addMembers(ctx(), { groupId: 'g-qa', accountIds: [LENA], expiresAt: NOW + 2 * 60 * 60 * 1000 })).results[0].changeRef;
  const blocked = (await service.createGroup(ctx(), { namePart: 'later-blocked' })).change.ref;
  // Since then: g-admins became IdP-synced, a block pattern was added, and the fixed end date passed.
  const config = await store.get('config');
  await store.set('config', { ...config, idpGroups: [...config.idpGroups, 'atlassian-PROJ-admins'], blockedGroups: [...config.blockedGroups, 'atlassian-PROJ-later-*'] });
  time.now = NOW + 3 * 60 * 60 * 1000;
  const res = await service.applyChanges(adminCtx(), { refs: [toIdp, ok, dated, blocked] });
  assert.deepEqual(res.results.map((r) => r.status), ['failed', 'applied', 'failed', 'failed']);
  assert.deepEqual(res.results.map((r) => r.code ?? null), ['GROUP_READ_ONLY', null, 'BAD_REQUEST', 'NAME_INVALID']);
  assert.equal(res.results[2].reason, 'EXPIRY_RANGE');
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  assert.ok(!jira.groups['g-admins'].members.includes(LENA));
  const left = await service.listChanges(adminCtx());
  assert.equal(left.changes.length, 3, 'failed changes stay waiting');
  assert.ok(left.changes.every((c) => c.lastError?.code));
});

test('queue: project not enabled any more, or scope guard tripped since the request -> not applied', async () => {
  const { service, ctx, adminCtx, store, jira } = setup();
  await service.bootstrap(ctx());
  const ref = (await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].changeRef;
  jira.usage['g-reviewer'].projectRoles = { status: 'ok', items: [{ projectKey: 'OPS', projectName: 'Operations', role: 'Developers' }] };
  await store.delete('usage:g-reviewer');
  assert.equal((await service.applyChanges(adminCtx(), { refs: [ref] })).results[0].code, 'GROUP_USED_ELSEWHERE');
  const config = await store.get('config');
  await store.set('config', { ...config, projectsMode: 'selected', allowedProjects: [{ id: '10002', key: 'OPS', name: 'Operations' }] });
  assert.equal((await service.applyChanges(adminCtx(), { refs: [ref] })).results[0].code, 'PROJECT_NOT_ALLOWED');
});

test('queue: Jira answers 403 -> "Only Jira administrators can apply changes", the rest of the batch stops', async () => {
  const { service, ctx, adminCtx, jira, store } = setup();
  await service.bootstrap(ctx());
  const refs = [];
  for (const id of [LENA, 'u-mia-becker']) refs.push((await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [id] })).results[0].changeRef);
  // The app saw "Administer Jira", but Jira refuses the write as this user (e.g. rights changed meanwhile).
  let calls = 0;
  const refuse = async () => {
    calls++;
    throw new AppError('JIRA_ADMIN_REQUIRED', 'Only Jira administrators can apply changes', { status: 403 });
  };
  const refusing = createService({ jira: memoryJira(jira), jiraUser: { createGroup: refuse, addMember: refuse, removeMember: refuse }, store, audit: memoryAudit([]), now: () => NOW });
  const res = await refusing.applyChanges(adminCtx(), { refs });
  assert.equal(calls, 1, 'stops after the first 403');
  assert.deepEqual(res.results.map((r) => [r.status, r.code]), [['failed', 'JIRA_ADMIN_REQUIRED'], ['failed', 'JIRA_ADMIN_REQUIRED']]);
  assert.equal(res.notJiraAdmin, true);
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
});

test('queue: missing consent at apply -> USER_CONSENT_REQUIRED for this and the rest, nothing lost; works after consent', async () => {
  const { service, ctx, adminCtx, jira, jiraUser } = setup({ consent: ['u-me'] });
  await service.bootstrap(ctx());
  const refs = [];
  for (const id of [LENA, 'u-mia-becker']) refs.push((await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [id] })).results[0].changeRef);
  const res = await service.applyChanges(adminCtx(), { refs });
  assert.equal(res.consentRequired, true);
  assert.deepEqual(res.results.map((r) => r.code), ['USER_CONSENT_REQUIRED', 'USER_CONSENT_REQUIRED']);
  assert.equal((await service.listChanges(adminCtx())).changes.length, 2);
  jiraUser.grantConsent('u-me');
  assert.ok((await service.applyChanges(adminCtx(), { refs })).results.every((r) => r.status === 'applied'));
  assert.ok(jira.groups['g-reviewer'].members.includes('u-mia-becker'));
});

test('queue: reject with a note (audited); a project page shows only its own project to Jira admins', async () => {
  const { service, ctx, adminCtx, audit, jira, store } = setup();
  await service.bootstrap(ctx());
  const ref = (await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] })).results[0].changeRef;
  // A change of another project (OPS) must not be reachable from the PROJ page.
  await store.set('change:10002:x1', { id: 'x1', projectId: '10002', projectKey: 'OPS', type: 'add', status: 'pending', groupId: 'g-other', groupName: 'atlassian-OPS-oncall', accountId: LENA, displayName: 'Lena Koch', requestedBy: { accountId: 'u-x', displayName: 'X' }, requestedAt: NOW });
  assert.equal((await service.listChanges(ctx('u-me'))).changes.length, 1);
  assert.equal((await service.listChanges(adminCtx())).changes.length, 2);
  assert.equal(await codeOf(service.applyChanges(ctx('u-me'), { refs: ['10002:x1'] })), 'BAD_REQUEST');
  const res = await service.rejectChanges(ctx('u-me'), { refs: [ref], note: 'Bitte über das Team-Lead' });
  assert.equal(res.results[0].status, 'rejected');
  const entry = audit._rows().find((r) => r.action === 'CHANGE_REJECTED');
  assert.equal(entry.details.decisionNote, 'Bitte über das Team-Lead');
  assert.equal(entry.details.requestedBy, 'Pia Projektadmin');
  // Rejected stays rejected: applying it afterwards changes nothing.
  assert.equal((await service.applyChanges(adminCtx(), { refs: [ref] })).results[0].status, 'skipped');
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
  const history = await service.listChanges(ctx(), { status: 'decided' });
  assert.equal(history.changes[0].status, 'rejected');
  assert.equal(history.changes[0].decisionNote, 'Bitte über das Team-Lead');
});

// ---------------------------------------------------------------- access requests

test('requests: a project admin approval waits for a Jira admin; the requester sees it; applying grants it', async () => {
  const { service, ctx, adminCtx, jira, store, time } = setup();
  const member = (extra = {}) => ({ accountId: LENA, projectId: '10001', surface: 'member', license: null, ...extra });
  jira.perms[LENA] = { browseOf: ['10001'] };
  const { request } = await service.requestAccess(member(), { groupId: 'g-reviewer', reason: 'Releases freigeben', durationDays: 30 });
  const decided = await service.decideRequest(ctx(), { requestId: request.id, decision: 'approve' });
  assert.equal(decided.request.status, 'waiting');
  assert.equal(decided.pending, true);
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
  assert.equal(await codeOf(service.requestAccess(member(), { groupId: 'g-reviewer', reason: 'nochmal bitte' })), 'BAD_REQUEST');
  const mine = await service.myGroups(member());
  assert.equal(mine.requests[0].status, 'waiting');
  // The duration starts when the Jira admin applies it.
  time.now = NOW + 2 * DAY;
  const res = await service.applyChanges(adminCtx(), { refs: [decided.request.pendingChangeRef] });
  assert.equal(res.results[0].status, 'applied');
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  assert.equal((await store.get(`expiry:g-reviewer:${LENA}`)).expiresAt, NOW + 32 * DAY);
  assert.equal((await service.myGroups(member())).requests[0].status, 'approved');
});

test('requests: rejected by a Jira admin -> denied with the note; withdrawn or reopened -> pending again', async () => {
  const { service, ctx, adminCtx, jira } = setup();
  const member = (accountId) => ({ accountId, projectId: '10001', surface: 'member', license: null });
  jira.perms[LENA] = { browseOf: ['10001'] };
  jira.perms['u-mia-becker'] = { browseOf: ['10001'] };
  const r1 = (await service.requestAccess(member(LENA), { groupId: 'g-reviewer', reason: 'Bitte' })).request;
  const r2 = (await service.requestAccess(member('u-mia-becker'), { groupId: 'g-reviewer', reason: 'Bitte' })).request;
  const d1 = await service.decideRequest(ctx(), { requestId: r1.id, decision: 'approve' });
  const d2 = await service.decideRequest(ctx(), { requestId: r2.id, decision: 'approve' });
  await service.rejectChanges(adminCtx(), { refs: [d1.request.pendingChangeRef], note: 'Nicht nötig' });
  const after1 = (await service.listRequests(ctx(), { status: 'all' })).requests.find((r) => r.id === r1.id);
  assert.deepEqual([after1.status, after1.note, after1.rejectedByJiraAdmin], ['denied', 'Nicht nötig', true]);
  // Reopening a waiting approval withdraws the waiting change.
  const reopened = await service.reopenRequest(ctx(), { requestId: r2.id });
  assert.equal(reopened.request.status, 'pending');
  assert.equal((await service.listChanges(adminCtx())).changes.length, 0);
  void d2;
});

test('requests: a Jira admin approving applies at once', async () => {
  const { service, ctx, jira } = setup();
  jira.perms[LENA] = { browseOf: ['10001'] };
  const { request } = await service.requestAccess({ accountId: LENA, projectId: '10001', surface: 'member', license: null }, { groupId: 'g-reviewer', reason: 'Bitte' });
  const decided = await service.decideRequest(ctx('u-me'), { requestId: request.id, decision: 'approve' });
  assert.equal(decided.request.status, 'approved');
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
});

// ---------------------------------------------------------------- scheduled jobs

test('automation: in Jira-admin mode ended memberships become one pending removal each, deduplicated', async () => {
  const { service, ctx, adminCtx, store, jira, time } = setup();
  await store.set(`expiry:g-reviewer:${ANNA}`, { groupId: 'g-reviewer', accountId: ANNA, projectId: '10001', expiresAt: NOW - 1000, setAt: NOW - DAY, setBy: null });
  const first = await service.runExpiry();
  assert.deepEqual(first, { removed: 0, dropped: 0, failed: 0, queued: 1 });
  time.now += 60 * 60 * 1000;
  assert.equal((await service.runExpiry()).queued, 0, 'not queued twice');
  assert.ok(jira.groups['g-reviewer'].members.includes(ANNA), 'nothing removed without a Jira admin');
  const [change] = (await service.listChanges(adminCtx())).changes;
  assert.deepEqual([change.type, change.reason, change.endedAt, change.requestedBy.displayName], ['remove', 'expiry', NOW - 1000, 'system']);
  // The member is shown with the ended date and the waiting removal.
  const page = await service.getMembers(ctx(), { groupId: 'g-reviewer' });
  assert.equal(page.pendingChanges[0].ref, change.ref);
  await service.applyChanges(adminCtx(), { refs: [change.ref] });
  assert.ok(!jira.groups['g-reviewer'].members.includes(ANNA));
  assert.equal(await store.get(`expiry:g-reviewer:${ANNA}`), undefined);
});

test('automation: rejecting an "access ended" removal keeps the person and clears the end date', async () => {
  const { service, adminCtx, store, jira } = setup();
  await store.set(`expiry:g-reviewer:${ANNA}`, { groupId: 'g-reviewer', accountId: ANNA, projectId: '10001', expiresAt: NOW - 1000, setAt: NOW - DAY, setBy: null });
  await service.runExpiry();
  const [change] = (await service.listChanges(adminCtx())).changes;
  await service.rejectChanges(adminCtx(), { refs: [change.ref], note: 'bleibt' });
  assert.equal(await store.get(`expiry:g-reviewer:${ANNA}`), undefined);
  assert.equal((await service.runExpiry()).queued, 0);
  assert.ok(jira.groups['g-reviewer'].members.includes(ANNA));
});

test('automation: deactivated accounts become pending removals (deduplicated, a rejection is respected)', async () => {
  const { service, adminCtx, store } = setup({ config: { autoRemoveDeactivated: true } });
  const first = await service.runAutomation();
  assert.equal(first.removed, 0);
  assert.ok(first.queued >= 1);
  assert.deepEqual(await service.runAutomation(), { removed: 0, queued: 0 });
  const queued = (await service.listChanges(adminCtx())).changes;
  assert.ok(queued.every((c) => c.reason === 'deactivated' && c.type === 'remove'));
  await service.rejectChanges(adminCtx(), { refs: [queued[0].ref] });
  assert.deepEqual(await service.runAutomation(), { removed: 0, queued: 0 }, 'a rejected removal is not asked again');
  assert.ok((await store.list('change:')).length >= 1);
});

// ---------------------------------------------------------------- Rovo

function rovoSetup(opts) {
  const s = setup({ ...opts, config: { aiEnabled: true, ...(opts?.config ?? {}) } });
  const rovo = createRovoActions(s.service, { now: () => s.time.now, env: { AI_BUDGET: '{"stop":false}' } });
  return { ...s, rovo, as: (accountId, extra = {}) => ({ principal: { accountId }, ...extra }) };
}

test('Rovo: a project admin\'s change waits for a Jira admin and the answer says so; undo withdraws it', async () => {
  const { rovo, as, jira, adminCtx, service, audit, time } = rovoSetup();
  const added = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'lena.koch@example.com' }, as(PA));
  assert.equal(added.ok, true);
  assert.equal(added.waitingForJiraAdmin, true);
  assert.match(added.note, /waiting for a Jira administrator/);
  assert.equal(added.results[0].status, 'waiting for a Jira administrator');
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
  const [change] = (await service.listChanges(adminCtx())).changes;
  assert.equal(change.via, 'rovo');
  assert.equal(audit._rows().find((r) => r.action === 'CHANGE_REQUESTED').details.via, undefined, 'rovo.js tags the Forge audit log; the record itself says via rovo');
  time.now += 10 * 60 * 1000; // a later, separate step
  const created = await rovo.createGroup({ projectKey: 'PROJ', namePart: 'rovo-team', addMe: true }, as(PA));
  assert.equal(created.waitingForJiraAdmin, true);
  assert.equal(created.created, null);
  const preview = await rovo.undoLastChange({ projectKey: 'PROJ' }, as(PA));
  assert.equal(preview.preview, true);
  const undone = await rovo.undoLastChange({ projectKey: 'PROJ', confirm: true }, as(PA));
  assert.equal(undone.withdrawn, 1);
  const left = (await service.listChanges(adminCtx())).changes;
  assert.deepEqual(left.map((c) => c.type), ['add'], 'only the last step (the new group) was withdrawn');
});

test('Rovo: a Jira admin\'s change applies at once as that user; the AI switch still gates everything', async () => {
  const { rovo, as, jira, jiraUser, service, adminCtx } = rovoSetup();
  const added = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'lena.koch@example.com' }, as('u-me'));
  assert.equal(added.waitingForJiraAdmin, undefined);
  assert.equal(added.results[0].status, 'added');
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));
  assert.deepEqual(jiraUser.calls.at(-1), ['addMember', 'g-reviewer', LENA, 'u-me']);
  const config = (await service.adminBootstrap(adminCtx())).config;
  await service.saveConfig(adminCtx(), { config: { ...config, aiEnabled: false } });
  assert.equal((await rovo.addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'mia.becker@example.com' }, as('u-me'))).code, 'AI_DISABLED');
});

test('Rovo: a missing consent is passed on to Forge (so Rovo can ask), nothing changes', async () => {
  const { rovo, as, jira } = rovoSetup({ consent: ['u-me'] });
  await assert.rejects(rovo.addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'lena.koch@example.com' }, as('u-me')), (e) => e.name === 'NEEDS_AUTHENTICATION_ERR');
  assert.ok(!jira.groups['g-reviewer'].members.includes(LENA));
});

// ---------------------------------------------------------------- TEST ONLY switch (development environment)

test('test switch: honoured only in DEVELOPMENT; production and staging ignore it completely', async () => {
  const { service, ctx, adminCtx, jira } = setup({ config: { testProjectAdmins: ['u-me'] } });
  for (const environmentType of ['PRODUCTION', 'STAGING', null, undefined, 'development ', 'Production']) {
    const boot = await service.bootstrap(ctx('u-me', { environmentType }));
    assert.equal(boot.user.isJiraAdmin, true, String(environmentType));
    assert.equal(boot.changeMode.writes, 'direct');
    assert.equal((await service.adminBootstrap(adminCtx('u-me', { environmentType }))).config.testProjectAdmins, undefined, 'hidden outside development');
  }
  await service.addMembers(ctx('u-me', { environmentType: 'PRODUCTION' }), { groupId: 'g-reviewer', accountIds: [LENA] });
  assert.ok(jira.groups['g-reviewer'].members.includes(LENA));

  const dev = (extra = {}) => ctx('u-me', { environmentType: 'DEVELOPMENT', ...extra });
  const boot = await service.bootstrap(dev());
  assert.deepEqual([boot.user.isJiraAdmin, boot.user.testProjectAdmin, boot.changeMode.writes], [false, true, 'pending']);
  const res = await service.addMembers(dev(), { groupId: 'g-reviewer', accountIds: ['u-mia-becker'] });
  assert.equal(res.results[0].status, 'pending');
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-mia-becker'));
  assert.equal(await codeOf(service.applyChanges(dev(), { refs: [res.results[0].changeRef] })), 'JIRA_ADMIN_REQUIRED');
  // The admin page keeps the real rights, so the same account applies it there.
  const admin = adminCtx('u-me', { environmentType: 'DEVELOPMENT' });
  assert.deepEqual((await service.adminBootstrap(admin)).config.testProjectAdmins, ['u-me']);
  assert.equal((await service.applyChanges(admin, { refs: [res.results[0].changeRef] })).results[0].status, 'applied');
});

test('test switch: can only be set in DEVELOPMENT; saving in production keeps it untouched and invisible', async () => {
  const { service, adminCtx, store } = setup();
  const prod = adminCtx('u-me', { environmentType: 'PRODUCTION' });
  const config = (await service.adminBootstrap(prod)).config;
  const saved = await service.saveConfig(prod, { config: { ...config, testProjectAdmins: ['u-me'] } });
  assert.equal(saved.config.testProjectAdmins, undefined);
  assert.deepEqual(saved.changed, []);
  assert.deepEqual((await store.get('config')).testProjectAdmins, []);
  const dev = adminCtx('u-me', { environmentType: 'DEVELOPMENT' });
  const devSaved = await service.saveConfig(dev, { config: { ...config, testProjectAdmins: ['u-me', 'bad id!', 'u-me'] } });
  assert.deepEqual(devSaved.config.testProjectAdmins, ['u-me']);
  assert.deepEqual(devSaved.changed, ['testProjectAdmins']);
  // A later production save does not wipe or show it.
  await service.saveConfig(prod, { config: { ...config, retentionMonths: 12 } });
  assert.deepEqual((await store.get('config')).testProjectAdmins, ['u-me']);
});

test('test switch: Rovo honours it only in DEVELOPMENT too', async () => {
  const { service, jira } = rovoSetup({ config: { testProjectAdmins: ['u-me'] } });
  const make = (environmentType) => createRovoActions(service, { now: () => NOW, env: { AI_BUDGET: '{"stop":false}' }, environmentType: () => environmentType });
  const prod = await make('PRODUCTION').addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'lena.koch@example.com' }, { principal: { accountId: 'u-me' } });
  assert.equal(prod.results[0].status, 'added');
  const dev = await make('DEVELOPMENT').addMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'mia.becker@example.com' }, { principal: { accountId: 'u-me' } });
  assert.equal(dev.waitingForJiraAdmin, true);
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-mia-becker'));
});

// ---------------------------------------------------------------- data export / import

test('export/import: waiting changes (change:) move with the data', async () => {
  const { service, ctx, adminCtx } = setup();
  await service.bootstrap(ctx());
  await service.addMembers(ctx(), { groupId: 'g-reviewer', accountIds: [LENA] });
  const meta = await service.exportData(adminCtx(), { part: 'meta' });
  assert.ok(meta.prefixes.includes('change:'));
  const entries = [];
  let cursor = null;
  do {
    const page = await service.exportData(adminCtx(), { part: 'kvs', cursor });
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor);
  const changes = entries.filter((e) => e.key.startsWith('change:'));
  assert.equal(changes.length, 1);
  const target = setup();
  await target.service.importData(target.adminCtx(), { part: 'kvs', entries: changes });
  assert.equal((await target.service.listChanges(target.adminCtx())).changes[0].accountId, LENA);
});
