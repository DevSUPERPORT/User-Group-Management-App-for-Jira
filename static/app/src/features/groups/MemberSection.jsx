import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, CountUp, IconButton, Skeleton } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease, spring } from '../../motion.js';
import { UserPicker } from './UserPicker.jsx';
import { ExpiryPicker, NO_EXPIRY, expiryFromValue, valueFromExpiry } from './ExpiryPicker.jsx';
import { PasteDialog } from './PasteDialog.jsx';
import { ReviewDialog } from './ReviewDialog.jsx';
import { useImpact } from './useImpact.js';
import { errorText } from '../errors.js';
import { downloadText } from '../download.js';

const FIRST_PAGE = 8;
const SOON = 7 * 24 * 60 * 60 * 1000;

// UC-02 (view) and UC-03 (add/remove) for one group, with undo for every change.
export function MemberSection({ group, expiryEnabled, reviewActive = false, onCountChange, onChanged, onReviewCompleted }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [members, setMembers] = useState([]);
  const [total, setTotal] = useState(group.memberCount ?? 0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [fresh, setFresh] = useState(() => new Set());
  const [confirmId, setConfirmId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [expiryEdit, setExpiryEdit] = useState(null); // { accountId, value }
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [addExpiry, setAddExpiry] = useState(NO_EXPIRY);
  const [reviewMode, setReviewMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Jira knows groups created through the Organization API only after a delay.
  const [syncing, setSyncing] = useState(false);
  const reqRef = useRef(0);
  const impact = useImpact(group.groupId);

  const fetchPage = async (startAt, maxResults, q) => call('getMembers', { groupId: group.groupId, startAt, maxResults, query: q });

  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    const timer = setTimeout(
      () => {
        fetchPage(0, FIRST_PAGE, query.trim())
          .then((res) => {
            if (id !== reqRef.current) return;
            setMembers(res.members);
            setSyncing(Boolean(res.syncing));
            if (res.total !== null) {
              setTotal(res.total);
              if (!query.trim()) onCountChange(res.total);
            }
          })
          .catch((err) => id === reqRef.current && notify({ type: 'error', title: errorText(t, err) }))
          .finally(() => id === reqRef.current && setLoading(false));
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [group.groupId, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const size = total <= 100 ? total - members.length : 50;
      const res = await fetchPage(members.length, Math.min(100, size), query.trim());
      setMembers((m) => [...m, ...res.members.filter((x) => !m.some((y) => y.accountId === x.accountId))]);
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setLoadingMore(false);
    }
  };

  const knownIds = useMemo(() => new Set(members.map((m) => m.accountId)), [members]);

  // Undo callbacks run seconds later; a ref keeps them on the current count.
  const totalRef = useRef(total);
  totalRef.current = total;

  // Jira's count can lag behind the change just made; trust the change itself.
  const applyCount = (reported, delta) => {
    const expected = Math.max(0, totalRef.current + delta);
    const count = reported === null || reported === undefined ? expected : delta >= 0 ? Math.max(reported, expected) : Math.min(reported, expected);
    totalRef.current = count;
    setTotal(count);
    onCountChange(count);
  };

  const applyAdded = (added, reported) => {
    setMembers((m) => [...added, ...m.filter((x) => !added.some((a) => a.accountId === x.accountId))]);
    setFresh((f) => new Set([...f, ...added.map((a) => a.accountId)]));
    applyCount(reported, added.length);
  };

  const applyRemoved = (ids, reported) => {
    setMembers((m) => m.filter((x) => !ids.includes(x.accountId)));
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    applyCount(reported, -ids.length);
  };

  // ---- undo helpers: each reverses exactly what was just done

  const undoAdd = async (people) => {
    try {
      const res = await call('removeMembers', { groupId: group.groupId, accountIds: people.map((p) => p.accountId), reason: 'undo' });
      applyRemoved(res.results.filter((r) => r.status === 'removed').map((r) => r.accountId), res.memberCount);
      notify({ type: 'info', title: t('notify.undone') });
      onChanged();
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    }
  };

  const undoRemove = async (removed) => {
    try {
      const expiries = Object.fromEntries(removed.filter((r) => r.previousExpiry).map((r) => [r.accountId, r.previousExpiry]));
      const res = await call('addMembers', { groupId: group.groupId, accountIds: removed.map((r) => r.accountId), expiries, reason: 'undo' });
      applyAdded(res.results.filter((r) => r.status === 'added'), res.memberCount);
      notify({ type: 'info', title: t('notify.undone') });
      onChanged();
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    }
  };

  const add = async (accountIds, expiresAt = expiryFromValue(addExpiry), reason = null) => {
    try {
      const res = await call('addMembers', { groupId: group.groupId, accountIds, expiresAt, reason });
      const added = res.results.filter((r) => r.status === 'added');
      const already = res.results.filter((r) => r.status === 'already').length;
      const failed = res.results.filter((r) => r.status === 'failed');
      applyAdded(added, res.memberCount);
      if (added.length) {
        notify({
          type: 'success',
          title: t('notify.added', { count: added.length }),
          description: added.map((a) => a.displayName).join(', ') + (expiresAt ? ` · ${t('members.until', { date: fmt.date(expiresAt) })}` : ''),
          action: { label: t('notify.undo'), onClick: () => undoAdd(added) },
        });
      }
      if (already) notify({ type: 'info', title: t('notify.already', { count: already }) });
      if (failed.length) {
        notify({
          type: 'error',
          title: t('notify.failed', { count: failed.length }),
          description: failed.map((f) => f.displayName).join(', '),
          action: { label: t('notify.retry'), onClick: () => add(failed.map((f) => f.accountId), expiresAt, 'retry').catch(() => {}) },
        });
      }
      setAddExpiry(NO_EXPIRY);
      onChanged();
      return res;
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      throw err;
    }
  };

  const remove = async (member) => {
    setRemovingId(member.accountId);
    try {
      const res = await call('removeMember', { groupId: group.groupId, accountId: member.accountId });
      setConfirmId(null);
      applyRemoved([member.accountId], res.memberCount);
      const removed = [{ ...(res.removed ?? { accountId: member.accountId, previousExpiry: member.expiresAt ?? null }), displayName: member.displayName }];
      notify({
        type: 'success',
        title: t('notify.removed', { name: member.displayName }),
        action: { label: t('notify.undo'), onClick: () => undoRemove(removed) },
      });
      onChanged();
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err), action: { label: t('notify.retry'), onClick: () => remove(member) } });
    } finally {
      setRemovingId(null);
    }
  };

  const saveExpiry = async (member, value, reason = null) => {
    setSavingExpiry(true);
    const next = value === null ? null : expiryFromValue(value);
    try {
      const res = await call('setExpiry', { groupId: group.groupId, accountId: member.accountId, expiresAt: next, reason });
      setMembers((ms) => ms.map((m) => (m.accountId === member.accountId ? { ...m, expiresAt: res.expiresAt } : m)));
      setExpiryEdit(null);
      if (reason !== 'undo') {
        notify({
          type: 'success',
          title: res.expiresAt ? t('notify.expirySet', { name: member.displayName, date: fmt.date(res.expiresAt) }) : t('notify.expiryCleared', { name: member.displayName }),
          action: { label: t('notify.undo'), onClick: () => saveExpiry(member, valueFromExpiry(res.previous), 'undo') },
        });
      } else notify({ type: 'info', title: t('notify.undone') });
      onChanged();
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setSavingExpiry(false);
    }
  };

  const onReviewed = (res) => {
    const removed = res.results.filter((r) => r.status === 'removed');
    const failed = res.results.filter((r) => r.status === 'failed');
    applyRemoved(removed.map((r) => r.accountId), res.memberCount);
    setReviewOpen(false);
    setReviewMode(false);
    setSelected(new Set());
    if (removed.length) {
      notify({
        type: 'success',
        title: t('notify.removedN', { count: removed.length }),
        description: removed.map((r) => r.displayName).join(', '),
        action: { label: t('notify.undo'), onClick: () => undoRemove(removed) },
      });
    }
    if (failed.length) {
      notify({
        type: 'error',
        title: t('notify.removeFailed', { count: failed.length }),
        description: failed.map((f) => f.displayName).join(', '),
        action: {
          label: t('notify.retry'),
          onClick: () =>
            call('removeMembers', { groupId: group.groupId, accountIds: failed.map((f) => f.accountId), reason: 'retry' })
              .then(onReviewed)
              .catch((err) => notify({ type: 'error', title: errorText(t, err) })),
        },
      });
    }
    onChanged();
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await call('exportMembers', { groupId: group.groupId });
      downloadText(res.csv, res.filename, 'text/csv;charset=utf-8');
      notify({ type: 'success', title: t('members.exported', { count: res.count }) });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setExporting(false);
    }
  };

  const toggleSelect = (id) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const allShownSelected = members.length > 0 && members.every((m) => selected.has(m.accountId));
  const selectedPeople = members.filter((m) => selected.has(m.accountId));
  const remaining = total - members.length;
  const editable = !group.readOnly;

  return (
    <div className="stack-16">
      <div className="row-between wrap">
        <div className="row-baseline">
          <h3 className="h3">{t('members.title')}</h3>
          <span className="muted">
            <CountUp value={total} />
          </span>
        </div>
        <div className="row-8 wrap">
          {(total > FIRST_PAGE || query) && (
            <div className="input-icon compact">
              <Icon name="search" size={16} />
              <input className="input input-sm" type="search" aria-label={t('members.search')} placeholder={t('members.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          {editable && total > 0 && (
            <Button
              size="sm"
              icon="checks"
              variant={reviewMode ? 'dark' : 'secondary'}
              aria-pressed={reviewMode}
              onClick={() => {
                setReviewMode((r) => !r);
                setSelected(new Set());
                setConfirmId(null);
                setExpiryEdit(null);
              }}
            >
              {reviewMode ? t('members.reviewDone') : t('members.review')}
            </Button>
          )}
          <IconButton icon="download" label={t('members.export')} className={`icon-btn-outline icon-btn-sm36 ${exporting ? 'is-busy' : ''}`} onClick={exportCsv} disabled={exporting || !total} />
        </div>
      </div>

      {editable && !reviewMode && (
        <div className="add-area">
          <UserPicker knownMemberIds={knownIds} onSubmit={(ids) => add(ids)} />
          <div className="add-options">
            {expiryEnabled && <ExpiryPicker value={addExpiry} onChange={setAddExpiry} compact />}
            <Button variant="link" size="sm" icon="clipboard" onClick={() => setPasteOpen(true)}>
              {t('members.paste')}
            </Button>
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {reviewMode && (
          <motion.div className="review-bar" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease }}>
            <label className="check">
              <input
                type="checkbox"
                checked={allShownSelected}
                onChange={() => setSelected(allShownSelected ? new Set() : new Set(members.map((m) => m.accountId)))}
                aria-label={t('members.selectAll')}
              />
              <span className="check-box" aria-hidden="true">
                {allShownSelected && <Icon name="check" size={14} strokeWidth={3.2} />}
              </span>
              <span>{selected.size ? t('members.selected', { count: selected.size }) : t('members.reviewHint')}</span>
            </label>
            <Button size="sm" variant="danger" disabled={!selected.size} onClick={() => setReviewOpen(true)}>
              {t('members.reviewRemove')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {syncing && (
          <motion.p className="notice" role="status" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Icon name="refresh" size={16} />
            <span>{t('members.syncing')}</span>
          </motion.p>
        )}
      </AnimatePresence>

      {loading && members.length === 0 ? (
        <ul className="member-list" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="member-row">
              <Skeleton width={36} height={36} radius={18} />
              <span className="member-text">
                <Skeleton width={`${46 - i * 5}%`} height={14} />
                <Skeleton width={`${62 - i * 6}%`} height={11} />
              </span>
            </li>
          ))}
        </ul>
      ) : members.length === 0 && syncing ? null : members.length === 0 ? (
        <motion.p className="empty-inline" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {query ? t('members.noMatch', { query }) : t('members.empty')}
        </motion.p>
      ) : (
        <ul className={`member-list ${loading ? 'is-refreshing' : ''}`}>
          <AnimatePresence initial={false}>
            {members.map((m, i) => {
              const soon = m.expiresAt && m.expiresAt - Date.now() < SOON;
              const isSelected = selected.has(m.accountId);
              return (
                <motion.li
                  key={m.accountId}
                  layout="position"
                  className={`member-row ${fresh.has(m.accountId) ? 'is-fresh' : ''} ${confirmId === m.accountId ? 'is-confirming' : ''} ${isSelected ? 'is-selected' : ''}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto', transition: { height: { duration: 0.3, ease }, opacity: { duration: 0.3, delay: Math.min(i, 8) * 0.025 } } }}
                  exit={{ opacity: 0, height: 0, transition: { height: { duration: 0.28, ease, delay: 0.05 }, opacity: { duration: 0.14 } } }}
                  transition={spring}
                >
                  <div className="member-main">
                    <AnimatePresence initial={false}>
                      {reviewMode && (
                        <motion.label
                          className="check member-check"
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: 'auto' }}
                          exit={{ opacity: 0, width: 0 }}
                          transition={{ duration: 0.2, ease }}
                        >
                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(m.accountId)} aria-label={t('members.select', { name: m.displayName })} />
                          <span className="check-box" aria-hidden="true">
                            {isSelected && <Icon name="check" size={14} strokeWidth={3.2} />}
                          </span>
                        </motion.label>
                      )}
                    </AnimatePresence>
                    <Avatar name={m.displayName} url={m.avatarUrl} dim={!m.active} />
                    <span className="member-text">
                      <span className="member-name">
                        {m.displayName}
                        {fresh.has(m.accountId) && (
                          <motion.span className="tag tag-new" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 22, delay: 0.15 }}>
                            {t('members.new')}
                          </motion.span>
                        )}
                        {!m.active && <span className="tag">{t('members.inactive')}</span>}
                        {m.expiresAt && (
                          <span className={`tag tag-expiry ${soon ? 'is-soon' : ''}`} title={t('members.untilLong', { date: fmt.dateTime(m.expiresAt) })}>
                            <Icon name="clock" size={11} />
                            {t('members.until', { date: fmt.date(m.expiresAt) })}
                          </span>
                        )}
                      </span>
                      <span className="muted small">
                        {m.email ?? t('members.emailHidden')}
                        {' · '}
                        {m.addedAt ? t('members.addedBy', { date: fmt.date(m.addedAt), name: m.addedBy }) : t('members.addedOutside')}
                      </span>
                    </span>
                    {editable && !reviewMode && (
                      <span className="row-actions">
                        {expiryEnabled && (
                          <IconButton
                            icon="calendar"
                            size={17}
                            label={t('members.editExpiry', { name: m.displayName })}
                            aria-expanded={expiryEdit?.accountId === m.accountId}
                            onClick={() => {
                              setConfirmId(null);
                              setExpiryEdit((e) => (e?.accountId === m.accountId ? null : { accountId: m.accountId, value: valueFromExpiry(m.expiresAt) }));
                            }}
                          />
                        )}
                        <IconButton
                          icon="close"
                          label={t('members.remove', { name: m.displayName })}
                          aria-expanded={confirmId === m.accountId}
                          onClick={() => {
                            setExpiryEdit(null);
                            setConfirmId((c) => (c === m.accountId ? null : m.accountId));
                          }}
                        />
                      </span>
                    )}
                  </div>

                  <AnimatePresence>
                    {confirmId === m.accountId && (
                      <motion.div
                        role="alertdialog"
                        aria-label={t('members.confirmRemove', { name: m.displayName })}
                        className="confirm"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease } }}
                        exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease } }}
                      >
                        <div className="confirm-inner">
                          <div className="confirm-text">
                            <strong>{t('members.confirmRemove', { name: m.displayName })}</strong>
                            <span className="muted small">{impact.text}</span>
                            <span className="muted small">{t('members.undoHint')}</span>
                          </div>
                          <div className="confirm-actions">
                            <Button size="sm" onClick={() => setConfirmId(null)}>
                              {t('members.cancel')}
                            </Button>
                            <Button size="sm" variant="danger" loading={removingId === m.accountId} onClick={() => remove(m)} autoFocus>
                              {t('members.confirm')}
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {expiryEdit?.accountId === m.accountId && (
                      <motion.div
                        className="confirm expiry-edit"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease } }}
                        exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease } }}
                      >
                        <div className="confirm-inner">
                          <ExpiryPicker value={expiryEdit.value} onChange={(v) => setExpiryEdit({ ...expiryEdit, value: v })} label={t('members.expiryTitle', { name: m.displayName })} />
                          <div className="confirm-actions">
                            <Button size="sm" onClick={() => setExpiryEdit(null)}>
                              {t('members.cancel')}
                            </Button>
                            <Button
                              size="sm"
                              variant="dark"
                              loading={savingExpiry}
                              disabled={expiryEdit.value.mode === 'date' && !expiryEdit.value.date}
                              onClick={() => saveExpiry(m, expiryEdit.value.mode === 'none' ? null : expiryEdit.value)}
                            >
                              {t('members.expirySave')}
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence>
        {remaining > 0 && !loading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Button variant="link" onClick={loadMore} loading={loadingMore}>
              {total <= 100 ? t('members.showAll', { count: total }) : t('members.loadMore', { count: Math.min(50, remaining) })}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reviewOpen && <ReviewDialog group={group} people={selectedPeople} impact={impact} reviewActive={reviewActive} onClose={() => setReviewOpen(false)} onDone={onReviewed} onReviewCompleted={onReviewCompleted} />}
      </AnimatePresence>
      <AnimatePresence>
        {pasteOpen && (
          <PasteDialog
            group={group}
            knownIds={knownIds}
            expiryEnabled={expiryEnabled}
            onClose={() => setPasteOpen(false)}
            onAdd={async (ids, expiresAt) => {
              await add(ids, expiresAt);
              setPasteOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
