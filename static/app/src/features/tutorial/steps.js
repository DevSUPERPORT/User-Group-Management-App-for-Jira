// First-run tour per surface. Texts live in i18n under tour.<surface>.<id>.title/.body
// and, for steps with points, .p1 … .pN. Raise a surface's version when its tour
// changes enough that its users should see it again.
export const TUTORIAL_VERSIONS = { project: 2, member: 1, admin: 2, auditor: 1 };

export const TOURS = {
  project: [
    { id: 'welcome', points: 2 },
    { id: 'create', target: '[data-tour="create"]' },
    { id: 'list', target: '.group-list' },
    { id: 'usage', target: '[data-tour="usage"]' },
    { id: 'members', target: '[data-tour="members"]', points: 3 },
    { id: 'people', target: '#project-tabs-people' },
    { id: 'requests', target: '#project-tabs-requests' },
    { id: 'audit', target: '#project-tabs-audit' },
    { id: 'done', target: '[data-tour="help"]', points: 2 },
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
    { id: 'compliance', target: '[aria-labelledby="sec-compliance"]', optional: true },
    { id: 'retention', target: '[aria-labelledby="sec-retention"]' },
    { id: 'org', target: '[aria-labelledby="sec-org"]' },
    { id: 'roles', target: '[aria-labelledby="sec-roles"]', points: 3 },
    { id: 'governance', target: '[aria-labelledby="sec-governance"]', points: 3 },
    { id: 'blocked', target: '[aria-labelledby="sec-blocked"]' },
    { id: 'projects', target: '[aria-labelledby="sec-projects"]' },
    { id: 'save', target: '.save-bar' },
    { id: 'transfer', target: '[aria-labelledby="sec-transfer"]', points: 3 },
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
