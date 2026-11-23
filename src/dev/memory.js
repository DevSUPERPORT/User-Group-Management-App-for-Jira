/**
 * In-memory implementations of the jira/store/audit adapters.
 * Used by the unit tests and by the UI click-dummy (static/app, `npm run dev`).
 * Never imported by src/index.js, so it is not part of the Forge bundle.
 *
 * @file        src/dev/memory.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { AppError, ErrorCodes } from '../core/errors.js';

export function memoryStore(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }));
    },
    async page(prefix, { cursor = null, limit = 100 } = {}) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const results = keys.slice(start, start + limit).map((key) => ({ key, value: structuredClone(data.get(key)) }));
      return { results, nextCursor: start + limit < keys.length ? String(start + limit) : null };
    },
    _dump: () => Object.fromEntries(data),
  };
}

export function memoryAudit(initial = []) {
  let rows = structuredClone(initial);
  const sorted = () => [...rows].sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
  const matches = (e, f) => {
    if (f.projectId && (e.projectId ?? '*') !== f.projectId) return false;
    if (f.from && e.createdAt < f.from) return false;
    if (f.to && e.createdAt > f.to) return false;
    if (f.groupId && e.groupId !== f.groupId) return false;
    if (f.action && e.action !== f.action) return false;
    if (f.person) {
      const p = f.person.toLowerCase();
      if (!(e.targetName ?? '').toLowerCase().includes(p) && !(e.actorName ?? '').toLowerCase().includes(p)) return false;
    }
    return true;
  };
  return {
    async append(e) {
      rows.push(structuredClone(e));
    },
    async query(f) {
      const hits = sorted().filter((e) => matches(e, f));
      return { entries: structuredClone(hits.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 20))), total: hits.length };
    },
    async groups({ projectId }) {
      const map = new Map();
      for (const e of sorted()) if (e.groupId && (!projectId || e.projectId === projectId) && !map.has(e.groupId)) map.set(e.groupId, e.groupName);
      return [...map.entries()].map(([groupId, groupName]) => ({ groupId, groupName })).sort((a, b) => a.groupName.localeCompare(b.groupName));
    },
    async projects() {
      const map = new Map();
      for (const e of rows) if (e.projectId && e.projectId !== '*') map.set(e.projectId, e.projectKey);
      return [...map.entries()].map(([projectId, projectKey]) => ({ projectId, projectKey }));
    },
    async exportPage({ after = null, limit = 200 } = {}) {
      const asc = [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const from = after ? asc.filter((e) => e.createdAt > after.createdAt || (e.createdAt === after.createdAt && e.id > after.id)) : asc;
      return structuredClone(from.slice(0, limit));
    },
    async importRows(list) {
      const ids = new Set(rows.map((e) => e.id));
      let inserted = 0;
      for (const e of list) {
        if (ids.has(e.id)) continue;
        ids.add(e.id);
        rows.push(structuredClone(e));
        inserted++;
      }
      return inserted;
    },
    async purgeOlderThan(ts) {
      const before = rows.length;
      rows = rows.filter((e) => e.createdAt >= ts);
      return before - rows.length;
    },
    _rows: () => rows,
  };
}

/**
 * Fake Jira. `state` = { projects: {id: {id,key,name}}, users: {accountId: user},
 * groups: {groupId: {groupId, name, members: [accountId]}}, perms: {accountId: {jiraAdmin, projectAdminOf: [projectId]}},
 * usage: {groupId: usageObject}, idpGroups: [groupId] }
 */
