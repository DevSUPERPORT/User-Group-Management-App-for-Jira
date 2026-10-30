// Naming convention: atlassian-<PROJECTKEY>-<name>
// The prefix is fixed and derived from the project's current key; the project
// admin only chooses <name>.

export const GROUP_PREFIX = 'atlassian-';
// Short enough to stay readable in Jira pickers and the people table.
export const NAME_PART_MAX = 30;

// Lowercase letters, digits and single hyphens; must start and end with a letter or digit.
const NAME_PART_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function prefixFor(projectKey) {
  return `${GROUP_PREFIX}${projectKey}-`;
}

export function fullGroupName(projectKey, namePart) {
  return `${prefixFor(projectKey)}${namePart}`;
}

/**
 * Validates the user-chosen part of a group name.
 * @returns {null | 'EMPTY' | 'TOO_LONG' | 'INVALID_CHARS' | 'INVALID_EDGES' | 'DOUBLE_HYPHEN'}
 */
export function validateNamePart(namePart) {
  const value = namePart ?? '';
  if (value.length === 0) return 'EMPTY';
  if (value.length > NAME_PART_MAX) return 'TOO_LONG';
  if (/[^a-z0-9-]/.test(value)) return 'INVALID_CHARS';
  if (value.includes('--')) return 'DOUBLE_HYPHEN';
  if (!NAME_PART_RE.test(value)) return 'INVALID_EDGES';
  return null;
}

/**
 * Splits a group name into prefix and name part if it follows the convention for
 * one of the given project keys. Returns null otherwise.
 */
export function parseGroupName(groupName, projectKeys) {
  for (const key of projectKeys) {
    const prefix = prefixFor(key);
    if (groupName.toLowerCase().startsWith(prefix.toLowerCase()) && groupName.length > prefix.length) {
      return { projectKey: key, prefix: groupName.slice(0, prefix.length), namePart: groupName.slice(prefix.length) };
    }
  }
  return null;
}
