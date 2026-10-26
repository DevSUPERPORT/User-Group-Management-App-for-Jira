// Rovo actions for the "Group & User Management" agent (logic only; the Forge
// wiring is in rovo.js so the actions can be tested against the in-memory backend).
//
// Safety model:
// - The caller is the Atlassian user talking to Rovo; their account id comes from
//   the Forge invocation context, never from the chat.
// - Every action runs through the same service as the app: project admin rights,
//   group ownership, block list, IdP read-only, licence and the Organization API
//   are all enforced there.
// - Changes are marked "via Rovo" in the audit log (see rovo.js) and are kept small
//   per call (max. 10 additions / 5 removals) so a misunderstanding cannot do much harm.
import { AppError, ErrorCodes } from './core/errors.js';

export const MAX_ADD = 10;
export const MAX_REMOVE = 5;
const DAY = 24 * 60 * 60 * 1000;

const list = (text) =>
  String(text ?? '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

function parseDate(text) {
  const v = String(text ?? '').trim();
  if (!v || /^(none|no|never|unbefristet|kein)/i.test(v)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) throw new AppError(ErrorCodes.BAD_REQUEST, 'Dates must look like 2026-12-31', { reason: 'DATE_FORMAT' });
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 22, 59);
}

const isoDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);

export function accountIdOf(payload, context) {
  return payload?.context?.accountId ?? context?.principal?.accountId ?? payload?.context?.principal?.accountId ?? context?.accountId ?? null;
}

