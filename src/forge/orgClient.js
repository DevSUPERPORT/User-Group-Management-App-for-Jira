import { fetch } from '@forge/api';
import { AppError, ErrorCodes } from '../core/errors.js';

// Secondary write path: Atlassian Organization Admin API (v2).
// Used when the Jira admin selects "Organization API" in the app configuration,
// because the Jira REST API rejects group creation by the app user.
//
// Setup per site (an org admin creates the key in admin.atlassian.com):
//   forge variables set ORG_ID <org id>
//   forge variables set --encrypt ORG_API_KEY <api key>
//   forge variables set ORG_DIRECTORY_ID <directory id>   # only if the org has several directories
//
// Docs: https://developer.atlassian.com/cloud/admin/organization/rest/api-group-groups/

const BASE = 'https://api.atlassian.com/admin/v2';

const env = () => ({
  orgId: process.env.ORG_ID?.trim() || null,
  apiKey: process.env.ORG_API_KEY?.trim() || null,
  directoryId: process.env.ORG_DIRECTORY_ID?.trim() || null,
});

async function call(path, { method = 'GET', body } = {}) {
  const { apiKey } = env();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

const enc = encodeURIComponent;

async function listDirectories() {
  const res = await call(`/orgs/${enc(env().orgId)}/directories?limit=10`);
  return (res?.data ?? []).map((d) => ({ directoryId: d.directoryId, name: d.name }));
}

// ORG_DIRECTORY_ID wins; otherwise the org's only directory. Null when ambiguous.
function pickDirectory(directories) {
  return env().directoryId || (directories.length === 1 ? directories[0].directoryId : null);
}

let cachedDirectory = null;
async function directoryId() {
  if (env().directoryId) return env().directoryId;
  if (cachedDirectory) return cachedDirectory;
  const directories = await listDirectories();
  const picked = pickDirectory(directories);
  if (!picked) {
    throw new AppError(ErrorCodes.ORG_API_ERROR, `Found ${directories.length} directories; set ORG_DIRECTORY_ID`, { directories });
  }
  cachedDirectory = picked;
  return picked;
}

async function groupsPath() {
  return `/orgs/${enc(env().orgId)}/directories/${enc(await directoryId())}/groups`;
}

async function findGroupIdByName(name) {
  const res = await call(`${await groupsPath()}/search`, { method: 'POST', body: { searchTerm: name, limit: 20 } });
  return (res?.data ?? []).find((g) => g.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A group created a moment ago can still answer 404 on membership calls while the
// directory catches up (seen live on superportdev): retry with backoff.
const NOT_FOUND_RETRIES_MS = [800, 1600, 3200];

// Jira's groupId and the directory group id are expected to be the same UUID; if
// the Admin API still does not know the id after the retries, the group is
// resolved once by its name.
async function withGroupId(groupId, groupName, fn) {
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
  const resolved = await findGroupIdByName(groupName);
  if (!resolved || resolved === groupId) throw lastErr;
  return fn(resolved);
}

export const _test = { setRetryDelays: (delays) => NOT_FOUND_RETRIES_MS.splice(0, NOT_FOUND_RETRIES_MS.length, ...delays) };

export const orgClient = {
  isConfigured() {
    const { orgId, apiKey } = env();
    return Boolean(orgId && apiKey);
  },

  async check() {
    const directories = await listDirectories();
    const selected = pickDirectory(directories);
    if (selected) cachedDirectory = selected;
    return { directories, directoryId: selected };
  },

  async createGroup(name, description = '') {
    const res = await call(await groupsPath(), { method: 'POST', body: { name, ...(description ? { description } : {}) } });
    const id = res?.id ?? res?.data?.id ?? (await findGroupIdByName(name));
    if (!id) throw new AppError(ErrorCodes.ORG_API_ERROR, 'Group was created but its id could not be resolved');
    return { groupId: id, name };
  },

  async addMember(groupId, accountId, groupName) {
    try {
      await withGroupId(groupId, groupName, async (id) =>
        call(`${await groupsPath()}/${enc(id)}/memberships`, { method: 'POST', body: { accountId } }),
      );
    } catch (err) {
      if (err.code === 'CONFLICT') throw new AppError('ALREADY_MEMBER', err.message);
      throw err;
    }
  },

  async removeMember(groupId, accountId, groupName) {
    await withGroupId(groupId, groupName, async (id) =>
      call(`${await groupsPath()}/${enc(id)}/memberships/${enc(accountId)}`, { method: 'DELETE' }),
    );
  },

  // Real IdP/SCIM signal: externalSynced / managementAccess.modifiable.
  async getGroupMeta(groupId, groupName) {
    const res = await withGroupId(groupId, groupName, async (id) => call(`${await groupsPath()}/${enc(id)}`));
    const g = res?.data ?? res ?? {};
    return {
      externalSynced: Boolean(g.externalSynced),
      managedBy: g.managedBy ?? null,
      modifiable: g.managementAccess?.modifiable !== false,
    };
  },
};
