import { sql, migrationRunner } from '@forge/sql';

// Append-only audit log in Forge SQL. The app exposes no update or delete
// operation; the only deletion is the retention purge run by the scheduled trigger.

migrationRunner
  .enqueue(
    'v001_create_audit_log',
    `CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      created_at BIGINT NOT NULL,
      project_id VARCHAR(32) NOT NULL,
      project_key VARCHAR(32) NULL,
      action VARCHAR(32) NOT NULL,
      group_id VARCHAR(128) NULL,
      group_name VARCHAR(255) NULL,
      target_account_id VARCHAR(128) NULL,
      target_name VARCHAR(255) NULL,
      actor_account_id VARCHAR(128) NULL,
      actor_name VARCHAR(255) NULL,
      details TEXT NULL
    )`,
  )
  .enqueue('v002_idx_project_time', 'CREATE INDEX idx_audit_project_time ON audit_log (project_id, created_at)')
  .enqueue('v003_idx_time', 'CREATE INDEX idx_audit_time ON audit_log (created_at)')
  .enqueue('v004_idx_group_time', 'CREATE INDEX idx_audit_group_time ON audit_log (group_id, created_at)');

let migrated = null;
export function runMigrations() {
  if (!migrated) {
    migrated = migrationRunner.run().catch((err) => {
      migrated = null;
      throw err;
    });
  }
  return migrated;
}

const COLUMNS =
  'id, created_at, project_id, project_key, action, group_id, group_name, target_account_id, target_name, actor_account_id, actor_name, details';

function fromRow(r) {
  let details = null;
  if (r.details) {
    try {
      details = JSON.parse(r.details);
    } catch {
      details = { raw: r.details };
    }
  }
  return {
    id: r.id,
    createdAt: Number(r.created_at),
    projectId: r.project_id === '*' ? null : r.project_id,
    projectKey: r.project_key,
    action: r.action,
    groupId: r.group_id,
    groupName: r.group_name,
    targetAccountId: r.target_account_id,
    targetName: r.target_name,
    actorAccountId: r.actor_account_id,
    actorName: r.actor_name,
    details,
  };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function whereClause({ projectId, from, to, groupId, action, person }) {
  const parts = [];
  const params = [];
  if (projectId) {
    parts.push('project_id = ?');
    params.push(String(projectId));
  }
  if (from) {
    parts.push('created_at >= ?');
    params.push(Number(from));
  }
  if (to) {
    parts.push('created_at <= ?');
    params.push(Number(to));
  }
  if (groupId) {
    parts.push('group_id = ?');
    params.push(groupId);
  }
  if (action) {
    parts.push('action = ?');
    params.push(action);
  }
  if (person) {
    const like = `%${escapeLike(person.toLowerCase())}%`;
    parts.push('(LOWER(target_name) LIKE ? OR LOWER(actor_name) LIKE ?)');
    params.push(like, like);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

const int = (n, fallback) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : fallback);

export const sqlAudit = {
  async append(e) {
    await runMigrations();
    await sql
      .prepare(`INSERT INTO audit_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bindParams(
        e.id,
        e.createdAt,
        e.projectId ?? '*',
        e.projectKey,
        e.action,
        e.groupId,
        e.groupName,
        e.targetAccountId,
        e.targetName,
        e.actorAccountId,
        e.actorName,
        e.details ? JSON.stringify(e.details) : null,
      )
      .execute();
  },

  async query(filters) {
    await runMigrations();
    const where = whereClause(filters);
    const limit = int(filters.limit, 20);
    const offset = int(filters.offset, 0);
    const [rows, count] = await Promise.all([
      sql
        .prepare(`SELECT ${COLUMNS} FROM audit_log ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`)
        .bindParams(...where.params)
        .execute(),
      sql.prepare(`SELECT COUNT(*) AS total FROM audit_log ${where.sql}`).bindParams(...where.params).execute(),
    ]);
    return { entries: rows.rows.map(fromRow), total: Number(count.rows[0]?.total ?? 0) };
  },

  async groups({ projectId }) {
    await runMigrations();
    const where = projectId ? 'WHERE group_id IS NOT NULL AND project_id = ?' : 'WHERE group_id IS NOT NULL';
    const stmt = sql.prepare(
      `SELECT group_id, MAX(group_name) AS group_name FROM audit_log ${where} GROUP BY group_id ORDER BY group_name LIMIT 500`,
    );
    const res = projectId ? await stmt.bindParams(String(projectId)).execute() : await stmt.execute();
    return res.rows.map((r) => ({ groupId: r.group_id, groupName: r.group_name }));
  },

  async projects() {
    await runMigrations();
    const res = await sql
      .prepare(
        "SELECT project_id, MAX(project_key) AS project_key FROM audit_log WHERE project_id <> '*' GROUP BY project_id ORDER BY project_key LIMIT 1000",
      )
      .execute();
    return res.rows.map((r) => ({ projectId: r.project_id, projectKey: r.project_key }));
  },

  async purgeOlderThan(timestamp) {
    await runMigrations();
    const res = await sql.prepare('DELETE FROM audit_log WHERE created_at < ?').bindParams(Number(timestamp)).execute();
    return res.rows?.affectedRows ?? 0;
  },
};
