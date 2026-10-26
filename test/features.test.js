import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function setup(configPatch = {}) {
  const seed = createSeed(NOW);
  const clock = { now: NOW };
  const store = memoryStore({ ...seed.store, config: { ...seed.store.config, ...configPatch } });
  const audit = memoryAudit([]);
  let n = 0;
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), store, audit, now: () => clock.now, uuid: () => `id-${++n}` });
  const ctx = (extra = {}) => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null, ...extra });
  return { service, store, audit, jira: seed.jira, clock, ctx };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details?.reason ?? e.code;
  }
  return null;
};

const ANNA = 'u-anna-beispiel';
const LENA = 'u-lena-koch';

test('time-limited membership: stored, shown, validated and audited', async () => {
  const { service, ctx, audit, store } = setup();
  await service.bootstrap(ctx());
  const until = NOW + 30 * DAY;
  const res = await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: until });
  assert.equal(res.results[0].expiresAt, until);
  assert.equal((await store.get(`expiry:g-admins:${ANNA}`)).expiresAt, until);

  const page = await service.getMembers(ctx(), { groupId: 'g-admins', maxResults: 50 });
  const anna = page.members.find((m) => m.accountId === ANNA);
  assert.equal(anna.expiresAt, until);
  assert.equal(anna.addedBy, 'George Papasotiriou');
  assert.deepEqual(audit._rows().at(-1).details, { expiresAt: until });

  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [LENA], expiresAt: NOW + 60_000 })), 'EXPIRY_RANGE');
  assert.equal(await codeOf(service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [LENA], expiresAt: NOW + 800 * DAY })), 'EXPIRY_RANGE');

  const off = setup({ expiryEnabled: false });
  await off.service.bootstrap(off.ctx());
  assert.equal(await codeOf(off.service.addMembers(off.ctx(), { groupId: 'g-admins', accountIds: [LENA], expiresAt: until })), 'EXPIRY_DISABLED');
});

test('expiry run removes due memberships with a system audit entry and leaves others alone', async () => {
  const { service, ctx, audit, store, jira, clock } = setup();
  await service.bootstrap(ctx());
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: NOW + 2 * DAY });
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [LENA], expiresAt: NOW + 20 * DAY });

  clock.now = NOW + 3 * DAY;
  const summary = await service.runExpiry();
  assert.deepEqual(summary, { removed: 1, dropped: 0, failed: 0 });
  assert.ok(!jira.groups['g-admins'].members.includes(ANNA));
  assert.ok(jira.groups['g-admins'].members.includes(LENA));
  const expired = audit._rows().find((r) => r.action === 'MEMBER_EXPIRED');
  assert.equal(expired.targetAccountId, ANNA);
  assert.equal(expired.actorName, 'system');
  assert.equal(expired.projectKey, 'PROJ');
  assert.equal(await store.get(`expiry:g-admins:${ANNA}`), undefined);

  // Nothing due anymore: idempotent.
  assert.deepEqual(await service.runExpiry(), { removed: 0, dropped: 0, failed: 0 });
});

test('expiry run never touches IdP-managed or blocked groups', async () => {
  const { service, store, jira, clock } = setup();
  await store.set(`expiry:g-externe:${ANNA}`, { groupId: 'g-externe', accountId: ANNA, expiresAt: NOW - 1 });
  await store.set('group:g-externe', { groupId: 'g-externe', name: 'atlassian-PROJ-externe', projectId: '10001' });
  jira.groups['g-externe'].members.push(ANNA);
  clock.now = NOW + DAY;
  assert.deepEqual(await service.runExpiry(), { removed: 0, dropped: 1, failed: 0 });
  assert.ok(jira.groups['g-externe'].members.includes(ANNA));
});

test('undo of a removal restores the membership and its previous end date', async () => {
  const { service, ctx, audit, store } = setup();
  await service.bootstrap(ctx());
  const until = NOW + 10 * DAY;
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: until });

  const removed = await service.removeMember(ctx(), { groupId: 'g-admins', accountId: ANNA });
  assert.equal(removed.removed.previousExpiry, until);
  assert.equal(await store.get(`expiry:g-admins:${ANNA}`), undefined);

  const undo = await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiries: { [ANNA]: until }, reason: 'undo' });
  assert.equal(undo.results[0].status, 'added');
  assert.equal((await store.get(`expiry:g-admins:${ANNA}`)).expiresAt, until);
  assert.deepEqual(audit._rows().at(-1).details, { expiresAt: until, reason: 'undo' });

  // An unknown reason is not recorded.
  await service.removeMember(ctx(), { groupId: 'g-admins', accountId: ANNA });
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], reason: 'because' });
  assert.equal(audit._rows().at(-1).details, null);
});

