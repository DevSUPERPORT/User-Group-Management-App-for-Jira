import { route } from '@forge/api';
import { ErrorCodes } from '../core/errors.js';
import { call, mapLimit } from './http.js';
import { jiraUsage } from './usage.js';

// All Jira calls run asApp(): project admins are natively not allowed to manage
// groups, so the app acts on their behalf after the service layer has checked
// their permissions. NOTE: confirming that the app user may create groups and
// change members on every customer site is the "permissions spike" from the
// concept document - see README.md.

function mapUser(u) {
  return {
    accountId: u.accountId,
    displayName: u.displayName,
    email: u.emailAddress || null, // only present when the user's privacy settings allow it
    avatarUrl: u.avatarUrls?.['48x48'] ?? null,
    active: u.active !== false,
  };
}

const membersPath = (groupId, startAt, maxResults) =>
  route`/rest/api/3/group/member?groupId=${groupId}&startAt=${startAt}&maxResults=${maxResults}&includeInactiveUsers=true`;

export const jiraClient = {
  async getProject(projectId) {
    const p = await call(route`/rest/api/3/project/${projectId}`);
    return { id: String(p.id), key: p.key, name: p.name, avatarUrl: p.avatarUrls?.['48x48'] ?? null };
  },

  async checkPermissions(accountId, projectId) {
    const body = {
      accountId,
      globalPermissions: ['ADMINISTER'],
      projectPermissions: projectId ? [{ permissions: ['ADMINISTER_PROJECTS', 'BROWSE_PROJECTS'], projects: [Number(projectId)] }] : [],
    };
    const res = await call(route`/rest/api/3/permissions/check`, { method: 'POST', body });
    const jiraAdmin = (res.globalPermissions ?? []).includes('ADMINISTER');
    const has = (permission) =>
      Boolean(
        projectId &&
          (res.projectPermissions ?? []).some((p) => p.permission === permission && (p.projects ?? []).map(String).includes(String(projectId))),
      );
    return { jiraAdmin, projectAdmin: has('ADMINISTER_PROJECTS'), canBrowse: has('BROWSE_PROJECTS') };
  },

  async getUser(accountId) {
    return mapUser(await call(route`/rest/api/3/user?accountId=${accountId}`));
  },

  async getUserGroups(accountId) {
    const res = await call(route`/rest/api/3/user/groups?accountId=${accountId}`);
    return (res ?? []).map((g) => ({ groupId: g.groupId, name: g.name }));
  },

  async findGroupByName(name) {
    const res = await call(route`/rest/api/3/group/bulk?groupName=${name}&maxResults=10`);
    const hit = (res.values ?? []).find((g) => g.name.toLowerCase() === name.toLowerCase());
    return hit ? { groupId: hit.groupId, name: hit.name } : null;
  },

  async searchGroups(query, maxResults = 20) {
    const res = await call(route`/rest/api/3/groups/picker?query=${query}&maxResults=${maxResults}&caseInsensitive=true`);
    return (res.groups ?? []).map((g) => ({ groupId: g.groupId, name: g.name }));
  },

  async createGroup(name) {
    const g = await call(route`/rest/api/3/group`, { method: 'POST', body: { name } });
    return { groupId: g.groupId, name: g.name };
  },

  async countMembers(groupId) {
    const res = await call(membersPath(groupId, 0, 1), { notFound: ErrorCodes.GROUP_NOT_FOUND });
    return res.total ?? 0;
  },

  async getMembers(groupId, startAt, maxResults) {
    const res = await call(membersPath(groupId, startAt, maxResults), { notFound: ErrorCodes.GROUP_NOT_FOUND });
    return { members: (res.values ?? []).map(mapUser), total: res.total ?? 0 };
  },

  async getAllMembers(groupId, cap) {
    const pageSize = 50;
    const first = await this.getMembers(groupId, 0, pageSize);
    const total = Math.min(first.total, cap);
    const starts = [];
    for (let s = pageSize; s < total; s += pageSize) starts.push(s);
    const pages = await mapLimit(starts, 5, (s) => this.getMembers(groupId, s, pageSize));
    return [...first.members, ...pages.flatMap((p) => p.members)];
  },

  async addMember(groupId, accountId) {
    await call(route`/rest/api/3/group/user?groupId=${groupId}`, { method: 'POST', body: { accountId }, notFound: ErrorCodes.GROUP_NOT_FOUND });
  },

  async removeMember(groupId, accountId) {
    await call(route`/rest/api/3/group/user?groupId=${groupId}&accountId=${accountId}`, {
      method: 'DELETE',
      notFound: ErrorCodes.GROUP_NOT_FOUND,
    });
  },

  async searchUsers(query, maxResults = 20) {
    const res = await call(route`/rest/api/3/user/search?query=${query}&maxResults=${maxResults}`);
    return (res ?? []).filter((u) => u.accountType === 'atlassian').map(mapUser);
  },

  async searchProjects(query, maxResults = 20) {
    const res = await call(route`/rest/api/3/project/search?query=${query}&maxResults=${maxResults}&orderBy=key`);
    return (res.values ?? []).map((p) => ({ id: String(p.id), key: p.key, name: p.name, avatarUrl: p.avatarUrls?.['24x24'] ?? null }));
  },

  // UC-06: where is the group used in Jira (see usage.js).
  getUsage({ groupId, name }) {
    return jiraUsage({ groupId, name });
  },
};
