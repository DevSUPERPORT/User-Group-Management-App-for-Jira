/**
 * Business logic of the Group Self-Service for Jira app.
 *
 * Everything platform-specific is injected:
 *   jira  – Jira REST access performed by the app (see src/forge/jiraClient.js)
 *   store – key/value storage (Forge KVS)
 *   audit – append-only audit log (Forge SQL)
 * The same service runs in Forge, in the unit tests and in the local UI click-dummy.
 *
 * Security model: project admins are natively not allowed to create groups or change
 * members. The app performs those actions on their behalf, so every call re-checks
 * the caller's permissions and that the group belongs to the caller's project.
 * The project and account ids always come from the trusted Forge context, never
 * from the payload.
 *
 * How group writes run: a Jira administrator's change runs through Jira REST as that user (asUser, injected as
 * jiraUser); a project admin's change becomes a pending change (KVS change:<projectId>:<id>) that a Jira admin applies
 * or rejects later. The app never collects or stores organization API keys (Atlassian Marketplace requirement); a key
 * stored by an earlier version is deleted on install/upgrade (purgeLegacyOrgConnection).
 *
 * @file        src/core/service.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { AppError, ErrorCodes } from './errors.js';
import { aiActive, vendorAiStop } from './aiBudget.js';

/**
 * True when Forge reports that the site has no active Marketplace licence. license.active is the current
 * property and isActive the deprecated one; either being false counts. No license object (development, staging,
 * free or unlisted installs) is not "inactive".
 */
export function isLicenseInactive(license) {
  return Boolean(license) && (license.active === false || license.isActive === false);
}
import { CORE_BLOCKED_GROUPS, PRODUCT_ACCESS_PATTERNS, blockingPattern, isFixedEntry, matchesPattern } from './blocklist.js';
import { fullGroupName, parseGroupName, prefixFor, validateNamePart } from './naming.js';
import { auditRowsToCsv, toCsv } from './csv.js';
import { indexState, pagesForGroup, resetIndex, runIndexStep } from './confluenceIndex.js';
import { EXPORT_FORMAT, EXPORT_VERSION, TRANSFER_PREFIXES, checkSameSite, exportAuditPage, exportKvsPage, importAudit, importKvs } from './transfer.js';

export const AuditActions = {
  GROUP_CREATED: 'GROUP_CREATED',
  MEMBER_ADDED: 'MEMBER_ADDED',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
  PROJECT_KEY_CHANGED: 'PROJECT_KEY_CHANGED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  EXPIRY_CHANGED: 'EXPIRY_CHANGED',
  DESCRIPTION_CHANGED: 'DESCRIPTION_CHANGED',
  MEMBER_EXPIRED: 'MEMBER_EXPIRED',
  MEMBER_AUTO_REMOVED: 'MEMBER_AUTO_REMOVED',
  ACCESS_REQUESTED: 'ACCESS_REQUESTED',
  ACCESS_REQUEST_APPROVED: 'ACCESS_REQUEST_APPROVED',
  ACCESS_REQUEST_DENIED: 'ACCESS_REQUEST_DENIED',
  ACCESS_REQUEST_WITHDRAWN: 'ACCESS_REQUEST_WITHDRAWN',
  ACCESS_REQUEST_REOPENED: 'ACCESS_REQUEST_REOPENED',
  ACCESS_REVIEW_COMPLETED: 'ACCESS_REVIEW_COMPLETED',
  DATA_EXPORTED: 'DATA_EXPORTED',
  DATA_IMPORTED: 'DATA_IMPORTED',
  // Jira-admin mode: a project admin's change waits for a Jira admin (requested), who applies or rejects it; the
  // requester can withdraw it while it waits.
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  CHANGE_APPLIED: 'CHANGE_APPLIED',
  CHANGE_REJECTED: 'CHANGE_REJECTED',
  CHANGE_WITHDRAWN: 'CHANGE_WITHDRAWN',
  // Project roles: people added to or removed from a role of the project, by its project admin with their own rights.
  ROLE_MEMBER_ADDED: 'ROLE_MEMBER_ADDED',
  ROLE_MEMBER_REMOVED: 'ROLE_MEMBER_REMOVED',
};

// Jira's internal role for apps: never shown or changed.
const HIDDEN_ROLES = ['atlassian-addons-project-access'];

// Forge secret in which versions up to 3.17 could keep an organization API key ("organization connection").
export const LEGACY_ORG_SECRET = 'org-connection';

export const DEFAULT_CONFIG = Object.freeze({
  retentionMonths: null, // null = never delete (default)
  blockedGroups: [], // additional groups/patterns; core and product access groups are always blocked
  idpReadOnly: true,
  idpGroups: [], // names or wildcard patterns of IdP/SCIM-synchronised groups
  projectsMode: 'all', // 'all' | 'selected'
  allowedProjects: [], // [{ id, key, name }]
  memberViewEnabled: true, // "My groups" page for project members (read-only)
  auditorGroups: [], // members of these groups may read and export the full audit log
  expiryEnabled: true, // project admins may add people for a limited time
  requestsEnabled: true, // project members may request access from the "My groups" page
  reviewIntervalMonths: null, // null | 3 | 6 | 12: periodic access review per group
  autoRemoveDeactivated: false, // daily: remove deactivated accounts from app-managed groups
  // Groups are global. When a project group also grants access in other projects
  // (their permission scheme or project roles), adding people would widen access
  // beyond the project admin's own project: 'block' stops that for project admins
  // (Jira admins may still), 'warn' only shows it.
  scopeGuard: 'block',
  // AI features (the Rovo agent) are off until a Jira admin turns them on (EULA §8.4). Installations without a
  // stored value count as off.
  aiEnabled: false,
  // Project roles tab: project admins add and remove people in their own project's roles, with their own Jira rights
  // (Administer Projects). Jira admins can turn it off.
  rolesEnabled: true,
  // TEST ONLY: account ids treated as project admins (not Jira admins) on the project page and in Rovo. Honoured only
  // when Forge reports the DEVELOPMENT environment (ctx.environmentType); ignored and hidden everywhere else.
  testProjectAdmins: [],
});

const PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const DAY = 24 * 60 * 60 * 1000;
const MAX_BULK_ADD = 50;
const MAX_DESCRIPTION = 500;
const USAGE_TTL = 10 * 60 * 1000;
// Bumped when the shape of the usage checks changes; older cache entries are ignored.
const USAGE_VERSION = 2;
const MEMBER_SCAN_CAP = 5000;
// Jira can learn about a newly created group with a delay and briefly answer "does not exist" (seen live on superportdev). A group is
// only forgotten after Jira has reported it missing for this long.
const MISSING_GRACE = 24 * 60 * 60 * 1000;
const FRESH_GROUP = 30 * 60 * 1000;
const MAX_BULK_REMOVE = 50;
const MAX_RESOLVE = 50;
// People view: groups and members loaded per project, and changes per batch.
const ACCESS_GROUP_CAP = 40;
const ACCESS_MEMBER_CAP = 500;
const MAX_ACCESS_CHANGES = 100;
const EXPIRY_MIN = 60 * 60 * 1000; // at least one hour ahead
const EXPIRY_MAX = 730 * DAY; // at most two years ahead
// Why a change happened; recorded in the audit entry's details.
const ADD_REASONS = ['undo', 'retry', 'request', 'bulk', 'copy'];
const REVIEW_INTERVALS = [3, 6, 12];
const REQUEST_DURATIONS = [7, 30, 90];
const AUTOMATION_GROUP_CAP = 200;
const REMOVE_REASONS = ['review', 'undo', 'retry', 'bulk'];
const SCOPE_GUARDS = ['block', 'warn'];
// Re-adding what this admin just removed restores earlier access; not a widening.
const SCOPE_EXEMPT_REASONS = ['undo', 'retry'];
// Errors after which further writes in the same batch are pointless: no consent yet, or not a Jira admin.
const STOP_CODES = [ErrorCodes.USER_CONSENT_REQUIRED, ErrorCodes.JIRA_ADMIN_REQUIRED, ErrorCodes.PRIVILEGED_ADMIN_UNAVAILABLE];
const MAX_CHANGE_BATCH = 100;
const MAX_TEST_ACCOUNTS = 20;
// Decided pending changes stay visible this long (queue history, the requester's status); the hourly job then drops them.
const CHANGE_HISTORY = 90 * DAY;

const keys = {
  config: 'config',
  project: (id) => `project:${id}`,
  group: (id) => `group:${id}`,
  usage: (id) => `usage:${id}`,
  expiry: (groupId, accountId) => `expiry:${groupId}:${accountId}`,
  expiryPrefix: (groupId) => `expiry:${groupId}:`,
  request: (projectId, id) => `request:${projectId}:${id}`,
  requestPrefix: (projectId) => `request:${projectId}:`,
  tutorial: (accountId) => `tutorial:${accountId}`,
  change: (projectId, id) => `change:${projectId}:${id}`,
  changePrefix: (projectId) => `change:${projectId}:`,
  // Automatic changes: the Jira admin whose account applies project admins' changes. Deliberately NOT exported or
  // imported (not in TRANSFER_PREFIXES): acting for an account needs that admin's own decision on each installation.
  privileged: 'privileged-admin',
  // First-run setup checklist on the admin page (per installation, not exported: a new site sets itself up).
  setup: 'setup',
};

const TUTORIAL_SURFACES = ['project', 'member', 'admin', 'auditor'];

