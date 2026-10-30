import { kvs, WhereConditions } from '@forge/kvs';

// Group-to-project assignment, project key history and app configuration.
export const kvsStore = {
  get: (key) => kvs.get(key),
  set: (key, value) => kvs.set(key, value),
  delete: (key) => kvs.delete(key),

  // One page of a prefix, for the data export.
  async page(prefix, { cursor = null, limit = 100 } = {}) {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(limit);
    if (cursor) query = query.cursor(cursor);
    const res = await query.getMany();
    return { results: res.results, nextCursor: res.nextCursor ?? null };
  },

  async list(prefix) {
    const out = [];
    let cursor;
    do {
      let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
      if (cursor) query = query.cursor(cursor);
      const page = await query.getMany();
      out.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  },
};

// Encrypted, installation-scoped secret storage (organization API connection).
// Secrets are not returned by kvs.query(), so they never end up in a data export.
export const kvsSecrets = {
  get: (key) => kvs.getSecret(key),
  set: (key, value) => kvs.setSecret(key, value),
  delete: (key) => kvs.deleteSecret(key),
};