test('access review removes several members with a note; undo of an add uses the same path', async () => {
  const { service, ctx, audit, jira } = setup();
  await service.bootstrap(ctx());
  const before = jira.groups['g-reviewer'].members.slice(0, 3);
  const res = await service.removeMembers(ctx(), { groupId: 'g-reviewer', accountIds: before, note: 'Quarterly access review' });
  assert.deepEqual(res.results.map((r) => r.status), ['removed', 'removed', 'removed']);
  assert.equal(res.memberCount, 9);
  const rows = audit._rows().filter((r) => r.action === 'MEMBER_REMOVED');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].details, { note: 'Quarterly access review', reason: 'review' });

  const tooMany = Array.from({ length: 51 }, (_, i) => `u-x-${i}`);
  assert.equal(await codeOf(service.removeMembers(ctx(), { groupId: 'g-reviewer', accountIds: tooMany })), 'TOO_MANY');

  // Undo an accidental add.
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA, LENA] });
  const undo = await service.removeMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA, LENA], reason: 'undo' });
  assert.equal(undo.results.length, 2);
  assert.deepEqual(audit._rows().at(-1).details, { reason: 'undo' });
  assert.ok(!jira.groups['g-admins'].members.includes(ANNA));
});

test('access review rejects IdP-managed groups and foreign groups', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  assert.equal(await codeOf(service.removeMembers(ctx(), { groupId: 'g-externe', accountIds: [ANNA] })), 'GROUP_READ_ONLY');
  assert.equal(await codeOf(service.removeMembers(ctx(), { groupId: 'g-other', accountIds: [ANNA] })), 'GROUP_NOT_IN_PROJECT');
});

test('changing an end date is audited with from/to and can be undone', async () => {
  const { service, ctx, audit, store } = setup();
  await service.bootstrap(ctx());
  const a = NOW + 5 * DAY;
  const b = NOW + 50 * DAY;
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: a });
  const changed = await service.setExpiry(ctx(), { groupId: 'g-admins', accountId: ANNA, expiresAt: b });
  assert.deepEqual(changed, { expiresAt: b, previous: a });
  assert.deepEqual(audit._rows().at(-1).details, { from: a, to: b });

  const cleared = await service.setExpiry(ctx(), { groupId: 'g-admins', accountId: ANNA, expiresAt: null });
  assert.equal(cleared.expiresAt, null);
  assert.equal(await store.get(`expiry:g-admins:${ANNA}`), undefined);

  await service.setExpiry(ctx(), { groupId: 'g-admins', accountId: ANNA, expiresAt: b, reason: 'undo' });
  assert.deepEqual(audit._rows().at(-1).details, { from: null, to: b, reason: 'undo' });
  assert.equal(await codeOf(service.setExpiry(ctx(), { groupId: 'g-admins', accountId: LENA, expiresAt: b })), 'NOT_A_MEMBER');
});

test('pasted lists resolve to accounts for review: matched, ambiguous, not found, duplicate', async () => {
  const { service, ctx } = setup();
  const { rows } = await service.resolveUsers(ctx(), {
    entries: ['anna.beispiel@example.com', 'Lena Koch', 'lena koch', 'nobody@nowhere.test', 'Anna Beispiel', 'an', ''],
  });
  const by = Object.fromEntries(rows.map((r) => [r.input, r]));
  assert.equal(by['anna.beispiel@example.com'].status, 'matched');
  assert.equal(by['anna.beispiel@example.com'].user.accountId, ANNA);
  assert.equal(by['Lena Koch'].status, 'matched');
  assert.equal(by['lena koch'].status, 'duplicate');
  assert.equal(by['nobody@nowhere.test'].status, 'notFound');
  assert.equal(by['Anna Beispiel'].status, 'duplicate');
  assert.equal(by.an.status, 'ambiguous');
  assert.ok(by.an.candidates.length > 1);
  assert.equal(rows.length, 6, 'empty entries are dropped');

  const many = Array.from({ length: 51 }, (_, i) => `person${i}@example.com`);
  assert.equal(await codeOf(service.resolveUsers(ctx(), { entries: many })), 'TOO_MANY');
});

