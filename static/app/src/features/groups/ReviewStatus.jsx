import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Checkbox, GroupName, IconButton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, shake } from '../../motion.js';
import { errorText } from '../errors.js';

// Periodic access review (interval set by the Jira admin): a banner while a review
// is due, and the "last reviewed" line otherwise.
export function ReviewStatus({ group, intervalMonths, onReviewed }) {
  const { t, fmt } = useI18n();
  const [open, setOpen] = useState(false);
  if (!intervalMonths || group.readOnly) return null;

  return (
    <>
      <AnimatePresence initial={false} mode="wait">
        {group.reviewDue ? (
          <motion.div key="due" className="notice notice-review" {...collapse}>
            <Icon name="calendar" size={16} />
            <span className="grow">
              <strong>{t('reviewDue.title')}</strong> {t('reviewDue.text', { count: intervalMonths })}
            </span>
            <Button size="sm" variant="dark" onClick={() => setOpen(true)}>
              {t('reviewDue.action')}
            </Button>
          </motion.div>
        ) : (
          <motion.p key="ok" className="muted small row-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Icon name="check" size={14} />
            {group.lastReviewedAt ? t('reviewDue.last', { date: fmt.date(group.lastReviewedAt), name: group.lastReviewedBy ?? '' }) : t('reviewDue.never')}
            {group.reviewDueAt ? ` · ${t('reviewDue.next', { date: fmt.date(group.reviewDueAt) })}` : ''}
          </motion.p>
        )}
      </AnimatePresence>
      <AnimatePresence>{open && <CompleteReviewDialog group={group} onClose={() => setOpen(false)} onDone={(r) => { setOpen(false); onReviewed(r); }} />}</AnimatePresence>
    </>
  );
}

function CompleteReviewDialog({ group, onClose, onDone }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState(0);

  const submit = async () => {
    if (!confirmed) {
      setNudge((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      const res = await call('completeReview', { groupId: group.groupId, note });
      notify({ type: 'success', title: t('reviewDue.done') });
      onDone(res);
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="complete-review-title" onClose={busy ? () => {} : onClose} width={560}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow with-dot">
              <span className="dot" />
              <GroupName prefix={group.prefix} name={group.namePart} />
            </div>
            <h1 id="complete-review-title" className="h1">
              {t('reviewDue.dialogTitle')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} disabled={busy} />
        </div>
        <ol className="steps">
          <li>{t('reviewDue.step1', { count: group.memberCount ?? 0 })}</li>
          <li>{t('reviewDue.step2')}</li>
          <li>{t('reviewDue.step3')}</li>
        </ol>
        <div className="stack-8">
          <label htmlFor="complete-review-note" className="label-strong">
            {t('review.note')} <span className="muted normal">{t('create.optional')}</span>
          </label>
          <input id="complete-review-note" className="input" maxLength={300} placeholder={t('review.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <motion.div key={nudge} animate={nudge ? shake : undefined}>
          <Checkbox id="complete-review-confirm" checked={confirmed} onChange={setConfirmed}>
            {t('reviewDue.confirm', { count: group.memberCount ?? 0 })}
          </Checkbox>
        </motion.div>
        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            {t('review.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} aria-disabled={!confirmed || undefined} className={confirmed ? '' : 'is-soft-disabled'}>
            {t('reviewDue.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
