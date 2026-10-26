import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { CountUp, IconButton, Skeleton } from '../../components/primitives.jsx';
import { collapse, ease, listChild, listParent } from '../../motion.js';
import { USAGE_CHECKS, describe, normalizeCheck } from './usageModel.js';

// UC-06: where is the group used? Nine checks across Jira and Confluence. Used
// checks become cards that open their findings; unused ones collapse into a quiet
// line, and checks that could not run say so instead of pretending "0".
export function UsagePanel({ groupId }) {
  const { t, fmt } = useI18n();
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = (refresh = false) => {
    setError(false);
    if (refresh) setRefreshing(true);
    return call('getUsage', { groupId, refresh })
      .then(setUsage)
      .catch(() => setError(true))
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    setUsage(null);
    setOpen(null);
    load();
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const checks = USAGE_CHECKS.map((c) => ({ ...c, ...normalizeCheck(usage?.[c.key]) }));
  const used = checks.filter((c) => c.items.length > 0);
  const problems = checks.filter((c) => c.items.length === 0 && c.status !== 'ok');
  const unused = checks.filter((c) => c.items.length === 0 && c.status === 'ok');
  const total = used.reduce((n, c) => n + c.items.length, 0);
  const cards = [...used, ...problems];
  const openCheck = checks.find((c) => c.key === open);
  const pageIndex = usage?.confluencePages?.index;

  return (
    <div className="stack-12">
      <div className="row-between">
        <div className="stack-4">
          <h3 className="eyebrow as-h3">{t('detail.usedIn')}</h3>
          {usage && (
            <motion.span key={total} className="usage-total" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
              {t('usage.total', { count: total })}
            </motion.span>
          )}
        </div>
        {usage && (
          <span className="usage-meta">
            <span className="muted small">{t('usage.checkedAt', { time: fmt.time(usage.cachedAt) })}</span>
            <IconButton icon="refresh" size={15} label={t('usage.refresh')} className={`icon-btn-sm ${refreshing ? 'is-spinning' : ''}`} onClick={() => load(true)} disabled={refreshing} />
          </span>
        )}
      </div>

      {error ? (
        <p className="muted small">{t('usage.error')}</p>
      ) : !usage ? (
        <div className="usage-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="usage-card is-skeleton">
              <Skeleton width={28} height={30} />
              <Skeleton width="70%" height={13} />
              <Skeleton width="50%" height={11} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {cards.length > 0 && (
            <motion.div className="usage-grid" variants={listParent(0.05, 0.04)} initial="initial" animate="animate">
              {cards.map((c) => {
                const tone = c.items.length ? (c.status === 'indexing' ? 'indexing' : 'ok') : c.status;
                return (
                  <motion.button
                    key={c.key}
                    layout="position"
                    type="button"
                    variants={listChild}
                    className={`usage-card tone-${tone} ${open === c.key ? 'is-open' : ''}`}
                    aria-expanded={open === c.key}
                    onClick={() => setOpen((o) => (o === c.key ? null : c.key))}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <span className="usage-card-top">
                      <span className="usage-count">{c.items.length ? <CountUp value={c.items.length} /> : <Icon name={c.status === 'indexing' ? 'clock' : 'alert'} size={22} />}</span>
                      <span className="usage-product">
                        <Icon name={c.icon} size={14} />
                        {t(`usage.section.${c.product}`)}
                      </span>
                    </span>
                    <span className="usage-label">{t(`usage.${c.key}`, { count: c.items.length || 2 })}</span>
                    <span className="usage-sub">
                      {c.items.length ? c.items.map((item) => describe(t, c.key, item).title).join(', ') : statusText(t, c)}
                    </span>
                    {tone === 'indexing' && <span className="usage-flag">{t('usage.status.indexing')}</span>}
                  </motion.button>
                );
              })}
            </motion.div>
          )}

          {unused.length > 0 && (
            <p className="usage-unused">
              <Icon name="check" size={14} />
              <span>
                {cards.length ? t('usage.alsoChecked') : t('usage.checkedNone')}{' '}
                <span className="muted">{unused.map((c) => t(`usage.${c.key}`, { count: 2 })).join(' · ')}</span>
              </span>
            </p>
          )}
        </>
      )}

      <AnimatePresence initial={false} mode="wait">
        {openCheck && usage && (
          <motion.div key={openCheck.key} className="usage-details" {...collapse}>
            <div className="usage-details-inner stack-12">
              {openCheck.items.length > 0 && (
                <motion.ul className="detail-list" variants={listParent(0.03)} initial="initial" animate="animate">
                  {openCheck.items.map((item, i) => {
                    const { title, detail } = describe(t, openCheck.key, item);
                    return (
                      <motion.li key={i} variants={listChild}>
                        <strong>{title}</strong>
                        {detail && <span className="muted small">{detail}</span>}
                      </motion.li>
                    );
                  })}
                </motion.ul>
              )}
              {openCheck.status !== 'ok' && openCheck.status !== 'indexing' && <p className="muted small">{statusHint(t, openCheck)}</p>}
              {openCheck.truncated && <p className="muted small">{t('usage.truncated')}</p>}
              {openCheck.key === 'confluencePages' && pageIndex && (
                <p className="muted small">
                  {pageIndex.lastFullScanAt
                    ? t('usage.indexInfo', { time: fmt.dateTime(pageIndex.lastFullScanAt), count: pageIndex.pagesInLastScan ?? 0 })
                    : t('usage.indexBuilding', { count: pageIndex.scannedInCurrentPass ?? 0 })}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function statusText(t, check) {
  if (check.reason === 'NOT_INSTALLED') return t('usage.status.notInstalled');
  if (check.status === 'indexing') return t('usage.status.indexing');
  return t(`usage.status.${check.status === 'unavailable' ? 'unavailable' : 'error'}`);
}

function statusHint(t, check) {
  if (check.reason === 'NOT_INSTALLED') return t('usage.hint.notInstalled');
  if (check.status === 'unavailable') return t('usage.hint.unavailable');
  return check.error?.message ? t('usage.hint.errorWith', { message: check.error.message }) : t('usage.hint.error');
}
