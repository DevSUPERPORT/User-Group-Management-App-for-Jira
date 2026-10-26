// Protection of critical groups. Blocked groups can neither be shown nor changed
// by the app. Entries support a trailing or leading "*" wildcard.
//
// The Atlassian core groups (administration) and the product access groups are
// FIXED: they are always blocked and cannot be removed from the block list, in
// the UI or through the API. The Jira admin can only add further groups.

export const CORE_BLOCKED_GROUPS = [
  'site-admins',
  'org-admins',
  'administrators',
  'jira-administrators',
  'jira-admins-*',
  'atlassian-addons-admin',
  'system-administrators',
  'trusted-users-*',
];

// Product access groups ("default access groups") as created by Atlassian Cloud.
export const PRODUCT_ACCESS_PATTERNS = [
  'jira-users',
  'jira-users-*',
  'jira-software-users',
  'jira-software-users-*',
  'jira-core-users',
  'jira-core-users-*',
  'jira-servicemanagement-users',
  'jira-servicemanagement-users-*',
  'jira-servicedesk-users',
  'jira-servicedesk-users-*',
  'jira-work-management-users-*',
  'jira-product-discovery-users-*',
  'confluence-users',
  'confluence-users-*',
  'bitbucket-users-*',
  'statuspage-users-*',
  'opsgenie-users-*',
  'compass-users-*',
  'atlas-users-*',
  '*-servicemanagement-users-*',
];

export const FIXED_BLOCKED = [...CORE_BLOCKED_GROUPS, ...PRODUCT_ACCESS_PATTERNS];

export function matchesPattern(pattern, name) {
  const p = pattern.trim().toLowerCase();
  const n = name.toLowerCase();
  if (!p) return false;
  const startsWild = p.startsWith('*');
  const endsWild = p.endsWith('*');
  const core = p.replace(/^\*/, '').replace(/\*$/, '');
  if (startsWild && endsWild) return n.includes(core);
  if (endsWild) return n.startsWith(core);
  if (startsWild) return n.endsWith(core);
  return n === p;
}

/** True when the entry is one of the fixed (non-removable) block list entries. */
export function isFixedEntry(entry) {
  const e = String(entry).trim().toLowerCase();
  return FIXED_BLOCKED.some((f) => f.toLowerCase() === e);
}

/** Returns the pattern that blocks the group, or null. Fixed entries always apply. */
export function blockingPattern(groupName, config) {
  const patterns = [...FIXED_BLOCKED, ...(config.blockedGroups ?? [])];
  return patterns.find((p) => matchesPattern(p, groupName)) ?? null;
}

export function isBlocked(groupName, config) {
  return blockingPattern(groupName, config) !== null;
}
