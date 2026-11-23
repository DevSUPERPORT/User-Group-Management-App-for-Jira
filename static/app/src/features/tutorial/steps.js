/**
 * First-run tour per surface. Texts live in i18n under tour.<surface>.<id>.title/.body
 * and, for steps with points, .p1 … .pN. Raise a surface's version when its tour
 * changes enough that its users should see it again.
 *
 * AI: a step with ai: true, and the points listed in a step's aiPoints (1-based), appear only while AI features are
 * effectively on (Tour's ai prop); otherwise the tour never mentions Rovo.
 *
 * @file        static/app/src/features/tutorial/steps.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

export const TUTORIAL_VERSIONS = { project: 5, member: 1, admin: 6, auditor: 1 };

export const TOURS = {
  project: [
    { id: 'welcome', points: 2 },
    { id: 'create', target: '[data-tour="create"]' },
    { id: 'list', target: '.group-list' },
    { id: 'usage', target: '[data-tour="usage"]' },
    { id: 'members', target: '[data-tour="members"]', points: 3 },
    { id: 'people', target: '#project-tabs-people' },
    { id: 'roles', target: '#project-tabs-roles', optional: true },
    { id: 'requests', target: '#project-tabs-requests' },
    // Jira-admin mode only (the tab exists while Jira admins apply group changes).
    { id: 'changes', target: '#project-tabs-changes', optional: true },
    { id: 'audit', target: '#project-tabs-audit' },
    { id: 'done', target: '[data-tour="help"]', points: 2, aiPoints: [2] },
  ],
  member: [
    { id: 'welcome' },
    { id: 'list', target: '[data-tour="my-groups"]' },
    { id: 'request', target: '[aria-labelledby="my-request-title"]', optional: true, points: 3 },
    { id: 'history', target: '[aria-labelledby="my-history-title"]', optional: true },
    { id: 'done', target: '[data-tour="help"]' },
  ],
  admin: [
    { id: 'welcome', points: 3 },
    // Only while the first-run checklist is shown (a new site, or "Setup checklist" reopened it).
    { id: 'setup', target: '[aria-labelledby="sec-setup"]', optional: true, points: 3 },
    { id: 'compliance', target: '[aria-labelledby="sec-compliance"]', optional: true },
    { id: 'retention', target: '[aria-labelledby="sec-retention"]' },
    { id: 'mode', target: '[aria-labelledby="sec-mode"]' },
    { id: 'roles', target: '[aria-labelledby="sec-roles"]', points: 4 },
    { id: 'governance', target: '[aria-labelledby="sec-governance"]', points: 3 },
    { id: 'blocked', target: '[aria-labelledby="sec-blocked"]' },
    { id: 'projects', target: '[aria-labelledby="sec-projects"]' },
    { id: 'save', target: '.save-bar' },
    { id: 'transfer', target: '[aria-labelledby="sec-transfer"]', points: 3 },
    { id: 'queue', target: '#admin-tabs-changes' },
    { id: 'audit', target: '#admin-tabs-audit' },
    { id: 'done', target: '[data-tour="help"]' },
  ],
  auditor: [
    { id: 'welcome' },
    { id: 'filters', target: '.filters' },
    { id: 'table', target: '.table-card' },
    { id: 'export', target: '[data-tour="export"]' },
    { id: 'done', target: '[data-tour="help"]' },
  ],
};

/**
 * The steps of a surface's tour for this user: without AI, steps marked ai and the points in aiPoints are left out.
 * Each step gets pointNumbers, the numbers of the i18n points (p1 … pN) to show.
 */
export function tourSteps(surface, { ai = false } = {}) {
  return (TOURS[surface] ?? [])
    .filter((s) => ai || !s.ai)
    .map((s) => ({
      ...s,
      pointNumbers: Array.from({ length: s.points ?? 0 }, (_, i) => i + 1).filter((n) => ai || !(s.aiPoints ?? []).includes(n)),
    }));
}
