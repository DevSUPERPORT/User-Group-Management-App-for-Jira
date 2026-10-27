import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

function setup() {
  const seed = createSeed(NOW);
  const store = memoryStore(seed.store);
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), store, audit: memoryAudit([]), now: () => NOW });
  const ctx = (extra = {}) => ({ accountId: 'u-me', projectId: '10001', surface: 'project', license: null, ...extra });
  return { service, store, ctx };
}

const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};

test('tutorial: unseen at first, remembered per user and per surface', async () => {
  const { service, store, ctx } = setup();
  assert.deepEqual(await service.tutorialState(ctx()), { seenVersion: null });

  await service.markTutorialSeen(ctx(), { version: 1, completed: true });
  assert.deepEqual(await service.tutorialState(ctx()), { seenVersion: 1 });
  assert.deepEqual(await store.get('tutorial:u-me'), { project: { version: 1, completed: true, at: NOW } });

  // Other surfaces and other people still get their own tour.
  assert.deepEqual(await service.tutorialState(ctx({ surface: 'admin' })), { seenVersion: null });
  assert.deepEqual(await service.tutorialState(ctx({ accountId: 'u-anna-beispiel' })), { seenVersion: null });

  await service.markTutorialSeen(ctx({ surface: 'member' }), { version: 2 });
  assert.deepEqual(await service.tutorialState(ctx({ surface: 'member' })), { seenVersion: 2 });
  assert.deepEqual(await service.tutorialState(ctx()), { seenVersion: 1 });
});

test('tutorial: rejects bad input and calls without an account', async () => {
  const { service, ctx } = setup();
  assert.equal(await codeOf(service.markTutorialSeen(ctx(), { version: 'x' })), 'BAD_REQUEST');
  assert.equal(await codeOf(service.markTutorialSeen(ctx(), { version: 0 })), 'BAD_REQUEST');
  assert.equal(await codeOf(service.markTutorialSeen(ctx({ surface: 'other' }))), 'BAD_REQUEST');
  assert.equal(await codeOf(service.markTutorialSeen(ctx({ accountId: undefined }))), 'BAD_REQUEST');
  assert.deepEqual(await service.tutorialState(ctx({ accountId: undefined })), { seenVersion: null });
});
