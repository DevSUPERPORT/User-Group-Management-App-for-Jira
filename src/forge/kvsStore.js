import { kvs, WhereConditions } from '@forge/kvs';

// Group-to-project assignment, project key history and app configuration.
export const kvsStore = {
  get: (key) => kvs.get(key),
  set: (key, value) => kvs.set(key, value),
  delete: (key) => kvs.delete(key),

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