test('member CSV export includes provenance and end dates', async () => {
  const { service, ctx } = setup();
  await service.bootstrap(ctx());
  const until = NOW + 30 * DAY;
  await service.addMembers(ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: until });
  const res = await service.exportMembers(ctx(), { groupId: 'g-admins' });
  assert.equal(res.count, 4);
  assert.match(res.filename, /^members-atlassian-PROJ-admins-2026-10-23\.csv$/);
  const annaLine = res.csv.split('\r\n').find((l) => l.includes(ANNA));
  assert.ok(annaLine.includes('George Papasotiriou'));
  assert.ok(annaLine.includes(new Date(until).toISOString()));
});

test('"My groups": members see only their own groups of this project, nothing about others', async () => {
  const { service, jira, store, ctx } = setup();
  await service.bootstrap(ctx());
  jira.perms['u-lena-koch'] = { browseOf: ['10001'] };
  await store.set('expiry:g-reviewer:u-lena-koch', { groupId: 'g-reviewer', accountId: 'u-lena-koch', expiresAt: NOW + 7 * DAY });
  jira.groups['g-reviewer'].members.push('u-lena-koch');

  const res = await service.myGroups({ accountId: 'u-lena-koch', projectId: '10001', surface: 'member' });
  assert.equal(res.enabled, true);
  // Lena is in "alle-entwickler" (seed) and was just added to "reviewer".
  assert.deepEqual(res.groups.map((g) => g.namePart), ['alle-entwickler', 'reviewer']);
  assert.equal(res.groups.find((g) => g.namePart === 'reviewer').expiresAt, NOW + 7 * DAY);
  assert.equal(res.groups.find((g) => g.namePart === 'alle-entwickler').expiresAt, null);
  assert.equal(res.groups[0].memberCount, undefined, 'no member counts');
  assert.equal(JSON.stringify(res).includes('Anna'), false, 'no other people');

  jira.perms['u-outsider'] = {};
  jira.users['u-outsider'] = { accountId: 'u-outsider', displayName: 'Outsider' };
  assert.equal(await codeOf(service.myGroups({ accountId: 'u-outsider', projectId: '10001', surface: 'member' })), 'FORBIDDEN');

  const off = setup({ memberViewEnabled: false });
  assert.equal((await off.service.myGroups({ accountId: 'u-lena-koch', projectId: '10001', surface: 'member' })).enabled, false);
});

test('auditors read and export the full log; everyone else is refused', async () => {
  const { service, jira, ctx } = setup({ auditorGroups: ['iso-auditors'] });
  await service.bootstrap(ctx());
  jira.groups['g-iso'] = { groupId: 'g-iso', name: 'iso-auditors', members: ['u-lena-koch'] };
  jira.perms['u-lena-koch'] = {};
  // A fresh context per call, as in Forge (the service caches permissions on it).
  const as = (accountId) => ({ accountId, projectId: null, surface: 'auditor', license: null });
  const auditor = as('u-lena-koch');

  const boot = await service.auditorBootstrap(auditor);
  assert.equal(boot.user.isJiraAdmin, false);
  const log = await service.queryAudit(auditor, { filters: { period: 'all' } });
  assert.ok(log.entries.some((e) => e.action === 'PROJECT_KEY_CHANGED'));
  assert.ok((await service.exportAudit(as('u-lena-koch'), {})).count >= 1);

  jira.perms['u-anna-beispiel'] = {};
  assert.equal(await codeOf(service.auditorBootstrap(as('u-anna-beispiel'))), 'NOT_AUDITOR');
  assert.equal(await codeOf(service.queryAudit(as('u-anna-beispiel'), {})), 'NOT_AUDITOR');

  // Jira admins are always auditors.
  assert.equal((await service.auditorBootstrap(as('u-admin'))).user.isJiraAdmin, true);
});

