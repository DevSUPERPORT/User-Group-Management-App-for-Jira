import { route } from '@forge/api';
import { callConfluence, mapLimit } from './http.js';

// Confluence access for UC-06 (needs the app installed in Confluence on the same
// site). Groups are organization-wide, so Confluence uses the same group ids.

const SPACE_CAP = 200;

function nextCursor(links) {
  const next = links?.next;
  if (!next) return null;
  const m = /[?&]cursor=([^&]+)/.exec(next);
  return m ? decodeURIComponent(m[1]) : null;
}

export const confluenceClient = {
  async isAvailable() {
    try {
      await callConfluence(route`/wiki/api/v2/spaces?limit=1`);
      return true;
    } catch (err) {
      console.warn('Confluence not available', err?.message);
      return false;
    }
  },

  async spacePermissions({ groupId }) {
    const spaces = [];
    let cursor = null;
    do {
      const page = cursor
        ? await callConfluence(route`/wiki/api/v2/spaces?limit=100&cursor=${cursor}`)
        : await callConfluence(route`/wiki/api/v2/spaces?limit=100`);
      spaces.push(...(page.results ?? []));
      cursor = nextCursor(page._links);
    } while (cursor && spaces.length < SPACE_CAP);

    const items = [];
    await mapLimit(spaces.slice(0, SPACE_CAP), 6, async (space) => {
      const operations = new Set();
      let pc = null;
      do {
        const page = pc
          ? await callConfluence(route`/wiki/api/v2/spaces/${space.id}/permissions?limit=250&cursor=${pc}`)
          : await callConfluence(route`/wiki/api/v2/spaces/${space.id}/permissions?limit=250`);
        for (const p of page.results ?? []) {
          if (p.principal?.type === 'group' && p.principal?.id === groupId) operations.add(`${p.operation?.key}:${p.operation?.targetType}`);
        }
        pc = nextCursor(page._links);
      } while (pc);
      if (operations.size) items.push({ spaceKey: space.key, spaceName: space.name, operations: [...operations].sort() });
    });
    items.sort((a, b) => a.spaceKey.localeCompare(b.spaceKey));
    return { items, truncated: spaces.length > SPACE_CAP };
  },

  // One batch of pages for the restriction index.
  async listPages(cursor, limit) {
    const page = cursor
      ? await callConfluence(route`/wiki/api/v2/pages?limit=${limit}&cursor=${cursor}`)
      : await callConfluence(route`/wiki/api/v2/pages?limit=${limit}`);
    return { pages: (page.results ?? []).map((p) => ({ id: String(p.id), title: p.title, spaceId: String(p.spaceId) })), next: nextCursor(page._links) };
  },

  // Group restrictions of one page: [{ groupId, name, operation: 'read' | 'update' }].
  async pageRestrictions(pageId) {
    const res = await callConfluence(route`/wiki/rest/api/content/${pageId}/restriction?expand=restrictions.group`);
    const out = [];
    for (const r of res.results ?? []) {
      for (const g of r.restrictions?.group?.results ?? []) out.push({ groupId: g.id, name: g.name, operation: r.operation });
    }
    return out;
  },

  async spaceKeys(spaceIds) {
    const map = {};
    for (let i = 0; i < spaceIds.length; i += 50) {
      const ids = spaceIds.slice(i, i + 50).join(',');
      const page = await callConfluence(route`/wiki/api/v2/spaces?ids=${ids}&limit=50`);
      for (const s of page.results ?? []) map[String(s.id)] = { key: s.key, name: s.name };
    }
    return map;
  },
};
