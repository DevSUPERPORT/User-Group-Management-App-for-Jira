import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, GroupName, Pill, Skeleton } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, ease, spring } from '../../motion.js';
import { errorText } from '../errors.js';

export function splitGroupName(name) {
  const m = /^(atlassian-[^-]+-)(.+)$/.exec(name ?? '');
  return m ? { prefix: m[1], namePart: m[2] } : { prefix: '', namePart: name ?? '' };
}

// Access requests of project members (from "My groups"). A project admin approves
// (the person is added, with the requested end date) or denies, each with an
// optional note; every decision can be undone.
export function RequestsPanel({ onPendingChange, onMembershipChange }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [deciding, setDeciding] = useState(null); // { id, decision }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return call('listRequests', { status: 'all' })
      .then((res) => setRequests(res.requests))
      .catch(setError);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const pending = (requests ?? []).filter((r) => r.status === 'pending');
  const decided = (requests ?? []).filter((r) => r.status !== 'pending');

  useEffect(() => {
    if (requests) onPendingChange?.(pending.length);
  }, [requests]); // eslint-disable-line react-hooks/exhaustive-deps

  const replace = (next) => setRequests((rs) => rs.map((r) => (r.id === next.id ? next : r)));

  const reopen = async (request) => {
    setBusy(request.id);
    try {
      const res = await call('reopenRequest', { requestId: request.id });
      replace(res.request);
      if (request.status === 'approved') onMembershipChange?.(request.groupId, -1);
      notify({ type: 'info', title: t('requests.reopened', { name: request.displayName }) });
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const decide = async (request, decision) => {
    setBusy(request.id);
    try {
      const res = await call('decideRequest', { requestId: request.id, decision, note });
      replace(res.request);
      setDeciding(null);
      setNote('');
      if (decision === 'approve') onMembershipChange?.(request.groupId, 1);
      notify({
        type: 'success',
        title: t(decision === 'approve' ? 'requests.approved' : 'requests.denied', { name: request.displayName }),
        description: decision === 'approve' && res.member?.expiresAt ? t('members.until', { date: fmt.date(res.member.expiresAt) }) : undefined,
        action: { label: t('notify.undo'), onClick: () => reopen(res.request) },
      });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      load();
    } finally {
      setBusy(null);
    }
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
    <div className="requests stack-20">
      <section className="card section" aria-labelledby="req-pending">
        <div className="row-between wrap">
          <div className="stack-4">
            <h2 id="req-pending" className="h3">
              {t('requests.pendingTitle')}
              {requests && pending.length > 0 && <span className="count-badge">{pending.length}</span>}
            </h2>
            <p className="muted small">{t('requests.pendingHint')}</p>
          </div>
        </div>

        {!requests ? (
          <div className="stack-12">
            {[0, 1].map((i) => (
              <div key={i} className="request-card">
                <Skeleton width={36} height={36} radius={18} />
                <div className="stack-6 grow">
                  <Skeleton width="40%" height={14} />
                  <Skeleton width="70%" height={12} />
                </div>
              </div>
            ))}
          </div>
        ) : pending.length === 0 ? (
          <motion.div className="empty-inline" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
            <Icon name="checks" size={20} />
            <span>{t('requests.none')}</span>
          </motion.div>
        ) : (
          <ul className="request-list">
            <AnimatePresence initial={false} mode="popLayout">
              {pending.map((r) => {
                const g = splitGroupName(r.groupName);
                const open = deciding?.id === r.id;
                return (
                  <motion.li
                    key={r.id}
                    layout
                    className={`request-card ${open ? 'is-open' : ''}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                    transition={spring}
                  >
                    <Avatar name={r.displayName} size={36} />
                    <div className="request-main">
                      <div className="request-head">
                        <strong>{r.displayName}</strong>
                        <span className="muted">{t('requests.wants')}</span>
                        <span className="request-group">
                          <GroupName prefix={g.prefix} name={g.namePart} />
                        </span>
                      </div>
                      <p className="request-reason">“{r.reason}”</p>
                      <div className="request-meta">
                        <Pill icon="clock">{r.durationDays ? t('requests.forDays', { count: r.durationDays }) : t('requests.unlimited')}</Pill>
                        <span className="muted small">{fmt.relative(r.createdAt)}</span>
                      </div>
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.div {...collapse}>
                            <div className="request-decide">
                              <label className="label-strong" htmlFor={`note-${r.id}`}>
                                {t(deciding.decision === 'approve' ? 'requests.approveNote' : 'requests.denyNote')} <span className="muted normal">{t('create.optional')}</span>
                              </label>
                              <input
                                id={`note-${r.id}`}
                                className="input"
                                maxLength={300}
                                autoFocus
                                value={note}
                                placeholder={t('requests.notePlaceholder')}
                                onChange={(e) => setNote(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') decide(r, deciding.decision);
                                  if (e.key === 'Escape') setDeciding(null);
                                }}
                              />
                              <div className="row-8 end">
                                <Button size="sm" onClick={() => setDeciding(null)} disabled={busy === r.id}>
                                  {t('members.cancel')}
                                </Button>
                                <Button size="sm" variant={deciding.decision === 'approve' ? 'dark' : 'danger'} loading={busy === r.id} onClick={() => decide(r, deciding.decision)}>
                                  {t(deciding.decision === 'approve' ? 'requests.confirmApprove' : 'requests.confirmDeny')}
                                </Button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    {!open && (
                      <div className="request-actions">
                        <Button size="sm" onClick={() => { setNote(''); setDeciding({ id: r.id, decision: 'deny' }); }}>
                          {t('requests.deny')}
                        </Button>
                        <Button size="sm" variant="primary" icon="check" onClick={() => { setNote(''); setDeciding({ id: r.id, decision: 'approve' }); }}>
                          {t('requests.approve')}
                        </Button>
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
        <section className="card section" aria-labelledby="req-decided">
          <div className="stack-4">
            <h2 id="req-decided" className="h3">
              {t('requests.decidedTitle')}
            </h2>
            <p className="muted small">{t('requests.decidedHint')}</p>
          </div>
          <ul className="request-history">
            <AnimatePresence initial={false}>
              {decided.map((r) => {
                const g = splitGroupName(r.groupName);
                return (
                  <motion.li key={r.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring}>
                    <span className={`status-chip status-${r.status}`}>{t(`requests.status.${r.status}`)}</span>
                    <span className="grow">
                      <strong>{r.displayName}</strong> <span className="muted">→</span>{' '}
                      <span className="request-group">
                        <GroupName prefix={g.prefix} name={g.namePart} />
                      </span>
                      <span className="muted small">
                        {' · '}
                        {r.decidedBy ? t('requests.decidedBy', { name: r.decidedBy, date: fmt.date(r.decidedAt) }) : fmt.date(r.decidedAt ?? r.createdAt)}
                        {r.note ? ` · “${r.note}”` : ''}
                      </span>
                    </span>
                    {(r.status === 'approved' || r.status === 'denied') && (
                      <Button size="sm" variant="ghost" icon="undo" loading={busy === r.id} onClick={() => reopen(r)}>
                        {t('requests.reopen')}
                      </Button>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </section>
      )}
    </div>
  );
}