test('saving the configuration returns the previous one for undo; undo is audited', async () => {
  const { service, audit } = setup();
  const admin = { accountId: 'u-me', projectId: null, surface: 'admin', license: null };
  const first = await service.saveConfig(admin, { config: { retentionMonths: 12, auditorGroups: ['iso-auditors'] } });
  assert.equal(first.previous.retentionMonths, null);
  assert.deepEqual(first.config.auditorGroups, ['iso-auditors']);
  assert.equal(first.config.memberViewEnabled, true);
  const undo = await service.saveConfig(admin, { config: first.previous, reason: 'undo' });
  assert.equal(undo.config.retentionMonths, null);
  assert.equal(audit._rows().at(-1).details.reason, 'undo');
});

test('description can be edited afterwards, is audited, and can be undone', async () => {
  const { service, ctx, audit, store } = setup();
  await service.bootstrap(ctx());
  const res = await service.updateDescription(ctx(), { groupId: 'g-big', description: '  Alle Entwickler:innen, inkl. Externe  ' });
  assert.deepEqual(res, { description: 'Alle Entwickler:innen, inkl. Externe', previous: 'Alle Entwicklerinnen und Entwickler im Projekt' });
  assert.equal((await store.get('group:g-big')).description, 'Alle Entwickler:innen, inkl. Externe');
  const entry = audit._rows().at(-1);
  assert.equal(entry.action, 'DESCRIPTION_CHANGED');
  assert.deepEqual(entry.details, { from: 'Alle Entwicklerinnen und Entwickler im Projekt', to: 'Alle Entwickler:innen, inkl. Externe' });

  // Unchanged text writes nothing.
  const count = audit._rows().length;
  await service.updateDescription(ctx(), { groupId: 'g-big', description: 'Alle Entwickler:innen, inkl. Externe' });
  assert.equal(audit._rows().length, count);

  // Undo restores the previous text.
  await service.updateDescription(ctx(), { groupId: 'g-big', description: res.previous, reason: 'undo' });
  assert.equal((await store.get('group:g-big')).description, 'Alle Entwicklerinnen und Entwickler im Projekt');
  assert.equal(audit._rows().at(-1).details.reason, 'undo');

  // Length limit, ownership, licence.
  const long = await service.updateDescription(ctx(), { groupId: 'g-big', description: 'x'.repeat(900) });
  assert.equal(long.description.length, 500);
  assert.equal(await codeOf(service.updateDescription(ctx(), { groupId: 'g-other', description: 'x' })), 'GROUP_NOT_IN_PROJECT');
  assert.equal(await codeOf(service.updateDescription(ctx({ license: { isActive: false } }), { groupId: 'g-big', description: 'y' })), 'LICENSE_INACTIVE');
});

test('discovered groups (no description yet) can get one; blocked groups cannot', async () => {
  const { service, ctx, store } = setup();
  await service.bootstrap(ctx());
  const res = await service.updateDescription(ctx(), { groupId: 'g-externe', description: 'Externe Partner (IdP)' });
  assert.equal(res.previous, '');
  assert.equal((await store.get('group:g-externe')).description, 'Externe Partner (IdP)');
  assert.equal(await codeOf(service.updateDescription(ctx(), { groupId: 'g-jsw', description: 'x' })), 'GROUP_NOT_IN_PROJECT');
});

test('writes need the Organization API; without it nothing is written', async () => {
  const seed = createSeed(NOW);
  const audit = memoryAudit([]);
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira, { configured: false }), store: memoryStore(seed.store), audit, now: () => NOW });
  const ctx = { accountId: 'u-me', projectId: '10001', surface: 'project', license: null };
  await service.bootstrap({ ...ctx });
  assert.equal(await codeOf(service.createGroup({ ...ctx }, { namePart: 'neu' })), 'ORG_API_NOT_CONFIGURED');
  assert.equal(await codeOf(service.addMembers({ ...ctx }, { groupId: 'g-admins', accountIds: [ANNA] })), 'ORG_API_NOT_CONFIGURED');
  assert.equal(await codeOf(service.removeMembers({ ...ctx }, { groupId: 'g-admins', accountIds: [ANNA] })), 'ORG_API_NOT_CONFIGURED');
  assert.ok(!seed.jira.groups['g-admins'].members.includes(ANNA));
  assert.equal(audit._rows().filter((r) => r.action !== 'PROJECT_KEY_CHANGED').length, 0);
});
