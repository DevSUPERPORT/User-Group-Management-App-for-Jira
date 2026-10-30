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
// Bulk actions (same groups as, offboarding, copy members, undo) answer with a
// preview first and only change something when called again with confirm: true.
export const MAX_COPY_MEMBERS = 50;
const UNDO_WINDOW = 60 * 60 * 1000; // the caller's own changes of the last hour
const BURST = 2 * 60 * 1000; // changes this close together count as one step
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
  const confirmed = (payload) => payload?.confirm === true || /^(true|yes|ja)$/i.test(String(payload?.confirm ?? ''));

  // One person among everyone in the project's groups (exact name or email).
  function onePerson(people, text) {
    const hits = people.filter((p) => fold(p.displayName) === fold(text) || (p.email && fold(p.email) === fold(text)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new AppError(ErrorCodes.BAD_REQUEST, `Several people match "${text}": ${hits.map((h) => h.email ?? h.displayName).join(', ')}. Please use the email address.`, { reason: 'AMBIGUOUS' });
    throw new AppError(ErrorCodes.BAD_REQUEST, `"${text}" is not in any group of this project.`, { reason: 'NOT_FOUND' });
  }

  const editable = (g) => !g.readOnly && g.available !== false;

  // Runs a list of changes (or only previews it) and reports per person and group.
  async function runChanges(ctx, matrix, changes, { confirm, expiresAt = null, note = '', reason = 'bulk', expiries = {} }) {
    const groupName = (id) => matrix.groups.find((g) => g.groupId === id)?.name ?? id;
    const personName = (id) => matrix.people.find((p) => p.accountId === id)?.displayName ?? id;
    const planned = changes.map((c) => ({ person: personName(c.accountId), group: groupName(c.groupId), change: c.op }));
    if (!confirm) return { preview: true, nothingChanged: true, planned, next: 'Show this list to the user and call the action again with confirm: true once they agree.' };
    if (!changes.length) return { planned, results: [], note: 'Nothing to change.' };
    const res = await service.applyAccessChanges(ctx, { changes, expiresAt, note, reason, expiries });
    return {
      results: res.results.map((r) => ({ person: personName(r.accountId), group: r.groupName, change: r.op, status: r.status, why: r.status === 'failed' ? r.error : undefined })),
      undo: 'Ask me to undo the last change, or use Undo in the app (People tab).',
    };
  }

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

  // ---------------------------------------------------------------- people across groups

  const personAccess = action(async ({ payload, ctx, project }) => {
    const m = await service.accessMatrix(ctx);
    const p = onePerson(m.people, payload.person);
    return {
      project: project.key,
      person: p.displayName,
      email: p.email,
      active: p.active,
      memberOf: m.groups.filter((g) => p.memberships[g.groupId]).map((g) => ({ group: g.name, until: isoDate(p.memberships[g.groupId].expiresAt) })),
      notMemberOf: m.groups.filter((g) => !p.memberships[g.groupId]).map((g) => g.name),
    };
  });

  // "Give them the same groups as …": adds only, never removes.
  const copyAccess = action(async ({ payload, ctx }) => {
    const m = await service.accessMatrix(ctx);
    const ref = onePerson(m.people, payload.fromPerson);
    const entries = list(payload.toPeople);
    if (!entries.length) throw new AppError(ErrorCodes.BAD_REQUEST, 'Tell me who should get the same groups.');
    if (entries.length > MAX_ADD) throw new AppError(ErrorCodes.BAD_REQUEST, `At most ${MAX_ADD} people per request.`, { reason: 'TOO_MANY' });
    const expiresAt = parseDate(payload.endDate);
    const { rows } = await service.resolveUsers(ctx, { entries });
    const targets = rows.filter((r) => r.status === 'matched').map((r) => r.user);
    const unclear = rows.filter((r) => r.status !== 'matched').map((r) => ({ input: r.input, why: r.status === 'ambiguous' ? `several people match: ${r.candidates.map((c) => c.displayName).join(', ')}` : 'nobody found' }));
    const changes = [];
    for (const u of targets) {
      const current = m.people.find((p) => p.accountId === u.accountId)?.memberships ?? {};
      for (const g of m.groups) if (editable(g) && ref.memberships[g.groupId] && !current[g.groupId]) changes.push({ groupId: g.groupId, accountId: u.accountId, op: 'add' });
    }
    for (const u of targets) if (!m.people.some((p) => p.accountId === u.accountId)) m.people.push({ ...u, memberships: {} });
    return { sameGroupsAs: ref.displayName, notChanged: unclear, ...(await runChanges(ctx, m, changes, { confirm: confirmed(payload), expiresAt })) };
  });

  // Offboarding: one person out of every changeable group of the project.
  const offboardPerson = action(async ({ payload, ctx }) => {
    const m = await service.accessMatrix(ctx);
    const p = onePerson(m.people, payload.person);
    const changes = m.groups.filter((g) => editable(g) && p.memberships[g.groupId]).map((g) => ({ groupId: g.groupId, accountId: p.accountId, op: 'remove' }));
    const skipped = m.groups.filter((g) => !editable(g) && p.memberships[g.groupId]).map((g) => ({ group: g.name, why: g.readOnly ? 'synchronised from the identity provider (read-only)' : 'not available yet' }));
    return { person: p.displayName, notChangeable: skipped, ...(await runChanges(ctx, m, changes, { confirm: confirmed(payload), note: payload.note || 'Offboarding via Rovo' })) };
  });

  // Copies the members of one project group into another (adds only).
  const copyMembers = action(async ({ payload, ctx }) => {
    const [from, to] = await Promise.all([groupOf(ctx, payload.fromGroup), groupOf(ctx, payload.toGroup)]);
    if (from.groupId === to.groupId) throw new AppError(ErrorCodes.BAD_REQUEST, 'Source and target are the same group.');
    const m = await service.accessMatrix(ctx);
    const changes = m.people.filter((p) => p.memberships[from.groupId] && !p.memberships[to.groupId]).map((p) => ({ groupId: to.groupId, accountId: p.accountId, op: 'add' }));
    if (changes.length > MAX_COPY_MEMBERS) throw new AppError(ErrorCodes.BAD_REQUEST, `${changes.length} people would be added; at most ${MAX_COPY_MEMBERS} at once. Use the People tab in the app for larger moves.`, { reason: 'TOO_MANY' });
    return { from: from.name, to: to.name, ...(await runChanges(ctx, m, changes, { confirm: confirmed(payload), expiresAt: parseDate(payload.endDate) })) };
  });

  // Undoes the caller's own most recent membership changes in this project (the
  // last burst within the past hour), restoring end dates of removed people.
  const undoLastChange = action(async ({ payload, ctx }) => {
    const res = await service.queryAudit(ctx, { filters: { from: now() - UNDO_WINDOW }, pageSize: 100 });
    const mine = res.entries.filter((e) => e.actorAccountId === ctx.accountId && (e.action === 'MEMBER_ADDED' || e.action === 'MEMBER_REMOVED') && e.details?.reason !== 'undo' && e.groupId && e.targetAccountId);
    if (!mine.length) return { nothingChanged: true, note: 'You made no membership changes in this project during the last hour.' };
    const latest = Math.max(...mine.map((e) => e.createdAt));
    const step = mine.filter((e) => e.createdAt >= latest - BURST);
    const seen = new Set();
    const changes = [];
    const expiries = {};
    for (const e of step) {
      const k = `${e.groupId}|${e.targetAccountId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      changes.push({ groupId: e.groupId, accountId: e.targetAccountId, op: e.action === 'MEMBER_ADDED' ? 'remove' : 'add' });
      if (e.action === 'MEMBER_REMOVED' && e.details?.previousExpiry) expiries[e.targetAccountId] = e.details.previousExpiry;
    }
    const m = await service.accessMatrix(ctx);
    for (const e of step) if (!m.people.some((p) => p.accountId === e.targetAccountId)) m.people.push({ accountId: e.targetAccountId, displayName: e.targetName, memberships: {} });
    for (const e of step) if (!m.groups.some((g) => g.groupId === e.groupId)) m.groups.push({ groupId: e.groupId, name: e.groupName });
    return { undoing: `${changes.length} change(s) from ${new Date(latest).toISOString()}`, ...(await runChanges(ctx, m, changes, { confirm: confirmed(payload), reason: 'undo', expiries, note: 'Undo via Rovo' })) };
  });

  return { listGroups, groupDetails, whereUsed, auditLog, complianceCheck, createGroup, addMembers, removeMembers, setEndDate, updateDescription, decideRequest, personAccess, copyAccess, offboardPerson, copyMembers, undoLastChange };
}
