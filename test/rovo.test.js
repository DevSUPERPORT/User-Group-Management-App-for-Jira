import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { createRovoActions } from '../src/rovoActions.js';

const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);

function setup({ idp = [] } = {}) {
  const seed = createSeed(NOW);
  seed.store.config.idpGroups.push(...idp);
  const audit = memoryAudit([]);
  const rovoAudit = { ...audit, append: (e) => audit.append({ ...e, details: { ...(e.details ?? {}), via: 'rovo' } }) };
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), confluence: memoryConfluence(seed.jira), store: memoryStore(seed.store), audit: rovoAudit, now: () => NOW });
  const rovo = createRovoActions(service, { now: () => NOW });
  // Forge passes the calling user in the invocation context.
  const as = (accountId = 'u-me') => ({ principal: { accountId } });
  return { rovo, audit, jira: seed.jira, as };
}

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