export function createRovoActions(service, { now = () => Date.now() } = {}) {
  // Wraps an action: resolves the caller and project, turns errors into a clear
  // answer Rovo can relay ("nothing was changed") instead of a stack trace.
  const action = (fn) => async (payload, context) => {
    try {
      const accountId = accountIdOf(payload, context);
      if (!accountId) return { ok: false, error: 'Could not identify the calling user; nothing was done.', nothingChanged: true };
      const project = payload?.projectKey ? await service.resolveProjectKey(payload.projectKey) : null;
      const ctx = { accountId, projectId: project?.id ?? null, surface: 'project', license: context?.license ?? null };
      return { ok: true, ...(await fn({ payload: payload ?? {}, ctx, project })) };
    } catch (err) {
      console.warn('Rovo action failed', err?.code, err?.message);
      return { ok: false, error: err?.message ?? String(err), code: err?.details?.reason ?? err?.code ?? 'ERROR', nothingChanged: true };
    }
  };

  const groupOf = (ctx, name) => service.findOwnedGroup(ctx, name);

  async function memberMatch(ctx, groupId, person) {
    const members = (await service.getMembers(ctx, { groupId, maxResults: 100 })).members;
    const hits = members.filter((m) => fold(m.displayName) === fold(person) || (m.email && fold(m.email) === fold(person)));
    return { hits, members };
  }

  // ---------------------------------------------------------------- GET

  const listGroups = action(async ({ ctx, project }) => {
    const boot = await service.bootstrap(ctx);
    return {
      project: project.key,
      pendingAccessRequests: boot.pendingRequests,
      groups: boot.groups.map((g) => ({
        name: g.name,
        description: g.description || null,
        members: g.memberCount,
        readOnlyIdpSynced: g.readOnly,
        reviewDue: g.reviewDue,
        createdUnderPreviousKey: g.legacyKey,
      })),
    };
  });

  const groupDetails = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const [detail, members] = await Promise.all([service.getGroup(ctx, { groupId: g.groupId }), service.getMembers(ctx, { groupId: g.groupId, maxResults: 50 })]);
    return {
      group: detail.name,
      description: detail.description || null,
      readOnlyIdpSynced: detail.readOnly,
      reviewDue: detail.reviewDue,
      lastReviewed: isoDate(detail.lastReviewedAt),
      memberCount: members.total,
      members: members.members.map((m) => ({ name: m.displayName, email: m.email, active: m.active, until: isoDate(m.expiresAt), addedBy: m.addedBy, addedOn: isoDate(m.addedAt) })),
      recentChanges: (detail.recentChanges ?? []).map((e) => ({ when: new Date(e.createdAt).toISOString(), action: e.action, person: e.targetName, by: e.actorName })),
    };
  });

  const whereUsed = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const usage = await service.getUsage(ctx, { groupId: g.groupId, refresh: true });
    const summary = {};
    for (const [key, value] of Object.entries(usage)) {
      if (!value || typeof value !== 'object' || !('status' in value)) continue;
      summary[key] = value.status === 'ok' ? value.items : { status: value.status, note: value.error?.message ?? value.reason ?? null };
    }
    return { group: g.name, usage: summary };
  });

  const auditLog = action(async ({ payload, ctx }) => {
    const days = Math.min(Math.max(Number(payload.days) || 30, 1), 365);
    const res = await service.queryAudit(ctx, { filters: { from: now() - days * DAY, person: payload.person ?? '' }, pageSize: 50 });
    return {
      days,
      total: res.total,
      entries: res.entries.map((e) => ({ when: new Date(e.createdAt).toISOString(), action: e.action, group: e.groupName, person: e.targetName, by: e.actorName, details: e.details })),
    };
  });

  const complianceCheck = action(async ({ ctx, project }) => {
    const boot = await service.bootstrap(ctx);
    const requests = await service.listRequests(ctx, { status: 'pending' });
    const expiring = [];
    const deactivated = [];
    for (const g of boot.groups) {
      const page = await service.getMembers(ctx, { groupId: g.groupId, maxResults: 100 });
      for (const m of page.members) {
        if (m.expiresAt && m.expiresAt - now() < 14 * DAY) expiring.push({ group: g.name, person: m.displayName, until: isoDate(m.expiresAt) });
        if (!m.active) deactivated.push({ group: g.name, person: m.displayName });
      }
    }
    return {
      project: project.key,
      reviewsDue: boot.groups.filter((g) => g.reviewDue).map((g) => g.name),
      pendingAccessRequests: requests.requests.map((r) => ({ group: r.groupName, person: r.displayName, reason: r.reason, since: isoDate(r.createdAt) })),
      expiringWithin14Days: expiring,
      deactivatedAccounts: deactivated,
    };
  });

  // ---------------------------------------------------------------- CREATE / UPDATE / DELETE

  const createGroup = action(async ({ payload, ctx }) => {
    const g = await service.createGroup(ctx, { namePart: String(payload.namePart ?? '').trim().toLowerCase(), description: payload.description ?? '', addMe: payload.addMe === true });
    return { created: g.name, membersAdded: g.memberCount, note: g.addMeError ? 'The group was created, but you could not be added as a member.' : null };
  });

  const addMembers = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const entries = list(payload.people);
    if (!entries.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'Tell me who to add (names or emails).');
    if (entries.length > MAX_ADD) throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_ADD} people per request.`, { reason: 'TOO_MANY' });
    const expiresAt = parseDate(payload.endDate);
    const { rows } = await service.resolveUsers(ctx, { entries });
    const matched = rows.filter((r) => r.status === 'matched');
    const unclear = rows.filter((r) => r.status === 'ambiguous' || r.status === 'notFound');
    let results = [];
    if (matched.length) {
      const res = await service.addMembers(ctx, { groupId: g.groupId, accountIds: matched.map((r) => r.user.accountId), expiresAt });
      results = res.results.map((r) => ({ person: r.displayName, status: r.status, until: isoDate(r.expiresAt) }));
    }
    return {
      group: g.name,
      results,
      notAdded: unclear.map((r) => ({ input: r.input, why: r.status === 'ambiguous' ? `several people match: ${r.candidates.map((c) => c.displayName).join(', ')}` : 'nobody found' })),
    };
  });

  const removeMembers = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const entries = list(payload.people);
    if (!entries.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'Tell me who to remove.');
    if (entries.length > MAX_REMOVE) throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_REMOVE} people per request.`, { reason: 'TOO_MANY' });
    // Only people who are actually in the group can match.
    const members = (await service.getMembers(ctx, { groupId: g.groupId, maxResults: 100 })).members;
    const picks = [];
    const unclear = [];
    for (const e of entries) {
      const hits = members.filter((m) => fold(m.displayName) === fold(e) || (m.email && fold(m.email) === fold(e)));
      if (hits.length === 1) picks.push(hits[0]);
      else unclear.push({ input: e, why: hits.length ? 'several members match' : 'not a member of this group' });
    }
    let results = [];
    if (picks.length) {
      const res = await service.removeMembers(ctx, { groupId: g.groupId, accountIds: picks.map((p) => p.accountId), reason: 'review', note: payload.note || 'via Rovo' });
      results = res.results.map((r) => ({ person: r.displayName, status: r.status }));
    }
    return { group: g.name, results, notRemoved: unclear, undo: 'Ask me to add them again, or use Undo in the app.' };
  });

  const setEndDate = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const { hits } = await memberMatch(ctx, g.groupId, payload.person);
    if (hits.length !== 1) throw new AppError(ErrorCodes.BAD_REQUEST, hits.length ? 'Several members match; please be more specific.' : 'That person is not a member of this group.');
    const res = await service.setExpiry(ctx, { groupId: g.groupId, accountId: hits[0].accountId, expiresAt: parseDate(payload.endDate) });
    return { group: g.name, person: hits[0].displayName, until: isoDate(res.expiresAt), before: isoDate(res.previous) };
  });

  const updateDescription = action(async ({ payload, ctx }) => {
    const g = await groupOf(ctx, payload.groupName);
    const res = await service.updateDescription(ctx, { groupId: g.groupId, description: payload.description ?? '' });
    return { group: g.name, description: res.description, before: res.previous };
  });

  const decideRequest = action(async ({ payload, ctx }) => {
    const d = fold(payload.decision);
    const decision = d.startsWith('appr') || d.startsWith('genehm') ? 'approve' : d.startsWith('den') || d.startsWith('ablehn') ? 'deny' : null;
    if (!decision) throw new AppError(ErrorCodes.BAD_REQUEST, 'Decision must be "approve" or "deny".');
    const pending = (await service.listRequests(ctx, { status: 'pending' })).requests;
    const group = fold(payload.groupName);
    const hits = pending.filter((r) => fold(r.displayName) === fold(payload.person) && (!group || fold(r.groupName) === group || fold(r.groupName).endsWith(`-${group}`)));
    if (hits.length !== 1) throw new AppError(ErrorCodes.BAD_REQUEST, hits.length ? 'Several pending requests match; name the group too.' : 'No pending request matches.');
    const res = await service.decideRequest(ctx, { requestId: hits[0].id, decision, note: payload.note ?? '' });
    return { request: { group: res.request.groupName, person: res.request.displayName, status: res.request.status } };
  });

  return { listGroups, groupDetails, whereUsed, auditLog, complianceCheck, createGroup, addMembers, removeMembers, setEndDate, updateDescription, decideRequest };
}