export function memoryJira(state) {
  const s = state;
  const group = (groupId) => {
    const g = s.groups[groupId];
    if (!g) throw new AppError(ErrorCodes.GROUP_NOT_FOUND, 'Group not found');
    return g;
  };
  const user = (id) => ({ active: true, email: null, avatarUrl: null, ...s.users[id] });
  let seq = 1000;
  return {
    async getProject(idOrKey) {
      // Like Jira: accepts the project id or key.
      const p = s.projects[idOrKey] ?? Object.values(s.projects).find((x) => x.key === String(idOrKey).toUpperCase());
      if (!p) throw new AppError(ErrorCodes.JIRA_ERROR, 'Project not found', { status: 404 });
      return { ...p };
    },
    async checkPermissions(accountId, projectId) {
      const p = s.perms[accountId] ?? {};
      const projectAdmin = Boolean(projectId && (p.projectAdminOf ?? []).includes(projectId));
      const canBrowse = Boolean(projectId && (projectAdmin || (p.browseOf ?? []).includes(projectId)));
      return { jiraAdmin: Boolean(p.jiraAdmin), projectAdmin, canBrowse };
    },
    async getUser(accountId) {
      if (!s.users[accountId]) throw new AppError(ErrorCodes.JIRA_ERROR, 'User not found');
      return user(accountId);
    },
    async getProjectRoles(projectId) {
      const roles = (s.roles ?? {})[projectId] ?? [];
      const name = (id) => s.users[id]?.displayName ?? id;
      return roles
        .map((r) => ({
          roleId: r.roleId,
          name: r.name,
          description: r.description ?? '',
          actors: [
            ...r.users.map((id) => ({ type: 'user', accountId: id, displayName: name(id), avatarUrl: null })),
            ...(r.groups ?? []).map((gid) => ({ type: 'group', groupId: gid, name: s.groups[gid]?.name ?? gid })),
          ],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getUserGroups(accountId) {
      return Object.values(s.groups)
        .filter((g) => g.members.includes(accountId))
        .map((g) => ({ groupId: g.groupId, name: g.name }));
    },
    async getGroup(groupId) {
      const g = s.groups[groupId];
      return g ? { groupId: g.groupId, name: g.name } : null;
    },
    async findGroupByName(name) {
      const g = Object.values(s.groups).find((x) => x.name.toLowerCase() === name.toLowerCase());
      return g ? { groupId: g.groupId, name: g.name } : null;
    },
    async searchGroups(query, max = 20) {
      const q = query.toLowerCase();
      return Object.values(s.groups)
        .filter((g) => g.name.toLowerCase().includes(q))
        .slice(0, max)
        .map((g) => ({ groupId: g.groupId, name: g.name }));
    },
    async createGroup(name) {
      if (Object.values(s.groups).some((g) => g.name.toLowerCase() === name.toLowerCase())) {
        throw new AppError(ErrorCodes.JIRA_ERROR, 'Group already exists', { status: 400 });
      }
      const groupId = `g-${(seq++).toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
      s.groups[groupId] = { groupId, name, members: [] };
      return { groupId, name };
    },
    async countMembers(groupId) {
      return group(groupId).members.length;
    },
    async getMembers(groupId, startAt, maxResults) {
      const g = group(groupId);
      const all = g.members.map(user).sort((a, b) => a.displayName.localeCompare(b.displayName));
      return { members: all.slice(startAt, startAt + maxResults), total: all.length };
    },
    async getAllMembers(groupId, cap) {
      return (await this.getMembers(groupId, 0, cap)).members;
    },
    async addMember(groupId, accountId) {
      const g = group(groupId);
      if ((s.idpGroups ?? []).includes(groupId)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is managed by identity provider');
      if (g.members.includes(accountId)) throw new AppError('ALREADY_MEMBER', 'User is already a member');
      g.members.push(accountId);
    },
    async removeMember(groupId, accountId) {
      const g = group(groupId);
      g.members = g.members.filter((m) => m !== accountId);
    },
    async searchUsers(query, max = 20) {
      const q = query.toLowerCase();
      return Object.keys(s.users)
        .map(user)
        .filter((u) => u.displayName.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
        .slice(0, max);
    },
    async searchProjects(query, max = 20) {
      const q = query.toLowerCase();
      return Object.values(s.projects)
        .filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .slice(0, max)
        .map((p) => ({ id: p.id, key: p.key, name: p.name }));
    },
    async getUsage({ groupId }) {
      const none = { status: 'ok', items: [] };
      return {
        permissionSchemes: none,
        workflows: none,
        projectRoles: none,
        notificationSchemes: none,
        issueSecurity: none,
        filters: none,
        dashboards: none,
        ...(s.usage?.[groupId] ?? {}),
      };
    },
  };
}

/**
 * Fake Jira REST writes made as the signed-in user (asUser), over the same state as memoryJira (Jira-admin mode).
 * Like Jira: only Jira admins may write (403 "Administrator privileges are required" otherwise). `needsConsent`
 * lists accounts that have not allowed the app to act for them yet: their calls fail like Forge's
 * NeedsAuthenticationError (wrapped as USER_CONSENT_REQUIRED by src/forge/jiraUserWriter.js).
 */
export function memoryJiraUser(state, { needsConsent = [], impersonation = true } = {}) {
  const s = state;
  const calls = [];
  const consent = new Set(needsConsent);
  let seq = 5000;
  const consentCheck = (as) => {
    if (consent.has(as?.accountId)) {
      const cause = Object.assign(new Error('Authentication Required'), { name: 'NEEDS_AUTHENTICATION_ERR', status: 401 });
      const err = new AppError(ErrorCodes.USER_CONSENT_REQUIRED, 'Allow the app to act on your behalf first (Grant access); nothing was changed.', { reason: 'CONSENT' });
      err.cause = cause;
      throw err;
    }
  };
  const roleCheck = (as, projectId) => {
    consentCheck(as);
    const p = s.perms?.[as?.accountId] ?? {};
    if (!p.jiraAdmin && !(p.projectAdminOf ?? []).includes(String(projectId))) throw new AppError(ErrorCodes.ROLE_FORBIDDEN, 'Jira did not allow this change for you', { status: 403 });
  };
  const role = (projectId, roleId) => {
    const r = ((s.roles ?? {})[projectId] ?? []).find((x) => x.roleId === String(roleId));
    if (!r) throw new AppError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    return r;
  };
  const check = (as) => {
    consentCheck(as);
    if (!s.perms?.[as?.accountId]?.jiraAdmin) throw new AppError(ErrorCodes.JIRA_ADMIN_REQUIRED, 'Only Jira administrators can apply changes', { status: 403, jira: 'Administrator privileges are required' });
  };
  const group = (groupId) => {
    const g = s.groups[groupId];
    if (!g) throw new AppError(ErrorCodes.GROUP_NOT_FOUND, 'Group not found');
    return g;
  };
  return {
    calls,
    grantConsent(accountId) {
      consent.delete(accountId);
    },
    async createGroup(name, as) {
      check(as);
      calls.push(['createGroup', name, as?.accountId]);
      if (Object.values(s.groups).some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new AppError('GROUP_EXISTS', 'A group with that name already exists.');
      const groupId = `gu-${(seq++).toString(16)}`;
      s.groups[groupId] = { groupId, name, members: [] };
      return { groupId, name };
    },
    async addMember(groupId, accountId, as) {
      check(as);
      calls.push(['addMember', groupId, accountId, as?.accountId]);
      const g = group(groupId);
      if ((s.idpGroups ?? []).includes(groupId)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is managed by identity provider');
      if (g.members.includes(accountId)) throw new AppError('ALREADY_MEMBER', 'User is already a member');
      g.members.push(accountId);
    },
    async removeMember(groupId, accountId, as) {
      check(as);
      calls.push(['removeMember', groupId, accountId, as?.accountId]);
      const g = group(groupId);
      if (!g.members.includes(accountId)) throw new AppError('NOT_MEMBER', 'User is not a member of the group');
      g.members = g.members.filter((m) => m !== accountId);
    },
    // Project roles: like Jira, the project's admins (Administer Projects) and Jira admins may change members.
    async addRoleActor(projectId, roleId, accountId, as) {
      roleCheck(as, projectId);
      calls.push(['addRoleActor', projectId, roleId, accountId, as?.accountId]);
      const r = role(projectId, roleId);
      if (r.users.includes(accountId)) throw new AppError('ALREADY_MEMBER', 'User is already a member of the project role');
      r.users.push(accountId);
    },
    async removeRoleActor(projectId, roleId, accountId, as) {
      roleCheck(as, projectId);
      calls.push(['removeRoleActor', projectId, roleId, accountId, as?.accountId]);
      const r = role(projectId, roleId);
      if (!r.users.includes(accountId)) throw new AppError('NOT_MEMBER', 'User is not a member of the project role');
      r.users = r.users.filter((u) => u !== accountId);
    },
    async addRoleGroup(projectId, roleId, groupId, as) {
      roleCheck(as, projectId);
      calls.push(['addRoleGroup', projectId, roleId, groupId, as?.accountId]);
      const r = role(projectId, roleId);
      if (!s.groups[groupId]) throw new AppError(ErrorCodes.GROUP_NOT_FOUND, 'Group not found');
      r.groups = r.groups ?? [];
      if (r.groups.includes(groupId)) throw new AppError('ALREADY_MEMBER', 'Group is already a member of the project role');
      r.groups.push(groupId);
    },
    async removeRoleGroup(projectId, roleId, groupId, as) {
      roleCheck(as, projectId);
      calls.push(['removeRoleGroup', projectId, roleId, groupId, as?.accountId]);
      const r = role(projectId, roleId);
      if (!(r.groups ?? []).includes(groupId)) throw new AppError('NOT_MEMBER', 'Group is not a member of the project role');
      r.groups = r.groups.filter((g) => g !== groupId);
    },
    async requestConsent(as) {
      if (consent.has(as?.accountId)) throw Object.assign(new Error('Authentication Required'), { name: 'NEEDS_AUTHENTICATION_ERR', status: 401 });
      return { ok: true, status: 200 };
    },
    // Offline impersonation (automatic changes): a harmless read as the given account.
    async checkImpersonation(as) {
      consentCheck(as);
      if (!impersonation) throw new Error('Impersonation is not allowed for this app');
      calls.push(['checkImpersonation', as?.accountId]);
      return { accountId: as?.accountId ?? null };
    },
    withdrawConsent(accountId) {
      consent.add(accountId);
    },
  };
}

/** Fake Confluence over state.confluence = { spaces: [...], pages: [...] }. */
export function memoryConfluence(state, { available = true } = {}) {
  const c = state.confluence ?? { spaces: [], pages: [] };
  return {
    async isAvailable() {
      return available;
    },
    async spacePermissions({ groupId }) {
      const items = c.spaces
        .filter((sp) => (sp.permissions[groupId] ?? []).length)
        .map((sp) => ({ spaceKey: sp.key, spaceName: sp.name, operations: [...sp.permissions[groupId]].sort() }));
      return { items, truncated: false };
    },
    async listPages(cursor, limit) {
      const start = cursor ? Number(cursor) : 0;
      const pages = c.pages.slice(start, start + limit).map((p) => ({ id: p.id, title: p.title, spaceId: p.spaceId }));
      const next = start + limit < c.pages.length ? String(start + limit) : null;
      return { pages, next };
    },
    async pageRestrictions(pageId) {
      return (c.pages.find((p) => p.id === pageId)?.restrictions ?? []).map((r) => ({ ...r }));
    },
    async spaceKeys(ids) {
      return Object.fromEntries(c.spaces.filter((sp) => ids.includes(sp.id)).map((sp) => [sp.id, { key: sp.key, name: sp.name }]));
    },
  };
}
