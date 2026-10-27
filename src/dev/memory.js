// In-memory implementations of the jira/store/audit adapters.
// Used by the unit tests and by the UI click-dummy (static/app, `npm run dev`).
// Never imported by src/index.js, so it is not part of the Forge bundle.

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
    async getUserGroups(accountId) {
      return Object.values(s.groups)
        .filter((g) => g.members.includes(accountId))
        .map((g) => ({ groupId: g.groupId, name: g.name }));
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
 * Fake Organization Admin API over the same state as memoryJira.
 * `configured` simulates whether ORG_ID / ORG_API_KEY are set.
 */
export function memoryOrg(state, { configured = true } = {}) {
  const jira = memoryJira(state);
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    async check() {
      return { directories: [{ directoryId: 'dir-1', name: 'SUPERPORT' }], directoryId: 'dir-1' };
    },
    async createGroup(name, description) {
      calls.push(['createGroup', name, description]);
      return jira.createGroup(name);
    },
    async addMember(groupId, accountId, groupName) {
      calls.push(['addMember', groupId, accountId, groupName]);
      return jira.addMember(groupId, accountId);
    },
    async removeMember(groupId, accountId, groupName) {
      calls.push(['removeMember', groupId, accountId, groupName]);
      return jira.removeMember(groupId, accountId);
    },
    async getGroupMeta(groupId) {
      const synced = (state.idpGroups ?? []).includes(groupId);
      return { externalSynced: synced, managedBy: synced ? 'scim' : null, modifiable: !synced };
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
