// Business logic of the Group & User Management app.
//
// Everything platform-specific is injected:
//   jira  – Jira REST access performed by the app (see src/forge/jiraClient.js)
//   store – key/value storage (Forge KVS)
//   audit – append-only audit log (Forge SQL)
// The same service runs in Forge, in the unit tests and in the local UI click-dummy.
//
// Security model: project admins are natively not allowed to create groups or change
// members. The app performs those actions on their behalf, so every call re-checks
// the caller's permissions and that the group belongs to the caller's project.
// The project and account ids always come from the trusted Forge context, never
// from the payload.

import { AppError, ErrorCodes } from './errors.js';
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
};

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
});

const PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const DAY = 24 * 60 * 60 * 1000;
const MAX_BULK_ADD = 50;
const MAX_DESCRIPTION = 500;
const USAGE_TTL = 10 * 60 * 1000;
// Bumped when the shape of the usage checks changes; older cache entries are ignored.
const USAGE_VERSION = 2;
const MEMBER_SCAN_CAP = 5000;
// Jira learns about groups created through the Organization API with a delay and
// can briefly answer "does not exist" (seen live on superportdev). A group is
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
};

const TUTORIAL_SURFACES = ['project', 'member', 'admin', 'auditor'];

function fold(s) {
  return (s ?? '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function createService({ jira, org = null, confluence = null, store, audit, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
  // ---------------------------------------------------------------- helpers

  // Group writes (create group, add/remove members) go through the Atlassian
  // Organization Admin API: Atlassian rejects them from apps via the Jira REST API
  // (verified on superportdev). Reads keep using the Jira REST API.
  function orgReady() {
    return Boolean(org && org.isConfigured());
  }
  function writerFor() {
    if (!orgReady()) {
      throw new AppError(ErrorCodes.ORG_API_NOT_CONFIGURED, 'ORG_ID / ORG_API_KEY are not set');
    }
    return org;
  }

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
    if (!ctx[cacheKey]) ctx[cacheKey] = await jira.checkPermissions(ctx.accountId, projectId);
    return ctx[cacheKey];
  }

  function assertLicensed(ctx) {
    // Forge only sets context.license for paid Marketplace apps in production.
    if (ctx.license && ctx.license.isActive === false) {
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
    await writer.removeMember(groupRec.groupId, accountId, groupRec.name);
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
      details,
    });
    return { accountId, displayName, previousExpiry };
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
              // Jira. Forget it only after it stayed missing for the grace period.
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
    return {
      project: { id: project.id, key: project.key, name: project.name, avatarUrl: project.avatarUrl ?? null, previousKeys: record.previousKeys ?? [] },
      user: { accountId: actor.accountId, displayName: actor.displayName, isJiraAdmin: Boolean(perms.jiraAdmin) },
      prefix: prefixFor(project.key),
      config: { retentionMonths: config.retentionMonths, idpReadOnly: config.idpReadOnly, expiryEnabled: config.expiryEnabled, reviewIntervalMonths: config.reviewIntervalMonths },
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
    return { fullName, valid: true, available: true, reason: null };
  }

  async function createGroup(ctx, { namePart, description = '', addMe = false, copyFromGroupId = null } = {}) {
    assertLicensed(ctx);
    const check = await checkName(ctx, { namePart });
    if (!check.valid) throw new AppError(ErrorCodes.NAME_INVALID, 'Invalid group name', { reason: check.reason });
    if (!check.available) throw new AppError(ErrorCodes.NAME_TAKEN, 'Group name already exists', { conflict: check.conflict });

    const { project, record, config } = await requireProjectAdmin(ctx);
    const writer = writerFor();
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
    const created = await writer.createGroup(check.fullName, cleanDescription);

    const groupRec = {
      groupId: created.groupId,
      name: created.name,
      projectId: project.id, // assignment by project id, not by key
      keyAtCreation: project.key,
      description: cleanDescription,
      createdAt: now(),
      createdBy: actor,
    };
    await store.set(keys.group(groupRec.groupId), groupRec);
    record.groupIds = [...new Set([...(record.groupIds ?? []), groupRec.groupId])];
    await store.set(keys.project(project.id), record);

    await writeAudit({
      action: AuditActions.GROUP_CREATED,
      projectId: project.id,
      projectKey: project.key,
      groupId: groupRec.groupId,
      groupName: groupRec.name,
      actorAccountId: actor.accountId,
      actorName: actor.displayName,
      details: groupRec.description ? { description: groupRec.description } : null,
    });

    let memberCount = 0;
    let addMeError = null;
    if (addMe) {
      try {
        await writer.addMember(groupRec.groupId, actor.accountId, groupRec.name);
        memberCount = 1;
        await writeAudit({
          action: AuditActions.MEMBER_ADDED,
          projectId: project.id,
          projectKey: project.key,
          groupId: groupRec.groupId,
          groupName: groupRec.name,
          targetAccountId: actor.accountId,
          targetName: actor.displayName,
          actorAccountId: actor.accountId,
          actorName: actor.displayName,
        });
      } catch (err) {
        // The group exists; report the failed membership instead of hiding it.
        console.warn('Could not add creator as first member', err);
        addMeError = { code: err?.code ?? ErrorCodes.JIRA_ERROR, message: err?.message ?? String(err) };
      }
    }
    let copied = null;
    if (copyFrom) {
      copied = { from: copyFrom.groupRec.name, added: 0, failed: [] };
      for (const m of copyFrom.members) {
        if (addMe && m.accountId === actor.accountId && !addMeError) continue;
        try {
          await writer.addMember(groupRec.groupId, m.accountId, groupRec.name);
          copied.added++;
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
            details: { reason: 'copy', from: copyFrom.groupRec.name },
          });
        } catch (err) {
          copied.failed.push({ accountId: m.accountId, displayName: m.displayName, error: err?.message ?? String(err) });
        }
      }
      memberCount += copied.added;
    }
    return summarize(groupRec, record, config, { memberCount, addMeError, copied });
  }

  async function getGroup(ctx, { groupId } = {}) {
    const loaded = await loadOwnedGroup(ctx, groupId);
    const { record, config } = loaded;
    let { groupRec } = loaded;
    // With the Organization API available, its externalSynced / modifiable flags
    // are the authoritative IdP signal.
    if (orgReady() && !groupRec.idpManaged) {
      const meta = await org.getGroupMeta(groupId, groupRec.name).catch(() => null);
      if (meta && (meta.externalSynced || !meta.modifiable)) {
        groupRec = { ...groupRec, idpManaged: true };
        await store.set(keys.group(groupId), groupRec);
      }
    }
    const [memberCount, recent] = await Promise.all([
      jira.countMembers(groupId).catch(() => null),
      audit.query({ groupId, offset: 0, limit: 5 }),
    ]);
    return { ...summarize(groupRec, record, config, { memberCount }), recentChanges: recent.entries };
  }

  // The description is the app's own text for the group (the Organization API
  // has no endpoint to change it). Allowed for every group the caller owns.
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

  async function getMembers(ctx, { groupId, query = '', startAt = 0, maxResults = 25 } = {}) {
    const { groupRec } = await loadOwnedGroup(ctx, groupId);
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

  async function addMembers(ctx, { groupId, accountIds = [], expiresAt = null, expiries = {}, reason = null } = {}) {
    const { project, groupRec, config } = await loadOwnedGroup(ctx, groupId, { write: true });
    const writer = writerFor();
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
          details: reasonDetails(reason, ADD_REASONS, expiry ? { expiresAt: expiry } : {}),
        });
        results.push({ ...base, status: 'added', expiresAt: expiry, addedAt: now(), addedBy: actor.displayName });
      } catch (err) {
        if (err?.code === 'ALREADY_MEMBER') results.push({ ...base, status: 'already' });
        else if (err?.code === ErrorCodes.GROUP_READ_ONLY) {
          await store.set(keys.group(groupId), { ...groupRec, idpManaged: true });
          throw new AppError(ErrorCodes.GROUP_READ_ONLY, 'Group is managed by an identity provider');
        } else results.push({ ...base, status: 'failed', error: err?.message ?? String(err) });
      }
    }
    const memberCount = await jira.countMembers(groupId).catch(() => null);
    return { results, memberCount };
  }

  async function removeMember(ctx, { groupId, accountId } = {}) {
    const { project, groupRec, config } = await loadOwnedGroup(ctx, groupId, { write: true });
    const writer = writerFor();
    if (!accountId) throw new AppError(ErrorCodes.BAD_REQUEST, 'accountId missing');
    const actor = await actorOf(ctx);
    const removed = await removeOne({ project, groupRec, writer, actor }, accountId, null);
    const memberCount = await jira.countMembers(groupId).catch(() => null);
    return { ok: true, memberCount, removed };
  }

  // Removes several members: used by the access review and by "undo" of an add.
  async function removeMembers(ctx, { groupId, accountIds = [], note = '', reason = 'review' } = {}) {
    const { project, groupRec, config } = await loadOwnedGroup(ctx, groupId, { write: true });
    const writer = writerFor();
    const ids = [...new Set(accountIds.filter((id) => typeof id === 'string' && id))];
    if (!ids.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'No users given');
    if (ids.length > MAX_BULK_REMOVE) {
      throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_BULK_REMOVE} people at once`, { reason: 'TOO_MANY' });
    }
    const actor = await actorOf(ctx);
    const reviewNote = note.toString().trim().slice(0, 300);
    const details = reasonDetails(reason, REMOVE_REASONS, reviewNote ? { note: reviewNote } : {});
    const results = [];
    for (const accountId of ids) {
      try {
        const removed = await removeOne({ project, groupRec, writer, actor }, accountId, details);
        results.push({ ...removed, status: 'removed' });
      } catch (err) {
        const user = await jira.getUser(accountId).catch(() => null);
        results.push({ accountId, displayName: user?.displayName ?? accountId, status: 'failed', error: err?.message ?? String(err) });
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
    const { groupRec } = await loadOwnedGroup(ctx, groupId);
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
    const open = (await requestsOf(project.id)).find((r) => r.groupId === groupId && r.accountId === ctx.accountId && r.status === 'pending');
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
    if (decision === 'approve') {
      const until =
        expiresAt !== undefined ? expiresAt : request.durationDays ? now() + request.durationDays * DAY : null;
      const res = await addMembers(ctx, { groupId: request.groupId, accountIds: [request.accountId], expiresAt: until, reason: 'request' });
      member = res.results[0];
      if (member?.status === 'failed') throw new AppError(ErrorCodes.JIRA_ERROR, member.error ?? 'Could not add the member');
    }
    const next = { ...request, status: decision === 'approve' ? 'approved' : 'denied', decidedAt: now(), decidedBy: actor.displayName, note: cleanNote };
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
      details: { requestId, ...(cleanNote ? { note: cleanNote } : {}) },
    });
    return { request: next, member };
  }

  // Undo of a decision: removes the membership an approval granted and puts the
  // request back to "pending"; a denial simply goes back to "pending".
  async function reopenRequest(ctx, { requestId } = {}) {
    const { project } = await requireProjectAdmin(ctx);
    assertLicensed(ctx);
    const key = keys.request(project.id, requestId);
    const request = await store.get(key);
    if (!request || !['approved', 'denied'].includes(request.status)) throw new AppError(ErrorCodes.BAD_REQUEST, 'Request cannot be reopened', { reason: 'NOT_DECIDED' });
    const actor = await actorOf(ctx);
    if (request.status === 'approved') {
      const { groupRec } = await loadOwnedGroup(ctx, request.groupId, { write: true });
      await removeOne({ project, groupRec, writer: writerFor(), actor }, request.accountId, { reason: 'undo', requestId });
    }
    const next = { ...request, status: 'pending', decidedAt: null, decidedBy: null, note: null };
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
      details: { requestId, reason: 'undo', was: request.status },
    });
    return { request: next };
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
    if (!orgReady()) return { removed: 0, skipped: 'org-api-not-configured' };
    let removed = 0;
    for (const item of await deactivatedMembers()) {
      try {
        await org.removeMember(item.groupId, item.accountId, item.groupName);
        await store.delete(keys.expiry(item.groupId, item.accountId));
        const project = await store.get(keys.project(item.projectId));
        await writeAudit({
          action: AuditActions.MEMBER_AUTO_REMOVED,
          projectId: item.projectId,
          projectKey: project?.key ?? null,
          groupId: item.groupId,
          groupName: item.groupName,
          targetAccountId: item.accountId,
          targetName: item.displayName,
          actorName: 'system',
          details: { reason: 'deactivated' },
        });
        removed++;
      } catch (err) {
        console.warn('Automatic removal failed', item.groupId, err?.message);
      }
    }
    return { removed };
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
    const expiringSoon = expiries
      .map((r) => r.value)
      .filter((e) => e?.expiresAt && e.expiresAt <= soon)
      .map((e) => ({ groupId: e.groupId, accountId: e.accountId, expiresAt: e.expiresAt, projectKey: projectKeys[e.projectId] ?? null }));
    const pendingRequests = requests.map((r) => r.value).filter((r) => r?.status === 'pending').length;
    return { reviewsDue, expiringSoon, pendingRequests, confluenceIndex: { lastFullScanAt: index.lastFullScanAt, scanned: index.scanned, pagesInLastScan: index.pagesInLastScan } };
  }

  async function rebuildConfluenceIndex(ctx) {
    await requireJiraAdmin(ctx);
    await resetIndex(store);
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

  async function adminBootstrap(ctx) {
    await requireJiraAdmin(ctx);
    const [config, actor, managed] = await Promise.all([getConfig(), actorOf(ctx), store.list('group:')]);
    const projects = new Set(managed.map((g) => g.value?.projectId).filter(Boolean));
    return {
      user: { accountId: actor.accountId, displayName: actor.displayName, isJiraAdmin: true },
      config,
      defaults: { coreBlockedGroups: CORE_BLOCKED_GROUPS, productAccessPatterns: PRODUCT_ACCESS_PATTERNS },
      stats: { managedGroups: managed.length, projects: projects.size },
      orgApi: { configured: Boolean(org?.isConfigured()) },
      compliance: await complianceOverview(),
      confluence: { available: Boolean(confluence && (await confluence.isAvailable())) },
    };
  }

  async function testOrgApi(ctx) {
    await requireJiraAdmin(ctx);
    if (!org || !org.isConfigured()) return { configured: false, ok: false };
    try {
      const res = await org.check();
      return { configured: true, ok: Boolean(res.directoryId), directories: res.directories, directoryId: res.directoryId };
    } catch (err) {
      return { configured: true, ok: false, error: { code: err.code ?? ErrorCodes.ORG_API_ERROR, message: err.message } };
    }
  }

  function sanitizeConfig(input = {}) {
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
    };
  }

  async function saveConfig(ctx, { config, reason = null } = {}) {
    await requireJiraAdmin(ctx);
    const before = await getConfig();
    const next = sanitizeConfig(config);
    await store.set(keys.config, next);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) {
      const actor = await actorOf(ctx);
      await writeAudit({
        action: AuditActions.CONFIG_CHANGED,
        projectId: '*',
        actorAccountId: actor.accountId,
        actorName: actor.displayName,
        details: reasonDetails(reason, ['undo'], { changed }),
      });
    }
    return { config: next, changed, previous: sanitizeConfig(before) };
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
    const config = await getConfig();
    if (!config.retentionMonths) return { deleted: 0 };
    const cutoff = new Date(now());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - config.retentionMonths);
    const deleted = await audit.purgeOlderThan(cutoff.getTime());
    return { deleted, cutoff: cutoff.getTime() };
  }

  // Hourly: removes memberships whose end date has passed, each with an audit entry.
  // Records that can no longer apply (group gone, blocked or IdP-managed) are dropped.
  async function runExpiry() {
    const config = await getConfig();
    const due = (await store.list('expiry:')).filter((r) => r.value?.expiresAt && r.value.expiresAt <= now());
    const summary = { removed: 0, dropped: 0, failed: 0 };
    for (const { key, value } of due) {
      const groupRec = await store.get(keys.group(value.groupId));
      if (!groupRec || blockingPattern(groupRec.name, config) || isIdpGroup(groupRec.name, groupRec, config)) {
        await store.delete(key);
        summary.dropped++;
        continue;
      }
      try {
        await writerFor().removeMember(value.groupId, value.accountId, groupRec.name);
      } catch (err) {
        if (err?.code === ErrorCodes.GROUP_NOT_FOUND) {
          await store.delete(key); // nothing left to remove
          summary.dropped++;
        } else {
          console.warn('Expiry removal failed, retrying next run', value.groupId, err?.message);
          summary.failed++;
        }
        continue;
      }
      const [user, project] = await Promise.all([jira.getUser(value.accountId).catch(() => null), store.get(keys.project(groupRec.projectId))]);
      await writeAudit({
        action: AuditActions.MEMBER_EXPIRED,
        projectId: groupRec.projectId,
        projectKey: project?.key ?? null,
        groupId: value.groupId,
        groupName: groupRec.name,
        targetAccountId: value.accountId,
        targetName: user?.displayName ?? value.accountId,
        actorName: 'system',
        details: { expiresAt: value.expiresAt, setBy: value.setBy?.displayName ?? null },
      });
      await store.delete(key);
      summary.removed++;
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
    exportData,
    importData,
    searchGroups,
    searchProjects,
    testOrgApi,
    runRetention,
    runExpiry,
    runAutomation,
    runConfluenceIndex,
  };
}
