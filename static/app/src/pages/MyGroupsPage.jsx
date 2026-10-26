import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../api/client.js';
import { useI18n } from '../i18n/index.jsx';
import { Footer, Header } from '../components/Shell.jsx';
import { Button, GroupName, IconButton, Pill, Skeleton } from '../components/primitives.jsx';
import { Icon } from '../components/Icon.jsx';
import { Modal } from '../components/Modal.jsx';
import { useNotify } from '../components/Toaster.jsx';
import { StateScreen } from './StateScreens.jsx';
import { ease, shake, spring } from '../motion.js';
import { errorText } from '../features/errors.js';
import { splitGroupName } from '../features/requests/RequestsPanel.jsx';

const WIDTH = 880;
const SOON = 7 * 24 * 60 * 60 * 1000;
const DURATIONS = [null, 7, 30, 90];

const cardIn = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: { duration: 0.38, ease } } };

// Project members: which groups of this project am I in? Only about the viewer –
// no member lists of other people. Members can ask for access to further groups;
// a project admin decides.
export function MyGroupsPage() {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [requesting, setRequesting] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return call('myGroups').then(setData).catch(setError);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <StateScreen error={error} onRetry={load} />;

  const requests = data?.requests ?? [];
  const pendingFor = (groupId) => requests.find((r) => r.groupId === groupId && r.status === 'pending');

  const withdraw = async (request) => {
    setBusy(request.id);
    try {
      const res = await call('withdrawRequest', { requestId: request.id });
      setData((d) => ({ ...d, requests: d.requests.map((r) => (r.id === request.id ? res.request : r)) }));
      notify({ type: 'info', title: t('my.withdrawn') });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const onRequested = (request) => {
    setRequesting(null);
    setData((d) => ({ ...d, requests: [request, ...d.requests] }));
    notify({ type: 'success', title: t('my.requested'), description: t('my.requestedHint'), action: { label: t('notify.undo'), onClick: () => withdraw(request) } });
  };

  return (
    <div className="page">
      <Header title={data ? t('my.title', { key: data.project.key }) : ' '} maxWidth={WIDTH} actions={<Pill icon="lock">{t('my.badge')}</Pill>} />
      <main className="container main stack-16" style={{ maxWidth: WIDTH }}>
        {!data ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="card my-card">
              <Skeleton width="45%" height={18} />
              <Skeleton width="70%" height={12} />
            </div>
          ))
        ) : !data.enabled ? (
          <p className="notice">
            <Icon name="info" size={16} />
            <span>{t('my.disabled')}</span>
          </p>
        ) : (
          <>
            <p className="muted">{t('my.intro')}</p>
            {data.groups.length === 0 ? (
              <div className="card empty-state">
                <Icon name="users" size={28} />
                <p className="muted">{t('my.empty')}</p>
              </div>
            ) : (
              <motion.ul className="my-list" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.05 } } }}>
                {data.groups.map((g) => (
                  <motion.li key={g.groupId} className="card my-card" variants={cardIn}>
                    <div className="row-between wrap">
                      <h2 className="h3 break">
                        <GroupName prefix={g.prefix} name={g.namePart} />
                      </h2>
                      {g.readOnly && <Pill icon="lock">{t('groups.idp')}</Pill>}
                    </div>
                    {g.description && <p>{g.description}</p>}
                    {g.expiresAt && (
                      <p className={`tag tag-expiry ${g.expiresAt - Date.now() < SOON ? 'is-soon' : ''}`}>
                        <Icon name="clock" size={12} />
                        {t('my.until', { date: fmt.date(g.expiresAt) })}
                      </p>
                    )}
                  </motion.li>
                ))}
              </motion.ul>
            )}

            {data.requestsEnabled && data.requestable.length > 0 && (
              <section className="stack-12" aria-labelledby="my-request-title">
                <div className="stack-4">
                  <h2 id="my-request-title" className="eyebrow as-h3">
                    {t('my.requestTitle')}
                  </h2>
                  <p className="muted small">{t('my.requestHint')}</p>
                </div>
                <motion.ul className="request-offers" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.04 } } }}>
                  {data.requestable.map((g) => {
                    const open = pendingFor(g.groupId);
                    return (
                      <motion.li key={g.groupId} className="offer" variants={cardIn} layout transition={spring}>
                        <span className="grow stack-4">
                          <span className="offer-name break">
                            <GroupName prefix={g.prefix} name={g.namePart} />
                          </span>
                          {g.description && <span className="muted small">{g.description}</span>}
                        </span>
                        <AnimatePresence mode="wait" initial={false}>
                          {open ? (
                            <motion.span key="pending" className="row-8" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                              <span className="status-chip status-pending">{t('requests.status.pending')}</span>
                              <Button size="sm" variant="ghost" loading={busy === open.id} onClick={() => withdraw(open)}>
                                {t('my.withdraw')}
                              </Button>
                            </motion.span>
                          ) : (
                            <motion.span key="ask" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                              <Button size="sm" icon="plus" onClick={() => setRequesting(g)}>
                                {t('my.request')}
                              </Button>
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.li>
                    );
                  })}
                </motion.ul>
              </section>
            )}

            {data.requestsEnabled && requests.some((r) => r.status !== 'pending') && (
              <section className="stack-12" aria-labelledby="my-history-title">
                <h2 id="my-history-title" className="eyebrow as-h3">
                  {t('my.historyTitle')}
                </h2>
                <ul className="request-history">
                  {requests
                    .filter((r) => r.status !== 'pending')
                    .map((r) => {
                      const g = splitGroupName(r.groupName);
                      return (
                        <li key={r.id}>
                          <span className={`status-chip status-${r.status}`}>{t(`requests.status.${r.status}`)}</span>
                          <span className="grow">
                            <GroupName prefix={g.prefix} name={g.namePart} />
                            <span className="muted small">
                              {' · '}
                              {fmt.date(r.decidedAt ?? r.createdAt)}
                              {r.note ? ` · “${r.note}”` : ''}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </section>
            )}

            <p className="muted small">{t('my.howToChange')}</p>
          </>
        )}
      </main>
      <Footer maxWidth={WIDTH} />
      <AnimatePresence>{requesting && <RequestDialog group={requesting} expiryEnabled={data.expiryEnabled} onClose={() => setRequesting(null)} onDone={onRequested} />}</AnimatePresence>
    </div>
  );
}

