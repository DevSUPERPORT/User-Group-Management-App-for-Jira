// Incremental index of Confluence page restrictions by group (UC-06).
// Confluence has no "which pages does this group restrict" lookup, so a scheduled
// trigger scans pages in small batches and keeps, per group, the pages that
// restrict it. A full pass ends with pruning of pages that were not seen again
// (deleted pages, removed restrictions).
//
// Storage: cfidx:state, cfidx:g:<groupId> = { [pageId]: { title, spaceId, ops, scan } },
//          cfidx:p:<pageId> = [groupId]

const MAX_PAGES_PER_GROUP = 2000;

export const indexKeys = {
  state: 'cfidx:state',
  group: (groupId) => `cfidx:g:${groupId}`,
  page: (pageId) => `cfidx:p:${pageId}`,
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export async function indexState(store) {
  return (await store.get(indexKeys.state)) ?? { scan: 1, cursor: null, scanned: 0, lastFullScanAt: null, pagesInLastScan: null, updatedAt: null };
}

export async function runIndexStep({ confluence, store, now, budget = 60 }) {
  const state = await indexState(store);
  let cursor = state.cursor;
  let processed = 0;
  let finished = false;

  while (processed < budget) {
    const { pages, next } = await confluence.listPages(cursor, Math.min(50, budget - processed));
    const results = await mapLimit(pages, 5, async (p) => ({ p, groups: await confluence.pageRestrictions(p.id).catch(() => null) }));

    for (const { p, groups } of results) {
      if (groups === null) continue; // keep what we knew; retried next pass
      const byGroup = {};
      for (const g of groups) {
        if (!g.groupId) continue;
        byGroup[g.groupId] ??= new Set();
        byGroup[g.groupId].add(g.operation);
      }
      const before = (await store.get(indexKeys.page(p.id))) ?? [];
      const now_ = Object.keys(byGroup);
      for (const gid of before.filter((g) => !now_.includes(g))) {
        const entry = (await store.get(indexKeys.group(gid))) ?? {};
        delete entry[p.id];
        await store.set(indexKeys.group(gid), entry);
      }
      for (const gid of now_) {
        const entry = (await store.get(indexKeys.group(gid))) ?? {};
        if (entry[p.id] || Object.keys(entry).length < MAX_PAGES_PER_GROUP) {
          entry[p.id] = { title: p.title, spaceId: p.spaceId, ops: [...byGroup[gid]].sort(), scan: state.scan };
          await store.set(indexKeys.group(gid), entry);
        }
      }
      if (now_.length) await store.set(indexKeys.page(p.id), now_);
      else if (before.length) await store.delete(indexKeys.page(p.id));
    }

    processed += pages.length;
    state.scanned += pages.length;
    cursor = next;
    if (!next) {
      finished = true;
      break;
    }
    if (!pages.length) break;
  }

  if (finished) {
    // Prune entries not confirmed in this pass (deleted pages, removed restrictions).
    for (const { key, value } of await store.list('cfidx:g:')) {
      const kept = Object.fromEntries(Object.entries(value ?? {}).filter(([, e]) => e.scan === state.scan));
      if (Object.keys(kept).length !== Object.keys(value ?? {}).length) await store.set(key, kept);
    }
    state.lastFullScanAt = now();
    state.pagesInLastScan = state.scanned;
    state.scanned = 0;
    state.scan += 1;
    state.cursor = null;
  } else {
    state.cursor = cursor;
  }
  state.updatedAt = now();
  await store.set(indexKeys.state, state);
  return { processed, finished, state };
}

export async function pagesForGroup(store, groupId) {
  const entry = (await store.get(indexKeys.group(groupId))) ?? {};
  return Object.entries(entry).map(([pageId, e]) => ({ pageId, title: e.title, spaceId: e.spaceId, ops: e.ops }));
}

export async function resetIndex(store) {
  const state = await indexState(store);
  await store.set(indexKeys.state, { ...state, cursor: null, scanned: 0, scan: state.scan + 1 });
}
