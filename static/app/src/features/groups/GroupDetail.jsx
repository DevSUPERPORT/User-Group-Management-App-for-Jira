import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, GroupName, Skeleton } from '../../components/primitives.jsx';
import { collapse, ease } from '../../motion.js';
import { UsagePanel } from './UsagePanel.jsx';
import { MemberSection } from './MemberSection.jsx';
import { DescriptionEditor } from './DescriptionEditor.jsx';
import { ReviewStatus } from './ReviewStatus.jsx';

export function changeText(t, entry) {
  return t(`change.${entry.action}`, { name: entry.targetName ?? '' });
}

export function GroupDetail({ group, project, expiryEnabled, reviewInterval, onCountChange, onGroupUpdate, onOpenAudit }) {
  const { t, fmt } = useI18n();
  const [detail, setDetail] = useState(null);

  const refresh = useCallback(() => {
    call('getGroup', { groupId: group.groupId })
      .then(setDetail)
      .catch(() => setDetail((d) => d ?? { recentChanges: [] }));
  }, [group.groupId]);

  useEffect(() => {
    setDetail(null);
    refresh();
  }, [refresh]);

  const last = detail?.recentChanges?.[0];
  const created = group.createdAt && group.createdBy ? t('detail.created', { date: fmt.date(group.createdAt), name: group.createdBy.displayName }) : t('detail.createdUnknown');

  return (
    <motion.div className="detail-body" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.06 } } }}>
      <motion.div className="stack-8" variants={item}>
        <h2 className="h2 break">
          <GroupName prefix={group.prefix} name={group.namePart} />
        </h2>
        <DescriptionEditor
          group={group}
          onSaved={(description) => {
            onGroupUpdate(group.groupId, { description });
            refresh();
          }}
        />
        <p className="muted small">
          {created} · {t('detail.orgWide')}
        </p>
        <ReviewStatus group={group} intervalMonths={reviewInterval} onReviewed={(r) => { onGroupUpdate(group.groupId, r); refresh(); }} />
      </motion.div>

      <AnimatePresence initial={false}>
        {(group.readOnly || group.legacyKey) && (
          <motion.div className="stack-8" {...collapse}>
            {group.readOnly && (
              <div className="notice">
                <Icon name="lock" size={16} />
                <span>{t('detail.readOnly')}</span>
              </div>
            )}
            {group.legacyKey && (
              <div className="notice">
                <Icon name="key" size={16} />
                <span>{t('detail.legacy', { old: group.legacyKey, current: project.key })}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div variants={item}>
        <UsagePanel groupId={group.groupId} />
      </motion.div>

      <motion.div variants={item}>
        <MemberSection group={group} expiryEnabled={expiryEnabled} reviewActive={Boolean(reviewInterval)} onCountChange={(n) => onCountChange(group.groupId, n)} onChanged={refresh} onReviewCompleted={(r) => onGroupUpdate(group.groupId, r)} />
      </motion.div>

      <motion.div className="detail-footer" variants={item}>
        <span className="last-change">
          {detail === null ? (
            <Skeleton width={260} height={12} />
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={last?.id ?? 'none'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease }}>
                {last ? t('detail.lastChange', { date: fmt.dateTime(last.createdAt), text: changeText(t, last) }) : t('detail.noChanges')}
              </motion.span>
            </AnimatePresence>
          )}
        </span>
        <Button variant="link" onClick={() => onOpenAudit(group.groupId)}>
          {t('detail.toAudit')}
          <Icon name="arrowRight" size={16} />
        </Button>
      </motion.div>
    </motion.div>
  );
}

const item = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0, transition: { duration: 0.42, ease } } };
