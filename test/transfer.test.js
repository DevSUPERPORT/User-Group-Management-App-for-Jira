import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { AUDIT_PAGE, EXPORT_FORMAT, KVS_PAGE } from '../src/core/transfer.js';

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ANNA = 'u-anna-beispiel';

// Source and target share the same site data (same Jira), like two installations on one site.
function installation(seed, { empty = false, cloudId = 'site-1' } = {}) {
  const store = memoryStore(empty ? {} : seed.store);
  const audit = memoryAudit([]);
  let n = 0;
  const clock = { now: NOW };
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), store, audit, now: () => clock.now++, uuid: () => `${empty ? 't' : 's'}-${String(++n).padStart(6, '0')}` });
  const ctx = (extra = {}) => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null, cloudId, ...extra });
  const admin = (extra = {}) => ctx({ projectId: null, surface: 'admin', ...extra });
  return { service, store, audit, ctx, admin };
}

async function exportAll(service, ctx) {
  const meta = await service.exportData(ctx, { part: 'meta' });
  const out = { ...meta, kvs: [], audit: [] };
  for (const part of ['kvs', 'audit']) {
    let cursor = null;
    do {
      const page = await service.exportData(ctx, { part, cursor });
      out[part].push(...page.entries);
      cursor = page.cursor;
    } while (cursor);
  }
  return out;
}

async function importAll(service, ctx, file, { kvsBatch = 50, auditBatch = 77 } = {}) {
  let skipped = 0;
  let inserted = 0;
  for (let i = 0; i < file.kvs.length; i += kvsBatch) await service.importData(ctx, { part: 'kvs', entries: file.kvs.slice(i, i + kvsBatch), cloudId: file.cloudId });
  for (let i = 0; i < file.audit.length; i += auditBatch) {
    const res = await service.importData(ctx, { part: 'audit', entries: file.audit.slice(i, i + auditBatch), cloudId: file.cloudId });
    skipped += res.skipped;
    inserted += res.inserted;
  }
  await service.importData(ctx, { part: 'finish', cloudId: file.cloudId, summary: { records: file.kvs.length, entries: inserted, skipped, exportedAt: file.exportedAt, exportedBy: file.exportedBy } });
  return { inserted, skipped };
}

const reasonOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.details?.reason ?? e.code;
  }
  return null;
};

async function busySource(seed) {
  const src = installation(seed);
  await src.service.bootstrap(src.ctx());
  await src.service.createGroup(src.ctx(), { namePart: 'migration-test', description: 'Moves along', addMe: true });
  await src.service.addMembers(src.ctx(), { groupId: 'g-admins', accountIds: [ANNA], expiresAt: NOW + 30 * DAY });
  await src.service.updateDescription(src.ctx(), { groupId: 'g-admins', description: 'Admins of PROJ' });
  await src.service.saveConfig(src.admin(), { config: { ...(await src.service.adminBootstrap(src.admin())).config, retentionMonths: 36, requestsEnabled: true, reviewIntervalMonths: 6 } });
  await src.service.markTutorialSeen(src.ctx(), { version: 1, completed: true });
  // Enough audit entries to need several export pages.
  for (let i = 0; i < AUDIT_PAGE + 30; i++) await src.service.setExpiry(src.ctx(), { groupId: 'g-admins', accountId: ANNA, expiresAt: NOW + (31 + (i % 5)) * DAY });
  return src;
}

