import { fetch } from '@forge/api';
import { AppError, ErrorCodes } from '../core/errors.js';

// Group writes: Atlassian Organization Admin API (v2). The Jira REST API rejects
// group creation by the app user.
//
// Every installation brings its own connection: a Jira admin of the site enters
// the organization ID and an organization API key on the app's admin page. Both
// are kept in Forge secret storage (encrypted, scoped to the installation, never
// returned to the browser and not part of the data export). There is deliberately
// no app-wide fallback: a Marketplace app must never act with another customer's key.
//
// Docs: https://developer.atlassian.com/cloud/admin/organization/rest/api-group-groups/

const BASE = 'https://api.atlassian.com/admin/v2';
const SECRET_KEY = 'org-connection';
const ORG_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const enc = encodeURIComponent;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A group created a moment ago can still answer 404 on membership calls while the
// directory catches up (seen live on superportdev): retry with backoff.
const NOT_FOUND_RETRIES_MS = [800, 1600, 3200];

export const _test = { setRetryDelays: (delays) => NOT_FOUND_RETRIES_MS.splice(0, NOT_FOUND_RETRIES_MS.length, ...delays) };

async function request(conn, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (res.ok) return json;

  const message = json?.message || json?.errors?.map((e) => e.title || e.detail).join(' ') || text || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new AppError(ErrorCodes.ORG_API_UNAUTHORIZED, message, { status: res.status });
  if (res.status === 409) throw new AppError('CONFLICT', message, { status: 409 });
  if (res.status === 404) throw new AppError(ErrorCodes.GROUP_NOT_FOUND, message, { status: 404 });
  if (/synced|identity provider|managed/i.test(message)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, message);
  throw new AppError(ErrorCodes.ORG_API_ERROR, message, { status: res.status });
}

async function listDirectories(conn) {
  const res = await request(conn, `/orgs/${enc(conn.orgId)}/directories?limit=10`);
  return (res?.data ?? []).map((d) => ({ directoryId: d.directoryId, name: d.name }));
}

const groupsPath = (conn) => `/orgs/${enc(conn.orgId)}/directories/${enc(conn.directoryId)}/groups`;

