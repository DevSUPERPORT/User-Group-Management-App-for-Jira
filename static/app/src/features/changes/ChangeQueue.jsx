/**
 * Jira-admin mode: the changes that wait for a Jira administrator.
 *
 * For Jira admins ("Changes to apply", on the admin page for all projects and on a project page for that project):
 * what, which group (and project), who asked, when and why; Apply (runs as the signed-in Jira admin and checks every
 * rule again), Reject with a note, and both for several at once. Every result is reported per change.
 * For project admins ("Waiting for Jira admin"): the same list read-only, with Withdraw for their own changes.
 *
 * @file        static/app/src/features/changes/ChangeQueue.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, GroupName, Pill, Skeleton } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, ease, spring } from '../../motion.js';
import { errorText } from '../errors.js';
import { splitGroupName } from '../requests/RequestsPanel.jsx';


// One line describing the change ("Add Lena Koch" + group), shared with the member view.
export function ChangeWhat({ change, showProject = false }) {
  const { t } = useI18n();
  const g = splitGroupName(change.groupName);
  return (
    <span className="change-what">
      <strong>{change.type === 'create' ? t('changes.type.create') : t(`changes.type.${change.type}`, { name: change.displayName ?? change.accountId })}</strong>
      {change.type !== 'create' && <span className="muted">{t(change.type === 'add' ? 'changes.toGroup' : 'changes.fromGroup')}</span>}
      <span className="request-group">
        <GroupName prefix={g.prefix} name={g.namePart} />
      </span>
      {showProject && change.projectKey && <Pill>{change.projectKey}</Pill>}
    </span>
  );
}

// Why and for how long: the reason, the end date or duration, the first members of a new group.
export function ChangeFacts({ change }) {
  const { t, fmt } = useI18n();
  const facts = [];
  if (change.reason === 'expiry' && change.endedAt) facts.push(<Pill key="r" icon="clock" tone="warn">{t('changes.reason.expiry', { date: fmt.date(change.endedAt) })}</Pill>);
  else if (change.reason && t(`changes.reason.${change.reason}`) !== `changes.reason.${change.reason}`) facts.push(<Pill key="r">{t(`changes.reason.${change.reason}`)}</Pill>);
  if (change.type === 'add' && change.expiresAt) facts.push(<Pill key="u" icon="clock">{t('members.until', { date: fmt.date(change.expiresAt) })}</Pill>);
  if (change.type === 'add' && change.durationDays) facts.push(<Pill key="d" icon="clock">{t('changes.forDays', { count: change.durationDays })}</Pill>);
  if (change.type === 'create') {
    facts.push(<Pill key="m" icon="users">{t('changes.firstMembers', { count: change.create?.members?.length ?? 0 })}</Pill>);
    if (change.create?.copyFrom?.name) facts.push(<Pill key="c" icon="copy">{t('changes.copyFrom', { name: change.create.copyFrom.name })}</Pill>);
  }
  if (change.via === 'rovo') facts.push(<span key="v" className="tag tag-rovo">{t('changes.viaRovo')}</span>);
  return facts.length ? <span className="change-facts">{facts}</span> : null;
}

export function ChangeQueue({ scope = 'project', onCountChange, onApplied }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null); // ref, 'bulk-apply', 'bulk-reject'
  const [rejecting, setRejecting] = useState(null); // { refs: [...] }
  const [note, setNote] = useState('');
  const [lastResults, setLastResults] = useState({}); // ref -> failed result

  const load = useCallback(() => {
    setError(null);
    return call('listChanges', { status: 'all' })
      .then((res) => {
        setData(res);
        onCountChange?.(res.pendingCount);
      })
      .catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load]);

  const pending = (data?.changes ?? []).filter((c) => c.status === 'pending');
  const decided = (data?.changes ?? []).filter((c) => c.status !== 'pending').slice(0, 30);
  const canApply = Boolean(data?.canApply);
  const showProject = scope === 'admin';
  const allSelected = pending.length > 0 && pending.every((c) => selected.has(c.ref));

  const report = (res, verb) => {
    const ok = res.results.filter((r) => r.status === verb);
    const already = ok.filter((r) => r.alreadyDone).length;
    const failed = res.results.filter((r) => r.status === 'failed');
    setLastResults(Object.fromEntries(failed.map((r) => [r.ref, r])));
    if (ok.length) {
      notify({
        type: 'success',
        title: t(verb === 'applied' ? 'changes.applied' : 'changes.rejectedN', { count: ok.length }),
        description: already ? t('changes.alreadyDone', { count: already }) : undefined,
      });
    }
    for (const r of ok) {
      const problems = r.change?.result?.failed ?? [];
      if (problems.length) notify({ type: 'error', title: t('changes.partial', { names: problems.map((f) => f.displayName ?? f.accountId).join(', ') }) });
    }
    if (failed.length) {
      notify({ type: 'error', title: t('changes.failedN', { count: failed.length }), description: failed.length === 1 ? errorText(t, { code: failed[0].code, message: failed[0].error, details: failed[0].details ?? { reason: failed[0].reason } }) : undefined });
    }
    if (res.notJiraAdmin) notify({ type: 'error', title: t('changes.notJiraAdmin') });
    setSelected((s) => new Set([...s].filter((ref) => failed.some((f) => f.ref === ref))));
    onCountChange?.(res.pendingCount);
    // Applied and rejected changes both change what the pages around the queue show (members, end dates).
    if (ok.length) onApplied?.();
  };

  const apply = async (refs, key) => {
    setBusy(key);
    try {
      const res = await call('applyChanges', { refs });
      report(res, 'applied');
      await load();
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    const { refs } = rejecting;
    setBusy(refs.length > 1 ? 'bulk-reject' : refs[0]);
    try {
      const res = await call('rejectChanges', { refs, note });
      report(res, 'rejected');
      setRejecting(null);
      setNote('');
      await load();
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (change) => {
    setBusy(change.ref);
    try {
      const res = await call('withdrawChanges', { refs: [change.ref] });
      const done = res.results.filter((r) => r.status === 'withdrawn').length;
      if (done) notify({ type: 'info', title: t('changes.withdrawnN', { count: done }) });
      else notify({ type: 'error', title: errorText(t, { details: { reason: res.results[0]?.reason } }) });
      onCountChange?.(res.pendingCount);
      await load();
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (ref) => setSelected((s) => (s.has(ref) ? new Set([...s].filter((x) => x !== ref)) : new Set([...s, ref])));

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

  const who = (c) =>
    c.requestedBy?.accountId ? t('changes.requestedBy', { name: c.requestedBy.displayName, when: fmt.relative(c.requestedAt) }) : t('changes.bySystem', { when: fmt.relative(c.requestedAt) });

  return (
    <div className="stack-20 change-queue">
      <section className="card section" aria-labelledby="changes-title">
        <div className="row-between wrap">
          <div className="stack-4">
            <h2 id="changes-title" className="h3">
              {canApply ? t('changes.title') : t('changes.waitingTitle')}
              {data && pending.length > 0 && <span className="count-badge">{pending.length}</span>}
            </h2>
            <p className="muted small">{canApply ? t('changes.hint') : t('changes.waitingHint')}</p>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {canApply && pending.length > 0 && (
            <motion.div className="review-bar" {...collapse}>
              <label className="check">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(pending.map((c) => c.ref)))} aria-label={t('changes.selectAll')} />
                <span className="check-box" aria-hidden="true">
                  {allSelected && <Icon name="check" size={14} strokeWidth={3.2} />}
                </span>
                <span>{selected.size ? t('changes.selected', { count: selected.size }) : t('changes.selectAll')}</span>
              </label>
              <div className="row-8">
                <Button size="sm" disabled={!selected.size || Boolean(busy)} loading={busy === 'bulk-reject'} onClick={() => setRejecting({ refs: [...selected] })}>
                  {t('changes.rejectSelected', { count: selected.size })}
                </Button>
                <Button size="sm" variant="primary" icon="check" disabled={!selected.size || Boolean(busy)} loading={busy === 'bulk-apply'} onClick={() => apply([...selected], 'bulk-apply')}>
                  {t('changes.applySelected', { count: selected.size })}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {rejecting && rejecting.refs.length > 1 && (
            <motion.div {...collapse}>
              <div className="request-decide">
                <label className="label-strong" htmlFor="reject-note-bulk">
                  {t('changes.rejectNote')} <span className="muted normal">{t('create.optional')}</span>
                </label>
                <input id="reject-note-bulk" className="input" maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reject()} />
                <div className="row-8 end">
                  <Button size="sm" onClick={() => setRejecting(null)}>
                    {t('members.cancel')}
                  </Button>
                  <Button size="sm" variant="danger" loading={busy === 'bulk-reject'} onClick={reject}>
                    {t('changes.rejectSelected', { count: rejecting.refs.length })}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!data ? (
          <div className="stack-12">
            {[0, 1].map((i) => (
              <div key={i} className="request-card">
                <Skeleton width={36} height={36} radius={18} />
                <div className="stack-6 grow">
                  <Skeleton width="45%" height={14} />
                  <Skeleton width="70%" height={12} />
                </div>
              </div>
            ))}
          </div>
        ) : pending.length === 0 ? (
          <motion.div className="empty-inline" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
            <Icon name="checks" size={20} />
            <span>{t('changes.none')}</span>
          </motion.div>
        ) : (
          <ul className="request-list">
            <AnimatePresence initial={false} mode="popLayout">
              {pending.map((c) => {
                const mine = c.requestedBy?.accountId && c.requestedBy.accountId === data.me;
                const failed = lastResults[c.ref] ?? (c.lastError ? { code: c.lastError.code, message: c.lastError.message, details: { reason: c.lastError.reason } } : null);
                const open = rejecting?.refs.length === 1 && rejecting.refs[0] === c.ref;
                return (
                  <motion.li key={c.ref} layout className={`request-card change-card ${selected.has(c.ref) ? 'is-selected' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }} transition={spring}>
                    {canApply && (
                      <label className="check change-check">
                        <input type="checkbox" checked={selected.has(c.ref)} onChange={() => toggle(c.ref)} aria-label={t('changes.select', { name: c.displayName ?? c.groupName })} />
                        <span className="check-box" aria-hidden="true">
                          {selected.has(c.ref) && <Icon name="check" size={14} strokeWidth={3.2} />}
                        </span>
                      </label>
                    )}
                    <span className={`change-icon is-${c.type}`} aria-hidden="true">
                      <Icon name={c.type === 'create' ? 'plus' : c.type === 'add' ? 'users' : 'close'} size={16} />
                    </span>
                    <div className="request-main">
                      <div className="request-head">
                        <ChangeWhat change={c} showProject={showProject} />
                      </div>
                      {c.note && <p className="request-reason">“{c.note}”</p>}
                      <div className="request-meta">
                        <ChangeFacts change={c} />
                        <span className="muted small">
                          {who(c)}
                          {mine ? ` · ${t('changes.mine')}` : ''}
                        </span>
                      </div>
                      {failed && (
                        <p className="notice notice-error small">
                          <Icon name="alert" size={16} />
                          <span>{t('changes.lastError', { message: errorText(t, { code: failed.code, message: failed.error ?? failed.message, details: failed.details ?? null }) })}</span>
                        </p>
                      )}
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.div {...collapse}>
                            <div className="request-decide">
                              <label className="label-strong" htmlFor={`reject-${c.ref}`}>
                                {t('changes.rejectNote')} <span className="muted normal">{t('create.optional')}</span>
                              </label>
                              <input id={`reject-${c.ref}`} className="input" maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') reject(); if (e.key === 'Escape') setRejecting(null); }} />
                              <div className="row-8 end">
                                <Button size="sm" onClick={() => setRejecting(null)} disabled={busy === c.ref}>
                                  {t('members.cancel')}
                                </Button>
                                <Button size="sm" variant="danger" loading={busy === c.ref} onClick={reject}>
                                  {t('changes.rejectConfirm')}
                                </Button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    {!open && (
                      <div className="request-actions">
                        {canApply ? (
                          <>
                            <Button size="sm" disabled={Boolean(busy)} onClick={() => { setNote(''); setRejecting({ refs: [c.ref] }); }}>
                              {t('changes.reject')}
                            </Button>
                            <Button size="sm" variant="primary" icon="check" disabled={Boolean(busy) && busy !== c.ref} loading={busy === c.ref} onClick={() => apply([c.ref], c.ref)}>
                              {t('changes.apply')}
                            </Button>
                          </>
                        ) : mine ? (
                          <Button size="sm" variant="ghost" icon="undo" loading={busy === c.ref} onClick={() => withdraw(c)}>
                            {t('changes.withdraw')}
                          </Button>
                        ) : (
                          <span className="status-chip status-pending">{t('pending.badge')}</span>
                        )}
                      </div>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section className="card section" aria-labelledby="changes-decided">
          <h2 id="changes-decided" className="h3">
            {t('changes.history')}
          </h2>
          <ul className="request-history">
            {decided.map((c) => (
              <li key={c.ref}>
                <span className={`status-chip status-${c.status === 'applied' ? 'approved' : c.status === 'rejected' ? 'denied' : 'withdrawn'}`}>{t(`changes.status.${c.status}`)}</span>
                <span className="grow">
                  <ChangeWhat change={c} showProject={showProject} />
                  <span className="muted small">
                    {' · '}
                    {t('changes.decidedBy', { name: c.decidedBy?.displayName ?? '–', date: fmt.date(c.decidedAt ?? c.requestedAt) })}
                    {c.outcome === 'alreadyDone' ? ` · ${t('changes.alreadyNote')}` : ''}
                    {c.decisionNote ? ` · “${c.decisionNote}”` : ''}
                  </span>
                </span>
                <Avatar name={c.requestedBy?.displayName ?? 'system'} size={24} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