test('transfer: a full export and import reproduces every record and audit entry', async () => {
  const seed = createSeed(NOW);
  const src = await busySource(seed);
  const file = await exportAll(src.service, src.admin());
  assert.equal(file.format, EXPORT_FORMAT);
  assert.equal(file.cloudId, 'site-1');

  // The export holds exactly what the source has stored, and the whole audit log.
  assert.deepEqual(Object.fromEntries(file.kvs.map((e) => [e.key, e.value])), src.store._dump());
  assert.equal(file.audit.length, src.audit._rows().length);
  assert.ok(file.audit.length > AUDIT_PAGE, 'audit export spans several pages');
  assert.ok(file.kvs.length > 0 && file.kvs.length < KVS_PAGE * 8);

  const dst = installation(seed, { empty: true });
  const res = await importAll(dst.service, dst.admin(), file);
  assert.equal(res.inserted, file.audit.length);
  assert.equal(res.skipped, 0);

  assert.deepEqual(dst.store._dump(), src.store._dump());
  const strip = (rows) => rows.map((r) => ({ ...r, projectId: r.projectId ?? null })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const imported = dst.audit._rows().filter((r) => r.action !== 'DATA_IMPORTED');
  assert.deepEqual(strip(imported), strip(src.audit._rows()));
  const last = dst.audit._rows().find((r) => r.action === 'DATA_IMPORTED');
  assert.equal(last.details.records, file.kvs.length);
  assert.equal(last.actorAccountId, 'u-me');

  // The target behaves like the source: same groups, members' end dates, descriptions, config.
  const a = await src.service.bootstrap(src.ctx());
  const b = await dst.service.bootstrap(dst.ctx());
  assert.deepEqual(b.groups, a.groups);
  assert.deepEqual(b.config, a.config);
  const members = await dst.service.getMembers(dst.ctx(), { groupId: 'g-admins' });
  assert.ok(members.members.find((m) => m.accountId === ANNA).expiresAt > NOW);
  assert.deepEqual(await dst.service.tutorialState(dst.ctx()), { seenVersion: 1 });
});

test('transfer: importing the same file again changes nothing and duplicates nothing', async () => {
  const seed = createSeed(NOW);
  const src = await busySource(seed);
  const file = await exportAll(src.service, src.admin());
  const dst = installation(seed, { empty: true });
  await importAll(dst.service, dst.admin(), file);
  const before = dst.store._dump();
  const again = await importAll(dst.service, dst.admin(), file, { kvsBatch: 200, auditBatch: 500 });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, file.audit.length);
  assert.deepEqual(dst.store._dump(), before);
  assert.equal(new Set(dst.audit._rows().map((r) => r.id)).size, dst.audit._rows().length);
});

test('transfer: only Jira admins may export or import, on every call', async () => {
  const seed = createSeed(NOW);
  seed.jira.perms[ANNA] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  const src = installation(seed);
  const file = await exportAll(src.service, src.admin());
  const projectAdmin = src.admin({ accountId: ANNA });
  const member = src.admin({ accountId: 'u-lena-koch' });
  for (const who of [projectAdmin, member]) {
    for (const part of ['meta', 'kvs', 'audit']) assert.equal(await reasonOf(src.service.exportData(who, { part })), 'NOT_ADMIN');
    for (const part of ['kvs', 'audit', 'finish']) assert.equal(await reasonOf(src.service.importData(who, { part, entries: file.kvs.slice(0, 1), cloudId: file.cloudId })), 'NOT_ADMIN');
  }
  // Nothing was exported or written for them.
  assert.ok(!src.audit._rows().some((r) => r.actorAccountId === ANNA || r.actorAccountId === 'u-lena-koch'));
});

test('transfer: files from another site, unknown keys and broken entries are rejected', async () => {
  const seed = createSeed(NOW);
  const src = installation(seed);
  const file = await exportAll(src.service, src.admin());
  const dst = installation(seed, { empty: true, cloudId: 'site-2' });
  assert.equal(await reasonOf(dst.service.importData(dst.admin(), { part: 'kvs', entries: file.kvs.slice(0, 1), cloudId: file.cloudId })), 'OTHER_SITE');

  const same = installation(seed, { empty: true });
  const imp = (part, entries) => reasonOf(same.service.importData(same.admin(), { part, entries, cloudId: 'site-1' }));
  assert.equal(await imp('kvs', [{ key: 'something-else', value: {} }]), 'INVALID_ENTRY');
  assert.equal(await imp('kvs', [{ key: 'configuration', value: {} }]), 'INVALID_ENTRY');
  assert.equal(await imp('kvs', [{ key: 'group:', value: {} }]), 'INVALID_ENTRY');
  assert.equal(await imp('kvs', [{ key: 'group:g1', value: null }]), 'INVALID_ENTRY');
  assert.equal(await imp('kvs', Array.from({ length: 201 }, (_, i) => ({ key: `group:g${i}`, value: {} }))), 'TOO_MANY');
  assert.equal(await imp('audit', [{ id: 'x', createdAt: 'soon', action: 'MEMBER_ADDED' }]), 'INVALID_ENTRY');
  assert.equal(await imp('audit', [{ id: 'x', createdAt: NOW, action: 'MEMBER_ADDED', groupName: 'g'.repeat(300) }]), 'INVALID_ENTRY');
  assert.equal(await imp('audit', []), 'INVALID_ENTRY');
  assert.deepEqual(same.store._dump(), {});
  assert.equal(same.audit._rows().length, 0);
});
