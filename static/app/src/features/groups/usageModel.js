// UC-06: the "where is this group used" checks, in display order, with how each
// finding is described. Shared by the usage panel, the removal impact and reviews.
export const USAGE_CHECKS = [
  { key: 'permissionSchemes', product: 'jira', icon: 'shield' },
  { key: 'workflows', product: 'jira', icon: 'arrowRight' },
  { key: 'projectRoles', product: 'jira', icon: 'users' },
  { key: 'issueSecurity', product: 'jira', icon: 'lock' },
  { key: 'notificationSchemes', product: 'jira', icon: 'info' },
  { key: 'filters', product: 'jira', icon: 'search' },
  { key: 'dashboards', product: 'jira', icon: 'checks' },
  { key: 'confluenceSpaces', product: 'confluence', icon: 'key' },
  { key: 'confluencePages', product: 'confluence', icon: 'clipboard' },
];

// Older cache entries held plain arrays; missing checks count as "not checked".
export function normalizeCheck(value) {
  if (Array.isArray(value)) return { status: 'ok', items: value };
  if (!value || typeof value !== 'object') return { status: 'error', items: [] };
  return { ...value, items: value.items ?? [] };
}

const pretty = (key) => {
  const s = String(key).replace(/[_:]+/g, ' ').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// title + detail line for one finding of a check.
export function describe(t, key, item) {
  switch (key) {
    case 'permissionSchemes':
      return {
        title: item.name,
        detail: [item.permissions.map(pretty).join(', '), item.projects?.length ? `${t('usage.projects')}: ${item.projects.map((p) => p.key).join(', ')}` : null].filter(Boolean).join(' · '),
      };
    case 'workflows':
      return {
        title: item.workflow,
        detail: [t('usage.transitionNamed', { name: item.transition }), item.types.map((ty) => t(`usage.${ty}`)).join(', '), item.scope ? t(`usage.scope.${item.scope}`) : null].filter(Boolean).join(' · '),
      };
    case 'projectRoles':
      return { title: `${item.projectKey} · ${item.role}`, detail: item.projectName };
    case 'issueSecurity':
      return { title: item.level, detail: item.scheme };
    case 'notificationSchemes':
      return { title: item.name, detail: `${t('usage.events')}: ${item.events.join(', ')}` };
    case 'filters':
    case 'dashboards':
      return { title: item.name, detail: [t(`usage.access.${item.access}`), item.owner ? t('usage.owner', { name: item.owner }) : null].filter(Boolean).join(' · ') };
    case 'confluenceSpaces':
      return { title: item.spaceName ? `${item.spaceName} (${item.spaceKey})` : item.spaceKey, detail: item.operations.map(pretty).join(', ') };
    case 'confluencePages':
      return {
        title: item.title,
        detail: [item.spaceName ?? item.spaceKey, (item.ops ?? []).map((op) => t(`usage.restriction.${op}`)).join(', ')].filter(Boolean).join(' · '),
      };
    default:
      return { title: String(item.name ?? item.title ?? ''), detail: '' };
  }
}

// Everything a member of the group can do through it (for removals and reviews).
export function impactItems(t, usage) {
  if (!usage) return [];
  const out = [];
  for (const c of USAGE_CHECKS) {
    if (c.key === 'notificationSchemes') continue; // notifications are not access
    for (const item of normalizeCheck(usage[c.key]).items) {
      const { title, detail } = describe(t, c.key, item);
      out.push({ kind: c.key, icon: c.icon, label: title, detail });
    }
  }
  return out;
}

export function incompleteChecks(usage) {
  if (!usage) return [];
  return USAGE_CHECKS.filter((c) => {
    const s = normalizeCheck(usage[c.key]).status;
    return s === 'error' || s === 'unavailable';
  }).map((c) => c.key);
}
