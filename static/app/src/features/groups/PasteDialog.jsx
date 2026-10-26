import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, GroupName, IconButton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ease } from '../../motion.js';
import { errorText } from '../errors.js';
import { ExpiryPicker, NO_EXPIRY, expiryFromValue } from './ExpiryPicker.jsx';

const MAX = 50;
const split = (text) => [...new Set(text.split(/[\n,;\t]+/).map((s) => s.trim()).filter(Boolean))];

const STATUS_ICON = { matched: 'check', ambiguous: 'info', notFound: 'close', duplicate: 'close', member: 'users' };

// Bulk add (UC-03 "several people at once"): paste emails or names, review how each
// line resolved, pick between ambiguous matches, then add. Nothing is added before
// the review step.
export function PasteDialog({ group, knownIds, expiryEnabled, onClose, onAdd }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [choice, setChoice] = useState({}); // input -> accountId for ambiguous rows
  const [expiry, setExpiry] = useState(NO_EXPIRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const textRef = useRef(null);
  const entries = split(text);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('resolveUsers', { entries });
      setRows(res.rows.map((r) => (r.user && knownIds.has(r.user.accountId) ? { ...r, status: 'member' } : r)));
      setChoice({});
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const picked = useMemo(() => {
    if (!rows) return [];
    const ids = new Set();
    for (const r of rows) {
      if (r.status === 'matched') ids.add(r.user.accountId);
      if (r.status === 'ambiguous' && choice[r.input] && !knownIds.has(choice[r.input])) ids.add(choice[r.input]);
    }
    return [...ids];
  }, [rows, choice, knownIds]);

  const submit = async () => {
    setBusy(true);
    try {
      await onAdd(picked, expiryFromValue(expiry));
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="paste-title" onClose={busy ? () => {} : onClose} width={680} initialFocus={textRef}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow with-dot">
              <span className="dot" />
              <GroupName prefix={group.prefix} name={group.namePart} />
            </div>
            <h1 id="paste-title" className="h1">
              {t('paste.title')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {!rows ? (
            <motion.div key="input" className="stack-8" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22, ease }}>
              <label htmlFor="paste-text" className="label-strong">
                {t('paste.label')}
              </label>
              <textarea
                ref={textRef}
                id="paste-text"
                className="input textarea paste-text"
                rows={7}
                placeholder={t('paste.placeholder')}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <span className={`small ${entries.length > MAX ? 'status-tone-bad' : 'muted'}`}>
                {t('paste.count', { count: entries.length, max: MAX })} · {t('paste.hint')}
              </span>
              {error && (
                <p className="notice notice-error" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{error}</span>
                </p>
              )}
            </motion.div>
          ) : (
            <motion.div key="review" className="stack-12" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.22, ease }}>
              <ul className="resolve-list">
                {rows.map((r, i) => (
                  <motion.li key={r.input} className={`resolve-row is-${r.status}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.025 } }}>
                    <span className="resolve-icon" aria-hidden="true">
                      <Icon name={STATUS_ICON[r.status]} size={13} strokeWidth={2.6} />
                    </span>
                    <span className="resolve-input" title={r.input}>
                      {r.input}
                    </span>
                    <span className="resolve-result">
                      {r.user && r.status !== 'ambiguous' ? (
                        <span className="row-8">
                          <Avatar name={r.user.displayName} url={r.user.avatarUrl} size={24} />
                          {r.user.displayName}
                        </span>
                      ) : r.status === 'ambiguous' ? (
                        <select className="input input-sm" aria-label={t('paste.choose')} value={choice[r.input] ?? ''} onChange={(e) => setChoice({ ...choice, [r.input]: e.target.value })}>
                          <option value="">{t('paste.choose')}</option>
                          {r.candidates.map((c) => (
                            <option key={c.accountId} value={c.accountId} disabled={knownIds.has(c.accountId)}>
                              {c.displayName}
                              {c.email ? ` (${c.email})` : ''}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <span className="muted small">{t(`paste.status.${r.status}`)}</span>
                    </span>
                  </motion.li>
                ))}
              </ul>
              {expiryEnabled && <ExpiryPicker value={expiry} onChange={setExpiry} />}
              <p className="muted small">{t('paste.summary', { ok: picked.length, total: rows.length })}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="actions">
          {rows ? (
            <>
              <Button onClick={() => setRows(null)} disabled={busy}>
                {t('paste.back')}
              </Button>
              <Button variant="primary" loading={busy} disabled={!picked.length || (expiry.mode === 'date' && !expiry.date)} onClick={submit}>
                {t('paste.submit', { count: picked.length })}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t('review.cancel')}</Button>
              <Button variant="dark" loading={busy} disabled={!entries.length || entries.length > MAX} onClick={check}>
                {t('paste.check')}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
