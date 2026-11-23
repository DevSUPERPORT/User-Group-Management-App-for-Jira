/**
 * Group writes as a Jira administrator: Jira REST through asUser().
 *
 * Atlassian rejects these endpoints for the app user (asApp → 403), but accepts them for a user who is a Jira
 * administrator ("Administrator privileges are required" otherwise). The service only ever hands this writer to
 * callers it has checked to be Jira admins (src/core/service.js, writePlan); project admins' changes become pending
 * changes instead. No extra scope or egress is needed: manage:jira-configuration already covers the endpoints and
 * requestJira needs no egress entry.
 *
 * Consent: asUser() needs the user's one-time "Allow access". Without it Forge throws NeedsAuthenticationError
 * (name NEEDS_AUTHENTICATION_ERR, status 401). The writer turns that into USER_CONSENT_REQUIRED (the UI then shows
 * "Grant access") and keeps the original error as `cause`. requestConsent() makes a harmless asUser call and lets
 * the original error through on purpose: src/index.js rethrows it from the grantAccess resolver, and Forge then
 * shows its own consent prompt ("Allow access").
 *
 * Automatic changes (like CSUM's "privileged user"): a Jira admin can let project admins' group changes and the
 * scheduled removals apply at once. The service then passes `as = { accountId, impersonate: true }` for that admin
 * and the call runs as asUser(accountId) (Forge offline impersonation; manage:jira-configuration has
 * allowImpersonation in manifest.yml). Jira checks that admin's own rights on every call; no credentials are stored.
 *
 * @file        src/forge/jiraUserWriter.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-23
 */

import { asUser, route } from '@forge/api';
import { AppError, ErrorCodes } from '../core/errors.js';

const CONSENT_MESSAGE = 'Allow the app to act on your behalf first (Grant access); nothing was changed.';

export function isConsentError(err) {
  return err?.name === 'NEEDS_AUTHENTICATION_ERR' || err?.cause?.name === 'NEEDS_AUTHENTICATION_ERR';
}

function consentError(cause) {
  const err = new AppError(ErrorCodes.USER_CONSENT_REQUIRED, CONSENT_MESSAGE, { reason: 'CONSENT' });
  err.cause = cause;
  return err;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// asUser() acts as the user of the current invocation; with `impersonate` it acts as the given account instead.
function clientFor(as) {
  return as?.impersonate && as.accountId ? asUser(as.accountId) : asUser();
}

async function send(path, { method = 'GET', body, notFound, forbidden } = {}, as = null) {
  let res;
  try {
    res = await clientFor(as).requestJira(path, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (isConsentError(err)) throw consentError(err);
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (res.ok) return json;
  console.warn('Jira refused a write', method, res.status, as?.impersonate ? 'impersonated' : 'user');
  const message = [...(json?.errorMessages ?? []), ...Object.values(json?.errors ?? {})].join(' ') || json?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) throw consentError(Object.assign(new Error(message), { status: 401 }));
  if (res.status === 403 && forbidden) throw new AppError(forbidden, 'Jira did not allow this change for you', { status: 403, jira: message });
  if (res.status === 403) throw new AppError(ErrorCodes.JIRA_ADMIN_REQUIRED, 'Only Jira administrators can apply changes', { status: 403, jira: message });
  if (/already a member/i.test(message)) throw new AppError('ALREADY_MEMBER', message);
  if (/not a member|is not in the group|does not belong/i.test(message)) throw new AppError('NOT_MEMBER', message);
  if (/already exists/i.test(message)) throw new AppError('GROUP_EXISTS', message);
  if (res.status === 404 && notFound) throw new AppError(notFound, message);
  if (/managed (externally|by)|identity provider|scim|synced|synchroni[sz]ed/i.test(message)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, message);
  throw new AppError(ErrorCodes.JIRA_ERROR, message, { status: res.status });
}

/**
 * The service passes `as` ({ accountId }) with every call. Without `impersonate` Forge acts as the user of the
 * current invocation anyway; the in-memory writer (src/dev/memory.js) uses `as` to simulate Jira's 403.
 */
export const jiraUserWriter = {
  async createGroup(name, as) {
    const g = await send(route`/rest/api/3/group`, { method: 'POST', body: { name } }, as);
    return { groupId: g.groupId, name: g.name ?? name };
  },

  async addMember(groupId, accountId, as) {
    await send(route`/rest/api/3/group/user?groupId=${groupId}`, { method: 'POST', body: { accountId }, notFound: ErrorCodes.GROUP_NOT_FOUND }, as);
  },

  async removeMember(groupId, accountId, as) {
    await send(route`/rest/api/3/group/user?groupId=${groupId}&accountId=${accountId}`, { method: 'DELETE', notFound: ErrorCodes.GROUP_NOT_FOUND }, as);
  },

  // Project roles: Jira lets the project's own admins (Administer Projects) and Jira admins change role members, so
  // these run with the caller's own rights; nobody gains anything they could not do in Jira's project settings.
  async addRoleActor(projectId, roleId, accountId) {
    await send(route`/rest/api/3/project/${projectId}/role/${roleId}`, { method: 'POST', body: { user: [accountId] }, forbidden: ErrorCodes.ROLE_FORBIDDEN, notFound: ErrorCodes.ROLE_NOT_FOUND });
  },

  // Groups in roles (same endpoints, actor type group; Jira allows it for the project's admins as well).
  async addRoleGroup(projectId, roleId, groupId) {
    await send(route`/rest/api/3/project/${projectId}/role/${roleId}`, { method: 'POST', body: { groupId: [groupId] }, forbidden: ErrorCodes.ROLE_FORBIDDEN, notFound: ErrorCodes.ROLE_NOT_FOUND });
  },

  async removeRoleGroup(projectId, roleId, groupId) {
    await send(route`/rest/api/3/project/${projectId}/role/${roleId}?groupId=${groupId}`, { method: 'DELETE', forbidden: ErrorCodes.ROLE_FORBIDDEN, notFound: 'NOT_MEMBER' });
  },

  async removeRoleActor(projectId, roleId, accountId) {
    await send(route`/rest/api/3/project/${projectId}/role/${roleId}?user=${accountId}`, { method: 'DELETE', forbidden: ErrorCodes.ROLE_FORBIDDEN, notFound: 'NOT_MEMBER' });
  },

  // Harmless asUser read. A missing consent is NOT mapped here: the grantAccess resolver lets Forge's own
  // NeedsAuthenticationError escape so Forge shows its "Allow access" prompt.
  async requestConsent() {
    const res = await asUser().requestJira(route`/rest/api/3/myself`, { headers: { Accept: 'application/json' } });
    return { ok: res.ok, status: res.status };
  },

  // Checks that the app can act as this account outside of their own session (offline impersonation): a harmless
  // read as asUser(accountId). The offline token only carries the scopes marked allowImpersonation
  // (manage:jira-configuration), and Forge never allows profile reads such as /myself offline, so this reads Jira's
  // advanced settings: covered by that scope, and Jira only answers it for Jira admins (403 otherwise).
  async checkImpersonation(as) {
    await send(route`/rest/api/3/application-properties/advanced-settings`, {}, { accountId: as?.accountId, impersonate: true });
    return { accountId: as?.accountId ?? null };
  },
};
