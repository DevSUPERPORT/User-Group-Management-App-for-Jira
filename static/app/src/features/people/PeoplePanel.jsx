import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, Checkbox, IconButton, Skeleton, Spinner } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease, shake, spring } from '../../motion.js';
import { errorText } from '../errors.js';
import { ExpiryPicker, NO_EXPIRY, expiryFromValue } from '../groups/ExpiryPicker.jsx';

const DAY = 24 * 60 * 60 * 1000;
const SOON = 14 * DAY;
const MAX_CHANGES = 100;
const keyOf = (groupId, accountId) => `${groupId}|${accountId}`;

// "Who is in which group": every person of the project's groups in one table.
// Clicks only stage changes; nothing happens until the review is confirmed. One
// person joining or leaving the team becomes one batch instead of a visit to
// every group, and the whole batch can be undone.
export function PeoplePanel({ onCountsChange, onOpenGroup }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [pending, setPending] = useState(() => new Map());
  const [extra, setExtra] = useState([]); // people added through search, not yet in any group
  const [reviewOpen, setReviewOpen] = useState(false);
  const [failed, setFailed] = useState(null); // { results, options } of the last batch
  const [flash, setFlash] = useState(null);
  // The Jira flag offers Undo for 10 seconds only; the last batch stays undoable here.
  const [lastBatch, setLastBatch] = useState(null);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return call('accessMatrix')
      .then((res) => {
        setData(res);
        return res;
      })
      .catch((err) => {
        setError(err);
        return null;
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const groups = data?.groups ?? [];
  const people = useMemo(() => {
    if (!data) return [];
    const known = new Set(data.people.map((p) => p.accountId));
    return [...extra.filter((p) => !known.has(p.accountId)), ...data.people];
  }, [data, extra]);

  const editable = (g) => !g.readOnly && g.available;
  const isMember = (p, g) => Boolean(p.memberships[g.groupId]);
  const endingSoon = (p) => Object.values(p.memberships).some((m) => m.expiresAt && m.expiresAt - Date.now() < SOON);
  const counts = useMemo(
    () => ({
      all: people.length,
      deactivated: people.filter((p) => !p.active).length,
      ending: people.filter(endingSoon).length,
      pending: new Set([...pending.keys()].map((k) => k.split('|')[1])).size,
    }),
    [people, pending],
  );

  const q = query.trim().toLowerCase();
  const visible = people.filter((p) => {
    if (q && !p.displayName.toLowerCase().includes(q) && !(p.email ?? '').toLowerCase().includes(q)) return false;
    if (filter === 'deactivated') return !p.active;
    if (filter === 'ending') return endingSoon(p);
    if (filter === 'pending') return groups.some((g) => pending.has(keyOf(g.groupId, p.accountId)));
    return true;
  });

  const toggle = (p, g) => {
    if (!editable(g)) return;
    setPending((prev) => {
      const next = new Map(prev);
      const k = keyOf(g.groupId, p.accountId);
      if (next.has(k)) next.delete(k);
      else if (next.size >= MAX_CHANGES) {
        notify({ type: 'error', title: t('people.tooMany', { count: MAX_CHANGES }) });
      } else next.set(k, isMember(p, g) ? 'remove' : 'add');
      return next;
    });
  };

  // Offboarding in one click: stage removal from every group that can be changed.
  const removeFromAll = (p) => {
    setPending((prev) => {
      const next = new Map(prev);
      const targets = groups.filter((g) => editable(g) && isMember(p, g));
      const allStaged = targets.length && targets.every((g) => next.get(keyOf(g.groupId, p.accountId)) === 'remove');
      for (const g of targets) {
        const k = keyOf(g.groupId, p.accountId);
        if (allStaged) next.delete(k);
        else next.set(k, 'remove');
      }
      return next;
    });
  };

  const changes = [...pending.entries()].map(([k, op]) => {
    const [groupId, accountId] = k.split('|');
    return { groupId, accountId, op };
  });
  const adds = changes.filter((c) => c.op === 'add').length;
  const removes = changes.length - adds;

  const personById = (id) => people.find((p) => p.accountId === id);
  const groupById = (id) => groups.find((g) => g.groupId === id);

  // Runs a batch, reloads the table from Jira and reports per change.
  const run = async (batch, options, { undoable = true } = {}) => {
    const res = await call('applyAccessChanges', { changes: batch, ...options });
    const ok = res.results.filter((r) => r.status === 'added' || r.status === 'removed');
    const already = res.results.filter((r) => r.status === 'already');
    const bad = res.results.filter((r) => r.status === 'failed');
    // Jira's member count lags behind Organization API changes; the counts follow
    // the changes just made instead (as in the group view).
    const counts = {};
    for (const r of ok) {
      const base = counts[r.groupId] ?? groupById(r.groupId)?.memberCount ?? 0;
      counts[r.groupId] = Math.max(0, base + (r.op === 'add' ? 1 : -1));
    }
    onCountsChange?.(counts);
    const fresh = await load();
    if (fresh) {
      // People removed from their last group stay in view (empty row), so the
      // result is visible and they can be added back right here.
      const touched = new Map(res.results.map((r) => [r.accountId, personById(r.accountId) ?? r]));
      setExtra((xs) => {
        const keep = new Map(xs.map((x) => [x.accountId, x]));
        for (const [id, p] of touched) if (!keep.has(id)) keep.set(id, { accountId: id, displayName: p.displayName, email: p.email ?? null, avatarUrl: p.avatarUrl ?? null, active: p.active !== false });
        return [...keep.values()].filter((x) => !fresh.people.some((p) => p.accountId === x.accountId)).map((x) => ({ ...x, memberships: {} }));
      });
    }
    setFailed(bad.length ? { results: bad, options } : null);
    setFlash(new Set(ok.map((r) => keyOf(r.groupId, r.accountId))));
    setTimeout(() => setFlash(null), 1800);
    if (options.reason === 'undo') setLastBatch(null);
    else if (undoable && ok.length) setLastBatch({ ok, at: Date.now() });
    if (ok.length || already.length) {
      notify({
        type: options.reason === 'undo' ? 'info' : 'success',
        title: options.reason === 'undo' ? t('notify.undone') : t('people.applied', { count: ok.length + already.length }),
        description: bad.length ? t('people.someFailed', { count: bad.length }) : undefined,
        action: undoable && ok.length ? { label: t('notify.undo'), onClick: () => undoBatch(ok) } : undefined,
      });
    } else if (bad.length) {
      notify({ type: 'error', title: t('people.allFailed', { count: bad.length }) });
    }
    return res;
  };

  // Reverses exactly what a batch changed, restoring removed people's end dates.
  const undoBatch = async (ok) => {
    setUndoing(true);
    try {
      await run(
        ok.map((r) => ({ groupId: r.groupId, accountId: r.accountId, op: r.op === 'add' ? 'remove' : 'add' })),
        { reason: 'undo', expiries: Object.fromEntries(ok.filter((r) => r.previousExpiry).map((r) => [r.accountId, r.previousExpiry])) },
        { undoable: false },
      );
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    } finally {
      setUndoing(false);
    }
  };

  const apply = async (options) => {
    const res = await run(changes, { ...options, reason: 'bulk' });
    // Keep only what failed staged, so it can be retried or discarded.
    const failedKeys = new Set(res.results.filter((r) => r.status === 'failed').map((r) => keyOf(r.groupId, r.accountId)));
    setPending((prev) => new Map([...prev].filter(([k]) => failedKeys.has(k))));
    setReviewOpen(false);
  };

  if (error) {
    return (
      <div className="card section">
        <p className="notice notice-warn">
          <Icon name="alert" size={16} />
          <span>{errorText(t, error)}</span>
        </p>
        <Button onClick={load}>{t('error.retry')}</Button>
      </div>
    );
  }

  return (
    <section className="card people" aria-labelledby="people-title">
      <div className="people-head">
        <div className="stack-4">
          <h2 id="people-title" className="h3">
            {t('people.title')}
          </h2>
          <p className="muted small">{t('people.hint')}</p>
        </div>
        <PersonSearch
          disabled={!data}
          onPick={(u) => {
            const existing = people.find((p) => p.accountId === u.accountId);
            if (!existing) setExtra((xs) => [{ ...u, active: u.active !== false, memberships: {} }, ...xs]);
            setQuery('');
            setFilter('all');
            setTimeout(() => document.getElementById(`person-${u.accountId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
            setFlash(new Set([`row|${u.accountId}`]));
            setTimeout(() => setFlash(null), 1800);
          }}
        />
      </div>

      <div className="people-tools">
        <div className="input-icon grow">
          <Icon name="search" size={18} />
          <input className="input" type="search" placeholder={t('people.filter')} aria-label={t('people.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="seg-control" role="radiogroup" aria-label={t('people.show')}>
          {['all', 'deactivated', 'ending', 'pending'].map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={`seg-option ${filter === f ? 'is-on' : ''}`} onClick={() => setFilter(f)} disabled={f !== 'all' && !counts[f] && filter !== f}>
              {filter === f && <motion.span layoutId="people-filter" className="seg-pill" transition={spring} />}
              <span>
                {t(`people.f.${f}`)} <span className="muted tabular">{counts[f]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {data?.truncated && (
        <p className="notice notice-warn">
          <Icon name="info" size={16} />
          <span>{t('people.truncated')}</span>
        </p>
      )}

      <AnimatePresence initial={false}>
        {lastBatch && !changes.length && (
          <motion.div className="notice last-batch" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="check" size={16} />
            <span className="grow">
              <strong>{t('people.lastBatch', { count: lastBatch.ok.length })}</strong>{' '}
              <span className="muted">
                {lastBatch.ok
                  .slice(0, 4)
                  .map((r) => `${r.op === 'add' ? '+' : '−'} ${personById(r.accountId)?.displayName ?? r.displayName} · ${groupById(r.groupId)?.namePart ?? r.groupName}`)
                  .join(', ')}
                {lastBatch.ok.length > 4 ? ' …' : ''}
              </span>
            </span>
            <Button size="sm" icon="undo" loading={undoing} onClick={() => undoBatch(lastBatch.ok)}>
              {t('people.undoBatch')}
            </Button>
            <IconButton icon="close" size={15} className="icon-btn-sm" label={t('people.dismiss')} onClick={() => setLastBatch(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {failed && (
          <motion.div className="notice notice-error" role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Icon name="alert" size={16} />
            <span className="grow">
              <strong>{t('people.failedTitle', { count: failed.results.length })}</strong>{' '}
              {failed.results.map((r) => `${personById(r.accountId)?.displayName ?? r.displayName} → ${groupById(r.groupId)?.namePart ?? r.groupName}: ${errorText(t, { code: r.code, message: r.error })}`).join(' · ')}
            </span>
            <Button size="sm" onClick={() => setFailed(null)}>
              {t('people.dismiss')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {!data ? (
        <div className="stack-8">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={44} radius={10} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-inline">
          <Icon name="users" size={20} />
          <span>{t('people.noGroups')}</span>
        </div>
      ) : (
        <div className="matrix-wrap" role="region" aria-label={t('people.title')} tabIndex={0}>
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col" className="matrix-person">
                  {t('people.person')}
                </th>
                {groups.map((g) => (
                  <th key={g.groupId} scope="col" className="matrix-group">
                    <button type="button" className="matrix-group-btn" title={g.name} onClick={() => onOpenGroup?.(g.groupId)}>
                      <span className="matrix-group-name">{g.namePart}</span>
                      <span className="matrix-group-meta">
                        {g.readOnly ? (
                          <>
                            <Icon name="lock" size={11} /> {t('groups.idp')}
                          </>
                        ) : !g.available ? (
                          t('groups.syncing')
                        ) : (
                          g.memberCount
                        )}
                      </span>
                    </button>
                  </th>
                ))}
                <th scope="col" className="matrix-actions">
                  <span className="sr-only">{t('people.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {visible.map((p) => {
                  const staged = groups.some((g) => pending.has(keyOf(g.groupId, p.accountId)));
                  const removable = groups.some((g) => editable(g) && isMember(p, g));
                  return (
                    <motion.tr
                      key={p.accountId}
                      id={`person-${p.accountId}`}
                      layout="position"
                      className={`${staged ? 'is-staged' : ''} ${flash?.has(`row|${p.accountId}`) ? 'is-flash' : ''}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: 0.12 } }}
                      transition={{ duration: 0.2, ease }}
                    >
                      <th scope="row" className="matrix-person">
                        <span className="matrix-person-inner">
                          <Avatar name={p.displayName} url={p.avatarUrl} size={28} dim={!p.active} />
                          <span className="member-text">
                            <span className="break">
                              {p.displayName} {!p.active && <span className="tag">{t('members.inactive')}</span>}
                            </span>
                            {p.email && <span className="muted small break">{p.email}</span>}
                          </span>
                        </span>
                      </th>
                      {groups.map((g) => {
                        const k = keyOf(g.groupId, p.accountId);
                        const op = pending.get(k);
                        const member = isMember(p, g);
                        const on = op ? op === 'add' : member;
                        const exp = p.memberships[g.groupId]?.expiresAt;
                        const soon = exp && exp - Date.now() < SOON;
                        return (
                          <td key={g.groupId} className="matrix-cell">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              aria-label={t('people.cellLabel', { name: p.displayName, group: g.namePart })}
                              title={exp ? t('members.until', { date: fmt.date(exp) }) : undefined}
                              disabled={!editable(g)}
                              className={`cell ${on ? 'is-on' : ''} ${op ? `is-${op}` : ''} ${flash?.has(k) ? 'is-flash' : ''}`}
                              onClick={() => toggle(p, g)}
                            >
                              <AnimatePresence initial={false} mode="wait">
                                {op === 'remove' ? (
                                  <motion.span key="rm" className="cell-mark" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: 0.14 }}>
                                    <Icon name="close" size={13} strokeWidth={3} />
                                  </motion.span>
                                ) : on ? (
                                  <motion.span key="on" className="cell-mark" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: 0.14 }}>
                                    {op === 'add' ? <Icon name="plus" size={13} strokeWidth={3} /> : <Icon name="check" size={13} strokeWidth={3} />}
                                  </motion.span>
                                ) : null}
                              </AnimatePresence>
                              {exp && !op && <span className={`cell-clock ${soon ? 'is-soon' : ''}`} aria-hidden="true" />}
                            </button>
                          </td>
                        );
                      })}
                      <td className="matrix-actions">
                        {removable && (
                          <IconButton icon="close" size={15} className="icon-btn-sm" label={t('people.removeAll', { name: p.displayName })} onClick={() => removeFromAll(p)} />
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
          {visible.length === 0 && <p className="muted small matrix-empty">{q ? t('people.noMatch', { query }) : t('people.emptyFilter')}</p>}
        </div>
      )}

      <p className="muted small people-legend">
        <span className="legend-item">
          <span className="cell is-on legend-cell">
            <Icon name="check" size={11} strokeWidth={3} />
          </span>
          {t('people.legend.member')}
        </span>
        <span className="legend-item">
          <span className="cell is-on is-add legend-cell">
            <Icon name="plus" size={11} strokeWidth={3} />
          </span>
          {t('people.legend.add')}
        </span>
        <span className="legend-item">
          <span className="cell is-remove legend-cell">
            <Icon name="close" size={11} strokeWidth={3} />
          </span>
          {t('people.legend.remove')}
        </span>
        <span className="legend-item">
          <span className="cell-clock is-soon legend-clock" />
          {t('people.legend.ending')}
        </span>
      </p>

      <AnimatePresence>
        {changes.length > 0 && (
          <motion.div className="people-bar" role="status" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={spring}>
            <span className="grow">
              <strong>{t('people.pending', { count: changes.length })}</strong>
              <span className="muted small">
                {' · '}
                {adds > 0 && t('people.adds', { count: adds })}
                {adds > 0 && removes > 0 && ', '}
                {removes > 0 && t('people.removes', { count: removes })}
              </span>
            </span>
            <Button size="sm" onClick={() => setPending(new Map())}>
              {t('people.discard')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}>
              {t('people.review')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reviewOpen && (
          <ApplyDialog
            changes={changes}
            personById={personById}
            groupById={groupById}
            expiryEnabled={data?.expiryEnabled}
            onClose={() => setReviewOpen(false)}
            onApply={apply}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

// Review before apply: grouped by person, end date for additions, note for the
// audit log, and an explicit tick when access is taken away.
function ApplyDialog({ changes, personById, groupById, expiryEnabled, onClose, onApply }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [expiry, setExpiry] = useState(NO_EXPIRY);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState(0);
  const removes = changes.filter((c) => c.op === 'remove').length;
  const adds = changes.length - removes;
  const byPerson = new Map();
  for (const c of changes) byPerson.set(c.accountId, [...(byPerson.get(c.accountId) ?? []), c]);

  const submit = async () => {
    if (removes && !confirmed) {
      setNudge((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      await onApply({ expiresAt: adds ? expiryFromValue(expiry) : null, note });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="apply-title" onClose={busy ? () => {} : onClose} width={640}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow">{t('people.reviewEyebrow')}</div>
            <h1 id="apply-title" className="h1">
              {t('people.reviewTitle', { count: changes.length })}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>

        <ul className="apply-list">
          {[...byPerson.entries()].map(([accountId, list], i) => {
            const p = personById(accountId);
            return (
              <motion.li key={accountId} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.03, duration: 0.24, ease } }}>
                <Avatar name={p?.displayName ?? accountId} url={p?.avatarUrl} size={30} dim={p && !p.active} />
                <span className="member-text grow">
                  <span>{p?.displayName ?? accountId}</span>
                  <span className="apply-chips">
                    {list.map((c) => (
                      <span key={c.groupId} className={`apply-chip is-${c.op}`}>
                        <Icon name={c.op === 'add' ? 'plus' : 'close'} size={11} strokeWidth={3} />
                        {groupById(c.groupId)?.namePart ?? c.groupId}
                      </span>
                    ))}
                  </span>
                </span>
              </motion.li>
            );
          })}
        </ul>

        {adds > 0 && expiryEnabled && <ExpiryPicker value={expiry} onChange={setExpiry} label={t('people.expiryForAdds', { count: adds })} />}

        <div className="stack-8">
          <label htmlFor="apply-note" className="label-strong">
            {t('review.note')} <span className="muted normal">{t('create.optional')}</span>
          </label>
          <input id="apply-note" className="input" maxLength={300} placeholder={t('people.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {removes > 0 && (
          <motion.div key={nudge} animate={nudge ? shake : undefined}>
            <Checkbox id="apply-confirm" checked={confirmed} onChange={setConfirmed}>
              {t('people.confirmRemovals', { count: removes })}
            </Checkbox>
          </motion.div>
        )}

        <div className="notice">
          <Icon name="undo" size={16} />
          <span>{t('people.undoHint')}</span>
        </div>

        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('review.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} aria-disabled={(removes > 0 && !confirmed) || undefined} className={removes > 0 && !confirmed ? 'is-soft-disabled' : ''}>
            {t('people.apply', { count: changes.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Finds anyone on the site to add them as a new row (e.g. a new team member).
function PersonSearch({ onPick, disabled }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    const v = q.trim();
    if (v.length < 2) {
      setResults([]);
      return undefined;
    }
    setBusy(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      call('searchUsers', { query: v })
        .then((res) => id === reqRef.current && (setResults(res.users.slice(0, 8)), setActive(0)))
        .catch(() => id === reqRef.current && setResults([]))
        .finally(() => id === reqRef.current && setBusy(false));
    }, 220);
    return () => clearTimeout(timer);
  }, [q]);

  const pick = (u) => {
    onPick(u);
    setQ('');
    setResults([]);
  };

  return (
    <div className="person-search">
      <div className="input-icon">
        <Icon name="plus" size={18} />
        <input
          className="input"
          placeholder={t('people.addPerson')}
          aria-label={t('people.addPerson')}
          value={q}
          disabled={disabled}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="person-search-list"
          aria-autocomplete="list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') setQ('');
          }}
        />
        {busy && (
          <span className="person-search-spin">
            <Spinner size={14} />
          </span>
        )}
      </div>
      <AnimatePresence>
        {results.length > 0 && (
          <motion.ul id="person-search-list" role="listbox" className="person-search-list" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
            {results.map((u, i) => (
              <li key={u.accountId} role="option" aria-selected={i === active} className={i === active ? 'is-active' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), pick(u))}>
                <Avatar name={u.displayName} url={u.avatarUrl} size={24} />
                <span className="member-text">
                  <span>{u.displayName}</span>
                  {u.email && <span className="muted small">{u.email}</span>}
                </span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
