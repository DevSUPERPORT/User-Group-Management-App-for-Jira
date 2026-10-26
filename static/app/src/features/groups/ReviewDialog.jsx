import { useState } from 'react';
import { motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, Checkbox, GroupName, IconButton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease, shake } from '../../motion.js';
import { errorText } from '../errors.js';

// Access review: removing several people goes through this explicit review step
// (who, what they lose, a note for the audit log, a confirmation tick).
export function ReviewDialog({ group, people, impact, reviewActive = false, onClose, onDone, onReviewCompleted }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState(0);
  // With periodic reviews switched on, a removal review can also count as the group's review.
  const [completeToo, setCompleteToo] = useState(Boolean(group.reviewDue));

  const submit = async () => {
    if (!confirmed) {
      setNudge((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      const res = await call('removeMembers', { groupId: group.groupId, accountIds: people.map((p) => p.accountId), note, reason: 'review' });
      if (reviewActive && completeToo) {
        const removed = res.results.filter((r) => r.status === 'removed').length;
        await call('completeReview', { groupId: group.groupId, note, removed })
          .then((r) => onReviewCompleted?.(r))
          .catch((err) => notify({ type: 'error', title: errorText(t, err) }));
      }
      onDone(res);
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="review-title" onClose={busy ? () => {} : onClose} width={640}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow with-dot">
              <span className="dot" />
              <GroupName prefix={group.prefix} name={group.namePart} />
            </div>
            <h1 id="review-title" className="h1">
              {t('review.title', { count: people.length })}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>

        <ul className="review-list">
          {people.map((p, i) => (
            <motion.li key={p.accountId} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.03, duration: 0.25, ease } }}>
              <Avatar name={p.displayName} url={p.avatarUrl} size={30} dim={!p.active} />
              <span className="member-text">
                <span>{p.displayName}</span>
                <span className="muted small">
                  {p.addedAt ? t('members.addedBy', { date: fmt.date(p.addedAt), name: p.addedBy }) : t('members.addedOutside')}
                  {p.expiresAt ? ` · ${t('members.until', { date: fmt.date(p.expiresAt) })}` : ''}
                </span>
              </span>
            </motion.li>
          ))}
        </ul>

        <div className="stack-8">
          <div className="eyebrow">{t('review.impactTitle')}</div>
          {impact.items.length ? (
            <ul className="impact-list">
              {impact.items.map((item) => (
                <li key={`${item.kind}-${item.label}-${item.detail}`}>
                  <Icon name={item.icon ?? 'arrowRight'} size={15} />
                  <span>
                    <strong>{item.label}</strong> <span className="muted">({t(`impact.kind.${item.kind}`)})</span>
                    {item.detail && <span className="muted small"> · {item.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{impact.text}</p>
          )}
          {impact.items.length > 0 && impact.partial && <p className="muted small">{t('impact.partial')}</p>}
        </div>

        <div className="stack-8">
          <label htmlFor="review-note" className="label-strong">
            {t('review.note')} <span className="muted normal">{t('create.optional')}</span>
          </label>
          <input id="review-note" className="input" maxLength={300} placeholder={t('review.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="stack-8">
          <motion.div key={nudge} animate={nudge ? shake : undefined}>
            <Checkbox id="review-confirm" checked={confirmed} onChange={setConfirmed}>
              {t('review.confirm')}
            </Checkbox>
          </motion.div>
          {reviewActive && (
            <Checkbox id="review-complete" checked={completeToo} onChange={setCompleteToo}>
              {t('review.completeToo')}
            </Checkbox>
          )}
        </div>

        <div className="notice">
          <Icon name="undo" size={16} />
          <span>{t('review.undoHint')}</span>
        </div>

        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('review.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={submit} aria-disabled={!confirmed || undefined} className={confirmed ? '' : 'is-soft-disabled'}>
            {t('review.submit', { count: people.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