function RequestDialog({ group, expiryEnabled, onClose, onDone }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(expiryEnabled ? 30 : null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [nudge, setNudge] = useState(0);
  const ref = useRef(null);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setProblem(t('my.reasonRequired'));
      setNudge((n) => n + 1);
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await call('requestAccess', { groupId: group.groupId, reason, durationDays: days });
      onDone(res.request);
    } catch (err) {
      setProblem(errorText(t, err));
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="request-title" onClose={busy ? () => {} : onClose} width={560} initialFocus={ref}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow with-dot">
              <span className="dot" />
              <GroupName prefix={group.prefix} name={group.namePart} />
            </div>
            <h1 id="request-title" className="h1">
              {t('my.requestDialog')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>
        {group.description && <p className="muted">{group.description}</p>}
        <motion.div className="stack-8" key={nudge} animate={nudge ? shake : undefined}>
          <label htmlFor="request-reason" className="label-strong">
            {t('my.reason')}
          </label>
          <textarea
            id="request-reason"
            ref={ref}
            className={`input textarea ${problem && reason.trim().length < 3 ? 'is-invalid' : ''}`}
            rows={3}
            maxLength={300}
            placeholder={t('my.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
            }}
          />
          <span className="muted small tabular">{reason.length}/300</span>
        </motion.div>
        {expiryEnabled && (
          <fieldset className="stack-8 plain-fieldset">
            <legend className="label-strong">{t('my.duration')}</legend>
            <div className="seg-control" role="radiogroup">
              {DURATIONS.map((d) => (
                <button key={d ?? 'none'} type="button" role="radio" aria-checked={days === d} className={`seg-option ${days === d ? 'is-on' : ''}`} onClick={() => setDays(d)}>
                  {days === d && <motion.span layoutId="duration-pill" className="seg-pill" transition={spring} />}
                  <span>{d ? t('requests.forDays', { count: d }) : t('requests.unlimited')}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <AnimatePresence>
          {problem && (
            <motion.p className="notice notice-warn" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Icon name="alert" size={16} />
              <span>{problem}</span>
            </motion.p>
          )}
        </AnimatePresence>
        <div className="notice">
          <Icon name="info" size={16} />
          <span>{t('my.requestNotice')}</span>
        </div>
        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('review.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {t('my.send')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
