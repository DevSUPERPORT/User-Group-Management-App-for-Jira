// RFC 4180 CSV with a leading BOM so Excel opens umlauts correctly.
// Cells starting with =, +, -, @ are prefixed to prevent formula injection.

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export const AUDIT_CSV_HEADERS = [
  'timestamp_utc',
  'action',
  'project_key',
  'project_id',
  'group_name',
  'group_id',
  'affected_person',
  'affected_account_id',
  'performed_by',
  'performed_by_account_id',
  'details',
];

export function auditRowsToCsv(entries) {
  return toCsv(
    AUDIT_CSV_HEADERS,
    entries.map((e) => [
      new Date(e.createdAt).toISOString(),
      e.action,
      e.projectKey,
      e.projectId,
      e.groupName,
      e.groupId,
      e.targetName,
      e.targetAccountId,
      e.actorName,
      e.actorAccountId,
      e.details ? JSON.stringify(e.details) : '',
    ]),
  );
}