async function findGroupIdByName(conn, name) {
  const res = await request(conn, `${groupsPath(conn)}/search`, { method: 'POST', body: { searchTerm: name, limit: 20 } });
  return (res?.data ?? []).find((g) => g.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

// Jira's groupId and the directory group id are expected to be the same UUID; if
// the Admin API still does not know the id after the retries, the group is
// resolved once by its name.
async function withGroupId(conn, groupId, groupName, fn) {
  let lastErr;
  for (const wait of [0, ...NOT_FOUND_RETRIES_MS]) {
    if (wait) await sleep(wait);
    try {
      return await fn(groupId);
    } catch (err) {
      if (err.code !== ErrorCodes.GROUP_NOT_FOUND) throw err;
      lastErr = err;
    }
  }
  if (!groupName) throw lastErr;
  const resolved = await findGroupIdByName(conn, groupName);
  if (!resolved || resolved === groupId) throw lastErr;
  return fn(resolved);
}

// Public view of a stored connection: everything except the key.
const publicStatus = (conn) =>
  conn
    ? { configured: true, orgId: conn.orgId, directoryId: conn.directoryId, directoryName: conn.directoryName ?? null, updatedAt: conn.updatedAt ?? null, updatedBy: conn.updatedBy ?? null }
    : { configured: false };

/**
 * secrets: { get(key), set(key, value), delete(key) } – Forge secret storage in
 * production (see kvsStore.kvsSecrets), a Map in tests.
 */
export function createOrgClient({ secrets, now = () => Date.now() }) {
  const load = async () => {
    const conn = await secrets.get(SECRET_KEY);
    return conn?.orgId && conn?.apiKey && conn?.directoryId ? conn : null;
  };
  const required = async () => {
    const conn = await load();
    if (!conn) throw new AppError(ErrorCodes.ORG_API_NOT_CONFIGURED, 'The organization connection is not set up');
    return conn;
  };

  return {
    async isConfigured() {
      return Boolean(await load());
    },

    async status() {
      return publicStatus(await load());
    },

    // Checks the stored connection with a read-only call.
    async check() {
      const conn = await required();
      const directories = await listDirectories(conn);
      const found = directories.some((d) => d.directoryId === conn.directoryId);
      return { directories, directoryId: found ? conn.directoryId : null };
    },

    // Validates organization ID + key against Atlassian before storing them.
    // With several directories the caller has to pick one (details.directories).
    async connect({ orgId, apiKey, directoryId = null }, updatedBy = null) {
      const candidate = { orgId: String(orgId ?? '').trim(), apiKey: String(apiKey ?? '').trim() };
      if (!ORG_ID_RE.test(candidate.orgId)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Invalid organization ID', { field: 'orgId' });
      if (!candidate.apiKey || candidate.apiKey.length > 4000) throw new AppError(ErrorCodes.BAD_REQUEST, 'Invalid API key', { field: 'apiKey' });
      const directories = await listDirectories(candidate);
      const picked = directoryId ? directories.find((d) => d.directoryId === directoryId) : directories.length === 1 ? directories[0] : null;
      if (!picked) {
        throw new AppError(ErrorCodes.ORG_DIRECTORY_REQUIRED, `Found ${directories.length} directories; choose one`, { directories });
      }
      const conn = { ...candidate, directoryId: picked.directoryId, directoryName: picked.name ?? null, updatedAt: now(), updatedBy };
      await secrets.set(SECRET_KEY, conn);
      return publicStatus(conn);
    },

    async disconnect() {
      await secrets.delete(SECRET_KEY);
      return publicStatus(null);
    },

    async createGroup(name, description = '') {
      const conn = await required();
      const res = await request(conn, groupsPath(conn), { method: 'POST', body: { name, ...(description ? { description } : {}) } });
      const id = res?.id ?? res?.data?.id ?? (await findGroupIdByName(conn, name));
      if (!id) throw new AppError(ErrorCodes.ORG_API_ERROR, 'Group was created but its id could not be resolved');
      return { groupId: id, name };
    },

    async addMember(groupId, accountId, groupName) {
      const conn = await required();
      try {
        await withGroupId(conn, groupId, groupName, (id) => request(conn, `${groupsPath(conn)}/${enc(id)}/memberships`, { method: 'POST', body: { accountId } }));
      } catch (err) {
        if (err.code === 'CONFLICT') throw new AppError('ALREADY_MEMBER', err.message);
        throw err;
      }
    },

    async removeMember(groupId, accountId, groupName) {
      const conn = await required();
      await withGroupId(conn, groupId, groupName, (id) => request(conn, `${groupsPath(conn)}/${enc(id)}/memberships/${enc(accountId)}`, { method: 'DELETE' }));
    },

    // One lookup, no retries: false only when the directory knows the group neither
    // by id nor by name (deleted in Atlassian Administration).
    async groupExists(groupId, groupName) {
      const conn = await required();
      try {
        await request(conn, `${groupsPath(conn)}/${enc(groupId)}`);
        return true;
      } catch (err) {
        if (err.code !== ErrorCodes.GROUP_NOT_FOUND) throw err;
      }
      return groupName ? Boolean(await findGroupIdByName(conn, groupName)) : false;
    },

    // Real IdP/SCIM signal: externalSynced / managementAccess.modifiable.
    async getGroupMeta(groupId, groupName) {
      const conn = await required();
      const res = await withGroupId(conn, groupId, groupName, (id) => request(conn, `${groupsPath(conn)}/${enc(id)}`));
      const g = res?.data ?? res ?? {};
      return {
        externalSynced: Boolean(g.externalSynced),
        managedBy: g.managedBy ?? null,
        modifiable: g.managementAccess?.modifiable !== false,
      };
    },
  };
}