function fold(s) {
  return (s ?? '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function createService({ jira, secrets = null, jiraUser = null, confluence = null, store, audit, now = () => Date.now(), uuid = () => crypto.randomUUID(), env = globalThis.process?.env ?? {} }) {
  // ---------------------------------------------------------------- helpers

  // Group writes (create group, add/remove members): Atlassian rejects them from the app user via the Jira REST API
  // (verified on superportdev). They run as the signed-in Jira admin (Jira REST asUser); a project admin's change waits
  // for a Jira admin. Reads keep using the Jira REST API as the app.

  // Jira REST as the calling user. Only ever handed out for callers whose permissions say "Jira admin" (writePlan,
  // applyChanges); `as` lets the in-memory backend simulate Jira's 403 for anyone else.
  function userWriter(ctx) {
    if (!jiraUser) throw new AppError(ErrorCodes.JIRA_ERROR, 'Group changes as a Jira admin are not available here');
    const as = { accountId: ctx.accountId };
    return {
      kind: 'jiraAdmin',
      createGroup: (name) => jiraUser.createGroup(name, as),
      addMember: (groupId, accountId) => jiraUser.addMember(groupId, accountId, as),
      removeMember: (groupId, accountId) => jiraUser.removeMember(groupId, accountId, as),
    };
  }

  // How a write of this caller runs: a Jira admin writes with their own rights; a project admin's write runs at once
  // with the privileged admin's account when automatic changes are on, otherwise it waits for a Jira admin.
  async function writePlan(ctx, perms) {
    if (perms?.jiraAdmin) return { pending: false, writer: userWriter(ctx) };
    const writer = await privilegedWriter(ctx);
    if (writer) return { pending: false, writer };
    return { pending: true };
  }

  async function changeModeOf(ctx, perms) {
    if (perms?.jiraAdmin) return { effective: 'jiraAdmin', writes: 'direct' };
    const writer = await privilegedWriter(ctx);
    if (writer) return { effective: 'automatic', writes: 'direct', appliedAs: writer.appliedAs.displayName };
    return { effective: 'jiraAdmin', writes: 'pending' };
  }

  // ---------------------------------------------------------------- automatic changes (privileged admin)
  //
  // Like CSUM's "privileged user": a Jira admin lets the app apply project admins' group changes and the scheduled
  // removals (end dates, deactivated accounts) at once, with that admin's account (Forge offline impersonation,
  // asUser(accountId); manage:jira-configuration allows impersonation in manifest.yml). Only a Jira admin can switch
  // it on, and only for themselves; any Jira admin can switch it off. No credentials are stored, only the account id.
  // Before each use the app checks that the account is still an active Jira admin, and Jira checks that admin's
  // rights on every call. If that fails, automatic changes pause (recorded and shown on the admin page) and changes
  // wait for a Jira admin again until a Jira admin switches it on again. Every write keeps the scope checks of the
  // project admin's own request and is logged with the project admin as actor and "applied as" the privileged admin.

  async function privilegedRecord() {
    return (await store.get(keys.privileged)) ?? null;
  }

  function publicPrivileged(rec) {
    if (!rec?.accountId) return { on: false, paused: false };
    return {
      on: !rec.pausedAt,
      paused: Boolean(rec.pausedAt),
      accountId: rec.accountId,
      displayName: rec.displayName,
      setAt: rec.setAt ?? null,
      pausedAt: rec.pausedAt ?? null,
      pausedReason: rec.pausedReason ?? null,
    };
  }

  async function pausePrivileged(rec, reason) {
    const current = await privilegedRecord();
    if (!current || current.accountId !== rec.accountId || current.pausedAt) return;
    await store.set(keys.privileged, { ...current, pausedAt: now(), pausedReason: reason });
    console.warn('Automatic changes paused', reason);
    await writeAudit({
      action: AuditActions.CONFIG_CHANGED,
      projectId: '*',
      actorName: 'system',
      details: { changed: ['privilegedAdmin'], privilegedAdmin: 'paused', reason, appliedAs: rec.displayName },
    });
  }

  // The writer that acts as the privileged admin, or null (automatic changes off or paused, or the account can no
  // longer apply changes). `cache` (the invocation's ctx, or an object per scheduled run) keeps one check per run.
  async function privilegedWriter(cache) {
    const memo = cache ?? {};
    if ('_privileged' in memo) return memo._privileged;
    memo._privileged = null;
    if (!jiraUser) return null;
    const rec = await privilegedRecord();
    if (!rec?.accountId || rec.pausedAt) return null;
    const [perms, user] = await Promise.all([jira.checkPermissions(rec.accountId, null).catch(() => null), jira.getUser(rec.accountId).catch(() => null)]);
    if (!perms) return null; // Jira did not answer: wait this time, check again next time
    if (!perms.jiraAdmin || user?.active === false) {
      await pausePrivileged(rec, user?.active === false ? 'INACTIVE' : 'NOT_ADMIN');
      return null;
    }
    const as = { accountId: rec.accountId, impersonate: true };
    const appliedAs = { accountId: rec.accountId, displayName: user?.displayName ?? rec.displayName };
    const guard = (fn) => async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err?.code !== ErrorCodes.USER_CONSENT_REQUIRED && err?.code !== ErrorCodes.JIRA_ADMIN_REQUIRED) throw err;
        const reason = err.code === ErrorCodes.USER_CONSENT_REQUIRED ? 'ADMIN_CONSENT' : 'NOT_ADMIN'; // not 'CONSENT': that is the caller's own
        await pausePrivileged(rec, reason);
        memo._privileged = null;
        throw new AppError(ErrorCodes.PRIVILEGED_ADMIN_UNAVAILABLE, 'Automatic changes are paused; changes wait for a Jira admin again', { reason });
      }
    };
    memo._privileged = {
      kind: 'privileged',
      appliedAs,
      createGroup: guard((name) => jiraUser.createGroup(name, as)),
      addMember: guard((groupId, accountId) => jiraUser.addMember(groupId, accountId, as)),
      removeMember: guard((groupId, accountId) => jiraUser.removeMember(groupId, accountId, as)),
    };
    return memo._privileged;
  }

  // Audit details of a write: notes the privileged admin's account when the write ran with it.
  function withAppliedAs(writer, details) {
    if (writer?.kind !== 'privileged') return details;
    return { ...(details ?? {}), appliedAs: writer.appliedAs.displayName };
  }

  // ---------------------------------------------------------------- first-run setup (admin page)
  //
  // Three steps a Jira admin does once on a new site; everything else has safe defaults. 1. allow access (Forge
  // consent for writes as yourself), 2. choose how project admins' changes apply (automatic with your account, or you
  // review them), 3. tell project admins where the app is. The checklist hides itself once dismissed.

  async function hasConsent(ctx) {
    if (!jiraUser?.requestConsent) return true;
    try {
      await jiraUser.requestConsent({ accountId: ctx.accountId });
      return true;
    } catch (err) {
      if (err?.name === 'NEEDS_AUTHENTICATION_ERR' || err?.code === ErrorCodes.USER_CONSENT_REQUIRED) return false;
      return null; // unknown: the step stays open with its button
    }
  }

  async function setupStatus(ctx) {
    const setup = (await store.get(keys.setup)) ?? {};
    const privileged = await privilegedRecord();
    const status = {
      dismissed: Boolean(setup.dismissedAt),
      mode: privileged?.accountId && !privileged.pausedAt ? 'automatic' : setup.mode === 'review' ? 'review' : null,
      announced: Boolean(setup.announcedAt),
    };
    status.access = status.dismissed ? true : await hasConsent(ctx);
    status.complete = status.access === true && Boolean(status.mode) && status.announced;
    return status;
  }

  const SETUP_STEPS = ['review', 'announced', 'dismiss', 'reopen'];

  async function updateSetup(ctx, { step } = {}) {
    await requireJiraAdmin(ctx);
    if (!SETUP_STEPS.includes(step)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown setup step');
    const actor = await actorOf(ctx);
    const setup = (await store.get(keys.setup)) ?? {};
    const by = { accountId: actor.accountId, displayName: actor.displayName };
    if (step === 'review') Object.assign(setup, { mode: 'review', modeAt: now(), modeBy: by });
    if (step === 'announced') Object.assign(setup, { announcedAt: now(), announcedBy: by });
    if (step === 'dismiss') Object.assign(setup, { dismissedAt: now(), dismissedBy: by });
    if (step === 'reopen') delete setup.dismissedAt;
    await store.set(keys.setup, setup);
    return { setup: await setupStatus(ctx) };
  }

  async function setPrivilegedAdmin(ctx) {
    await requireJiraAdmin(ctx);
    if (!jiraUser?.checkImpersonation) throw new AppError(ErrorCodes.JIRA_ERROR, 'Automatic changes are not available here');
    try {
      const me = await jiraUser.checkImpersonation({ accountId: ctx.accountId });
      if (me?.accountId && me.accountId !== ctx.accountId) throw new Error('Jira answered for another account');
    } catch (err) {
      if (err?.code === ErrorCodes.USER_CONSENT_REQUIRED) throw err; // "Grant access" first
      console.warn('Impersonation check failed', err?.name, err?.code, err?.status, err?.message);
      throw new AppError(ErrorCodes.PRIVILEGED_ADMIN_UNAVAILABLE, 'Jira did not let the app act for your account', { reason: 'IMPERSONATION', jira: err?.message ?? String(err) });
    }
    const actor = await actorOf(ctx);
    const before = await privilegedRecord();
    const rec = { accountId: actor.accountId, displayName: actor.displayName, setAt: now() };
    await store.set(keys.privileged, rec);
    await writeAudit({
      action: AuditActions.CONFIG_CHANGED,
      projectId: '*',
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { changed: ['privilegedAdmin'], privilegedAdmin: 'on', appliedAs: actor.displayName, ...(before?.accountId && before.accountId !== actor.accountId ? { replaced: before.displayName } : {}) },
    });
    return { privileged: publicPrivileged(rec) };
  }

  async function clearPrivilegedAdmin(ctx) {
    await requireJiraAdmin(ctx);
    const before = await privilegedRecord();
    if (!before) return { privileged: publicPrivileged(null) };
    await store.delete(keys.privileged);
    const actor = await actorOf(ctx);
    await writeAudit({
      action: AuditActions.CONFIG_CHANGED,
      projectId: '*',
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { changed: ['privilegedAdmin'], privilegedAdmin: 'off', appliedAs: before.displayName },
    });
    return { privileged: publicPrivileged(null) };
  }

  // The writer a Jira admin uses to apply pending changes: their own Jira rights.
  async function applierWriter(ctx) {
    return userWriter(ctx);
  }

  const isDevelopment = (ctx) => ctx?.environmentType === 'DEVELOPMENT';

  async function getConfig() {
    const stored = (await store.get(keys.config)) ?? {};
    const config = { ...DEFAULT_CONFIG, ...stored };
    // Older configs listed the fixed entries too; only extras are kept.
    config.blockedGroups = (config.blockedGroups ?? []).filter((g) => !isFixedEntry(g));
    delete config.autoBlockProductGroups;
    delete config.groupWriteApi;
    return config;
  }

  async function actorOf(ctx) {
    if (ctx._actor) return ctx._actor;
    const user = await jira.getUser(ctx.accountId).catch(() => null);
    ctx._actor = { accountId: ctx.accountId, displayName: user?.displayName ?? ctx.accountId };
    return ctx._actor;
  }

  async function permissionsOf(ctx, projectId) {
    const cacheKey = `_perms_${projectId ?? 'global'}`;
    if (!ctx[cacheKey]) {
      let perms = await jira.checkPermissions(ctx.accountId, projectId);
      // TEST ONLY (development environment): a Jira admin listed in testProjectAdmins is treated as a project admin
      // on the project page and in Rovo, so the project-admin flow can be tested with a single account. The admin
      // page keeps the real rights, so the same account can still apply the changes there.
      if (perms.jiraAdmin && ctx.surface === 'project' && isDevelopment(ctx)) {
        const testAccounts = (await getConfig()).testProjectAdmins ?? [];
        if (testAccounts.includes(ctx.accountId)) perms = { ...perms, jiraAdmin: false, projectAdmin: Boolean(projectId), testProjectAdmin: true };
      }
      ctx[cacheKey] = perms;
    }
    return ctx[cacheKey];
  }

  function assertLicensed(ctx) {
    // Forge only sets context.license for paid Marketplace apps in production.
    if (isLicenseInactive(ctx.license)) {
      throw new AppError(ErrorCodes.LICENSE_INACTIVE, 'The app licence is not active');
    }
  }

  // Strictly increasing timestamps keep entries written in one call (e.g. "group
  // created" then "member added") in their real order.
  let lastAuditTs = 0;
  async function writeAudit(entry) {
    lastAuditTs = Math.max(now(), lastAuditTs + 1);
    const row = {
      id: uuid(),
      createdAt: lastAuditTs,
      projectId: null,
      projectKey: null,
      groupId: null,
      groupName: null,
      targetAccountId: null,
      targetName: null,
      actorAccountId: null,
      actorName: null,
      details: null,
      ...entry,
    };
    await audit.append(row);
    return row;
  }

  function isIdpGroup(groupName, groupRec, config) {
    if (!config.idpReadOnly) return false;
    if (groupRec?.idpManaged) return true;
    return (config.idpGroups ?? []).some((p) => matchesPattern(p, groupName));
  }

  async function syncProjectKey(project) {
    const existing = await store.get(keys.project(project.id));
    const rec = existing ?? { id: project.id, key: project.key, previousKeys: [], groupIds: [] };
    if (existing && existing.key !== project.key) {
      const from = existing.key;
      rec.previousKeys = [...new Set([...(rec.previousKeys ?? []), from])].filter((k) => k !== project.key);
      rec.key = project.key;
      await store.set(keys.project(project.id), rec);
      const affected = (rec.groupIds ?? []).length;
      // Logged with the time of detection, not necessarily the time of the change.
      await writeAudit({
        action: AuditActions.PROJECT_KEY_CHANGED,
        projectId: project.id,
        projectKey: project.key,
        actorName: 'system',
        details: { from, to: project.key, affectedGroups: affected },
      });
    } else if (!existing) {
      await store.set(keys.project(project.id), rec);
    }
    return rec;
  }

  async function requireProjectAdmin(ctx) {
    if (!ctx.projectId) throw new AppError(ErrorCodes.BAD_REQUEST, 'No project context');
    const [project, perms, config] = await Promise.all([
      jira.getProject(ctx.projectId),
      permissionsOf(ctx, ctx.projectId),
      getConfig(),
    ]);
    if (!perms.projectAdmin && !perms.jiraAdmin) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Project admin permission required');
    }
    if (config.projectsMode === 'selected' && !config.allowedProjects.some((p) => p.id === project.id)) {
      throw new AppError(ErrorCodes.PROJECT_NOT_ALLOWED, 'The app is not enabled for this project', {
        projectKey: project.key,
      });
    }
    const record = await syncProjectKey(project);
    return { project, record, perms, config };
  }

  async function requireJiraAdmin(ctx) {
    const perms = await permissionsOf(ctx, null);
    if (!perms.jiraAdmin) throw new AppError(ErrorCodes.NOT_ADMIN, 'Jira admin permission required');
    return perms;
  }

  async function isAuditor(ctx, config) {
    const perms = await permissionsOf(ctx, null);
    if (perms.jiraAdmin) return true;
    const wanted = (config.auditorGroups ?? []).map((g) => g.toLowerCase());
    if (!wanted.length) return false;
    const mine = await jira.getUserGroups(ctx.accountId).catch(() => []);
    return mine.some((g) => wanted.includes(g.name.toLowerCase()));
  }

  async function requireAuditor(ctx) {
    const config = await getConfig();
    if (!(await isAuditor(ctx, config))) throw new AppError(ErrorCodes.NOT_AUDITOR, 'Auditor access required');
    return config;
  }

  function validateExpiry(expiresAt, config) {
    if (expiresAt === null || expiresAt === undefined || expiresAt === '') return null;
    if (!config.expiryEnabled) throw new AppError(ErrorCodes.BAD_REQUEST, 'Time-limited memberships are disabled', { reason: 'EXPIRY_DISABLED' });
    const ts = Number(expiresAt);
    if (!Number.isFinite(ts) || ts < now() + EXPIRY_MIN || ts > now() + EXPIRY_MAX) {
      throw new AppError(ErrorCodes.BAD_REQUEST, 'Expiry must be between one hour and two years ahead', { reason: 'EXPIRY_RANGE' });
    }
    return ts;
  }

  async function expiriesOf(groupId) {
    const rows = await store.list(keys.expiryPrefix(groupId));
    return new Map(rows.map((r) => [r.value.accountId, r.value]));
  }

  // Who added whom and when, from the audit log (latest "member added" per person).
  async function provenanceOf(groupId) {
    const { entries } = await audit.query({ groupId, action: AuditActions.MEMBER_ADDED, offset: 0, limit: 2000 });
    const map = new Map();
    for (const e of entries) {
      if (e.targetAccountId && !map.has(e.targetAccountId)) map.set(e.targetAccountId, { addedAt: e.createdAt, addedBy: e.actorName });
    }
    return map;
  }

  function reasonDetails(reason, allowed, extra = {}) {
    const details = { ...extra, ...(allowed.includes(reason) ? { reason } : {}) };
    return Object.keys(details).length ? details : null;
  }

  // Removes one member and its expiry record; returns the removed expiry so the
  // removal can be undone exactly.
  async function removeOne({ project, groupRec, writer, actor }, accountId, details) {
    const user = await jira.getUser(accountId).catch(() => null);
    const displayName = user?.displayName ?? accountId;
    const previousExpiry = (await store.get(keys.expiry(groupRec.groupId, accountId)))?.expiresAt ?? null;
    try {
      await writer.removeMember(groupRec.groupId, accountId, groupRec.name);
    } catch (err) {
      // Already gone (Jira-admin mode reports it): the wanted state is reached, nothing to log.
      if (err?.code !== 'NOT_MEMBER') throw err;
      await store.delete(keys.expiry(groupRec.groupId, accountId));
      return { accountId, displayName, previousExpiry, alreadyDone: true };
    }
    await store.delete(keys.expiry(groupRec.groupId, accountId));
    await writeAudit({
      action: AuditActions.MEMBER_REMOVED,
      projectId: project.id,
      projectKey: project.key,
      groupId: groupRec.groupId,
      groupName: groupRec.name,
      targetAccountId: accountId,
      targetName: displayName,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      // The end date goes along, so an undo from anywhere (app or Rovo) restores it.
      details: withAppliedAs(writer, previousExpiry ? { ...(details ?? {}), previousExpiry } : details),
    });
    return { accountId, displayName, previousExpiry };
  }

  // ---------------------------------------------------------------- pending changes (Jira-admin mode)
  //
  // One record per change: 'create' (a new group with its first members), 'add' or 'remove' (one membership).
  // Stored under change:<projectId>:<id>; addressed by the UI as ref "<projectId>:<id>". Requested by a project admin
  // (or the scheduled jobs), applied or rejected by a Jira admin, withdrawn by the requester. Every guardrail runs
  // when the change is requested and again when it is applied.

  const SYSTEM = { accountId: null, displayName: 'system' };
  const refOf = (c) => `${c.projectId}:${c.id}`;
  const isPending = (c) => c?.status === 'pending';
  const publicChange = (c) => ({ ...c, ref: refOf(c) });

  function parseRef(ref) {
    const m = /^([^:\s]{1,32}):([A-Za-z0-9_-]{1,64})$/.exec(String(ref ?? ''));
    if (!m) throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown change', { reason: 'CHANGE_NOT_FOUND' });
    return { projectId: m[1], id: m[2] };
  }

  async function changesOf(projectId) {
    return (await store.list(projectId ? keys.changePrefix(projectId) : 'change:'))
      .map((r) => r.value)
      .filter((c) => c && c.id)
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }

  const openMembershipChange = (list, groupId, accountId, type) =>
    list.find((c) => isPending(c) && c.groupId === groupId && c.accountId === accountId && (!type || c.type === type));

  function changeDetails(rec, extra = {}) {
    const d = { changeRef: refOf(rec), change: rec.type };
    if (rec.reason) d.reason = rec.reason;
    if (rec.type === 'add' && rec.expiresAt) d.expiresAt = rec.expiresAt;
    if (rec.durationDays) d.durationDays = rec.durationDays;
    if (rec.endedAt) d.endedAt = rec.endedAt;
    if (rec.note) d.note = rec.note;
    if (rec.requestId) d.requestId = rec.requestId;
    return { ...d, ...extra };
  }

  async function queueChange(ctx, project, actor, change) {
    const rec = {
      id: uuid(),
      projectId: project.id,
      projectKey: project.key,
      type: change.type,
      status: 'pending',
      groupId: null,
      groupName: null,
      accountId: null,
      displayName: null,
      expiresAt: null,
      durationDays: null,
      endedAt: null,
      reason: null,
      note: null,
      requestId: null,
      create: null,
      via: ctx?.via === 'rovo' ? 'rovo' : null,
      requestedBy: { accountId: actor.accountId ?? null, displayName: actor.displayName },
      requestedAt: now(),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      outcome: null,
      result: null,
      lastError: null,
      ...change,
    };
    await store.set(keys.change(project.id, rec.id), rec);
    await writeAudit({
      action: AuditActions.CHANGE_REQUESTED,
      projectId: project.id,
      projectKey: project.key,
      groupId: rec.groupId,
      groupName: rec.groupName,
      targetAccountId: rec.accountId,
      targetName: rec.displayName,
      actorAccountId: actor.accountId ?? null,
      actorName: actor.displayName,
      details: changeDetails(rec),
    });
    return publicChange(rec);
  }

  // An access request approved by a project admin follows its pending change.
  async function syncRequest(change, actor) {
    if (!change.requestId) return;
    const key = keys.request(change.projectId, change.requestId);
    const request = await store.get(key);
    if (!request || request.status !== 'waiting' || request.pendingChangeRef !== refOf(change)) return;
    let next = null;
    if (change.status === 'applied') next = { ...request, status: 'approved', appliedAt: now(), appliedBy: actor.displayName, pendingChangeRef: null };
    if (change.status === 'rejected') next = { ...request, status: 'denied', decidedAt: now(), decidedBy: actor.displayName, note: change.decisionNote ?? null, rejectedByJiraAdmin: true, pendingChangeRef: null };
    if (change.status === 'withdrawn') next = { ...request, status: 'pending', decidedAt: null, decidedBy: null, note: null, pendingChangeRef: null };
    if (next) await store.set(key, next);
  }

  async function closeChange(rec, status, actor, { note = null, outcome = null, result = null, extra = {} } = {}) {
    const next = { ...rec, status, decidedBy: { accountId: actor.accountId ?? null, displayName: actor.displayName }, decidedAt: now(), decisionNote: note, outcome, result, lastError: null };
    await store.set(keys.change(rec.projectId, rec.id), next);
    const action = { applied: AuditActions.CHANGE_APPLIED, rejected: AuditActions.CHANGE_REJECTED, withdrawn: AuditActions.CHANGE_WITHDRAWN }[status];
    await writeAudit({
      action,
      projectId: rec.projectId,
      projectKey: rec.projectKey,
      groupId: rec.groupId ?? result?.groupId ?? null,
      groupName: rec.groupName,
      targetAccountId: rec.accountId,
      targetName: rec.displayName,
      actorAccountId: actor.accountId ?? null,
      actorName: actor.displayName,
      details: changeDetails(next, { requestedBy: rec.requestedBy?.displayName ?? null, ...(note ? { decisionNote: note } : {}), ...(outcome === 'alreadyDone' ? { alreadyDone: true } : {}), ...extra }),
    });
    await syncRequest(next, actor);
    return next;
  }

  // Project admin, Jira-admin mode: additions wait for a Jira admin. People already in the group are reported as
  // such; an addition that is already waiting is not queued twice; adding someone whose removal you asked for
  // withdraws that removal instead.
  async function queueAdds(ctx, { project, groupRec }, ids, expiryFor, reason, internal = {}) {
    const actor = await actorOf(ctx);
    const members = new Set((await jira.getAllMembers(groupRec.groupId, MEMBER_SCAN_CAP).catch(() => [])).map((m) => m.accountId));
    const open = (await changesOf(project.id)).filter(isPending);
    const results = [];
    for (const accountId of ids) {
      const user = await jira.getUser(accountId).catch(() => null);
      const base = { accountId, displayName: user?.displayName ?? accountId, email: user?.email ?? null, avatarUrl: user?.avatarUrl ?? null, active: user?.active ?? true };
      const removal = openMembershipChange(open, groupRec.groupId, accountId, 'remove');
      if (removal && removal.requestedBy?.accountId === actor.accountId) {
        await closeChange(removal, 'withdrawn', actor);
        results.push({ ...base, status: 'withdrawn', changeRef: refOf(removal) });
        continue;
      }
      if (members.has(accountId)) {
        results.push({ ...base, status: 'already' });
        continue;
      }
      const waiting = openMembershipChange(open, groupRec.groupId, accountId, 'add');
      if (waiting) {
        results.push({ ...base, status: 'pending', changeRef: refOf(waiting), expiresAt: waiting.expiresAt ?? null });
        continue;
      }
      const expiresAt = internal.durationDays ? null : expiryFor(accountId);
      const change = await queueChange(ctx, project, actor, {
        type: 'add',
        groupId: groupRec.groupId,
        groupName: groupRec.name,
        accountId,
        displayName: base.displayName,
        expiresAt,
        durationDays: internal.durationDays ?? null,
        reason: ADD_REASONS.includes(reason) ? reason : null,
        note: internal.note ?? null,
        requestId: internal.requestId ?? null,
      });
      open.push(change);
      results.push({ ...base, status: 'pending', changeRef: change.ref, expiresAt });
    }
    return results;
  }

  // Project admin, Jira-admin mode: removals wait for a Jira admin. Removing someone whose addition you asked for
  // withdraws that addition instead; people who are not in the group are reported as such.
  async function queueRemoves(ctx, { project, groupRec }, ids, { reason = null, note = null, requestId = null } = {}) {
    const actor = await actorOf(ctx);
    const members = new Set((await jira.getAllMembers(groupRec.groupId, MEMBER_SCAN_CAP).catch(() => [])).map((m) => m.accountId));
    const open = (await changesOf(project.id)).filter(isPending);
    const results = [];
    for (const accountId of ids) {
      const user = await jira.getUser(accountId).catch(() => null);
      const displayName = user?.displayName ?? accountId;
      const addition = openMembershipChange(open, groupRec.groupId, accountId, 'add');
      if (addition && addition.requestedBy?.accountId === actor.accountId) {
        await closeChange(addition, 'withdrawn', actor);
        results.push({ accountId, displayName, status: 'withdrawn', changeRef: refOf(addition) });
        continue;
      }
      if (!members.has(accountId)) {
        results.push({ accountId, displayName, status: 'notMember' });
        continue;
      }
      const waiting = openMembershipChange(open, groupRec.groupId, accountId, 'remove');
      if (waiting) {
        results.push({ accountId, displayName, status: 'pending', changeRef: refOf(waiting) });
        continue;
      }
      const previousExpiry = (await store.get(keys.expiry(groupRec.groupId, accountId)))?.expiresAt ?? null;
      const change = await queueChange(ctx, project, actor, {
        type: 'remove',
        groupId: groupRec.groupId,
        groupName: groupRec.name,
        accountId,
        displayName,
        reason,
        note,
        requestId,
      });
      open.push(change);
      results.push({ accountId, displayName, status: 'pending', changeRef: change.ref, previousExpiry });
    }
    return results;
  }

  // The scheduled jobs in Jira-admin mode: a removal for a Jira admin, never twice for the same membership.
  async function queueSystemRemoval({ groupRec, accountId, displayName, reason, endedAt = null }) {
    const projectRec = await store.get(keys.project(groupRec.projectId));
    const open = await changesOf(groupRec.projectId);
    const existing = openMembershipChange(open, groupRec.groupId, accountId, 'remove');
    if (existing) return { queued: false, change: existing };
    // A Jira admin who rejected the removal of a deactivated account keeps it; the daily job does not ask again.
    if (reason === 'deactivated' && open.some((c) => c.status === 'rejected' && c.type === 'remove' && c.reason === 'deactivated' && c.groupId === groupRec.groupId && c.accountId === accountId)) {
      return { queued: false, change: null };
    }
    const change = await queueChange(null, { id: groupRec.projectId, key: projectRec?.key ?? null }, SYSTEM, {
      type: 'remove',
      groupId: groupRec.groupId,
      groupName: groupRec.name,
      accountId,
      displayName,
      reason,
      endedAt,
    });
    return { queued: true, change };
  }

  // A scheduled removal (end date reached, deactivated account): at once with the privileged admin's account when
  // automatic changes are on, otherwise a pending removal for a Jira admin. A removal that already waits for a Jira
  // admin stays in the queue. Returns { status: 'removed' | 'queued' | 'waiting' | 'gone' | 'failed', change? }.
  async function scheduledRemoval(cache, { groupRec, accountId, displayName, reason, endedAt = null, auditDetails = {} }) {
    const open = await changesOf(groupRec.projectId);
    const existing = openMembershipChange(open, groupRec.groupId, accountId, 'remove');
    if (existing) return { status: 'waiting', change: existing };
    if (reason === 'deactivated' && open.some((c) => c.status === 'rejected' && c.type === 'remove' && c.reason === 'deactivated' && c.groupId === groupRec.groupId && c.accountId === accountId)) {
      return { status: 'waiting', change: null }; // a Jira admin decided to keep this account
    }
    const writer = await privilegedWriter(cache);
    if (writer) {
      try {
        await writer.removeMember(groupRec.groupId, accountId, groupRec.name);
        const project = await store.get(keys.project(groupRec.projectId));
        await writeAudit({
          action: reason === 'expiry' ? AuditActions.MEMBER_EXPIRED : AuditActions.MEMBER_AUTO_REMOVED,
          projectId: groupRec.projectId,
          projectKey: project?.key ?? null,
          groupId: groupRec.groupId,
          groupName: groupRec.name,
          targetAccountId: accountId,
          targetName: displayName,
          actorName: 'system',
          details: withAppliedAs(writer, auditDetails),
        });
        return { status: 'removed' };
      } catch (err) {
        if (err?.code === 'NOT_MEMBER' || err?.code === ErrorCodes.GROUP_NOT_FOUND) return { status: 'gone' };
        if (err?.code !== ErrorCodes.PRIVILEGED_ADMIN_UNAVAILABLE) {
          console.warn('Scheduled removal failed, retrying next run', groupRec.groupId, err?.code, err?.message);
          return { status: 'failed' };
        }
        // Automatic changes just paused: this removal waits for a Jira admin like the rest.
      }
    }
    const res = await queueSystemRemoval({ groupRec, accountId, displayName, reason, endedAt });
    return { status: res.queued ? 'queued' : 'waiting', change: res.change };
  }

  function addMonths(ts, months) {
    const d = new Date(ts);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.getTime();
  }

  // Periodic access review: due when the interval has passed since the last review
  // (or since creation; groups never reviewed and without a creation date are due).
  function reviewStatus(groupRec, config) {
    const months = config.reviewIntervalMonths;
    const last = groupRec.lastReviewedAt ?? null;
    if (!months) return { reviewDue: false, reviewDueAt: null, lastReviewedAt: last, lastReviewedBy: groupRec.lastReviewedBy ?? null };
    const base = last ?? groupRec.createdAt ?? null;
    const dueAt = base ? addMonths(base, months) : null;
    return { reviewDue: dueAt === null || now() >= dueAt, reviewDueAt: dueAt, lastReviewedAt: last, lastReviewedBy: groupRec.lastReviewedBy ?? null };
  }

  function projectKeysOf(record) {
    return [record.key, ...(record.previousKeys ?? [])];
  }

  async function loadOwnedGroup(ctx, groupId, { write = false } = {}) {
    if (!groupId) throw new AppError(ErrorCodes.BAD_REQUEST, 'groupId missing');
    const base = await requireProjectAdmin(ctx);
    if (write) assertLicensed(ctx);
    const groupRec = await store.get(keys.group(groupId));
    // A group belongs to exactly one project: the owner project stored at creation
    // AND the key it carries in its name (current or a previous key).
    if (!groupRec || groupRec.projectId !== base.project.id || !parseGroupName(groupRec.name, projectKeysOf(base.record))) {
      throw new AppError(ErrorCodes.GROUP_NOT_IN_PROJECT, 'Group does not belong to this project');
    }
    if (blockingPattern(groupRec.name, base.config)) {
      throw new AppError(ErrorCodes.GROUP_BLOCKED, 'Group is blocked by the Jira admin');
    }
    const readOnly = isIdpGroup(groupRec.name, groupRec, base.config);
    if (write && readOnly) throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is synchronised via IdP/SCIM');
    return { ...base, groupRec, readOnly };
  }

  function summarize(groupRec, record, config, extra = {}) {
    const parsed = parseGroupName(groupRec.name, projectKeysOf(record));
    return {
      groupId: groupRec.groupId,
      name: groupRec.name,
      prefix: parsed?.prefix ?? '',
      namePart: parsed?.namePart ?? groupRec.name,
      // Set when the group was created under a previous project key.
      legacyKey: parsed && parsed.projectKey !== record.key ? parsed.projectKey : null,
      description: groupRec.description ?? '',
      createdAt: groupRec.createdAt ?? null,
      createdBy: groupRec.createdBy ?? null,
      discovered: Boolean(groupRec.discovered),
      readOnly: isIdpGroup(groupRec.name, groupRec, config),
      ...reviewStatus(groupRec, config),
      ...extra,
    };
  }

  // Groups that carry the project's key in their name but were not created through
  // the app (e.g. provisioned via IdP) are registered to the project, as the naming
  // convention defines ownership.
  async function discoverGroups(record, project) {
    const known = new Set(record.groupIds ?? []);
    let changed = false;
    for (const key of projectKeysOf(record)) {
      const found = await jira.searchGroups(prefixFor(key), 100).catch(() => []);
      for (const g of found) {
        if (known.has(g.groupId) || !parseGroupName(g.name, [key])) continue;
        const existing = await store.get(keys.group(g.groupId));
        if (existing && existing.projectId !== project.id) continue;
        if (!existing) {
          await store.set(keys.group(g.groupId), {
            groupId: g.groupId,
            name: g.name,
            projectId: project.id,
            keyAtCreation: key,
            description: '',
            createdAt: null,
            createdBy: null,
            discovered: true,
          });
        }
        known.add(g.groupId);
        changed = true;
      }
    }
    if (changed) {
      record.groupIds = [...known];
      await store.set(keys.project(project.id), record);
    }
    return record;
  }

  function periodToRange(filters = {}) {
    const to = filters.to ?? null;
    if (filters.from) return { from: filters.from, to };
    const days = PERIODS[filters.period];
    return { from: days ? now() - days * DAY : null, to };
  }

  function sanitizeAuditFilters(filters = {}) {
    const actions = Object.values(AuditActions);
    return {
      ...periodToRange(filters),
      groupId: filters.groupId || null,
      action: actions.includes(filters.action) ? filters.action : null,
      person: (filters.person ?? '').toString().trim().slice(0, 100) || null,
    };
  }

  // ---------------------------------------------------------------- project surface

  async function bootstrap(ctx) {
    const { project, record: rec0, perms, config } = await requireProjectAdmin(ctx);
    const record = await discoverGroups(rec0, project);
    const actor = await actorOf(ctx);

    const groupRecs = (await Promise.all((record.groupIds ?? []).map((id) => store.get(keys.group(id))))).filter(Boolean);
    const visible = groupRecs.filter(
      (g) => g.projectId === project.id && parseGroupName(g.name, projectKeysOf(record)) && !blockingPattern(g.name, config),
    );

    const gone = [];
    const groups = (
      await Promise.all(
        visible.map(async (g) => {
          try {
            const memberCount = await jira.countMembers(g.groupId);
            if (g.missingSince) await store.set(keys.group(g.groupId), { ...g, missingSince: null });
            return summarize(g, record, config, { memberCount });
          } catch (err) {
            if (err?.code === ErrorCodes.GROUP_NOT_FOUND) {
              // Deleted natively in Atlassian Administration, or not yet known to
              // Jira: forgotten only after it stayed missing for the grace period.
              const missingSince = g.missingSince ?? now();
              const fresh = g.createdAt && now() - g.createdAt < MISSING_GRACE;
              if (!fresh && now() - missingSince >= MISSING_GRACE) {
                gone.push(g.groupId);
                return null;
              }
              if (!g.missingSince) await store.set(keys.group(g.groupId), { ...g, missingSince });
              return summarize(g, record, config, { memberCount: null, syncing: true });
            }
            return summarize(g, record, config, { memberCount: null });
          }
        }),
      )
    ).filter(Boolean);

    if (gone.length) {
      record.groupIds = record.groupIds.filter((id) => !gone.includes(id));
      await store.set(keys.project(project.id), record);
      await Promise.all(gone.map((id) => store.delete(keys.group(id))));
    }

    groups.sort((a, b) => a.namePart.localeCompare(b.namePart));
    const changes = await changesOf(project.id);
    const openChanges = changes.filter(isPending);
    return {
      project: { id: project.id, key: project.key, name: project.name, avatarUrl: project.avatarUrl ?? null, previousKeys: record.previousKeys ?? [] },
      user: { accountId: actor.accountId, displayName: actor.displayName, isJiraAdmin: Boolean(perms.jiraAdmin), testProjectAdmin: Boolean(perms.testProjectAdmin) },
      // How this caller's group changes run: 'direct' (applied at once) or 'pending' (a Jira admin applies them).
      // effective 'automatic': a project admin's changes apply at once with the privileged admin's account.
      changeMode: await changeModeOf(ctx, perms),
      changes: {
        pending: openChanges.length,
        mine: openChanges.filter((c) => c.requestedBy?.accountId === actor.accountId).length,
        canApply: Boolean(perms.jiraAdmin),
        // Jira admins: everything that waits for a Jira admin, across all projects (the admin page has the full queue).
        ...(perms.jiraAdmin ? { pendingAll: (await changesOf(null)).filter(isPending).length } : {}),
      },
      rolesEnabled: config.rolesEnabled !== false,
      // New groups a project admin asked for that wait for a Jira admin.
      pendingGroups: openChanges
        .filter((c) => c.type === 'create')
        .map((c) => ({ ref: refOf(c), name: c.groupName, prefix: prefixFor(project.key), namePart: c.create?.namePart ?? c.groupName, description: c.create?.description ?? '', requestedBy: c.requestedBy, requestedAt: c.requestedAt, members: c.create?.members?.length ?? 0 })),
      prefix: prefixFor(project.key),
      config: {
        retentionMonths: config.retentionMonths,
        idpReadOnly: config.idpReadOnly,
        expiryEnabled: config.expiryEnabled,
        reviewIntervalMonths: config.reviewIntervalMonths,
        aiEnabled: config.aiEnabled === true,
        aiStopped: vendorAiStop(env),
        // The effective state (switch on AND no vendor stop): the page shows AI entry points only when it is true.
        ai: aiActive(config, env),
      },
      pendingRequests: (await requestsOf(project.id)).filter((r) => r.status === 'pending').length,
      groups,
    };
  }

  async function checkName(ctx, { namePart } = {}) {
    const { project, record, config } = await requireProjectAdmin(ctx);
    const part = (namePart ?? '').toString();
    const fullName = fullGroupName(project.key, part);
    const invalid = validateNamePart(part);
    if (invalid) return { fullName, valid: false, available: false, reason: invalid };
    if (blockingPattern(fullName, config)) return { fullName, valid: false, available: false, reason: 'BLOCKED' };

    // The name check also covers the project's previous keys to avoid duplicates.
    const candidates = projectKeysOf(record).map((k) => fullGroupName(k, part));
    for (const candidate of candidates) {
      const existing = await jira.findGroupByName(candidate);
      if (existing) {
        return { fullName, valid: true, available: false, reason: candidate === fullName ? 'TAKEN' : 'TAKEN_PREVIOUS_KEY', conflict: existing.name };
      }
    }
    // A new group with this name that already waits for a Jira admin.
    const lower = candidates.map((c) => c.toLowerCase());
    const waiting = (await changesOf(project.id)).find((c) => isPending(c) && c.type === 'create' && lower.includes(String(c.groupName).toLowerCase()));
    if (waiting) return { fullName, valid: true, available: false, reason: 'PENDING', conflict: waiting.groupName };
    return { fullName, valid: true, available: true, reason: null };
  }

  async function createGroup(ctx, { namePart, description = '', addMe = false, copyFromGroupId = null } = {}) {
    assertLicensed(ctx);
    const check = await checkName(ctx, { namePart });
    if (!check.valid) throw new AppError(ErrorCodes.NAME_INVALID, 'Invalid group name', { reason: check.reason });
    if (!check.available) throw new AppError(ErrorCodes.NAME_TAKEN, 'Group name already exists', { conflict: check.conflict, ...(check.reason === 'PENDING' ? { reason: 'NAME_PENDING' } : {}) });

    const { project, record, config, perms } = await requireProjectAdmin(ctx);
    const plan = await writePlan(ctx, perms, config);
    const actor = await actorOf(ctx);
    // Preflight for "start with the members of …": the source must be a group of
    // this project and small enough, checked before anything is created.
    let copyFrom = null;
    if (copyFromGroupId) {
      const source = await loadOwnedGroup(ctx, copyFromGroupId);
      const members = await jira.getAllMembers(copyFromGroupId, MAX_BULK_ADD + 1);
      if (members.length > MAX_BULK_ADD) {
        throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_BULK_ADD} members can be copied`, { reason: 'COPY_TOO_MANY' });
      }
      copyFrom = { groupRec: source.groupRec, members };
    }
    const cleanDescription = description.toString().trim().slice(0, MAX_DESCRIPTION);
    // Who is in the group from the start: the creator ("add me") and the copied members, each once.
    const firstMembers = [];
    if (addMe) firstMembers.push({ accountId: actor.accountId, displayName: actor.displayName, reason: null });
    for (const m of copyFrom?.members ?? []) {
      if (!firstMembers.some((f) => f.accountId === m.accountId)) firstMembers.push({ accountId: m.accountId, displayName: m.displayName, reason: 'copy' });
    }

    if (plan.pending) {
      // The full, validated request is stored; a Jira admin creates the group later (checked again then).
      const change = await queueChange(ctx, project, actor, {
        type: 'create',
        groupName: check.fullName,
        create: {
          namePart: String(namePart),
          fullName: check.fullName,
          description: cleanDescription,
          addMe: Boolean(addMe),
          copyFrom: copyFrom ? { groupId: copyFrom.groupRec.groupId, name: copyFrom.groupRec.name } : null,
          members: firstMembers,
        },
      });
      return { pending: true, change, name: check.fullName, prefix: prefixFor(project.key), namePart: String(namePart), description: cleanDescription };
    }

    const out = await executeCreate({ project, record, actor, writer: plan.writer, fullName: check.fullName, description: cleanDescription, createdBy: actor, members: firstMembers, copyFromName: copyFrom?.groupRec.name ?? null });
    const addMeError = addMe ? out.failed.find((f) => f.accountId === actor.accountId) ?? null : null;
    const copied = copyFrom
      ? {
          from: copyFrom.groupRec.name,
          added: out.added.filter((a) => a.reason === 'copy').length,
          failed: out.failed.filter((f) => f.reason === 'copy').map((f) => ({ accountId: f.accountId, displayName: f.displayName, error: f.error })),
        }
      : null;
    return summarize(out.groupRec, record, config, {
      memberCount: out.added.length,
      addMeError: addMeError ? { code: addMeError.code, message: addMeError.error } : null,
      copied,
    });
  }

  // Creates the group, registers it to the project, logs it and adds the first members one by one. Failed members
  // are returned, never dropped. A group that already exists under this name (a retried apply, or created natively
  // meanwhile) is taken over, unless another project owns it.
  async function executeCreate({ project, record, actor, writer, fullName, description, createdBy, members = [], copyFromName = null, auditExtra = {}, reuse = null }) {
    let created = reuse;
    let reused = Boolean(reuse);
    if (!created) try {
      created = await writer.createGroup(fullName, description);
    } catch (err) {
      if (err?.code !== 'GROUP_EXISTS') throw err;
      const existing = await jira.findGroupByName(fullName);
      if (!existing) throw err;
      const owner = await store.get(keys.group(existing.groupId));
      if (owner && owner.projectId !== project.id) throw new AppError(ErrorCodes.NAME_TAKEN, 'Group name already exists', { conflict: existing.name });
      created = existing;
      reused = true;
    }
    const before = await store.get(keys.group(created.groupId));
    const groupRec = {
      ...(before ?? {}),
      groupId: created.groupId,
      name: created.name,
      projectId: project.id, // assignment by project id, not by key
      keyAtCreation: before?.keyAtCreation ?? project.key,
      description,
      createdAt: before?.createdAt ?? now(),
      createdBy: before?.createdBy ?? createdBy,
      discovered: false,
    };
    await store.set(keys.group(groupRec.groupId), groupRec);
    record.groupIds = [...new Set([...(record.groupIds ?? []), groupRec.groupId])];
    await store.set(keys.project(project.id), record);

    if (!before?.createdAt) {
      const details = withAppliedAs(writer, { ...(groupRec.description ? { description: groupRec.description } : {}), ...auditExtra });
      await writeAudit({
        action: AuditActions.GROUP_CREATED,
        projectId: project.id,
        projectKey: project.key,
        groupId: groupRec.groupId,
        groupName: groupRec.name,
        actorAccountId: actor.accountId,
        actorName: actor.displayName,
        details: Object.keys(details).length ? details : null,
      });
    }

    const added = [];
    const failed = [];
    for (const m of members) {
      try {
        let already = false;
        try {
          await writer.addMember(groupRec.groupId, m.accountId, groupRec.name);
        } catch (err) {
          if (err?.code !== 'ALREADY_MEMBER') throw err;
          already = true;
        }
        added.push(m);
        if (already) continue;
        const details = withAppliedAs(writer, { ...(m.reason === 'copy' ? { reason: 'copy', from: copyFromName } : {}), ...auditExtra });
        await writeAudit({
          action: AuditActions.MEMBER_ADDED,
          projectId: project.id,
          projectKey: project.key,
          groupId: groupRec.groupId,
          groupName: groupRec.name,
          targetAccountId: m.accountId,
          targetName: m.displayName,
          actorAccountId: actor.accountId,
          actorName: actor.displayName,
          details: Object.keys(details).length ? details : null,
        });
      } catch (err) {
        // The group exists; report the failed membership instead of hiding it.
        console.warn('Could not add a first member', err?.code, err?.message);
        failed.push({ ...m, code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
      }
    }
    return { groupRec, added, failed, reused };
  }

  async function getGroup(ctx, { groupId } = {}) {
    const loaded = await loadOwnedGroup(ctx, groupId);
    const { record, config } = loaded;
    const { groupRec } = loaded;
    const [memberCount, recent] = await Promise.all([
      jira.countMembers(groupId).catch(() => null),
      audit.query({ groupId, offset: 0, limit: 5 }),
    ]);
    return { ...summarize(groupRec, record, config, { memberCount }), recentChanges: recent.entries };
  }

  // The description is the app's own text for the group (Jira groups have no
  // description field). Allowed for every group the caller owns.
  async function updateDescription(ctx, { groupId, description = '', reason = null } = {}) {
    const { project, groupRec } = await loadOwnedGroup(ctx, groupId);
    assertLicensed(ctx);
    const next = description.toString().trim().slice(0, MAX_DESCRIPTION);
    const before = groupRec.description ?? '';
    if (next === before) return { description: next, previous: before };
    await store.set(keys.group(groupId), { ...groupRec, description: next });
    const actor = await actorOf(ctx);
    await writeAudit({
      action: AuditActions.DESCRIPTION_CHANGED,
      projectId: project.id,
      projectKey: project.key,
      groupId,
      groupName: groupRec.name,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: reasonDetails(reason, ['undo'], { from: before, to: next }),
    });
    return { description: next, previous: before };
  }

  // Members of a group, plus its changes that wait for a Jira admin (shown as such, never as done).
  async function getMembers(ctx, args = {}) {
    const owned = await loadOwnedGroup(ctx, args.groupId);
    const page = await memberPage(owned.groupRec, args);
    const pendingChanges = (await changesOf(owned.project.id)).filter((c) => isPending(c) && c.groupId === owned.groupRec.groupId).map(publicChange);
    return { ...page, pendingChanges };
  }

  async function memberPage(groupRec, { groupId, query = '', startAt = 0, maxResults = 25 } = {}) {
    const size = Math.min(Math.max(Number(maxResults) || 25, 1), 100);
    const offset = Math.max(Number(startAt) || 0, 0);
    const q = fold(query).trim();
    try {
      const page = await readMembers(groupId, q, offset, size);
      if (!page.members.length) return page;
      const [expiries, provenance] = await Promise.all([expiriesOf(groupId), provenanceOf(groupId).catch(() => new Map())]);
      return {
        ...page,
        members: page.members.map((m) => ({
          ...m,
          expiresAt: expiries.get(m.accountId)?.expiresAt ?? null,
          addedAt: provenance.get(m.accountId)?.addedAt ?? null,
          addedBy: provenance.get(m.accountId)?.addedBy ?? null,
        })),
      };
    } catch (err) {
      // A group created moments ago may not be known to Jira yet.
      const fresh = groupRec.createdAt && now() - groupRec.createdAt < FRESH_GROUP;
      if (err?.code === ErrorCodes.GROUP_NOT_FOUND && (fresh || groupRec.missingSince)) {
        return { members: [], total: null, startAt: offset, syncing: true };
      }
      throw err;
    }
  }

  async function readMembers(groupId, q, offset, size) {
    if (!q) {
      const page = await jira.getMembers(groupId, offset, size);
      return { members: page.members, total: page.total, startAt: offset };
    }
    // The Jira API has no member search; scan the (paginated) member list.
    const all = await jira.getAllMembers(groupId, MEMBER_SCAN_CAP);
    const hits = all.filter((m) => fold(m.displayName).includes(q) || fold(m.email).includes(q));
    return { members: hits.slice(offset, offset + size), total: hits.length, startAt: offset };
  }

  async function searchUsers(ctx, { query = '' } = {}) {
    await requireProjectAdmin(ctx);
    const q = query.toString().trim();
    if (q.length < 2) return { users: [] };
    return { users: await jira.searchUsers(q, 20) };
  }

  // The resolver: everything from the payload; request links and durations are only set internally (decideRequest).
  function addMembers(ctx, payload = {}) {
    const { groupId, accountIds = [], expiresAt = null, expiries = {}, reason = null } = payload ?? {};
    return addMembersAs(ctx, { groupId, accountIds, expiresAt, expiries, reason });
  }

  async function addMembersAs(ctx, { groupId, accountIds = [], expiresAt = null, expiries = {}, reason = null }, internal = {}) {
    const owned = await loadOwnedGroup(ctx, groupId, { write: true });
    const { project, groupRec, config } = owned;
    const plan = await writePlan(ctx, owned.perms, config);
    const writer = plan.writer;
    await assertInScope(ctx, owned, reason);
    const defaultExpiry = validateExpiry(expiresAt, config);
    // Undo of a removal restores each person's previous end date, if it still lies ahead.
    const expiryFor = (accountId) => {
      const own = expiries?.[accountId];
      if (own === undefined || own === null) return defaultExpiry;
      return Number(own) > now() + EXPIRY_MIN ? validateExpiry(own, config) : defaultExpiry;
    };
    const ids = [...new Set(accountIds.filter((id) => typeof id === 'string' && id))].slice(0, MAX_BULK_ADD);
    if (!ids.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No users given');
    const actor = await actorOf(ctx);

    if (plan.pending) {
      const results = await queueAdds(ctx, owned, ids, expiryFor, reason, internal);
      return { results, memberCount: await jira.countMembers(groupId).catch(() => null), pending: true };
    }

    const results = [];
    // Sequential on purpose: keeps the audit order stable and stays below rate limits.
    for (const accountId of ids) {
      const user = await jira.getUser(accountId).catch(() => null);
      const base = { accountId, displayName: user?.displayName ?? accountId, email: user?.email ?? null, avatarUrl: user?.avatarUrl ?? null, active: user?.active ?? true };
      try {
        const expiry = expiryFor(accountId);
        await writer.addMember(groupId, accountId, groupRec.name);
        if (expiry) {
          await store.set(keys.expiry(groupId, accountId), {
            groupId,
            accountId,
            projectId: project.id,
            expiresAt: expiry,
            setAt: now(),
            setBy: { accountId: actor.accountId, displayName: actor.displayName },
          });
        }
        await writeAudit({
          action: AuditActions.MEMBER_ADDED,
          projectId: project.id,
          projectKey: project.key,
          groupId,
          groupName: groupRec.name,
          targetAccountId: accountId,
          targetName: base.displayName,
          actorAccountId: actor.accountId,
          actorName: actor.displayName,
          details: withAppliedAs(writer, reasonDetails(reason, ADD_REASONS, expiry ? { expiresAt: expiry } : {})),
        });
        results.push({ ...base, status: 'added', expiresAt: expiry, addedAt: now(), addedBy: actor.displayName });
      } catch (err) {
        if (err?.code === 'ALREADY_MEMBER') results.push({ ...base, status: 'already' });
        else if (err?.code === ErrorCodes.GROUP_READ_ONLY) {
          await store.set(keys.group(groupId), { ...groupRec, idpManaged: true });
          throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is managed by an identity provider');
        } else if (STOP_CODES.includes(err?.code)) throw err; // no consent yet / not a Jira admin: every further call fails too
        else results.push({ ...base, status: 'failed', code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
      }
    }
    const memberCount = await jira.countMembers(groupId).catch(() => null);
    return { results, memberCount };
  }

  async function removeMember(ctx, { groupId, accountId } = {}) {
    const owned = await loadOwnedGroup(ctx, groupId, { write: true });
    const { project, groupRec, config } = owned;
    const plan = await writePlan(ctx, owned.perms, config);
    if (!accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'accountId missing');
    if (plan.pending) {
      const [result] = await queueRemoves(ctx, owned, [accountId]);
      return { ok: true, pending: true, result, memberCount: await jira.countMembers(groupId).catch(() => null) };
    }
    const writer = plan.writer;
    const actor = await actorOf(ctx);
    const removed = await removeOne({ project, groupRec, writer, actor }, accountId, null);
    const memberCount = await jira.countMembers(groupId).catch(() => null);
    return { ok: true, memberCount, removed };
  }

  // Removes several members: used by the access review and by "undo" of an add.
  async function removeMembers(ctx, { groupId, accountIds = [], note = '', reason = 'review' } = {}) {
    const owned = await loadOwnedGroup(ctx, groupId, { write: true });
    const { project, groupRec, config } = owned;
    const plan = await writePlan(ctx, owned.perms, config);
    const writer = plan.writer;
    const ids = [...new Set(accountIds.filter((id) => typeof id === 'string' && id))];
    if (!ids.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No users given');
    if (ids.length > MAX_BULK_REMOVE) {
      throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_BULK_REMOVE} people at once`, { reason: 'TOO_MANY' });
    }
    const actor = await actorOf(ctx);
    const reviewNote = note.toString().trim().slice(0, 300);
    const details = reasonDetails(reason, REMOVE_REASONS, reviewNote ? { note: reviewNote } : {});
    if (plan.pending) {
      const results = await queueRemoves(ctx, owned, ids, { reason: REMOVE_REASONS.includes(reason) ? reason : null, note: reviewNote || null });
      return { results, memberCount: await jira.countMembers(groupId).catch(() => null), pending: true };
    }
    const results = [];
    for (const accountId of ids) {
      try {
        const removed = await removeOne({ project, groupRec, writer, actor }, accountId, details);
        results.push({ ...removed, status: 'removed' });
      } catch (err) {
        if (STOP_CODES.includes(err?.code)) throw err;
        const user = await jira.getUser(accountId).catch(() => null);
        results.push({ accountId, displayName: user?.displayName ?? accountId, status: 'failed', code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
      }
    }
    const memberCount = await jira.countMembers(groupId).catch(() => null);
    return { results, memberCount };
  }

  async function setExpiry(ctx, { groupId, accountId, expiresAt = null, reason = null } = {}) {
    const { project, groupRec, config } = await loadOwnedGroup(ctx, groupId, { write: true });
    if (!accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'accountId missing');
    const userGroups = await jira.getUserGroups(accountId);
    if (!userGroups.some((g) => g.groupId === groupId)) {
      throw new AppError(ErrorCodes.BAD_REQUEST, 'Person is not a member of this group', { reason: 'NOT_A_MEMBER' });
    }
    const next = expiresAt === null ? null : validateExpiry(expiresAt, config);
    const key = keys.expiry(groupId, accountId);
    const before = (await store.get(key))?.expiresAt ?? null;
    if (before === next) return { expiresAt: next, previous: before };
    const actor = await actorOf(ctx);
    if (next) {
      await store.set(key, { groupId, accountId, projectId: project.id, expiresAt: next, setAt: now(), setBy: { accountId: actor.accountId, displayName: actor.displayName } });
    } else {
      await store.delete(key);
    }
    const user = await jira.getUser(accountId).catch(() => null);
    await writeAudit({
      action: AuditActions.EXPIRY_CHANGED,
      projectId: project.id,
      projectKey: project.key,
      groupId,
      groupName: groupRec.name,
      targetAccountId: accountId,
      targetName: user?.displayName ?? accountId,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: reasonDetails(reason, ['undo'], { from: before, to: next }),
    });
    return { expiresAt: next, previous: before };
  }

  // Resolves a pasted list of emails or names to accounts, for review before adding.
  async function resolveUsers(ctx, { entries = [] } = {}) {
    await requireProjectAdmin(ctx);
    const list = [...new Set((Array.isArray(entries) ? entries : []).map((e) => String(e).trim()).filter(Boolean))];
    if (list.length > MAX_RESOLVE) {
      throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_RESOLVE} entries at once`, { reason: 'TOO_MANY' });
    }
    const seen = new Set();
    const rows = [];
    for (const input of list) {
      const found = await jira.searchUsers(input, 10).catch(() => []);
      let match = null;
      let candidates = [];
      if (input.includes('@')) {
        const exact = found.filter((u) => (u.email ?? '').toLowerCase() === input.toLowerCase());
        if (exact.length === 1) match = exact[0];
        else if (found.length === 1) match = found[0];
        else candidates = found.slice(0, 5);
      } else {
        const exact = found.filter((u) => fold(u.displayName) === fold(input));
        if (exact.length === 1) match = exact[0];
        else candidates = (exact.length ? exact : found).slice(0, 5);
      }
      if (match && seen.has(match.accountId)) rows.push({ input, status: 'duplicate', user: match, candidates: [] });
      else if (match) {
        seen.add(match.accountId);
        rows.push({ input, status: 'matched', user: match, candidates: [] });
      } else rows.push({ input, status: candidates.length ? 'ambiguous' : 'notFound', user: null, candidates });
    }
    return { rows };
  }

  async function exportMembers(ctx, { groupId } = {}) {
    const { groupRec } = await loadOwnedGroup(ctx, groupId);
    const [all, expiries, provenance] = await Promise.all([
      jira.getAllMembers(groupId, MEMBER_SCAN_CAP),
      expiriesOf(groupId),
      provenanceOf(groupId).catch(() => new Map()),
    ]);
    const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
    const csv = toCsv(
      ['display_name', 'account_id', 'email', 'status', 'added_at_utc', 'added_by', 'expires_at_utc'],
      all.map((m) => [
        m.displayName,
        m.accountId,
        m.email ?? '',
        m.active ? 'active' : 'deactivated',
        iso(provenance.get(m.accountId)?.addedAt),
        provenance.get(m.accountId)?.addedBy ?? '',
        iso(expiries.get(m.accountId)?.expiresAt),
      ]),
    );
    const stamp = new Date(now()).toISOString().slice(0, 10);
    return { csv, filename: `members-${groupRec.name}-${stamp}.csv`, count: all.length };
  }

  // ---------------------------------------------------------------- member surface ("My groups")

  async function myGroups(ctx) {
    if (!ctx.projectId) throw new AppError(ErrorCodes.BAD_REQUEST, 'No project context');
    const [project, perms, config] = await Promise.all([jira.getProject(ctx.projectId), permissionsOf(ctx, ctx.projectId), getConfig()]);
    const projectInfo = { key: project.key, name: project.name };
    if (!config.memberViewEnabled) return { enabled: false, project: projectInfo, groups: [] };
    if (!perms.canBrowse && !perms.projectAdmin && !perms.jiraAdmin) throw new AppError(ErrorCodes.FORBIDDEN, 'No access to this project');
    if (config.projectsMode === 'selected' && !config.allowedProjects.some((p) => p.id === project.id)) {
      throw new AppError(ErrorCodes.PROJECT_NOT_ALLOWED, 'The app is not enabled for this project');
    }
    const stored = (await store.get(keys.project(project.id))) ?? { key: project.key, previousKeys: [], groupIds: [] };
    const record = {
      ...stored,
      key: project.key,
      previousKeys: [...new Set([...(stored.previousKeys ?? []), stored.key].filter((k) => k && k !== project.key))],
    };
    const mine = new Set((await jira.getUserGroups(ctx.accountId)).map((g) => g.groupId));
    const recs = (await Promise.all((record.groupIds ?? []).filter((id) => mine.has(id)).map((id) => store.get(keys.group(id))))).filter(
      (g) => g && g.projectId === project.id && parseGroupName(g.name, projectKeysOf(record)) && !blockingPattern(g.name, config),
    );
    const groups = await Promise.all(
      recs.map(async (g) => {
        const own = await store.get(keys.expiry(g.groupId, ctx.accountId));
        const sum = summarize(g, record, config);
        // Only what concerns the viewer: no member lists of other people.
        return { groupId: sum.groupId, name: sum.name, prefix: sum.prefix, namePart: sum.namePart, description: sum.description, readOnly: sum.readOnly, expiresAt: own?.expiresAt ?? null };
      }),
    );
    groups.sort((a, b) => a.namePart.localeCompare(b.namePart));
    const actor = await actorOf(ctx);
    let requestable = [];
    let requests = [];
    if (config.requestsEnabled) {
      const { recs: all } = await projectGroupRecords(project, config);
      requestable = all
        .filter((g) => !mine.has(g.groupId) && !isIdpGroup(g.name, g, config))
        .map((g) => {
          const sum = summarize(g, record, config);
          return { groupId: sum.groupId, name: sum.name, prefix: sum.prefix, namePart: sum.namePart, description: sum.description };
        })
        .sort((a, b) => a.namePart.localeCompare(b.namePart));
      const since = now() - 90 * DAY;
      requests = (await requestsOf(project.id)).filter((r) => r.accountId === ctx.accountId && r.createdAt >= since);
    }
    return {
      enabled: true,
      project: projectInfo,
      user: { displayName: actor.displayName },
      groups,
      requestsEnabled: Boolean(config.requestsEnabled),
      expiryEnabled: Boolean(config.expiryEnabled),
      requestable,
      requests,
    };
  }

  // ---------------------------------------------------------------- first-run tutorial

  // Which tutorial version the caller has finished or skipped on this surface.
  // Stored per user, so every new user sees the tour once.
  async function tutorialState(ctx) {
    if (!ctx.accountId) return { seenVersion: null };
    const seen = (await store.get(keys.tutorial(ctx.accountId))) ?? {};
    return { seenVersion: seen[ctx.surface]?.version ?? null };
  }

  async function markTutorialSeen(ctx, { version = 1, completed = false } = {}) {
    if (!ctx.accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'No account context');
    if (!TUTORIAL_SURFACES.includes(ctx.surface)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown surface');
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw new AppError(ErrorCodes.BAD_REQUEST, 'Invalid version');
    const seen = (await store.get(keys.tutorial(ctx.accountId))) ?? {};
    seen[ctx.surface] = { version: v, completed: Boolean(completed), at: now() };
    await store.set(keys.tutorial(ctx.accountId), seen);
    return { seenVersion: v };
  }

  // ---------------------------------------------------------------- auditor surface

  async function auditorBootstrap(ctx) {
    const config = await requireAuditor(ctx);
    const perms = await permissionsOf(ctx, null);
    const actor = await actorOf(ctx);
    return { user: { displayName: actor.displayName, isJiraAdmin: Boolean(perms.jiraAdmin) }, retentionMonths: config.retentionMonths };
  }

  async function getUsage(ctx, { groupId, refresh = false } = {}) {
    const { groupRec, project, record } = await loadOwnedGroup(ctx, groupId);
    const usage = await usageOf(groupRec, { refresh });
    return { ...usage, outsideProject: outsideUses(usage, projectKeysOf(record ?? { key: project.key })) };
  }

  // Where-used result, cached for USAGE_TTL. No permission check: callers check.
  async function usageOf(groupRec, { refresh = false } = {}) {
    const groupId = groupRec.groupId;
    const cached = await store.get(keys.usage(groupId));
    if (!refresh && cached?.v === USAGE_VERSION && now() - cached.at < USAGE_TTL) return { ...cached.data, cachedAt: cached.at };
    const [jiraChecks, confluenceChecks] = await Promise.all([jira.getUsage({ groupId, name: groupRec.name }), confluenceUsage(groupId, groupRec.name)]);
    const data = { ...jiraChecks, ...confluenceChecks };
    console.log('Usage checks', Object.entries(data).map(([k, c]) => `${k}=${c?.status}:${c?.items?.length ?? 0}`).join(' '));
    // Failed checks are not cached, so the next view tries them again.
    const failed = Object.values(data).some((c) => c?.status === 'error');
    if (!failed) await store.set(keys.usage(groupId), { at: now(), v: USAGE_VERSION, data });
    return { ...data, cachedAt: now() };
  }

  // Grants in other Jira projects: a permission scheme shared with other projects,
  // or a role in another project. Only checks that ran count; a failed check is
  // reported as unknown by the where-used panel itself.
  function outsideUses(usage, ownKeys) {
    const own = new Set(ownKeys.map((k) => k.toUpperCase()));
    const out = [];
    if (usage.permissionSchemes?.status === 'ok') {
      for (const s of usage.permissionSchemes.items ?? []) {
        for (const p of s.projects ?? []) if (!own.has(String(p.key).toUpperCase())) out.push({ kind: 'permissionScheme', name: s.name, projectKey: p.key });
      }
    }
    if (usage.projectRoles?.status === 'ok') {
      for (const r of usage.projectRoles.items ?? []) if (!own.has(String(r.projectKey).toUpperCase())) out.push({ kind: 'projectRole', name: r.role, projectKey: r.projectKey });
    }
    return out;
  }

  // Scope guard for additions by project admins (see DEFAULT_CONFIG.scopeGuard).
  async function assertInScope(ctx, { groupRec, record, project, config, perms }, reason) {
    if (perms?.jiraAdmin || config.scopeGuard !== 'block' || SCOPE_EXEMPT_REASONS.includes(reason)) return;
    const memo = (ctx._scope ??= new Map());
    if (!memo.has(groupRec.groupId)) {
      memo.set(groupRec.groupId, usageOf(groupRec).then((u) => outsideUses(u, projectKeysOf(record ?? { key: project.key }))));
    }
    const outside = await memo.get(groupRec.groupId);
    if (outside.length) {
      const projects = [...new Set(outside.map((o) => o.projectKey))].sort();
      throw new AppError(ErrorCodes.GROUP_USED_ELSEWHERE, 'The group also grants access in other projects; only a Jira admin can add people to it', { reason: 'USED_ELSEWHERE', projects, uses: outside.slice(0, 20) });
    }
  }

  async function confluenceUsage(groupId, name) {
    const off = { status: 'unavailable', items: [], reason: 'NOT_INSTALLED' };
    if (!confluence || !(await confluence.isAvailable())) return { confluenceSpaces: off, confluencePages: off };
    const spaces = await confluence
      .spacePermissions({ groupId, name })
      .then((r) => ({ status: 'ok', ...r }))
      .catch((err) => ({ status: 'error', items: [], error: { message: err?.message ?? String(err) } }));
    const state = await indexState(store);
    const pages = await pagesForGroup(store, groupId);
    let spaceMap = {};
    if (pages.length) spaceMap = await confluence.spaceKeys([...new Set(pages.map((p) => p.spaceId))]).catch(() => ({}));
    return {
      confluenceSpaces: spaces,
      confluencePages: {
        status: state.lastFullScanAt ? 'ok' : 'indexing',
        items: pages.map((p) => ({ ...p, spaceKey: spaceMap[p.spaceId]?.key ?? null, spaceName: spaceMap[p.spaceId]?.name ?? null })),
        index: { lastFullScanAt: state.lastFullScanAt, scannedInCurrentPass: state.scanned, pagesInLastScan: state.pagesInLastScan, updatedAt: state.updatedAt },
      },
    };
  }

  // ---------------------------------------------------------------- people view (who is in which group)

  // One table of every person in the project's groups. Read-only; IdP groups are
  // included (marked) so the overview is complete.
  async function accessMatrix(ctx) {
    const { project, config } = await requireProjectAdmin(ctx);
    const { recs, record } = await projectGroupRecords(project, config);
    const chosen = recs
      .map((g) => ({ rec: g, sum: summarize(g, record, config) }))
      .sort((a, b) => a.sum.namePart.localeCompare(b.sum.namePart))
      .slice(0, ACCESS_GROUP_CAP);
    const people = new Map();
    let truncated = recs.length > ACCESS_GROUP_CAP;
    const groups = await Promise.all(
      chosen.map(async ({ rec, sum }) => {
        const out = { groupId: sum.groupId, name: sum.name, prefix: sum.prefix, namePart: sum.namePart, readOnly: sum.readOnly, memberCount: 0, available: true };
        let members;
        let expiries;
        try {
          [members, expiries] = await Promise.all([jira.getAllMembers(rec.groupId, ACCESS_MEMBER_CAP), expiriesOf(rec.groupId)]);
        } catch (err) {
          // Not yet known to Jira (just created) or not readable: shown as such.
          return { ...out, available: false };
        }
        if (members.length >= ACCESS_MEMBER_CAP) truncated = true;
        for (const m of members) {
          const person = people.get(m.accountId) ?? { accountId: m.accountId, displayName: m.displayName, email: m.email ?? null, avatarUrl: m.avatarUrl ?? null, active: m.active !== false, memberships: {} };
          person.memberships[rec.groupId] = { expiresAt: expiries.get(m.accountId)?.expiresAt ?? null };
          people.set(m.accountId, person);
        }
        return { ...out, memberCount: members.length };
      }),
    );
    const list = [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { project: { key: project.key }, groups, people: list, truncated, expiryEnabled: Boolean(config.expiryEnabled) };
  }

  // Applies several membership changes across groups in one go. Every change runs
  // through addMembers/removeMembers, so ownership, block list, IdP read-only,
  // licence and audit apply per group. Returns one result per change.
  async function applyAccessChanges(ctx, { changes = [], expiresAt = null, expiries = {}, note = '', reason = 'bulk' } = {}) {
    await requireProjectAdmin(ctx);
    assertLicensed(ctx);
    if (!Array.isArray(changes) || !changes.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No changes given');
    const seen = new Set();
    const clean = [];
    for (const c of changes) {
      if (!c || typeof c.groupId !== 'string' || typeof c.accountId !== 'string' || !['add', 'remove'].includes(c.op)) {
        throw new AppError(ErrorCodes.BAD_REQUEST, 'Invalid change', { reason: 'INVALID_CHANGE' });
      }
      const key = `${c.groupId}|${c.accountId}`;
      if (seen.has(key)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Conflicting changes for the same membership', { reason: 'DUPLICATE_CHANGE' });
      seen.add(key);
      clean.push({ groupId: c.groupId, accountId: c.accountId, op: c.op });
    }
    if (clean.length > MAX_ACCESS_CHANGES) {
      throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_ACCESS_CHANGES} changes at once`, { reason: 'TOO_MANY' });
    }
    const addReason = ['undo', 'bulk'].includes(reason) ? reason : 'bulk';
    const batches = new Map();
    for (const c of clean) {
      const key = `${c.groupId}|${c.op}`;
      batches.set(key, [...(batches.get(key) ?? []), c]);
    }
    const results = [];
    const counts = {};
    // Warm the where-used cache of every group that gains people, in parallel, so
    // the scope guard does not check them one after another.
    const addGroups = [...new Set(clean.filter((c) => c.op === 'add').map((c) => c.groupId))];
    await Promise.all(addGroups.map(async (id) => {
      const rec = await store.get(keys.group(id)).catch(() => null);
      if (rec) await usageOf(rec).catch(() => null);
    }));
    // Removals first: a person moved between groups never holds both for long.
    const ordered = [...batches.values()].sort((a, b) => (a[0].op === b[0].op ? 0 : a[0].op === 'remove' ? -1 : 1));
    for (const batch of ordered) {
      const { groupId, op } = batch[0];
      const ids = batch.map((c) => c.accountId);
      try {
        const res =
          op === 'add'
            ? await addMembers(ctx, { groupId, accountIds: ids, expiresAt, expiries, reason: addReason })
            : await removeMembers(ctx, { groupId, accountIds: ids, note, reason: addReason });
        const name = (await store.get(keys.group(groupId)))?.name ?? groupId;
        for (const r of res.results) results.push({ ...r, groupId, groupName: name, op });
        if (res.memberCount !== null && res.memberCount !== undefined) counts[groupId] = res.memberCount;
      } catch (err) {
        const name = (await store.get(keys.group(groupId)).catch(() => null))?.name ?? groupId;
        for (const accountId of ids) {
          results.push({ accountId, displayName: accountId, groupId, groupName: name, op, status: 'failed', code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
        }
      }
    }
    return { results, memberCounts: counts };
  }

  // ---------------------------------------------------------------- access requests

  async function projectGroupRecords(project, config) {
    const stored = (await store.get(keys.project(project.id))) ?? { key: project.key, previousKeys: [], groupIds: [] };
    const record = {
      ...stored,
      key: project.key,
      previousKeys: [...new Set([...(stored.previousKeys ?? []), stored.key].filter((k) => k && k !== project.key))],
    };
    const recs = (await Promise.all((record.groupIds ?? []).map((id) => store.get(keys.group(id))))).filter(
      (g) => g && g.projectId === project.id && parseGroupName(g.name, projectKeysOf(record)) && !blockingPattern(g.name, config),
    );
    return { record, recs };
  }

  async function requestsOf(projectId) {
    return (await store.list(keys.requestPrefix(projectId))).map((r) => r.value).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function memberContext(ctx) {
    if (!ctx.projectId) throw new AppError(ErrorCodes.BAD_REQUEST, 'No project context');
    const [project, perms, config] = await Promise.all([jira.getProject(ctx.projectId), permissionsOf(ctx, ctx.projectId), getConfig()]);
    if (!perms.canBrowse && !perms.projectAdmin && !perms.jiraAdmin) throw new AppError(ErrorCodes.FORBIDDEN, 'No access to this project');
    if (config.projectsMode === 'selected' && !config.allowedProjects.some((p) => p.id === project.id)) {
      throw new AppError(ErrorCodes.PROJECT_NOT_ALLOWED, 'The app is not enabled for this project');
    }
    return { project, perms, config };
  }

  async function requestAccess(ctx, { groupId, reason = '', durationDays = null } = {}) {
    const { project, config } = await memberContext(ctx);
    assertLicensed(ctx);
    if (!config.memberViewEnabled || !config.requestsEnabled) throw new AppError(ErrorCodes.BAD_REQUEST, 'Access requests are switched off', { reason: 'REQUESTS_DISABLED' });
    const text = reason.toString().trim().slice(0, 300);
    if (text.length < 3) throw new AppError(ErrorCodes.BAD_REQUEST, 'Please give a reason', { reason: 'REASON_REQUIRED' });
    const days = durationDays === null || durationDays === undefined ? null : Number(durationDays);
    if (days !== null && !REQUEST_DURATIONS.includes(days)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Invalid duration', { reason: 'DURATION' });
    if (days !== null && !config.expiryEnabled) throw new AppError(ErrorCodes.BAD_REQUEST, 'Time-limited memberships are disabled', { reason: 'EXPIRY_DISABLED' });
    const { recs } = await projectGroupRecords(project, config);
    const groupRec = recs.find((g) => g.groupId === groupId);
    if (!groupRec) throw new AppError(ErrorCodes.GROUP_NOT_IN_PROJECT, 'Group does not belong to this project');
    if (isIdpGroup(groupRec.name, groupRec, config)) throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is synchronised via IdP/SCIM');
    const mine = await jira.getUserGroups(ctx.accountId);
    if (mine.some((g) => g.groupId === groupId)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Already a member', { reason: 'ALREADY_MEMBER' });
    const open = (await requestsOf(project.id)).find((r) => r.groupId === groupId && r.accountId === ctx.accountId && (r.status === 'pending' || r.status === 'waiting'));
    if (open) throw new AppError(ErrorCodes.BAD_REQUEST, 'A request is already pending', { reason: 'ALREADY_REQUESTED' });
    const actor = await actorOf(ctx);
    const request = {
      id: uuid(),
      projectId: project.id,
      groupId,
      groupName: groupRec.name,
      accountId: ctx.accountId,
      displayName: actor.displayName,
      reason: text,
      durationDays: days,
      status: 'pending',
      createdAt: now(),
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    await store.set(keys.request(project.id, request.id), request);
    await writeAudit({
      action: AuditActions.ACCESS_REQUESTED,
      projectId: project.id,
      projectKey: project.key,
      groupId,
      groupName: groupRec.name,
      targetAccountId: ctx.accountId,
      targetName: actor.displayName,
      actorAccountId: ctx.accountId,
      actorName: actor.displayName,
      details: { requestId: request.id, reason: text, ...(days ? { durationDays: days } : {}) },
    });
    return { request };
  }

  async function withdrawRequest(ctx, { requestId } = {}) {
    const { project } = await memberContext(ctx);
    const key = keys.request(project.id, requestId);
    const request = await store.get(key);
    if (!request || request.accountId !== ctx.accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'Request not found', { reason: 'NOT_FOUND' });
    if (request.status !== 'pending') throw new AppError(ErrorCodes.BAD_REQUEST, 'Request is no longer pending', { reason: 'NOT_PENDING' });
    const next = { ...request, status: 'withdrawn', decidedAt: now() };
    await store.set(key, next);
    await writeAudit({
      action: AuditActions.ACCESS_REQUEST_WITHDRAWN,
      projectId: project.id,
      projectKey: project.key,
      groupId: request.groupId,
      groupName: request.groupName,
      targetAccountId: request.accountId,
      targetName: request.displayName,
      actorAccountId: ctx.accountId,
      actorName: request.displayName,
      details: { requestId },
    });
    return { request: next };
  }

  async function listRequests(ctx, { status = 'pending' } = {}) {
    const { project } = await requireProjectAdmin(ctx);
    const all = await requestsOf(project.id);
    const since = now() - 90 * DAY;
    return { requests: status === 'all' ? all.filter((r) => r.createdAt >= since) : all.filter((r) => r.status === status) };
  }

  async function decideRequest(ctx, { requestId, decision, note = '', expiresAt } = {}) {
    if (!['approve', 'deny'].includes(decision)) throw new AppError(ErrorCodes.BAD_REQUEST, 'decision must be approve or deny');
    const { project } = await requireProjectAdmin(ctx);
    assertLicensed(ctx);
    const key = keys.request(project.id, requestId);
    const request = await store.get(key);
    if (!request) throw new AppError(ErrorCodes.BAD_REQUEST, 'Request not found', { reason: 'NOT_FOUND' });
    if (request.status !== 'pending') throw new AppError(ErrorCodes.BAD_REQUEST, 'Request is no longer pending', { reason: 'NOT_PENDING' });
    const actor = await actorOf(ctx);
    const cleanNote = note.toString().trim().slice(0, 300) || null;
    let member = null;
    let status = decision === 'approve' ? 'approved' : 'denied';
    let pendingChangeRef = null;
    if (decision === 'approve') {
      const until =
        expiresAt !== undefined ? expiresAt : request.durationDays ? now() + request.durationDays * DAY : null;
      // In Jira-admin mode a project admin's approval becomes a pending change; the requested duration then starts
      // when a Jira admin applies it.
      const internal = { requestId, note: request.reason ?? null, durationDays: expiresAt === undefined ? request.durationDays ?? null : null };
      const res = await addMembersAs(ctx, { groupId: request.groupId, accountIds: [request.accountId], expiresAt: until, reason: 'request' }, internal);
      member = res.results[0];
      if (member?.status === 'failed') throw new AppError(member.code ?? ErrorCodes.JIRA_ERROR, member.error ?? 'Could not add the member');
      if (member?.status === 'pending') {
        status = 'waiting';
        pendingChangeRef = member.changeRef;
        // A change that already waited for the same membership (another request or a manual add) is followed too.
        const change = await store.get(keys.change(project.id, parseRef(member.changeRef).id));
        if (change && !change.requestId) await store.set(keys.change(project.id, change.id), { ...change, requestId });
      }
    }
    const next = { ...request, status, decidedAt: now(), decidedBy: actor.displayName, note: cleanNote, ...(pendingChangeRef ? { pendingChangeRef } : {}) };
    await store.set(key, next);
    await writeAudit({
      action: decision === 'approve' ? AuditActions.ACCESS_REQUEST_APPROVED : AuditActions.ACCESS_REQUEST_DENIED,
      projectId: project.id,
      projectKey: project.key,
      groupId: request.groupId,
      groupName: request.groupName,
      targetAccountId: request.accountId,
      targetName: request.displayName,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { requestId, ...(cleanNote ? { note: cleanNote } : {}), ...(pendingChangeRef ? { changeRef: pendingChangeRef, waitingForJiraAdmin: true } : {}) },
    });
    return { request: next, member, pending: status === 'waiting' };
  }

  // Undo of a decision: removes the membership an approval granted and puts the
  // request back to "pending"; a denial simply goes back to "pending".
  async function reopenRequest(ctx, { requestId } = {}) {
    const { project } = await requireProjectAdmin(ctx);
    assertLicensed(ctx);
    const key = keys.request(project.id, requestId);
    const request = await store.get(key);
    if (!request || !['approved', 'denied', 'waiting'].includes(request.status)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Request cannot be reopened', { reason: 'NOT_DECIDED' });
    const actor = await actorOf(ctx);
    let removalPending = false;
    if (request.status === 'waiting' && request.pendingChangeRef) {
      // Approved, but not applied yet: the waiting change is withdrawn.
      const change = await store.get(keys.change(project.id, parseRef(request.pendingChangeRef).id));
      if (isPending(change)) await closeChange(change, 'withdrawn', actor, { note: 'request reopened' });
    }
    if (request.status === 'approved') {
      const owned = await loadOwnedGroup(ctx, request.groupId, { write: true });
      const plan = await writePlan(ctx, owned.perms, owned.config);
      if (plan.pending) {
        await queueRemoves(ctx, owned, [request.accountId], { reason: 'undo', requestId });
        removalPending = true;
      } else {
        await removeOne({ project, groupRec: owned.groupRec, writer: plan.writer, actor }, request.accountId, { reason: 'undo', requestId });
      }
    }
    const next = { ...(await store.get(key)), status: 'pending', decidedAt: null, decidedBy: null, note: null, pendingChangeRef: null };
    await store.set(key, next);
    await writeAudit({
      action: AuditActions.ACCESS_REQUEST_REOPENED,
      projectId: project.id,
      projectKey: project.key,
      groupId: request.groupId,
      groupName: request.groupName,
      targetAccountId: request.accountId,
      targetName: request.displayName,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { requestId, reason: 'undo', was: request.status, ...(removalPending ? { removalWaitingForJiraAdmin: true } : {}) },
    });
    return { request: next, removalPending };
  }

  // ---------------------------------------------------------------- periodic access review

  async function completeReview(ctx, { groupId, note = '', removed = 0 } = {}) {
    const { project, groupRec } = await loadOwnedGroup(ctx, groupId);
    assertLicensed(ctx);
    const actor = await actorOf(ctx);
    const cleanNote = note.toString().trim().slice(0, 300) || null;
    const next = { ...groupRec, lastReviewedAt: now(), lastReviewedBy: actor.displayName };
    await store.set(keys.group(groupId), next);
    await writeAudit({
      action: AuditActions.ACCESS_REVIEW_COMPLETED,
      projectId: project.id,
      projectKey: project.key,
      groupId,
      groupName: groupRec.name,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { removed: Math.max(0, Number(removed) || 0), ...(cleanNote ? { note: cleanNote } : {}) },
    });
    const config = await getConfig();
    return { ...reviewStatus(next, config) };
  }

  // ---------------------------------------------------------------- automation: deactivated accounts

  async function deactivatedMembers() {
    const config = await getConfig();
    const groups = (await store.list('group:'))
      .map((r) => r.value)
      .filter((g) => g && !blockingPattern(g.name, config) && !isIdpGroup(g.name, g, config))
      .slice(0, AUTOMATION_GROUP_CAP);
    const out = [];
    for (const g of groups) {
      const members = await jira.getAllMembers(g.groupId, 2000).catch(() => []);
      for (const m of members) if (!m.active) out.push({ groupId: g.groupId, groupName: g.name, projectId: g.projectId, accountId: m.accountId, displayName: m.displayName });
    }
    return out;
  }

  async function previewDeactivatedCleanup(ctx) {
    await requireJiraAdmin(ctx);
    const items = await deactivatedMembers();
    return { items };
  }

  async function runAutomation() {
    const config = await getConfig();
    if (!config.autoRemoveDeactivated) return { removed: 0, skipped: 'disabled' };
    // Removed at once with the privileged admin's account (automatic changes); otherwise each removal waits for a
    // Jira admin, since a scheduled job has no signed-in user of its own.
    const cache = {};
    let queued = 0;
    let removed = 0;
    for (const item of await deactivatedMembers()) {
      const res = await scheduledRemoval(cache, { groupRec: { groupId: item.groupId, name: item.groupName, projectId: item.projectId }, accountId: item.accountId, displayName: item.displayName, reason: 'deactivated', auditDetails: { reason: 'deactivated' } });
      if (res.status === 'queued') queued++;
      if (res.status === 'removed' || res.status === 'gone') await store.delete(keys.expiry(item.groupId, item.accountId));
      if (res.status === 'removed') removed++;
    }
    return { removed, queued };
  }

  // ---------------------------------------------------------------- project roles

  // Role changes run as the signed-in user (asUser): Jira allows them for the project's admins and for Jira admins,
  // so nobody can do more here than in Jira's own project settings. They apply at once; no Jira admin is needed.
  function roleWriter(ctx) {
    if (!jiraUser?.addRoleActor) throw new AppError(ErrorCodes.JIRA_ERROR, 'Project roles are not available here');
    const as = { accountId: ctx.accountId };
    return {
      add: (projectId, roleId, accountId) => jiraUser.addRoleActor(projectId, roleId, accountId, as),
      remove: (projectId, roleId, accountId) => jiraUser.removeRoleActor(projectId, roleId, accountId, as),
      addGroup: (projectId, roleId, groupId) => jiraUser.addRoleGroup(projectId, roleId, groupId, as),
      removeGroup: (projectId, roleId, groupId) => jiraUser.removeRoleGroup(projectId, roleId, groupId, as),
    };
  }

  async function requireRoles(ctx, { write = false } = {}) {
    const base = await requireProjectAdmin(ctx);
    if (base.config.rolesEnabled === false) throw new AppError(ErrorCodes.FORBIDDEN, 'Project roles are turned off by the Jira admin', { reason: 'ROLES_OFF' });
    if (write) assertLicensed(ctx);
    return base;
  }

  async function rolesOf(project) {
    const roles = await jira.getProjectRoles(project.id);
    return roles.filter((r) => !HIDDEN_ROLES.includes(r.name));
  }

  async function loadRole(project, roleId) {
    const role = (await rolesOf(project)).find((r) => r.roleId === String(roleId ?? ''));
    if (!role) throw new AppError(ErrorCodes.ROLE_NOT_FOUND, 'This role does not exist in the project');
    return role;
  }

  // The roles of the caller's project with their people and groups, both changeable here. Groups this app manages for
  // the project are marked so the UI can link to them; protected groups (admin, product access, the blocked list) are
  // marked locked: only a Jira admin changes those, in Jira's own project settings.
  async function listRoles(ctx) {
    const { project, record, config } = await requireRoles(ctx);
    const owned = new Set(record.groupIds ?? []);
    const roles = await rolesOf(project);
    return {
      project: { id: project.id, key: project.key },
      me: ctx.accountId,
      roles: roles.map((r) => ({
        roleId: r.roleId,
        name: r.name,
        description: r.description ?? '',
        people: r.actors
          .filter((a) => a.type === 'user')
          .map((a) => ({ accountId: a.accountId, displayName: a.displayName ?? a.accountId, avatarUrl: a.avatarUrl ?? null }))
          .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '')),
        groups: r.actors
          .filter((a) => a.type === 'group')
          .map((a) => ({ groupId: a.groupId, name: a.name, managed: Boolean(a.groupId && owned.has(a.groupId)), locked: Boolean(blockingPattern(a.name ?? '', config)) }))
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      })),
    };
  }

  async function roleAudit(action, { project, role, actor, accountId, displayName, details = {} }) {
    await writeAudit({
      action,
      projectId: project.id,
      projectKey: project.key,
      // Roles share the group columns of the audit log: id "role:<projectId>:<roleId>", name "<role> (project role)".
      groupId: `role:${project.id}:${role.roleId}`,
      groupName: `${role.name} (project role)`,
      targetAccountId: accountId,
      targetName: displayName,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: { kind: 'role', roleId: role.roleId, role: role.name, ...details },
    });
  }

  // Adds people to a role of the caller's project, at once and with the caller's own Jira rights.
  async function addRoleMembers(ctx, { roleId, accountIds = [], reason = null } = {}) {
    const { project } = await requireRoles(ctx, { write: true });
    const role = await loadRole(project, roleId);
    const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).filter((id) => typeof id === 'string' && id))].slice(0, MAX_BULK_ADD);
    if (!ids.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No users given');
    const writer = roleWriter(ctx);
    const actor = await actorOf(ctx);
    const results = [];
    let stop = null;
    for (const accountId of ids) {
      const user = await jira.getUser(accountId).catch(() => null);
      const base = { accountId, displayName: user?.displayName ?? accountId, avatarUrl: user?.avatarUrl ?? null };
      if (stop) {
        results.push({ ...base, status: 'failed', code: stop.code, error: stop.message });
        continue;
      }
      try {
        await writer.add(project.id, role.roleId, accountId);
        await roleAudit(AuditActions.ROLE_MEMBER_ADDED, { project, role, actor, accountId, displayName: base.displayName, details: reason === 'undo' ? { reason: 'undo' } : {} });
        results.push({ ...base, status: 'added' });
      } catch (err) {
        if (err?.code === 'ALREADY_MEMBER') results.push({ ...base, status: 'already' });
        else {
          results.push({ ...base, status: 'failed', code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
          // Consent missing or not allowed for this user: the rest would fail the same way.
          if ([ErrorCodes.USER_CONSENT_REQUIRED, ErrorCodes.ROLE_FORBIDDEN, ErrorCodes.ROLE_NOT_FOUND].includes(err?.code)) stop = err;
        }
      }
    }
    return { role: { roleId: role.roleId, name: role.name }, results, consentRequired: stop?.code === ErrorCodes.USER_CONSENT_REQUIRED };
  }

  // Groups for the "Add group" field of a role: this project's own groups first, protected groups left out.
  // Without a query it suggests the project's own groups.
  async function searchRoleGroups(ctx, { query = '' } = {}) {
    const { record, config } = await requireRoles(ctx);
    const q = String(query ?? '').trim().slice(0, 100);
    const owned = new Set(record.groupIds ?? []);
    let found;
    if (q.length >= 2) {
      found = await jira.searchGroups(q, 30);
    } else {
      found = (await Promise.all((record.groupIds ?? []).map((id) => store.get(keys.group(id))))).filter(Boolean).map((g) => ({ groupId: g.groupId, name: g.name }));
    }
    const groups = found
      .filter((g) => g?.groupId && g.name && !blockingPattern(g.name, config))
      .map((g) => ({ groupId: g.groupId, name: g.name, own: owned.has(g.groupId) }))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name))
      .slice(0, 20);
    return { groups };
  }

  // Adds groups to a role of the caller's project, at once and with the caller's own Jira rights (as in Jira's project
  // settings). Protected groups are refused; a Jira admin adds those in Jira itself.
  async function addRoleGroups(ctx, { roleId, groupIds = [], reason = null } = {}) {
    const { project, config } = await requireRoles(ctx, { write: true });
    const role = await loadRole(project, roleId);
    const ids = [...new Set((Array.isArray(groupIds) ? groupIds : []).filter((id) => typeof id === 'string' && id))].slice(0, 20);
    if (!ids.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No groups given');
    const writer = roleWriter(ctx);
    const actor = await actorOf(ctx);
    const results = [];
    let stop = null;
    for (const groupId of ids) {
      const group = await jira.getGroup(groupId).catch(() => null);
      const base = { groupId, name: group?.name ?? groupId };
      if (!group) {
        results.push({ ...base, status: 'failed', code: ErrorCodes.GROUP_NOT_FOUND, error: 'Group not found' });
        continue;
      }
      if (blockingPattern(group.name, config)) {
        results.push({ ...base, status: 'failed', code: ErrorCodes.GROUP_BLOCKED, error: 'Protected group' });
        continue;
      }
      if (stop) {
        results.push({ ...base, status: 'failed', code: stop.code, error: stop.message });
        continue;
      }
      try {
        await writer.addGroup(project.id, role.roleId, groupId);
        await roleAudit(AuditActions.ROLE_MEMBER_ADDED, { project, role, actor, accountId: null, displayName: group.name, details: { actorType: 'group', actorGroupId: groupId, ...(reason === 'undo' ? { reason: 'undo' } : {}) } });
        results.push({ ...base, status: 'added' });
      } catch (err) {
        if (err?.code === 'ALREADY_MEMBER') results.push({ ...base, status: 'already' });
        else {
          results.push({ ...base, status: 'failed', code: err?.code ?? ErrorCodes.JIRA_ERROR, error: err?.message ?? String(err) });
          if ([ErrorCodes.USER_CONSENT_REQUIRED, ErrorCodes.ROLE_FORBIDDEN, ErrorCodes.ROLE_NOT_FOUND].includes(err?.code)) stop = err;
        }
      }
    }
    return { role: { roleId: role.roleId, name: role.name }, results, consentRequired: stop?.code === ErrorCodes.USER_CONSENT_REQUIRED };
  }

  // Removes a group from a role. Protected groups stay (a Jira admin changes those in Jira).
  async function removeRoleGroup(ctx, { roleId, groupId, reason = null } = {}) {
    const { project, config } = await requireRoles(ctx, { write: true });
    if (!groupId || typeof groupId !== 'string') throw new AppError(ErrorCodes.BAD_REQUEST, 'groupId missing');
    const role = await loadRole(project, roleId);
    const inRole = role.actors.find((a) => a.type === 'group' && a.groupId === groupId);
    const name = inRole?.name ?? (await jira.getGroup(groupId).catch(() => null))?.name ?? groupId;
    if (blockingPattern(name, config)) throw new AppError(ErrorCodes.GROUP_BLOCKED, 'Protected groups are changed by a Jira admin in Jira', { reason: 'ROLE_GROUP_LOCKED' });
    const actor = await actorOf(ctx);
    try {
      await roleWriter(ctx).removeGroup(project.id, role.roleId, groupId);
    } catch (err) {
      if (err?.code === 'NOT_MEMBER') return { role: { roleId: role.roleId, name: role.name }, groupId, name, alreadyDone: true };
      throw err;
    }
    await roleAudit(AuditActions.ROLE_MEMBER_REMOVED, { project, role, actor, accountId: null, displayName: name, details: { actorType: 'group', actorGroupId: groupId, ...(reason === 'undo' ? { reason: 'undo' } : {}) } });
    return { role: { roleId: role.roleId, name: role.name }, groupId, name, alreadyDone: false };
  }

  // Removes one person from a role. Removing yourself is refused: it could take away your own project admin rights.
  async function removeRoleMember(ctx, { roleId, accountId, reason = null } = {}) {
    const { project } = await requireRoles(ctx, { write: true });
    if (!accountId || typeof accountId !== 'string') throw new AppError(ErrorCodes.BAD_REQUEST, 'accountId missing');
    if (accountId === ctx.accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'You cannot remove yourself from a role', { reason: 'SELF' });
    const role = await loadRole(project, roleId);
    const user = await jira.getUser(accountId).catch(() => null);
    const displayName = user?.displayName ?? accountId;
    const actor = await actorOf(ctx);
    try {
      await roleWriter(ctx).remove(project.id, role.roleId, accountId);
    } catch (err) {
      if (err?.code === 'NOT_MEMBER') return { role: { roleId: role.roleId, name: role.name }, accountId, displayName, alreadyDone: true };
      throw err;
    }
    await roleAudit(AuditActions.ROLE_MEMBER_REMOVED, { project, role, actor, accountId, displayName, details: reason === 'undo' ? { reason: 'undo' } : {} });
    return { role: { roleId: role.roleId, name: role.name }, accountId, displayName, alreadyDone: false };
  }

  // ---------------------------------------------------------------- compliance overview (Jira admins)

  async function complianceOverview() {
    const config = await getConfig();
    const [groups, expiries, requests, index] = await Promise.all([store.list('group:'), store.list('expiry:'), store.list('request:'), indexState(store)]);
    const projectKeys = {};
    for (const r of await store.list('project:')) projectKeys[r.value?.id] = r.value?.key;
    const reviewsDue = groups
      .map((r) => r.value)
      .filter((g) => g && !blockingPattern(g.name, config) && reviewStatus(g, config).reviewDue)
      .map((g) => ({ groupId: g.groupId, groupName: g.name, projectKey: projectKeys[g.projectId] ?? null, dueAt: reviewStatus(g, config).reviewDueAt }));
    const soon = now() + 14 * DAY;
    const groupNames = new Map(groups.map((r) => [r.value?.groupId, r.value?.name]));
    const expiringSoon = expiries
      .map((r) => r.value)
      .filter((e) => e?.expiresAt && e.expiresAt <= soon)
      .sort((x, y) => x.expiresAt - y.expiresAt)
      .map((e) => ({ groupId: e.groupId, groupName: groupNames.get(e.groupId) ?? null, accountId: e.accountId, expiresAt: e.expiresAt, projectKey: projectKeys[e.projectId] ?? null }));
    // Names for the first entries, so the card says who loses access where; a failed lookup just leaves the name out.
    await Promise.all(
      expiringSoon.slice(0, 50).map(async (e) => {
        const user = await jira.getUser(e.accountId).catch(() => null);
        if (user?.displayName) e.displayName = user.displayName;
      }),
    );
    const pendingRequests = requests.map((r) => r.value).filter((r) => r?.status === 'pending').length;
    const pendingChanges = (await changesOf(null)).filter(isPending).length;
    return { reviewsDue, expiringSoon, pendingRequests, pendingChanges, confluenceIndex: { lastFullScanAt: index.lastFullScanAt, scanned: index.scanned, pagesInLastScan: index.pagesInLastScan } };
  }

  async function rebuildConfluenceIndex(ctx) {
    await requireJiraAdmin(ctx);
    await resetIndex(store);
    return { ok: true };
  }

  // ---------------------------------------------------------------- changes to apply (Jira admins)

  // Applying and rejecting: Jira admins only. On the admin page for every project, on a project page for that project.
  async function requireChangeAdmin(ctx) {
    if (ctx.surface === 'admin') {
      await requireJiraAdmin(ctx);
      return { projectId: null };
    }
    const { project, perms } = await requireProjectAdmin(ctx);
    if (!perms.jiraAdmin) throw new AppError(ErrorCodes.JIRA_ADMIN_REQUIRED, 'Only Jira administrators can apply changes');
    return { projectId: project.id };
  }

  function cleanRefs(refs, projectId) {
    const list = [...new Set((Array.isArray(refs) ? refs : [refs]).filter((r) => typeof r === 'string' && r))];
    if (!list.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No changes given');
    if (list.length > MAX_CHANGE_BATCH) throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_CHANGE_BATCH} changes at once`, { reason: 'TOO_MANY' });
    return list.map((ref) => {
      const parsed = parseRef(ref);
      // A project page only reaches its own project's changes.
      if (projectId && parsed.projectId !== projectId) throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown change', { reason: 'CHANGE_NOT_FOUND' });
      return { ref, ...parsed };
    });
  }

  async function listChanges(ctx, { status = 'pending', groupId = null } = {}) {
    let projectId = null;
    let canApply = true;
    if (ctx.surface === 'admin') await requireJiraAdmin(ctx);
    else {
      const { project, perms } = await requireProjectAdmin(ctx);
      projectId = project.id;
      canApply = Boolean(perms.jiraAdmin);
    }
    const all = await changesOf(projectId);
    const since = now() - CHANGE_HISTORY;
    const recent = (c) => (c.decidedAt ?? c.requestedAt) >= since;
    const wanted = status === 'decided' ? (c) => !isPending(c) && recent(c) : status === 'all' ? (c) => isPending(c) || recent(c) : isPending;
    const list = all.filter((c) => (!groupId || c.groupId === groupId) && wanted(c));
    return { changes: list.slice(0, 500).map(publicChange), canApply, pendingCount: all.filter(isPending).length, mode: 'jiraAdmin', me: ctx.accountId };
  }

  // Applies pending changes as the calling Jira admin. Idempotent: a change whose result is already in place
  // (person already in / out, group already there) is marked applied without an error. Every guardrail runs again.
  // One result per change; nothing is dropped. Without consent or Jira admin rights the rest of the batch stops.
  async function applyChanges(ctx, { refs = [] } = {}) {
    const scope = await requireChangeAdmin(ctx);
    assertLicensed(ctx);
    const list = cleanRefs(refs, scope.projectId);
    const config = await getConfig();
    const writer = await applierWriter(ctx, config);
    const actor = await actorOf(ctx);
    const results = [];
    let stop = null;
    for (const { ref, projectId, id } of list) {
      const key = keys.change(projectId, id);
      const rec = await store.get(key);
      if (!rec) {
        results.push({ ref, status: 'failed', code: ErrorCodes.BAD_REQUEST, reason: 'CHANGE_NOT_FOUND', error: 'This change no longer exists' });
        continue;
      }
      if (rec.status === 'applied') {
        results.push({ ref, status: 'applied', alreadyDone: true, change: publicChange(rec) });
        continue;
      }
      if (!isPending(rec)) {
        results.push({ ref, status: 'skipped', reason: rec.status, change: publicChange(rec) });
        continue;
      }
      if (stop) {
        results.push({ ref, status: 'failed', code: stop.code, error: stop.message, change: publicChange(rec) });
        continue;
      }
      try {
        const out = await applyOne(ctx, rec, writer, actor);
        const next = await closeChange(rec, 'applied', actor, {
          outcome: out.alreadyDone ? 'alreadyDone' : 'done',
          result: out.result ?? null,
          extra: out.result?.failed?.length ? { failed: out.result.failed.map((f) => f.displayName ?? f.accountId) } : {},
        });
        results.push({ ref, status: 'applied', alreadyDone: Boolean(out.alreadyDone), change: publicChange(next) });
      } catch (err) {
        const code = err?.code ?? ErrorCodes.JIRA_ERROR;
        const failed = { ...rec, lastError: { code, reason: err?.details?.reason ?? null, message: err?.message ?? String(err), at: now() } };
        await store.set(key, failed);
        results.push({ ref, status: 'failed', code, reason: err?.details?.reason ?? null, error: err?.message ?? String(err), details: err?.details ?? null, change: publicChange(failed) });
        if (STOP_CODES.includes(code)) stop = err;
      }
    }
    const pendingCount = (await changesOf(scope.projectId)).filter(isPending).length;
    return { results, consentRequired: stop?.code === ErrorCodes.USER_CONSENT_REQUIRED, notJiraAdmin: stop?.code === ErrorCodes.JIRA_ADMIN_REQUIRED, pendingCount };
  }

  async function applyOne(ctx, rec, writer, actor) {
    // The change's own project, checked again with the applier's rights (project still enabled, key, ownership).
    const projCtx = { accountId: ctx.accountId, projectId: rec.projectId, surface: ctx.surface, license: ctx.license, environmentType: ctx.environmentType, cloudId: ctx.cloudId, _actor: actor };
    const extra = { changeRef: refOf(rec), requestedBy: rec.requestedBy?.displayName ?? null };
    if (rec.type === 'create') return applyCreate(projCtx, rec, writer, actor, extra);
    if (rec.type === 'add') return applyAdd(projCtx, rec, writer, actor, extra);
    if (rec.type === 'remove') return applyRemove(projCtx, rec, writer, actor, extra);
    throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown change type');
  }

  async function applyCreate(projCtx, rec, writer, actor, extra) {
    const { project, record, config } = await requireProjectAdmin(projCtx);
    assertLicensed(projCtx);
    const c = rec.create ?? {};
    const fullName = c.fullName ?? rec.groupName;
    // Name rules again: still this project's prefix (current or previous key), valid, not blocked.
    const parsed = parseGroupName(fullName, projectKeysOf(record));
    if (!parsed) throw new AppError(ErrorCodes.NAME_INVALID, 'The name no longer matches this project', { reason: 'PROJECT_KEY' });
    const invalid = validateNamePart(parsed.namePart);
    if (invalid) throw new AppError(ErrorCodes.NAME_INVALID, 'Invalid group name', { reason: invalid });
    if (blockingPattern(fullName, config)) throw new AppError(ErrorCodes.NAME_INVALID, 'The name is blocked', { reason: 'BLOCKED' });
    const existing = await jira.findGroupByName(fullName);
    let alreadyDone = false;
    if (existing) {
      const owner = await store.get(keys.group(existing.groupId));
      if (owner && owner.projectId !== project.id) throw new AppError(ErrorCodes.NAME_TAKEN, 'Group name already exists', { conflict: existing.name });
      alreadyDone = Boolean(owner);
    }
    const out = await executeCreate({
      project,
      record,
      actor,
      writer,
      fullName,
      description: String(c.description ?? '').slice(0, MAX_DESCRIPTION),
      createdBy: rec.requestedBy,
      members: Array.isArray(c.members) ? c.members.slice(0, MAX_BULK_ADD + 1) : [],
      copyFromName: c.copyFrom?.name ?? null,
      auditExtra: extra,
      reuse: existing ? { groupId: existing.groupId, name: existing.name } : null,
    });
    return {
      alreadyDone: alreadyDone && !out.failed.length,
      result: { groupId: out.groupRec.groupId, added: out.added.length, failed: out.failed.map((f) => ({ accountId: f.accountId, displayName: f.displayName, code: f.code, error: f.error })) },
    };
  }

  async function applyAdd(projCtx, rec, writer, actor, extra) {
    const owned = await loadOwnedGroup(projCtx, rec.groupId, { write: true });
    const { project, groupRec, config } = owned;
    // The scope guard applies as for the project admin who asked (Jira admins add directly when they want more).
    await assertInScope(projCtx, { ...owned, perms: { jiraAdmin: false } }, rec.reason);
    // A requested duration starts now; a fixed end date must still lie ahead.
    const expiry = rec.durationDays ? validateExpiry(now() + rec.durationDays * DAY, config) : rec.expiresAt ? validateExpiry(rec.expiresAt, config) : null;
    let alreadyDone = false;
    try {
      await writer.addMember(groupRec.groupId, rec.accountId, groupRec.name);
    } catch (err) {
      if (err?.code === 'ALREADY_MEMBER') alreadyDone = true;
      else if (err?.code === ErrorCodes.GROUP_READ_ONLY) {
        await store.set(keys.group(groupRec.groupId), { ...groupRec, idpManaged: true });
        throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is managed by an identity provider');
      } else throw err;
    }
    if (expiry) {
      await store.set(keys.expiry(groupRec.groupId, rec.accountId), { groupId: groupRec.groupId, accountId: rec.accountId, projectId: project.id, expiresAt: expiry, setAt: now(), setBy: rec.requestedBy });
    }
    if (!alreadyDone) {
      await writeAudit({
        action: AuditActions.MEMBER_ADDED,
        projectId: project.id,
        projectKey: project.key,
        groupId: groupRec.groupId,
        groupName: groupRec.name,
        targetAccountId: rec.accountId,
        targetName: rec.displayName,
        actorAccountId: actor.accountId,
        actorName: actor.displayName,
        details: reasonDetails(rec.reason, ADD_REASONS, { ...extra, ...(expiry ? { expiresAt: expiry } : {}) }),
      });
    }
    return { alreadyDone, result: { expiresAt: expiry } };
  }

  async function applyRemove(projCtx, rec, writer, actor, extra) {
    // A group that no longer exists (deleted and forgotten) has nobody left to remove.
    if (!(await store.get(keys.group(rec.groupId)))) return { alreadyDone: true };
    const owned = await loadOwnedGroup(projCtx, rec.groupId, { write: true });
    const details = { ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.note ? { note: rec.note } : {}), ...(rec.endedAt ? { expiresAt: rec.endedAt } : {}), ...(rec.requestId ? { requestId: rec.requestId } : {}), ...extra };
    try {
      const removed = await removeOne({ project: owned.project, groupRec: owned.groupRec, writer, actor }, rec.accountId, details);
      return { alreadyDone: Boolean(removed.alreadyDone), result: { previousExpiry: removed.previousExpiry } };
    } catch (err) {
      if (err?.code !== ErrorCodes.GROUP_NOT_FOUND) throw err;
      await store.delete(keys.expiry(rec.groupId, rec.accountId));
      return { alreadyDone: true };
    }
  }

  async function rejectChanges(ctx, { refs = [], note = '' } = {}) {
    const scope = await requireChangeAdmin(ctx);
    const list = cleanRefs(refs, scope.projectId);
    const actor = await actorOf(ctx);
    const cleanNote = String(note ?? '').trim().slice(0, 300) || null;
    const results = [];
    for (const { ref, projectId, id } of list) {
      const rec = await store.get(keys.change(projectId, id));
      if (!rec) {
        results.push({ ref, status: 'failed', reason: 'CHANGE_NOT_FOUND', error: 'This change no longer exists' });
        continue;
      }
      if (!isPending(rec)) {
        results.push({ ref, status: 'skipped', reason: rec.status, change: publicChange(rec) });
        continue;
      }
      // Keeping a member whose access ended: the end date goes, otherwise the hourly job would ask again.
      let extra = {};
      if (rec.type === 'remove' && rec.reason === 'expiry') {
        await store.delete(keys.expiry(rec.groupId, rec.accountId));
        extra = { expiryCleared: true };
      }
      const next = await closeChange(rec, 'rejected', actor, { note: cleanNote, extra });
      results.push({ ref, status: 'rejected', change: publicChange(next) });
    }
    return { results, pendingCount: (await changesOf(scope.projectId)).filter(isPending).length };
  }

  // The requester takes back their own waiting changes.
  async function withdrawChanges(ctx, { refs = [] } = {}) {
    const { project } = await requireProjectAdmin(ctx);
    const list = cleanRefs(refs, project.id);
    const actor = await actorOf(ctx);
    const results = [];
    for (const { ref, projectId, id } of list) {
      const rec = await store.get(keys.change(projectId, id));
      if (!rec) results.push({ ref, status: 'failed', reason: 'CHANGE_NOT_FOUND' });
      else if (rec.requestedBy?.accountId !== ctx.accountId) results.push({ ref, status: 'failed', reason: 'NOT_YOURS' });
      else if (!isPending(rec)) results.push({ ref, status: 'skipped', reason: rec.status, change: publicChange(rec) });
      else results.push({ ref, status: 'withdrawn', change: publicChange(await closeChange(rec, 'withdrawn', actor)) });
    }
    return { results, pendingCount: (await changesOf(project.id)).filter(isPending).length };
  }

  // "Grant access": an asUser call that lets Forge ask for the user's consent. src/index.js passes Forge's
  // authentication error through for this resolver only, so Forge shows its own "Allow access" prompt.
  async function grantAccess(ctx) {
    if (!ctx.accountId) throw new AppError(ErrorCodes.FORBIDDEN, 'Not signed in');
    if (!jiraUser?.requestConsent) return { ok: true };
    await jiraUser.requestConsent({ accountId: ctx.accountId });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Rovo helpers

  // Resolves a project key typed in Rovo into a trusted project id; permissions are
  // still checked for the calling user on every service call.
  async function resolveProjectKey(projectKey) {
    const key = String(projectKey ?? '').trim();
    if (!key) throw new AppError(ErrorCodes.BAD_REQUEST, 'projectKey missing');
    const project = await jira.getProject(key).catch(() => null);
    if (!project) throw new AppError(ErrorCodes.BAD_REQUEST, `Project ${key} not found`, { reason: 'PROJECT_NOT_FOUND' });
    return project;
  }

  async function findOwnedGroup(ctx, groupName) {
    const { project, config } = await requireProjectAdmin(ctx);
    const { recs, record } = await projectGroupRecords(project, config);
    const wanted = String(groupName ?? '').trim().toLowerCase();
    const hit = recs.find((g) => g.name.toLowerCase() === wanted || (parseGroupName(g.name, projectKeysOf(record))?.namePart ?? '').toLowerCase() === wanted);
    if (!hit) throw new AppError(ErrorCodes.GROUP_NOT_IN_PROJECT, `No group "${groupName}" in ${project.key}`);
    return hit;
  }

  // ---------------------------------------------------------------- audit log (both surfaces)

  async function auditScope(ctx) {
    if (ctx.surface === 'admin') {
      await requireJiraAdmin(ctx);
      return { projectId: null };
    }
    if (ctx.surface === 'auditor') {
      await requireAuditor(ctx);
      return { projectId: null };
    }
    const { project } = await requireProjectAdmin(ctx);
    return { projectId: project.id };
  }

  async function queryAudit(ctx, { filters = {}, page = 0, pageSize = 20 } = {}) {
    const scope = await auditScope(ctx);
    const size = Math.min(Math.max(Number(pageSize) || 20, 5), 100);
    const f = sanitizeAuditFilters(filters);
    const projectId = scope.projectId ?? (filters.projectId || null);
    const { entries, total } = await audit.query({ ...f, projectId, offset: Math.max(Number(page) || 0, 0) * size, limit: size });
    const config = await getConfig();
    return { entries, total, page, pageSize: size, retentionMonths: config.retentionMonths };
  }

  async function auditFilterOptions(ctx) {
    const scope = await auditScope(ctx);
    return { groups: await audit.groups({ projectId: scope.projectId }), projects: scope.projectId ? [] : await audit.projects() };
  }

  async function exportAudit(ctx, { filters = {} } = {}) {
    const scope = await auditScope(ctx);
    const f = sanitizeAuditFilters(filters);
    const projectId = scope.projectId ?? (filters.projectId || null);
    const { entries, total } = await audit.query({ ...f, projectId, offset: 0, limit: 50000 });
    const stamp = new Date(now()).toISOString().slice(0, 10);
    return { csv: auditRowsToCsv(entries), filename: `audit-log-${stamp}.csv`, count: entries.length, truncated: total > entries.length };
  }

  // ---------------------------------------------------------------- admin surface

  // The configuration as the admin page sees it: the TEST ONLY list only in development.
  function publicConfig(ctx, config) {
    const out = { ...config };
    delete out.groupChanges; // setting of versions up to 3.17 (organization mode), no longer used
    if (!isDevelopment(ctx)) delete out.testProjectAdmins;
    return out;
  }

  async function adminBootstrap(ctx) {
    await requireJiraAdmin(ctx);
    const [config, actor, managed] = await Promise.all([getConfig(), actorOf(ctx), store.list('group:')]);
    const projects = new Set(managed.map((g) => g.value?.projectId).filter(Boolean));
    return {
      user: { accountId: actor.accountId, displayName: actor.displayName, isJiraAdmin: true },
      config: publicConfig(ctx, config),
      // The TEST ONLY switch exists only in Forge's development environment.
      development: isDevelopment(ctx),
      // SUPERPORT stopped the AI features for all sites (AI_BUDGET): the admin's own switch is kept but has no effect.
      aiStopped: vendorAiStop(env),
      defaults: { coreBlockedGroups: CORE_BLOCKED_GROUPS, productAccessPatterns: PRODUCT_ACCESS_PATTERNS },
      stats: { managedGroups: managed.length, projects: projects.size },
      compliance: await complianceOverview(),
      confluence: { available: Boolean(confluence && (await confluence.isAvailable())) },
      privileged: publicPrivileged(await privilegedRecord()),
      setup: await setupStatus(ctx),
    };
  }

  // Versions up to 3.17 could keep an organization API key (Forge secret LEGACY_ORG_SECRET) for an optional
  // "organization connection". Atlassian does not allow Marketplace apps to collect organization API keys, so the app
  // no longer reads it and deletes a stored key: on install/upgrade, and daily in case that trigger did not run.
  // Idempotent; the removal is recorded in the audit log (no key material, only that it was removed).
  async function purgeLegacyOrgConnection() {
    if (!secrets) return { removed: false };
    const stored = await secrets.get(LEGACY_ORG_SECRET).catch(() => null);
    const config = await store.get(keys.config);
    if (config && 'groupChanges' in config) {
      const { groupChanges, ...rest } = config;
      await store.set(keys.config, rest);
    }
    if (!stored) return { removed: false };
    await secrets.delete(LEGACY_ORG_SECRET);
    await writeAudit({
      action: AuditActions.CONFIG_CHANGED,
      projectId: '*',
      actorName: 'system',
      details: { changed: ['orgConnection'], removed: true, reason: 'unsupported' },
    });
    return { removed: true };
  }

  function sanitizeConfig(input = {}, { development = false, testProjectAdmins = [] } = {}) {
    input = input ?? {};
    const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 500);
    const months = input.retentionMonths === null || input.retentionMonths === undefined ? null : Math.round(Number(input.retentionMonths));
    if (months !== null && (!Number.isFinite(months) || months < 1 || months > 600)) {
      throw new AppError(ErrorCodes.BAD_REQUEST, 'Retention must be between 1 and 600 months', { field: 'retentionMonths' });
    }
    const projects = (Array.isArray(input.allowedProjects) ? input.allowedProjects : [])
      .filter((p) => p && p.id)
      .map((p) => ({ id: String(p.id), key: String(p.key ?? ''), name: String(p.name ?? '') }));
    return {
      retentionMonths: months,
      blockedGroups: list(input.blockedGroups).filter((g) => !isFixedEntry(g)),
      idpReadOnly: Boolean(input.idpReadOnly),
      idpGroups: list(input.idpGroups),
      projectsMode: input.projectsMode === 'selected' ? 'selected' : 'all',
      allowedProjects: projects,
      memberViewEnabled: input.memberViewEnabled !== false,
      auditorGroups: list(input.auditorGroups),
      expiryEnabled: input.expiryEnabled !== false,
      requestsEnabled: input.requestsEnabled !== false,
      reviewIntervalMonths: REVIEW_INTERVALS.includes(Number(input.reviewIntervalMonths)) ? Number(input.reviewIntervalMonths) : null,
      autoRemoveDeactivated: input.autoRemoveDeactivated === true,
      scopeGuard: SCOPE_GUARDS.includes(input.scopeGuard) ? input.scopeGuard : 'block',
      aiEnabled: input.aiEnabled === true,
      rolesEnabled: input.rolesEnabled !== false,
      // TEST ONLY: changeable only in the development environment; elsewhere the stored value is kept untouched.
      testProjectAdmins: development
        ? [...new Set((Array.isArray(input.testProjectAdmins) ? input.testProjectAdmins : []).map((v) => String(v).trim()).filter((v) => /^[A-Za-z0-9:_-]{1,128}$/.test(v)))].slice(0, MAX_TEST_ACCOUNTS)
        : testProjectAdmins,
    };
  }

  async function saveConfig(ctx, { config, reason = null } = {}) {
    await requireJiraAdmin(ctx);
    const stored = await getConfig();
    const before = { ...stored };
    delete before.groupChanges;
    const options = { development: isDevelopment(ctx), testProjectAdmins: stored.testProjectAdmins ?? [] };
    const next = sanitizeConfig(config, options);
    await store.set(keys.config, next);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) {
      const actor = await actorOf(ctx);
      await writeAudit({
        action: AuditActions.CONFIG_CHANGED,
        projectId: '*',
        actorAccountId: actor.accountId,
        actorName: actor.displayName,
        // The AI switch also records its new state (on/off), so the log shows who turned it on or off and when.
        // The same for the TEST ONLY list (development only).
        details: reasonDetails(reason, ['undo'], {
          changed,
          ...(changed.includes('aiEnabled') ? { aiEnabled: next.aiEnabled } : {}),
          ...(changed.includes('testProjectAdmins') ? { testProjectAdmins: next.testProjectAdmins.length } : {}),
        }),
      });
    }
    return { config: publicConfig(ctx, next), changed, previous: publicConfig(ctx, sanitizeConfig(before, options)) };
  }

  // The Rovo actions ask this before anything else: AI features run only when a Jira admin turned them on.
  async function isAiEnabled() {
    return (await getConfig()).aiEnabled === true;
  }

  // ---------------------------------------------------------------- data export / import

  // Jira admins only (global "Administer Jira"), checked again on every page of
  // an export or import. Used to move an installation, e.g. development → production.
  async function exportData(ctx, { part, cursor = null } = {}) {
    await requireJiraAdmin(ctx);
    if (part === 'meta') {
      const actor = await actorOf(ctx);
      await writeAudit({ action: AuditActions.DATA_EXPORTED, projectId: '*', actorAccountId: actor.accountId, actorName: actor.displayName });
      return { format: EXPORT_FORMAT, version: EXPORT_VERSION, cloudId: ctx.cloudId ?? null, exportedAt: now(), exportedBy: actor.displayName, prefixes: TRANSFER_PREFIXES };
    }
    if (part === 'kvs') return exportKvsPage(store, cursor);
    if (part === 'audit') return exportAuditPage(audit, cursor);
    throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown export part');
  }

  async function importData(ctx, { part, entries, cloudId = null, summary = {} } = {}) {
    await requireJiraAdmin(ctx);
    checkSameSite(ctx.cloudId, cloudId);
    if (part === 'kvs') return importKvs(store, entries);
    if (part === 'audit') return importAudit(audit, entries);
    if (part === 'finish') {
      const actor = await actorOf(ctx);
      const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
      const details = { records: n(summary.records), entries: n(summary.entries), skipped: n(summary.skipped), exportedAt: n(summary.exportedAt) || null, exportedBy: summary.exportedBy ? String(summary.exportedBy).slice(0, 255) : null };
      await writeAudit({ action: AuditActions.DATA_IMPORTED, projectId: '*', actorAccountId: actor.accountId, actorName: actor.displayName, details });
      return { ok: true };
    }
    throw new AppError(ErrorCodes.BAD_REQUEST, 'Unknown import part');
  }

  async function searchGroups(ctx, { query = '' } = {}) {
    await requireJiraAdmin(ctx);
    return { groups: await jira.searchGroups(query.toString().trim(), 20) };
  }

  async function searchProjects(ctx, { query = '' } = {}) {
    await requireJiraAdmin(ctx);
    return { projects: await jira.searchProjects(query.toString().trim(), 20) };
  }

  // ---------------------------------------------------------------- scheduled

  async function runConfluenceIndex({ budget = 60 } = {}) {
    if (!confluence || !(await confluence.isAvailable())) return { skipped: 'confluence-not-available' };
    const { processed, finished, state } = await runIndexStep({ confluence, store, now, budget });
    return { processed, finished, lastFullScanAt: state.lastFullScanAt };
  }

  async function runRetention() {
    await purgeDecidedChanges().catch((err) => console.warn('Purging decided changes failed', err?.message));
    const config = await getConfig();
    if (!config.retentionMonths) return { deleted: 0 };
    const cutoff = new Date(now());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - config.retentionMonths);
    const deleted = await audit.purgeOlderThan(cutoff.getTime());
    return { deleted, cutoff: cutoff.getTime() };
  }

  // Decided pending changes (applied, rejected, withdrawn) are kept for CHANGE_HISTORY, then removed; the audit log
  // keeps the full story.
  async function purgeDecidedChanges() {
    const cutoff = now() - CHANGE_HISTORY;
    let purged = 0;
    for (const { key, value } of await store.list('change:')) {
      if (value && !isPending(value) && (value.decidedAt ?? value.requestedAt ?? 0) < cutoff) {
        await store.delete(key);
        purged++;
      }
    }
    if (purged) console.log('Decided changes purged', purged);
    return purged;
  }

  // Hourly: memberships whose end date has passed. With automatic changes on they are removed at once (with the
  // privileged admin's account); otherwise each becomes one pending removal ("Access ended on …") for a Jira admin and
  // the end date stays until it is applied or rejected. Records that can no longer apply (group gone, blocked or
  // IdP-managed, person already out) are dropped.
  async function runExpiry() {
    const config = await getConfig();
    const due = (await store.list('expiry:')).filter((r) => r.value?.expiresAt && r.value.expiresAt <= now());
    const summary = { removed: 0, dropped: 0, failed: 0, queued: 0 };
    const cache = {};
    for (const { key, value } of due) {
      const groupRec = await store.get(keys.group(value.groupId));
      if (!groupRec || blockingPattern(groupRec.name, config) || isIdpGroup(groupRec.name, groupRec, config)) {
        await store.delete(key);
        summary.dropped++;
        continue;
      }
      const groups = await jira.getUserGroups(value.accountId).catch(() => null);
      if (groups && !groups.some((g) => g.groupId === value.groupId)) {
        await store.delete(key); // already out of the group
        summary.dropped++;
        continue;
      }
      const user = await jira.getUser(value.accountId).catch(() => null);
      const res = await scheduledRemoval(cache, {
        groupRec,
        accountId: value.accountId,
        displayName: user?.displayName ?? value.accountId,
        reason: 'expiry',
        endedAt: value.expiresAt,
        auditDetails: { expiresAt: value.expiresAt, setBy: value.setBy?.displayName ?? null },
      });
      if (res.status === 'removed' || res.status === 'gone') {
        await store.delete(key);
        summary[res.status === 'removed' ? 'removed' : 'dropped']++;
      } else if (res.status === 'failed') {
        summary.failed++;
      } else if (res.status === 'queued') {
        await store.set(key, { ...value, pendingChangeRef: refOf(res.change) });
        summary.queued++;
      }
    }
    return summary;
  }

  return {
    bootstrap,
    checkName,
    createGroup,
    getGroup,
    getMembers,
    updateDescription,
    searchUsers,
    addMembers,
    removeMember,
    removeMembers,
    setExpiry,
    resolveUsers,
    exportMembers,
    myGroups,
    tutorialState,
    markTutorialSeen,
    auditorBootstrap,
    requestAccess,
    withdrawRequest,
    listRequests,
    decideRequest,
    reopenRequest,
    completeReview,
    previewDeactivatedCleanup,
    rebuildConfluenceIndex,
    resolveProjectKey,
    accessMatrix,
    applyAccessChanges,
    findOwnedGroup,
    getUsage,
    queryAudit,
    auditFilterOptions,
    exportAudit,
    adminBootstrap,
    saveConfig,
    isAiEnabled,
    exportData,
    importData,
    searchGroups,
    searchProjects,
    purgeLegacyOrgConnection,
    setPrivilegedAdmin,
    clearPrivilegedAdmin,
    updateSetup,
    listRoles,
    addRoleMembers,
    removeRoleMember,
    searchRoleGroups,
    addRoleGroups,
    removeRoleGroup,
    runRetention,
    runExpiry,
    runAutomation,
    runConfluenceIndex,
    listChanges,
    applyChanges,
    rejectChanges,
    withdrawChanges,
    grantAccess,
  };
}
