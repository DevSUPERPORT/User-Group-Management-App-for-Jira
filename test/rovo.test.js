/**
 * Tests for the Rovo actions on the in-memory backend: identity and permission checks, read actions, member
 * changes, end dates and requests, the preview-then-confirm bulk actions, and the admin-only AI switch (off by default).
 *
 * @file        test/rovo.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-16
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { AI_DISABLED_MESSAGE, AI_STOPPED_MESSAGE, createRovoActions } from '../src/rovoActions.js';
import { vendorAiStop } from '../src/core/aiBudget.js';

const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);

// ai: the app setting "AI features (Rovo agent)"; null = never saved (a fresh or older installation).
// env: the Forge environment variables (AI_BUDGET); undefined = the process environment.
function setup({ idp = [], ai = true, env } = {}) {
  const seed = createSeed(NOW);
  seed.store.config.idpGroups.push(...idp);
  if (ai !== null) seed.store.config.aiEnabled = ai;
  const audit = memoryAudit([]);
  const rovoAudit = { ...audit, append: (e) => audit.append({ ...e, details: { ...(e.details ?? {}), via: 'rovo' } }) };
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), confluence: memoryConfluence(seed.jira), store: memoryStore(seed.store), audit: rovoAudit, now: () => NOW, env });
  const rovo = createRovoActions(service, { now: () => NOW, env });
  // Forge passes the calling user in the invocation context.
  const as = (accountId = 'u-me') => ({ principal: { accountId } });
  return { rovo, service, audit, jira: seed.jira, as };
}

const adminCtx = (accountId = 'u-me') => ({ accountId, projectId: null, surface: 'admin', license: null });

test('AI switch: off by default, and every Rovo action refuses while it is off', async () => {
  const { rovo, service, as, jira } = setup({ ai: null });
  assert.equal(await service.isAiEnabled(), false);
  assert.equal((await service.adminBootstrap(adminCtx())).config.aiEnabled, false);
  for (const [name, fn] of Object.entries(rovo)) {
    const res = await fn({ projectKey: 'PROJ', groupName: 'admins', people: 'Lena Koch', confirm: true }, as());
    assert.deepEqual(res, { ok: false, error: AI_DISABLED_MESSAGE, code: 'AI_DISABLED', nothingChanged: true }, name);
  }
  assert.ok(!jira.groups['g-admins'].members.includes('u-lena-koch'), 'nothing changed');
  // Saving other settings keeps it off.
  const saved = await service.saveConfig(adminCtx(), { config: { retentionMonths: 12 } });
  assert.equal(saved.config.aiEnabled, false);
});

test('AI switch: only Jira admins can turn it on; the change is logged with on/off; Rovo then works', async () => {
  const { rovo, service, as, audit, jira } = setup({ ai: false });
  jira.perms['u-pa'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  const config = (await service.adminBootstrap(adminCtx())).config;
  await assert.rejects(service.saveConfig(adminCtx('u-pa'), { config: { ...config, aiEnabled: true } }), (err) => err.code === 'NOT_ADMIN');
  assert.equal(await service.isAiEnabled(), false);
  assert.equal((await rovo.listGroups({ projectKey: 'PROJ' }, as())).code, 'AI_DISABLED');

  const on = await service.saveConfig(adminCtx(), { config: { ...config, aiEnabled: true } });
  assert.deepEqual(on.changed, ['aiEnabled']);
  const entry = audit._rows().at(-1);
  assert.equal(entry.action, 'CONFIG_CHANGED');
  assert.equal(entry.actorAccountId, 'u-me');
  assert.deepEqual(entry.details.changed, ['aiEnabled']);
  assert.equal(entry.details.aiEnabled, true);
  assert.equal((await service.bootstrap({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null })).config.aiEnabled, true);

  const groups = await rovo.listGroups({ projectKey: 'PROJ' }, as());
  assert.equal(groups.ok, true);
  const added = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'admins', people: 'lena.koch@example.com' }, as());
  assert.equal(added.ok, true);
  assert.equal(audit._rows().at(-1).details.via, 'rovo');

  await service.saveConfig(adminCtx(), { config: { ...on.config, aiEnabled: false } });
  assert.equal(audit._rows().at(-1).details.aiEnabled, false);
  assert.equal((await rovo.listGroups({ projectKey: 'PROJ' }, as())).code, 'AI_DISABLED');
});

const STOPPED = 'AI features of this app are temporarily turned off by the app vendor. Please try again later.';
const STOP = { AI_BUDGET: '{"stop":true}' };

test('AI_BUDGET: only a JSON object with stop: true stops; unset, invalid or another shape is no stop and warns once', () => {
  const warnings = [];
  const stop = (v) => vendorAiStop(v === undefined ? {} : { AI_BUDGET: v }, (m) => warnings.push(m));
  assert.equal(stop('{"stop":true}'), true);
  assert.equal(stop(' {"stop":true,"limit":5,"note":"x"} '), true, 'other fields are ignored');
  assert.equal(stop('{"stop":false}'), false);
  assert.equal(stop('{"stop":false,"limit":0}'), false);
  assert.deepEqual(warnings, [], 'valid values do not warn');
  assert.equal(stop(undefined), false, 'unset');
  assert.equal(stop(''), false, 'empty');
  // Warnings are remembered per value for the whole process (other tests may have seen "unset"), so count new ones.
  const bad = ['true', '{stop:true}', '{"stop":"true"}', '{"stop":1}', '[true]', 'null', '{}', '{"Stop":true}'];
  const before = warnings.length;
  for (const v of bad) {
    assert.equal(stop(v), false, `no stop for ${JSON.stringify(v)}`);
    assert.equal(stop(v), false, `still no stop for ${JSON.stringify(v)}`);
  }
  assert.equal(warnings.length - before, bad.length, 'one warning per bad value, not one per call');
  assert.match(warnings.at(-1), /AI_BUDGET/);
  assert.equal(AI_STOPPED_MESSAGE, STOPPED);
});

test('AI_BUDGET stop: every Rovo action refuses with the vendor text even when a Jira admin turned AI on', async () => {
  const { rovo, service, as, jira } = setup({ ai: true, env: STOP });
  assert.equal(await service.isAiEnabled(), true, "the admin's own setting is kept");
  for (const [name, fn] of Object.entries(rovo)) {
    const res = await fn({ projectKey: 'PROJ', groupName: 'admins', people: 'Lena Koch', confirm: true }, as());
    assert.deepEqual(res, { ok: false, error: STOPPED, code: 'AI_STOPPED', nothingChanged: true }, name);
  }
  assert.ok(!jira.groups['g-admins'].members.includes('u-lena-koch'), 'nothing changed');
  // Customer switch off as well: the vendor text, so nobody looks for a setting that would not help.
  const off = setup({ ai: false, env: STOP });
  assert.equal((await off.rovo.listGroups({ projectKey: 'PROJ' }, off.as())).code, 'AI_STOPPED');
  // The pages are told: the admin page shows the notice, the project page hides "Ask Rovo".
  assert.equal((await service.adminBootstrap(adminCtx())).aiStopped, true);
  const boot = await service.bootstrap({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null });
  assert.equal(boot.config.aiEnabled, true);
  assert.equal(boot.config.aiStopped, true);
});

test('AI_BUDGET {"stop":false}: Rovo works when a Jira admin turned AI on, and stays off when not', async () => {
  const env = { AI_BUDGET: '{"stop":false}' };
  const { rovo, service, as } = setup({ ai: true, env });
  assert.equal((await rovo.listGroups({ projectKey: 'PROJ' }, as())).ok, true);
  assert.equal((await service.adminBootstrap(adminCtx())).aiStopped, false);
  const off = setup({ ai: false, env });
  assert.equal((await off.rovo.listGroups({ projectKey: 'PROJ' }, off.as())).code, 'AI_DISABLED');
});

test('Rovo: no identity, no action', async () => {
  const { rovo } = setup();
  const res = await rovo.listGroups({ projectKey: 'PROJ' }, {});
  assert.equal(res.ok, false);
  assert.equal(res.nothingChanged, true);
});

test('Rovo: list, details, where-used and compliance for a project admin', async () => {
  const { rovo, as } = setup();
  const groups = await rovo.listGroups({ projectKey: 'proj' }, as());
  assert.equal(groups.ok, true);
  assert.ok(groups.groups.some((g) => g.name === 'atlassian-PROJ-reviewer'));
  const details = await rovo.groupDetails({ projectKey: 'PROJ', groupName: 'admins' }, as());
  assert.equal(details.group, 'atlassian-PROJ-admins');
  assert.equal(details.memberCount, 3);
  const used = await rovo.whereUsed({ projectKey: 'PROJ', groupName: 'reviewer' }, as());
  assert.equal(used.usage.workflows.length, 2);
  assert.equal(used.usage.confluenceSpaces[0].spaceKey, 'PROJ');
  const comp = await rovo.complianceCheck({ projectKey: 'PROJ' }, as());
  assert.ok(comp.deactivatedAccounts.length >= 2);
});

test('Rovo: people who are not project admins get nothing', async () => {
  const { rovo, as, jira } = setup();
  jira.perms['u-lena-koch'] = { browseOf: ['10001'] };
  const res = await rovo.listGroups({ projectKey: 'PROJ' }, as('u-lena-koch'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FORBIDDEN');
});

test('Rovo: add members adds only unambiguous matches, with end date, audited via Rovo', async () => {
  const { rovo, as, audit, jira } = setup();
  const res = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'admins', people: 'lena.koch@example.com, an, nobody@nowhere.test', endDate: '2026-12-31' }, as());
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ person: 'Lena Koch', status: 'added', until: '2026-12-31' }]);
  assert.deepEqual(res.notAdded.map((n) => n.input), ['an', 'nobody@nowhere.test']);
  assert.ok(jira.groups['g-admins'].members.includes('u-lena-koch'));
  assert.equal(audit._rows().at(-1).details.via, 'rovo');

  const tooMany = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'admins', people: Array.from({ length: 11 }, (_, i) => `p${i}@x.test`).join(',') }, as());
  assert.equal(tooMany.code, 'TOO_MANY');
  const badDate = await rovo.addMembers({ projectKey: 'PROJ', groupName: 'admins', people: 'Mia Becker', endDate: '31.12.2026' }, as());
  assert.equal(badDate.code, 'DATE_FORMAT');
  assert.ok(!jira.groups['g-admins'].members.includes('u-mia-becker'), 'nothing added on a bad date');
});

test('Rovo: remove only matches current members; blocked/IdP groups refused', async () => {
  const { rovo, as, jira } = setup({ idp: ['atlassian-PRJ-qa'] });
  const res = await rovo.removeMembers({ projectKey: 'PROJ', groupName: 'reviewer', people: 'Anna Beispiel, Lena Koch' }, as());
  assert.deepEqual(res.results, [{ person: 'Anna Beispiel', status: 'removed' }]);
  assert.deepEqual(res.notRemoved, [{ input: 'Lena Koch', why: 'not a member of this group' }]);
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-anna-beispiel'));

  const idp = await rovo.removeMembers({ projectKey: 'PROJ', groupName: 'qa', people: jira.users[jira.groups['g-qa'].members[0]].displayName }, as());
  assert.equal(idp.ok, false);
  assert.equal(idp.code, 'GROUP_READ_ONLY');
  const foreign = await rovo.removeMembers({ projectKey: 'OPS', groupName: 'oncall', people: 'x' }, as());
  assert.equal(foreign.ok, false);
});

test('Rovo: end date, description and request decisions', async () => {
  const { rovo, as, jira } = setup();
  const end = await rovo.setEndDate({ projectKey: 'PROJ', groupName: 'admins', person: 'George Papasotiriou', endDate: '2027-01-15' }, as());
  assert.equal(end.until, '2027-01-15');
  const cleared = await rovo.setEndDate({ projectKey: 'PROJ', groupName: 'admins', person: 'George Papasotiriou', endDate: 'none' }, as());
  assert.equal(cleared.until, null);
  const desc = await rovo.updateDescription({ projectKey: 'PROJ', groupName: 'qa', description: 'Externe Partner' }, as());
  assert.equal(desc.description, 'Externe Partner');

  // A pending request from Lena, decided through Rovo.
  jira.perms['u-lena-koch'] = { browseOf: ['10001'] };
  const none = await rovo.decideRequest({ projectKey: 'PROJ', person: 'Lena Koch', decision: 'approve' }, as());
  assert.equal(none.ok, false);
});

test('Rovo: person access lists the groups of one person in the project', async () => {
  const { rovo, as } = setup();
  const res = await rovo.personAccess({ projectKey: 'PROJ', person: 'Anna Beispiel' }, as());
  assert.equal(res.ok, true);
  assert.ok(res.memberOf.some((g) => g.group === 'atlassian-PROJ-reviewer'));
  assert.ok(!res.memberOf.some((g) => g.group.includes('OPS')), 'other projects stay out');
  const nobody = await rovo.personAccess({ projectKey: 'PROJ', person: 'Nobody Here' }, as());
  assert.equal(nobody.code, 'NOT_FOUND');
});

test('Rovo: bulk actions preview first and change only with confirm', async () => {
  const { rovo, as, jira } = setup();
  // Same groups as George (admins + reviewer?) for Mia: preview changes nothing.
  const preview = await rovo.copyAccess({ projectKey: 'PROJ', fromPerson: 'Anna Beispiel', toPeople: 'Mia Becker' }, as());
  assert.equal(preview.preview, true);
  assert.ok(preview.planned.length > 0);
  assert.ok(preview.planned.every((c) => c.change === 'add' && c.person === 'Mia Becker'));
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-mia-becker'));
  const done = await rovo.copyAccess({ projectKey: 'PROJ', fromPerson: 'Anna Beispiel', toPeople: 'Mia Becker', confirm: true }, as());
  assert.ok(done.results.every((r) => r.status === 'added'));
  assert.ok(jira.groups['g-reviewer'].members.includes('u-mia-becker'));

  // Undo takes exactly that step back.
  const undoPreview = await rovo.undoLastChange({ projectKey: 'PROJ' }, as());
  assert.equal(undoPreview.planned.length, done.results.length);
  assert.ok(undoPreview.planned.every((c) => c.change === 'remove'));
  await rovo.undoLastChange({ projectKey: 'PROJ', confirm: 'true' }, as());
  assert.ok(!jira.groups['g-reviewer'].members.includes('u-mia-becker'));
});

test('Rovo: offboarding removes one person from every changeable project group; undo restores', async () => {
  const { rovo, as, jira } = setup();
  const anna = 'u-anna-beispiel';
  const before = Object.values(jira.groups).filter((g) => g.members.includes(anna)).map((g) => g.groupId);
  const preview = await rovo.offboardPerson({ projectKey: 'PROJ', person: 'Anna Beispiel' }, as());
  assert.ok(preview.planned.every((c) => c.change === 'remove'));
  assert.ok(jira.groups['g-reviewer'].members.includes(anna), 'preview changes nothing');
  const res = await rovo.offboardPerson({ projectKey: 'PROJ', person: 'Anna Beispiel', note: 'left the team', confirm: true }, as());
  assert.ok(res.results.length >= 1 && res.results.every((r) => r.status === 'removed'));
  assert.ok(!jira.groups['g-reviewer'].members.includes(anna));
  assert.ok(Object.values(jira.groups).filter((g) => g.members.includes(anna)).every((g) => !g.name.startsWith('atlassian-PROJ-') || g.groupId === 'g-externe'), 'only IdP groups keep her');
  await rovo.undoLastChange({ projectKey: 'PROJ', confirm: true }, as());
  const after = Object.values(jira.groups).filter((g) => g.members.includes(anna)).map((g) => g.groupId);
  assert.deepEqual(after.sort(), before.sort());
});

test('Rovo: copy members between groups, capped and project-scoped', async () => {
  const { rovo, as, jira } = setup();
  const res = await rovo.copyMembers({ projectKey: 'PROJ', fromGroup: 'admins', toGroup: 'reviewer', confirm: true }, as());
  assert.equal(res.ok, true);
  for (const id of jira.groups['g-admins'].members) assert.ok(jira.groups['g-reviewer'].members.includes(id));
  const same = await rovo.copyMembers({ projectKey: 'PROJ', fromGroup: 'admins', toGroup: 'admins' }, as());
  assert.equal(same.ok, false);
  const foreign = await rovo.copyMembers({ projectKey: 'PROJ', fromGroup: 'admins', toGroup: 'atlassian-OPS-oncall' }, as());
  assert.equal(foreign.ok, false);
  // Undo only ever takes back the caller's own changes, never someone else's.
  const other = await rovo.undoLastChange({ projectKey: 'PROJ', confirm: true }, as('u-admin'));
  assert.equal(other.nothingChanged, true);
  assert.ok(jira.groups['g-reviewer'].members.includes(jira.groups['g-admins'].members[1]));
});
