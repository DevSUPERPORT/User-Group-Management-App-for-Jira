/**
 * Group writes as the signed-in Jira administrator (Jira-admin mode): Jira REST through asUser().
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
 * @file        src/forge/jiraUserWriter.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
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

async function send(path, { method = 'GET', body, notFound } = {}) {
  let res;
  try {
    res = await asUser().requestJira(path, {
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
  const message = [...(json?.errorMessages ?? []), ...Object.values(json?.errors ?? {})].join(' ') || json?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) throw consentError(Object.assign(new Error(message), { status: 401 }));
  if (res.status === 403) throw new AppError(ErrorCodes.JIRA_ADMIN_REQUIRED, 'Only Jira administrators can apply changes', { status: 403, jira: message });
  if (/already a member/i.test(message)) throw new AppError('ALREADY_MEMBER', message);
  if (/not a member|is not in the group|does not belong/i.test(message)) throw new AppError('NOT_MEMBER', message);
  if (/already exists/i.test(message)) throw new AppError('GROUP_EXISTS', message);
  if (res.status === 404 && notFound) throw new AppError(notFound, message);
  if (/managed (externally|by)|identity provider|scim|synced|synchroni[sz]ed/i.test(message)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, message);
  throw new AppError(ErrorCodes.JIRA_ERROR, message, { status: res.status });
}

/**
 * The service passes `as` ({ accountId }) with every call; Forge ignores it (asUser() always acts as the user of
 * the current invocation). The in-memory writer (src/dev/memory.js) uses it to simulate Jira's 403.
 */
export const jiraUserWriter = {
  async createGroup(name) {
    const g = await send(route`/rest/api/3/group`, { method: 'POST', body: { name } });
    return { groupId: g.groupId, name: g.name ?? name };
  },

  async addMember(groupId, accountId) {
    await send(route`/rest/api/3/group/user?groupId=${groupId}`, { method: 'POST', body: { accountId }, notFound: ErrorCodes.GROUP_NOT_FOUND });
  },

  async removeMember(groupId, accountId) {
    await send(route`/rest/api/3/group/user?groupId=${groupId}&accountId=${accountId}`, { method: 'DELETE', notFound: ErrorCodes.GROUP_NOT_FOUND });
  },

  // Harmless asUser read. A missing consent is NOT mapped here: the grantAccess resolver lets Forge's own
  // NeedsAuthenticationError escape so Forge shows its "Allow access" prompt.
  async requestConsent() {
    const res = await asUser().requestJira(route`/rest/api/3/myself`, { headers: { Accept: 'application/json' } });
    return { ok: res.ok, status: res.status };
  },
};
