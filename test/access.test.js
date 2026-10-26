import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const seed = createSeed(NOW);
  const store = memoryStore(seed.store);
  const audit = memoryAudit([]);
  const jira = memoryJira(seed.jira);
  const service = createService({ jira, org: memoryOrg(seed.jira), store, audit, now: () => NOW });
  const admin = () => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null });
  return { service, store, audit, data: seed.jira, admin };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details?.reason ?? e.code;
  }
  return null;
};

test('People view: every person with their memberships across the project groups', async () => {
  const { service, admin, data } = setup();
  await service.bootstrap(admin()); // registers groups found by naming convention
  const m = await service.accessMatrix(admin());
  const names = m.groups.map((g) => g.namePart);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'groups sorted by name');
  assert.ok(!names.includes('oncall'), 'other projects are not included');
  assert.ok(!m.groups.some((g) => g.name === 'jira-software-users-superport'), 'blocked groups are not included');
  assert.equal(m.groups.find((g) => g.namePart === 'externe').readOnly, true);
  const anna = m.people.find((p) => p.accountId === 'u-anna-beispiel');
  assert.ok(anna.memberships['g-reviewer']);
  // end dates come along
  const soon = data.groups['g-reviewer'].members.find((id) => m.people.find((p) => p.accountId === id)?.memberships['g-reviewer'].expiresAt);
  assert.ok(soon, 'an end date is reported');
  // counts match
  assert.equal(m.groups.find((g) => g.groupId === 'g-admins').memberCount, data.groups['g-admins'].members.length);
});

test('People view: only project admins', async () => {
  const { service, data } = setup();
  data.perms['u-lena-koch'] = { browseOf: ['10001'] };
  assert.equal(await codeOf(service.accessMatrix({ accountId: 'u-lena-koch', projectId: '10001', surface: 'project' })), 'FORBIDDEN');
});

test('Batch changes across groups: per-change results, audit, partial failure, undo', async () => {
  const { service, admin, data, audit } = setup();
  await service.bootstrap(admin());
  const res = await service.applyAccessChanges(admin(), {
    changes: [
      { groupId: 'g-reviewer', accountId: 'u-lena-koch', op: 'add' },
      { groupId: 'g-admins', accountId: 'u-lena-koch', op: 'add' },
      { groupId: 'g-reviewer', accountId: 'u-anna-beispiel', op: 'remove' },
      { groupId: 'g-externe', accountId: 'u-lena-koch', op: 'add' }, // IdP: refused
      { groupId: 'g-other', accountId: 'u-lena-koch', op: 'add' }, // other project: refused
    ],
    expiresAt: NOW + 30 * DAY,
    note: 'Team change',
  });
  const by = (g, a) => res.results.find((r) => r.groupId === g && r.accountId === a);
  assert.equal(by('g-reviewer', 'u-lena-koch').status, 'added');
  assert.equal(by('g-admins', 'u-lena-koch').status, 'added');
  assert.equal(by('g-admins', 'u-lena-koch').expiresAt, NOW + 30 * DAY);
  assert.equal(by('g-reviewer', 'u-anna-beispiel').status, 'removed');
  assert.equal(by('g-externe', 'u-lena-koch').status, 'failed');
  assert.equal(by('g-externe', 'u-lena-koch').code, 'GROUP_READ_ONLY');
  assert.equal(by('g-other', 'u-lena-koch').status, 'failed');
  assert.ok(!data.groups['g-externe'].members.includes('u-lena-koch'));
  assert.ok(!data.groups['g-other'].members.includes('u-lena-koch'));
  assert.ok(data.groups['g-admins'].members.includes('u-lena-koch'));
  assert.equal(res.memberCounts['g-admins'], data.groups['g-admins'].members.length);
  const rows = audit._rows();
  assert.ok(rows.some((r) => r.action === 'MEMBER_ADDED' && r.details?.reason === 'bulk'));
  assert.ok(rows.some((r) => r.action === 'MEMBER_REMOVED' && r.details?.reason === 'bulk' && r.details?.note === 'Team change'));

  // Undo: the inverse of what succeeded, restoring the removed person's end date.
  const done = res.results.filter((r) => r.status === 'added' || r.status === 'removed');
  const undo = await service.applyAccessChanges(admin(), {
    changes: done.map((r) => ({ groupId: r.groupId, accountId: r.accountId, op: r.op === 'add' ? 'remove' : 'add' })),
    expiries: Object.fromEntries(done.filter((r) => r.previousExpiry).map((r) => [r.accountId, r.previousExpiry])),
    reason: 'undo',
  });
  assert.ok(undo.results.every((r) => r.status === 'added' || r.status === 'removed'));
  assert.ok(!data.groups['g-admins'].members.includes('u-lena-koch'));
  assert.ok(data.groups['g-reviewer'].members.includes('u-anna-beispiel'));
  assert.ok(audit._rows().some((r) => r.details?.reason === 'undo'));
});

test('Batch changes: validation before anything happens', async () => {
  const { service, admin, data } = setup();
  await service.bootstrap(admin());
  assert.equal(await codeOf(service.applyAccessChanges(admin(), { changes: [] })), 'BAD_REQUEST');
  assert.equal(await codeOf(service.applyAccessChanges(admin(), { changes: [{ groupId: 'g-admins', accountId: 'u-x', op: 'delete' }] })), 'INVALID_CHANGE');
  assert.equal(
    await codeOf(
      service.applyAccessChanges(admin(), {
        changes: [
          { groupId: 'g-admins', accountId: 'u-lena-koch', op: 'add' },
          { groupId: 'g-admins', accountId: 'u-lena-koch', op: 'remove' },
        ],
      }),
    ),
    'DUPLICATE_CHANGE',
  );
  const many = Array.from({ length: 101 }, (_, i) => ({ groupId: 'g-admins', accountId: `u-${i}`, op: 'add' }));
  assert.equal(await codeOf(service.applyAccessChanges(admin(), { changes: many })), 'TOO_MANY');
  assert.ok(!data.groups['g-admins'].members.includes('u-lena-koch'), 'nothing applied');
});

test('Create a group with the members of an existing group', async () => {
  const { service, admin, data, audit } = setup();
  await service.bootstrap(admin());
  const g = await service.createGroup(admin(), { namePart: 'admins-copy', copyFromGroupId: 'g-admins', addMe: true });
  assert.equal(g.copied.added + 1, data.groups['g-admins'].members.length, 'everyone copied, me added once');
  assert.equal(g.memberCount, data.groups['g-admins'].members.length);
  assert.deepEqual([...data.groups[g.groupId].members].sort(), [...data.groups['g-admins'].members].sort());
  assert.ok(audit._rows().some((r) => r.groupId === g.groupId && r.details?.reason === 'copy' && r.details?.from === 'atlassian-PROJ-admins'));

  // Source of another project: refused before anything is created.
  assert.equal(await codeOf(service.createGroup(admin(), { namePart: 'copy-foreign', copyFromGroupId: 'g-other' })), 'GROUP_NOT_IN_PROJECT');
  assert.ok(!Object.values(data.groups).some((x) => x.name === 'atlassian-PROJ-copy-foreign'));
});
