/**
 * Click-dummy backend: the real service layer with in-memory Jira, storage and
 * audit log, plus realistic latency so loading states can be seen.
 *
 * Mirrors the per-surface resolver lists and the READS list of src/index.js; ?maintenance=readonly|on previews the
 * kill-switch screens locally; ?ai=on|stopped previews the AI switch turned on, or turned on but stopped by SUPERPORT
 * (AI_BUDGET {"stop":true}); without it AI features are off, as on a fresh installation.
 *
 * Group changes: Jira admins apply them as themselves; ?as=projectAdmin makes the signed-in demo user a project admin without Jira admin rights on the project page (their changes then wait for a
 * Jira admin; the admin page keeps the Jira admin view). ?consent=needed simulates a Jira admin who has not allowed
 * the app to act on their behalf yet ("Grant access" then simulates Forge's "Allow access"). ?env=development shows
 * the TEST ONLY switch on the admin page. A few waiting changes from another project admin are seeded so the queue
 * has content (?changes=off leaves it empty). ?auto=on simulates automatic changes switched on by another Jira admin
 * (Dominik Admin): with ?as=projectAdmin the project admin's changes then apply at once.
 *
 * @file        static/app/src/api/demoBackend.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { createService } from '../../../../src/core/service.js';
import { toErrorPayload } from '../../../../src/core/errors.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryJiraUser, memoryStore } from '../../../../src/dev/memory.js';
import { createSeed } from '../../../../src/dev/seed.js';

// Mirrors the per-surface function lists in src/index.js.
const ALLOWED = {
  project: ['bootstrap', 'checkName', 'createGroup', 'accessMatrix', 'applyAccessChanges', 'getGroup', 'getMembers', 'updateDescription', 'searchUsers', 'addMembers', 'removeMember', 'removeMembers', 'setExpiry', 'resolveUsers', 'exportMembers', 'getUsage', 'listRequests', 'decideRequest', 'reopenRequest', 'completeReview', 'listChanges', 'applyChanges', 'rejectChanges', 'withdrawChanges', 'listRoles', 'addRoleMembers', 'removeRoleMember', 'searchRoleGroups', 'addRoleGroups', 'removeRoleGroup', 'grantAccess', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
  admin: ['adminBootstrap', 'saveConfig', 'setPrivilegedAdmin', 'clearPrivilegedAdmin', 'updateSetup', 'exportData', 'importData', 'searchGroups', 'searchProjects', 'previewDeactivatedCleanup', 'rebuildConfluenceIndex', 'listChanges', 'applyChanges', 'rejectChanges', 'grantAccess', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
  member: ['myGroups', 'requestAccess', 'withdrawRequest'],
  auditor: ['auditorBootstrap', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
};
// First-run tutorial: available on every surface.
for (const list of Object.values(ALLOWED)) list.push('tutorialState', 'markTutorialSeen');
// Mirrors READS in src/index.js: the resolvers that keep working while changes are paused.
const READS = new Set(['bootstrap', 'listRoles', 'searchRoleGroups', 'checkName', 'accessMatrix', 'getGroup', 'getMembers', 'searchUsers', 'resolveUsers', 'exportMembers', 'getUsage', 'listRequests', 'queryAudit', 'auditFilterOptions', 'exportAudit', 'tutorialState', 'myGroups', 'auditorBootstrap', 'adminBootstrap', 'exportData', 'searchGroups', 'searchProjects', 'previewDeactivatedCleanup', 'listChanges', 'grantAccess']);
const STATUS_URL = 'https://superapps.statuspage.io';
const MODULES = { project: 'gum-project-settings', admin: 'gum-admin-page', member: 'gum-my-groups', auditor: 'gum-audit' };

// Demo-only governance data: a periodic review (one group overdue), open and
// decided access requests and an entry made through Rovo.
function addGovernanceDemo(seed) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  seed.store.config = { ...seed.store.config, reviewIntervalMonths: 6, requestsEnabled: true };
  seed.store['group:g-admins'] = { ...seed.store['group:g-admins'], lastReviewedAt: now - 210 * day, lastReviewedBy: 'George Papasotiriou' };
  seed.store['group:g-reviewer'] = { ...seed.store['group:g-reviewer'], lastReviewedAt: now - 20 * day, lastReviewedBy: 'George Papasotiriou' };
  const request = (id, accountId, displayName, groupId, groupName, extra) => {
    seed.store[`request:10001:${id}`] = { id, projectId: '10001', groupId, groupName, accountId, displayName, durationDays: null, status: 'pending', decidedAt: null, decidedBy: null, note: null, ...extra };
  };
  request('r1', 'u-lena-koch', 'Lena Koch', 'g-reviewer', 'atlassian-PROJ-reviewer', { reason: 'Ich gebe ab November die Releases für das Mobile-Team frei.', durationDays: 90, createdAt: now - 3 * 60 * 60 * 1000 });
  request('r2', 'u-mia-becker', 'Mia Becker', 'g-admins', 'atlassian-PROJ-admins', { reason: 'Vertretung von Paul während seiner Elternzeit.', durationDays: 30, createdAt: now - 26 * 60 * 60 * 1000 });
  request('r3', 'u-felix-hoffmann', 'Felix Hoffmann', 'g-admins', 'atlassian-PROJ-admins', { reason: 'Brauche Admin-Rechte für Tests.', createdAt: now - 6 * day, status: 'denied', decidedAt: now - 5 * day, decidedBy: 'George Papasotiriou', note: 'Bitte über die Testumgebung lösen.' });
  seed.audit.push({ id: 'rovo1', createdAt: now - 50 * 60 * 1000, projectId: '10001', projectKey: 'PROJ', action: 'DESCRIPTION_CHANGED', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', actorAccountId: 'u-me', actorName: 'George Papasotiriou', details: { from: '', to: 'Reviewer für Freigaben im PROJ-Workflow', via: 'rovo' } });
}

// Demo-only waiting changes (Jira-admin mode): requested by the project admin Paul Richter, plus one from the hourly
// expiry job, and two already decided ones for the history.
function addChangesDemo(seed) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const paul = { accountId: 'u-paul-richter', displayName: 'Paul Richter' };
  seed.jira.perms['u-paul-richter'] = { jiraAdmin: false, projectAdminOf: ['10001'] };
  const base = { projectId: '10001', projectKey: 'PROJ', status: 'pending', groupId: null, groupName: null, accountId: null, displayName: null, expiresAt: null, durationDays: null, endedAt: null, reason: null, note: null, requestId: null, create: null, via: null, requestedBy: paul, decidedBy: null, decidedAt: null, decisionNote: null, outcome: null, result: null, lastError: null };
  const change = (id, extra) => {
    seed.store[`change:10001:${id}`] = { ...base, id, ...extra };
  };
  change('c-add-1', { type: 'add', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', accountId: 'u-lena-koch', displayName: 'Lena Koch', durationDays: 30, reason: 'request', note: 'Ich gebe ab November die Releases für das Mobile-Team frei.', requestedAt: now - 2 * hour });
  change('c-add-2', { type: 'add', groupId: 'g-admins', groupName: 'atlassian-PROJ-admins', accountId: 'u-nora-lange', displayName: 'Nora Lange', expiresAt: now + 45 * day, requestedAt: now - 5 * hour, via: 'rovo' });
  change('c-remove-1', { type: 'remove', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', accountId: 'u-anna-beispiel', displayName: 'Anna Beispiel', reason: 'review', note: 'Wechselt ins Marketing.', requestedAt: now - 26 * hour });
  change('c-create-1', { type: 'create', groupName: 'atlassian-PROJ-release-team', create: { namePart: 'release-team', fullName: 'atlassian-PROJ-release-team', description: 'Freigaben für Mobile-Releases', addMe: true, copyFrom: null, members: [{ accountId: 'u-paul-richter', displayName: 'Paul Richter', reason: null }, { accountId: 'u-mia-becker', displayName: 'Mia Becker', reason: null }] }, requestedAt: now - 30 * 60 * 1000 });
  // The hourly job found an ended membership: removal waits for a Jira admin, the member shows "access ended".
  const ended = Object.keys(seed.jira.users).find((id) => seed.jira.groups['g-reviewer'].members.includes(id) && id.startsWith('u-e'));
  if (ended) {
    seed.store[`expiry:g-reviewer:${ended}`] = { groupId: 'g-reviewer', accountId: ended, projectId: '10001', expiresAt: now - 3 * hour, setAt: now - 20 * day, setBy: paul, pendingChangeRef: '10001:c-expiry-1' };
    change('c-expiry-1', { type: 'remove', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', accountId: ended, displayName: seed.jira.users[ended].displayName, reason: 'expiry', endedAt: now - 3 * hour, requestedBy: { accountId: null, displayName: 'system' }, requestedAt: now - 2 * hour });
  }
  change('c-done-1', { type: 'add', groupId: 'g-qa', groupName: 'atlassian-PRJ-qa', accountId: 'u-oskar-lindqvist', displayName: 'Oskar Lindqvist', status: 'applied', outcome: 'done', requestedAt: now - 3 * day, decidedAt: now - 2 * day, decidedBy: { accountId: 'u-admin', displayName: 'Dominik Admin' } });
  change('c-done-2', { type: 'remove', groupId: 'g-admins', groupName: 'atlassian-PROJ-admins', accountId: 'u-paul-richter', displayName: 'Paul Richter', status: 'rejected', decisionNote: 'Paul bleibt Admin bis Jahresende.', requestedAt: now - 4 * day, decidedAt: now - 4 * day + 2 * hour, decidedBy: { accountId: 'u-admin', displayName: 'Dominik Admin' } });
}

export function createDemoBackend() {
  const params = new URLSearchParams(window.location.search);
  const seed = createSeed();
  if (params.get('governance') !== 'off') addGovernanceDemo(seed);
  const ai = params.get('ai');
  if (ai === 'on' || ai === 'stopped') seed.store.config = { ...seed.store.config, aiEnabled: true };
  if (params.get('changes') !== 'off') addChangesDemo(seed);
  // The click-dummy shows a site that is already set up; ?setup=new shows the first-run checklist.
  if (params.get('setup') !== 'new') seed.store.setup = { dismissedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, mode: 'review', announcedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 };
  if (params.get('auto') === 'on') seed.store['privileged-admin'] = { accountId: 'u-admin', displayName: 'Dominik Admin', setAt: Date.now() - 6 * 24 * 60 * 60 * 1000 };
  // ?as=projectAdmin: the demo user is a project admin only (project page); the admin page keeps the Jira admin.
  const asProjectAdmin = params.get('as') === 'projectAdmin';
  const jiraUser = memoryJiraUser(seed.jira, { needsConsent: params.get('consent') === 'needed' ? ['u-me'] : [] });
  const service = createService({
    jira: memoryJira(seed.jira),
    jiraUser,
    // ?confluence=off simulates a site where the app is not installed in Confluence.
    confluence: memoryConfluence(seed.jira, { available: params.get('confluence') !== 'off' }),
    store: memoryStore(seed.store),
    audit: memoryAudit(seed.audit),
    // Click-dummy only: in Jira AI_BUDGET comes from the server's environment.
    env: { AI_BUDGET: JSON.stringify({ stop: ai === 'stopped' }) },
  });
  // Build the page-restriction index once, as the hourly trigger would.
  const ready = service.runConfluenceIndex({ budget: 100 });
  const surface = MODULES[params.get('view')] ? params.get('view') : 'project';
  const withProject = surface === 'project' || surface === 'member';
  const fast = params.has('fast');
  // ?maintenance=readonly|on previews the kill-switch screens. Click-dummy only: in Jira the mode comes from the
  // server's environment and nothing in the browser can set it.
  const maint = ['readonly', 'on'].includes(params.get('maintenance')) ? params.get('maintenance') : 'off';
  const refusal = (mode) => ({
    error: {
      code: 'UNAVAILABLE',
      message: mode === 'on' ? `Group Self-Service for Jira is temporarily unavailable. Status page: ${STATUS_URL}` : `Changes are paused for maintenance to keep your data safe. Status page: ${STATUS_URL}`,
      details: { reason: mode === 'on' ? 'APP_UNAVAILABLE' : 'CHANGES_PAUSED', mode, statusUrl: STATUS_URL },
    },
  });
  // ?license=inactive simulates a site whose Marketplace licence has ended (as Forge's context.license reports it).
  const license = params.get('license') === 'inactive' ? { isActive: false } : null;
  const latency = (name) => (fast ? 0 : name === 'checkName' || name === 'searchUsers' ? 180 + Math.random() * 220 : 280 + Math.random() * 420);

  return {
    async invoke(name, payload) {
      await ready;
      await new Promise((r) => setTimeout(r, latency(name)));
      if (name === 'availability') return { data: { mode: maint, statusUrl: STATUS_URL, licensed: license === null || license.isActive } };
      if (maint === 'on' || (maint === 'readonly' && !READS.has(name))) return refusal(maint);
      const ctx = { accountId: 'u-me', projectId: withProject ? '10001' : null, surface, license, environmentType: params.get('env') === 'development' ? 'DEVELOPMENT' : 'PRODUCTION' };
      if (!ALLOWED[surface].includes(name)) return { error: { code: 'FORBIDDEN', message: 'Not available here' } };
      // Click-dummy only: in Jira, Forge shows its own "Allow access" prompt here.
      if (name === 'grantAccess') {
        jiraUser.grantConsent('u-me');
        return { data: { ok: true } };
      }
      seed.jira.perms['u-me'].jiraAdmin = !(asProjectAdmin && surface === 'project');
      try {
        return { data: structuredClone(await service[name](ctx, payload ?? {})) };
      } catch (err) {
        return toErrorPayload(err);
      }
    },
    async getContext() {
      const lang = params.get('lang') ?? 'de';
      return {
        locale: lang === 'en' ? 'en_US' : 'de_DE',
        moduleKey: MODULES[surface],
        extension: withProject ? { project: { id: '10001', key: 'PROJ' } } : {},
      };
    },
    async enableTheme() {
      const theme = params.get('theme');
      const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.colorMode = dark ? 'dark' : 'light';
    },
  };
}
