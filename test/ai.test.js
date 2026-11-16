/**
 * Tests for the effective AI state the pages get (switch on AND no SUPERPORT stop, anything else off) and for
 * hiding the AI entry points: "Ask Rovo" follows aiOn(bootstrap), and the tour leaves out its Rovo hint while AI is off.
 *
 * @file        test/ai.test.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/core/service.js';
import { aiActive } from '../src/core/aiBudget.js';
import { AI_DISABLED_MESSAGE } from '../src/rovoActions.js';
import { memoryAudit, memoryJira, memoryOrg, memoryStore } from '../src/dev/memory.js';
import { createSeed } from '../src/dev/seed.js';
import { aiOn } from '../static/app/src/features/ai.js';
import { TOURS, tourSteps } from '../static/app/src/features/tutorial/steps.js';
import de from '../static/app/src/i18n/de.js';
import en from '../static/app/src/i18n/en.js';

const NOW = Date.UTC(2026, 10, 16, 10, 0, 0);
const GO = { AI_BUDGET: '{"stop":false}' };
const STOP = { AI_BUDGET: '{"stop":true}' };
const quiet = () => {};

function setup({ ai = null, env = GO } = {}) {
  const seed = createSeed(NOW);
  if (ai !== null) seed.store.config.aiEnabled = ai;
  const service = createService({ jira: memoryJira(seed.jira), org: memoryOrg(seed.jira), store: memoryStore(seed.store), audit: memoryAudit([]), now: () => NOW, env });
  const project = { accountId: 'u-me', projectId: '10001', surface: 'project', license: null };
  const admin = { accountId: 'u-me', projectId: null, surface: 'admin', license: null };
  return { service, project, admin };
}

test('effective AI flag: off by default, also for an installation that never saved the switch', async () => {
  const { service, project, admin } = setup({ ai: null });
  const boot = await service.bootstrap(project);
  assert.equal(boot.config.ai, false);
  assert.equal(aiOn(boot), false);
  assert.equal((await service.adminBootstrap(admin)).config.aiEnabled, false, 'the admin page shows the switch off');
});

test('effective AI flag: on once a Jira admin saved the switch, off again when saved off', async () => {
  const { service, project, admin } = setup({ ai: null });
  const config = (await service.adminBootstrap(admin)).config;
  await service.saveConfig(admin, { config: { ...config, aiEnabled: true } });
  assert.equal(aiOn(await service.bootstrap(project)), true);
  await service.saveConfig(admin, { config: { ...config, aiEnabled: false } });
  assert.equal(aiOn(await service.bootstrap(project)), false);
});

test('effective AI flag: off while SUPERPORT stopped AI (AI_BUDGET), even with the switch on', async () => {
  const { service, project } = setup({ ai: true, env: STOP });
  const boot = await service.bootstrap(project);
  assert.equal(boot.config.aiEnabled, true, "the admin's setting is kept");
  assert.equal(boot.config.ai, false);
  assert.equal(aiOn(boot), false);
  // Unset or unreadable AI_BUDGET is no stop: the switch alone decides.
  assert.equal(aiActive({ aiEnabled: true }, {}, quiet), true);
  assert.equal(aiActive({ aiEnabled: true }, { AI_BUDGET: 'nonsense' }, quiet), true);
  assert.equal(aiActive({ aiEnabled: false }, GO), false);
});

test('effective AI flag: anything unexpected counts as off (failed or missing bootstrap, odd values)', () => {
  for (const boot of [null, undefined, {}, { config: null }, { config: {} }, { config: { ai: 'true' } }, { config: { ai: 1 } }, { config: { aiEnabled: true } }]) {
    assert.equal(aiOn(boot), false, JSON.stringify(boot));
  }
  assert.equal(aiOn({ config: { ai: true } }), true);
  for (const config of [null, undefined, {}, { aiEnabled: 'true' }, { aiEnabled: 1 }]) assert.equal(aiActive(config, GO), false, JSON.stringify(config));
});

test('tour: without AI no step or point mentions the Rovo agent; with AI the project tour points to it', () => {
  // "via Rovo" / "über Rovo" name the audit-log tag of past changes, which is not an AI entry point.
  const mentionsAgent = (text) => /rovo/i.test(String(text).replace(/(via|über) Rovo/g, ''));
  for (const surface of Object.keys(TOURS)) {
    for (const step of tourSteps(surface, { ai: false })) {
      for (const dict of [en, de]) {
        const texts = [dict[`tour.${surface}.${step.id}.title`], dict[`tour.${surface}.${step.id}.body`], ...step.pointNumbers.map((n) => dict[`tour.${surface}.${step.id}.p${n}`])];
        for (const text of texts) {
          assert.ok(text !== undefined, `tour.${surface}.${step.id} has all texts`);
          assert.ok(!mentionsAgent(text), `tour.${surface}.${step.id} mentions Rovo without AI: ${text}`);
        }
      }
    }
  }
  const done = (ai) => tourSteps('project', { ai }).find((s) => s.id === 'done');
  assert.deepEqual(done(false).pointNumbers, [1]);
  assert.deepEqual(done(true).pointNumbers, [1, 2]);
  assert.match(en['tour.project.done.p2'], /Rovo agent/);
  assert.deepEqual(tourSteps('project').find((s) => s.id === 'done').pointNumbers, [1], 'off unless told otherwise');
});

test('Rovo refusal while AI is off tells the user that a Jira admin can turn it on in the app configuration', () => {
  assert.match(AI_DISABLED_MESSAGE, /turned off/);
  assert.match(AI_DISABLED_MESSAGE, /Jira administrator can turn them on in the app configuration/);
  assert.match(AI_DISABLED_MESSAGE, /AI features \(Rovo agent\)/, 'names the switch as the admin page shows it');
  assert.equal(en['config.ai'], 'AI features (Rovo agent)');
});
