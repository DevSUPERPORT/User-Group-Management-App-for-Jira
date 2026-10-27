import { AppError, ErrorCodes } from './errors.js';

// Moves everything the app has stored from one installation to another on the
// same site (e.g. development → production): Forge KVS records and the full
// audit log. Export and import run in pages so no single call gets too large;
// importing the same file twice is safe (KVS keys are overwritten with the same
// value, audit entries that already exist are skipped).

export const EXPORT_FORMAT = 'superport-gum-export';
export const EXPORT_VERSION = 1;

// Every KVS prefix the app writes. Caches (usage:) and the Confluence index
// (cfidx:) are included too, so the new installation starts exactly where the old one was.
export const TRANSFER_PREFIXES = ['config', 'project:', 'group:', 'expiry:', 'request:', 'tutorial:', 'usage:', 'cfidx:'];

export const KVS_PAGE = 100;
export const AUDIT_PAGE = 200;
export const MAX_KVS_IMPORT = 200;
export const MAX_AUDIT_IMPORT = 500;

const AUDIT_LIMITS = {
  id: 36,
  projectId: 32,
  projectKey: 32,
  action: 32,
  groupId: 128,
  groupName: 255,
  targetAccountId: 128,
  targetName: 255,
  actorAccountId: 128,
  actorName: 255,
};

const bad = (message, reason = 'INVALID_ENTRY') => new AppError(ErrorCodes.BAD_REQUEST, message, { reason });

function isAllowedKey(key) {
  if (typeof key !== 'string' || !key || key.length > 500) return false;
  return key === 'config' || TRANSFER_PREFIXES.some((p) => p !== 'config' && key.startsWith(p) && key.length > p.length);
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== 'object') throw bad('Invalid cursor');
  return cursor;
}

/** One page of KVS records, walking the prefixes in order. */
export async function exportKvsPage(store, cursor) {
  const c = decodeCursor(cursor) ?? { p: 0, c: null };
  let p = Number(c.p);
  let inner = c.c ?? null;
  if (!Number.isInteger(p) || p < 0) throw bad('Invalid cursor');
  while (p < TRANSFER_PREFIXES.length) {
    const prefix = TRANSFER_PREFIXES[p];
    const page = await store.page(prefix, { cursor: inner, limit: KVS_PAGE });
    // "config" also matches longer keys starting with it; only the exact key belongs to it.
    const entries = page.results.filter((r) => (prefix === 'config' ? r.key === 'config' : true)).map((r) => ({ key: r.key, value: r.value }));
    const next = page.nextCursor ? { p, c: page.nextCursor } : p + 1 < TRANSFER_PREFIXES.length ? { p: p + 1, c: null } : null;
    if (entries.length || !next) return { entries, cursor: next };
    p = next.p;
    inner = next.c;
  }
  return { entries: [], cursor: null };
}

/** One page of audit entries, oldest first (new entries written meanwhile land at the end). */
export async function exportAuditPage(audit, cursor) {
  const after = decodeCursor(cursor);
  if (after && (!Number.isFinite(Number(after.createdAt)) || typeof after.id !== 'string')) throw bad('Invalid cursor');
  const entries = await audit.exportPage({ after, limit: AUDIT_PAGE });
  const last = entries[entries.length - 1];
  return { entries, cursor: entries.length === AUDIT_PAGE ? { createdAt: last.createdAt, id: last.id } : null };
}

export async function importKvs(store, entries) {
  if (!Array.isArray(entries) || !entries.length) throw bad('No entries given');
  if (entries.length > MAX_KVS_IMPORT) throw bad(`At most ${MAX_KVS_IMPORT} records at once`, 'TOO_MANY');
  for (const e of entries) {
    if (!e || !isAllowedKey(e.key)) throw bad(`Unexpected key: ${String(e?.key).slice(0, 80)}`);
    if (e.value === undefined || e.value === null) throw bad(`Missing value for ${e.key}`);
  }
  for (const e of entries) await store.set(e.key, e.value);
  return { written: entries.length };
}

function normalizeAuditRow(r) {
  if (!r || typeof r !== 'object') throw bad('Invalid audit entry');
  const row = {
    id: r.id,
    createdAt: Number(r.createdAt),
    projectId: r.projectId ?? null,
    projectKey: r.projectKey ?? null,
    action: r.action,
    groupId: r.groupId ?? null,
    groupName: r.groupName ?? null,
    targetAccountId: r.targetAccountId ?? null,
    targetName: r.targetName ?? null,
    actorAccountId: r.actorAccountId ?? null,
    actorName: r.actorName ?? null,
    details: r.details ?? null,
  };
  if (typeof row.id !== 'string' || !row.id) throw bad('Audit entry without id');
  if (!Number.isFinite(row.createdAt) || row.createdAt <= 0) throw bad(`Audit entry ${row.id} has no valid time`);
  if (typeof row.action !== 'string' || !row.action) throw bad(`Audit entry ${row.id} has no action`);
  for (const [field, max] of Object.entries(AUDIT_LIMITS)) {
    const v = row[field];
    if (v !== null && (typeof v !== 'string' || v.length > max)) throw bad(`Audit entry ${row.id}: invalid ${field}`);
  }
  if (row.details !== null && typeof row.details !== 'object') throw bad(`Audit entry ${row.id}: invalid details`);
  return row;
}

export async function importAudit(audit, entries) {
  if (!Array.isArray(entries) || !entries.length) throw bad('No entries given');
  if (entries.length > MAX_AUDIT_IMPORT) throw bad(`At most ${MAX_AUDIT_IMPORT} audit entries at once`, 'TOO_MANY');
  const rows = entries.map(normalizeAuditRow);
  const inserted = await audit.importRows(rows);
  return { inserted, skipped: rows.length - inserted };
}

/** Rejects files from another site: group and account ids only mean something on their own site. */
export function checkSameSite(ctxCloudId, fileCloudId) {
  if (ctxCloudId && fileCloudId && ctxCloudId !== fileCloudId) {
    throw new AppError(ErrorCodes.BAD_REQUEST, 'This export comes from a different Atlassian site', { reason: 'OTHER_SITE' });
  }
}
