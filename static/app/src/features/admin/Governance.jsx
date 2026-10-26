import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, Checkbox, CountUp, IconButton, Skeleton } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, ease, listChild, listParent, spring } from '../../motion.js';
import { errorText } from '../errors.js';
import { splitGroupName } from '../requests/RequestsPanel.jsx';

const INTERVALS = [null, 3, 6, 12];

// Compliance at a glance for Jira admins: due reviews, ending memberships, open
// requests and the state of the Confluence page index.
export function ComplianceCards({ compliance, confluence }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [index, setIndex] = useState(compliance.confluenceIndex);
  const [rebuilding, setRebuilding] = useState(false);
  const [open, setOpen] = useState(null);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await call('rebuildConfluenceIndex');
      setIndex((i) => ({ ...i, scanned: 0 }));
      notify({ type: 'success', title: t('compliance.rebuildStarted') });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setRebuilding(false);
    }
  };

  const cards = [
    { key: 'reviews', icon: 'calendar', count: compliance.reviewsDue.length, tone: compliance.reviewsDue.length ? 'warn' : 'ok', items: compliance.reviewsDue.map((r) => ({ id: r.groupId, name: r.groupName, meta: r.projectKey })) },
    { key: 'expiring', icon: 'clock', count: compliance.expiringSoon.length, tone: 'neutral', items: compliance.expiringSoon.map((e) => ({ id: `${e.groupId}-${e.accountId}`, name: e.projectKey ?? '', meta: fmt.date(e.expiresAt) })) },
    { key: 'requests', icon: 'users', count: compliance.pendingRequests, tone: compliance.pendingRequests ? 'warn' : 'ok', items: [] },
  ];
  const openCard = cards.find((c) => c.key === open && c.items.length);

  return (
    <motion.section className="card section" aria-labelledby="sec-compliance" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease } }}>
      <div className="stack-4">
        <h2 id="sec-compliance" className="h3">
          {t('compliance.title')}
        </h2>
        <p className="muted small">{t('compliance.hint')}</p>
      </div>
      <motion.div className="compliance-grid" variants={listParent(0.05, 0.1)} initial="initial" animate="animate">
        {cards.map((c) => (
          <motion.button
            key={c.key}
            type="button"
            variants={listChild}
            className={`compliance-card tone-${c.tone} ${open === c.key ? 'is-open' : ''}`}
            onClick={() => setOpen((o) => (o === c.key ? null : c.key))}
            disabled={!c.items.length}
            aria-expanded={c.items.length ? open === c.key : undefined}
            whileHover={c.items.length ? { y: -2 } : undefined}
          >
            <span className="compliance-icon">
              <Icon name={c.icon} size={16} />
            </span>
            <span className="usage-count">
              <CountUp value={c.count} />
            </span>
            <span className="small">{t(`compliance.${c.key}`, { count: c.count })}</span>
          </motion.button>
        ))}
        <motion.div variants={listChild} className={`compliance-card tone-${confluence.available ? (index.lastFullScanAt ? 'ok' : 'neutral') : 'muted'}`}>
          <span className="compliance-icon">
            <Icon name="clipboard" size={16} />
          </span>
          <span className="small strong">{t('compliance.index')}</span>
          <span className="muted small">
            {!confluence.available
              ? t('compliance.indexOff')
              : index.lastFullScanAt
                ? t('compliance.indexDone', { date: fmt.dateTime(index.lastFullScanAt), count: index.pagesInLastScan ?? 0 })
                : t('compliance.indexBuilding', { count: index.scanned ?? 0 })}
          </span>
          {confluence.available && (
            <Button size="sm" variant="ghost" icon="refresh" loading={rebuilding} onClick={rebuild}>
              {t('compliance.rebuild')}
            </Button>
          )}
        </motion.div>
      </motion.div>
      <AnimatePresence initial={false}>
        {openCard && (
          <motion.div key={openCard.key} {...collapse}>
            <ul className="detail-list compliance-list">
              {openCard.items.slice(0, 50).map((i) => {
                const g = splitGroupName(i.name);
                return (
                  <li key={i.id} className="row-between">
                    <strong className="break">{g.prefix ? <><span className="gn-prefix">{g.prefix}</span>{g.namePart}</> : i.name}</strong>
                    <span className="muted small">{i.meta}</span>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// Settings for the governance features; saved together with the rest of the
// configuration (and undoable like every configuration change).
export function AutomationSettings({ draft, update }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);

  return (
    <div className="stack-16">
      <Checkbox id="requests-on" checked={draft.requestsEnabled !== false} onChange={(v) => update({ requestsEnabled: v })}>
        {t('config.requests')}
      </Checkbox>

      <div className="subsection">
        <div className="stack-4">
          <h3 className="label-strong">{t('config.reviewInterval')}</h3>
          <p className="muted small">{t('config.reviewIntervalHint')}</p>
        </div>
        <div className="seg-control" role="radiogroup" aria-label={t('config.reviewInterval')}>
          {INTERVALS.map((m) => {
            const on = (draft.reviewIntervalMonths ?? null) === m;
            return (
              <button key={m ?? 'off'} type="button" role="radio" aria-checked={on} className={`seg-option ${on ? 'is-on' : ''}`} onClick={() => update({ reviewIntervalMonths: m })}>
                {on && <motion.span layoutId="interval-pill" className="seg-pill" transition={spring} />}
                <span>{m ? t('config.everyMonths', { count: m }) : t('config.off')}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="subsection">
        <div className="row-between wrap">
          <Checkbox
            id="auto-deactivated"
            checked={draft.autoRemoveDeactivated === true}
            onChange={(v) => (v ? setPreview(true) : update({ autoRemoveDeactivated: false }))}
          >
            {t('config.autoDeactivated')}
          </Checkbox>
          <Button size="sm" variant="link" onClick={() => setPreview(true)}>
            {t('config.autoPreview')}
            <Icon name="arrowRight" size={15} />
          </Button>
        </div>
        <p className="muted small">{t('config.autoDeactivatedHint')}</p>
      </div>

      <AnimatePresence>
        {preview && (
          <DeactivatedPreview
            enabled={draft.autoRemoveDeactivated === true}
            onClose={() => setPreview(false)}
            onEnable={() => {
              update({ autoRemoveDeactivated: true });
              setPreview(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// Read-only dry run: who the daily automation would remove right now.
function DeactivatedPreview({ enabled, onClose, onEnable }) {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    call('previewDeactivatedCleanup')
      .then((r) => setItems(r.items))
      .catch(setError);
  }, []);

  return (
    <Modal labelledBy="auto-preview-title" onClose={onClose} width={600}>
      <div className="dialog-body">
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow">{t('config.autoPreviewEyebrow')}</div>
            <h1 id="auto-preview-title" className="h1">
              {t('config.autoPreviewTitle')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} />
        </div>
        {error ? (
          <p className="notice notice-warn">
            <Icon name="alert" size={16} />
            <span>{errorText(t, error)}</span>
          </p>
        ) : !items ? (
          <div className="stack-8">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={36} radius={10} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="empty-inline">
            <Icon name="checks" size={20} />
            <span>{t('config.autoNone')}</span>
          </div>
        ) : (
          <>
            <p className="muted small">{t('config.autoWould', { count: items.length })}</p>
            <motion.ul className="review-list" variants={listParent(0.03)} initial="initial" animate="animate">
              {items.slice(0, 100).map((i) => {
                const g = splitGroupName(i.groupName);
                return (
                  <motion.li key={`${i.groupId}-${i.accountId}`} variants={listChild}>
                    <Avatar name={i.displayName} size={28} dim />
                    <span className="member-text">
                      <span>{i.displayName}</span>
                      <span className="muted small">
                        <span className="gn-prefix">{g.prefix}</span>
                        {g.namePart}
                      </span>
                    </span>
                  </motion.li>
                );
              })}
            </motion.ul>
          </>
        )}
        <div className="notice">
          <Icon name="shield" size={16} />
          <span>{t('config.autoSafety')}</span>
        </div>
        <div className="actions">
          <Button onClick={onClose}>{enabled ? t('create.close') : t('review.cancel')}</Button>
          {!enabled && (
            <Button variant="primary" onClick={onEnable} disabled={!items && !error}>
              {t('config.autoEnable')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
