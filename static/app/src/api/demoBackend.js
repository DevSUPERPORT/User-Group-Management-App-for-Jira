// Click-dummy backend: the real service layer with in-memory Jira, storage and
// audit log, plus realistic latency so loading states can be seen.
import { createService } from '../../../../src/core/service.js';
import { toErrorPayload } from '../../../../src/core/errors.js';
import { memoryAudit, memoryConfluence, memoryJira, memoryOrg, memoryStore } from '../../../../src/dev/memory.js';
import { createSeed } from '../../../../src/dev/seed.js';

// Mirrors the per-surface function lists in src/index.js.
const ALLOWED = {
  project: ['bootstrap', 'checkName', 'createGroup', 'accessMatrix', 'applyAccessChanges', 'getGroup', 'getMembers', 'updateDescription', 'searchUsers', 'addMembers', 'removeMember', 'removeMembers', 'setExpiry', 'resolveUsers', 'exportMembers', 'getUsage', 'listRequests', 'decideRequest', 'reopenRequest', 'completeReview', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
  admin: ['adminBootstrap', 'saveConfig', 'searchGroups', 'searchProjects', 'testOrgApi', 'previewDeactivatedCleanup', 'rebuildConfluenceIndex', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
  member: ['myGroups', 'requestAccess', 'withdrawRequest'],
  auditor: ['auditorBootstrap', 'queryAudit', 'auditFilterOptions', 'exportAudit'],
};
// First-run tutorial: available on every surface.
for (const list of Object.values(ALLOWED)) list.push('tutorialState', 'markTutorialSeen');
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

export function createDemoBackend() {
  const params = new URLSearchParams(window.location.search);
  const seed = createSeed();
  if (params.get('governance') !== 'off') addGovernanceDemo(seed);
  const service = createService({
    jira: memoryJira(seed.jira),
    // ?org=off simulates an Organization API without ORG_ID / ORG_API_KEY.
    org: memoryOrg(seed.jira, { configured: params.get('org') !== 'off' }),
    // ?confluence=off simulates a site where the app is not installed in Confluence.
    confluence: memoryConfluence(seed.jira, { available: params.get('confluence') !== 'off' }),
    store: memoryStore(seed.store),
    audit: memoryAudit(seed.audit),
  });
  // Build the page-restriction index once, as the hourly trigger would.
  const ready = service.runConfluenceIndex({ budget: 100 });
  const surface = MODULES[params.get('view')] ? params.get('view') : 'project';
  const withProject = surface === 'project' || surface === 'member';
  const fast = params.has('fast');
  const latency = (name) => (fast ? 0 : name === 'checkName' || name === 'searchUsers' ? 180 + Math.random() * 220 : 280 + Math.random() * 420);

  return {
    async invoke(name, payload) {
      await ready;
      await new Promise((r) => setTimeout(r, latency(name)));
      const ctx = { accountId: 'u-me', projectId: withProject ? '10001' : null, surface, license: null };
      if (!ALLOWED[surface].includes(name)) return { error: { code: 'FORBIDDEN', message: 'Not available here' } };
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
