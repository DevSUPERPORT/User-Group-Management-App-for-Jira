import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, IconButton, Skeleton } from '../../components/primitives.jsx';
import { Select } from '../../components/Select.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease } from '../../motion.js';
import { downloadText } from '../download.js';
import { errorText } from '../errors.js';

const PAGE_SIZE = 20;
const ACTIONS = [
  'GROUP_CREATED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'MEMBER_EXPIRED',
  'MEMBER_AUTO_REMOVED',
  'EXPIRY_CHANGED',
  'DESCRIPTION_CHANGED',
  'ACCESS_REQUESTED',
  'ACCESS_REQUEST_APPROVED',
  'ACCESS_REQUEST_DENIED',
  'ACCESS_REQUEST_WITHDRAWN',
  'ACCESS_REQUEST_REOPENED',
  'ACCESS_REVIEW_COMPLETED',
  'PROJECT_KEY_CHANGED',
  'CONFIG_CHANGED',
  'DATA_EXPORTED',
  'DATA_IMPORTED',
];

// Small tags that explain why an entry happened (undo, access review, end date).
function EntryTags({ entry, t, fmt }) {
  const d = entry.details ?? {};
  const tags = [];
  if (d.via === 'rovo') tags.push({ key: 'via', text: t('audit.viaRovo'), tone: 'rovo' });
  if (entry.action === 'ACCESS_REQUESTED' && d.reason) tags.push({ key: 'why', text: `“${d.reason}”` });
  else if (d.reason && t(`audit.reason.${d.reason}`) !== `audit.reason.${d.reason}`) tags.push({ key: 'reason', text: t(`audit.reason.${d.reason}`), title: d.note });
  else if (d.note) tags.push({ key: 'note', text: t('audit.noteTag'), title: d.note });
  if (entry.action === 'MEMBER_ADDED' && d.expiresAt) tags.push({ key: 'until', text: t('members.until', { date: fmt.date(d.expiresAt) }) });
  if (entry.action === 'MEMBER_EXPIRED' && d.expiresAt) tags.push({ key: 'until', text: t('members.until', { date: fmt.date(d.expiresAt) }) });
  if (entry.action === 'ACCESS_REVIEW_COMPLETED') tags.push({ key: 'removed', text: t('audit.reviewRemoved', { count: d.removed ?? 0 }) });
  if (entry.action === 'ACCESS_REQUESTED' && d.durationDays) tags.push({ key: 'days', text: t('requests.forDays', { count: d.durationDays }) });
  if (entry.action === 'EXPIRY_CHANGED') {
    const show = (ts) => (ts ? fmt.date(ts) : t('expiry.none'));
    tags.push({ key: 'change', text: `${show(d.from)} → ${show(d.to)}` });
  }
  if (!tags.length) return null;
  return (
    <span className="entry-tags">
      {tags.map((tag) => (
        <span key={tag.key} className={`tag ${tag.tone ? `tag-${tag.tone}` : ''}`} title={tag.title || undefined}>
          {tag.text}
          {tag.title ? ' …' : ''}
        </span>
      ))}
    </span>
  );
}

function splitGroup(name) {
  const m = /^(atlassian-[^-]+-)(.+)$/.exec(name ?? '');
  return m ? [m[1], m[2]] : ['', name ?? ''];
}

function Marker({ action }) {
  return <span className={`marker marker-${action}`} aria-hidden="true" />;
}

// UC-04: filterable, paginated, exportable audit log. Entries are read-only.
export function AuditLog({ scope, preset }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  // Jira admins and auditors see all projects.
  const admin = scope !== 'project';
  const [filters, setFilters] = useState(() => ({ period: preset?.groupId ? 'all' : '30d', groupId: preset?.groupId ?? '', action: '', person: '', projectId: '' }));
  const [personInput, setPersonInput] = useState('');
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState({ groups: [], projects: [] });
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState(null);
  const reqRef = useRef(0);

  useEffect(() => {
    call('auditFilterOptions').then(setOptions).catch(() => {});
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      setFilters((f) => (f.person === personInput.trim() ? f : { ...f, person: personInput.trim() }));
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [personInput]);

  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    call('queryAudit', { filters, page, pageSize: PAGE_SIZE })
      .then((res) => id === reqRef.current && setData({ ...res, key: `${id}` }))
      .catch((err) => id === reqRef.current && setError(errorText(t, err)))
      .finally(() => id === reqRef.current && setLoading(false));
  }, [filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (key) => (value) => {
    setDirection(0);
    setPage(0);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const go = (delta) => {
    setDirection(delta);
    setPage((p) => p + delta);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await call('exportAudit', { filters });
      downloadText(res.csv, res.filename, 'text/csv;charset=utf-8');
      setExported(true);
      setTimeout(() => setExported(false), 1400);
      notify({ type: 'success', title: t('audit.exported', { count: res.count }) });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setExporting(false);
    }
  };

  const filtersActive = filters.groupId || filters.action || filters.person || filters.projectId || filters.period !== '30d';
  const reset = () => {
    setPersonInput('');
    setPage(0);
    setFilters({ period: '30d', groupId: '', action: '', person: '', projectId: '' });
  };

  const periodOptions = ['7d', '30d', '90d', '365d', 'all'].map((p) => ({ value: p, label: t(`audit.period.${p}`) }));
  const groupOptions = useMemo(() => [{ value: '', label: t('audit.allGroups') }, ...options.groups.map((g) => ({ value: g.groupId, label: g.groupName }))], [options.groups, t]);
  const actionOptions = [{ value: '', label: t('audit.allActions') }, ...ACTIONS.filter((a) => admin || a !== 'CONFIG_CHANGED').map((a) => ({ value: a, label: t(`audit.action.${a}`) }))];
  const projectOptions = [{ value: '', label: t('audit.allProjects') }, ...options.projects.map((p) => ({ value: p.projectId, label: p.projectKey }))];

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const from = total ? page * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="stack-20">
      <div className="filters">
        <div className="filter f-period">
          <Select id="f-time" label={t('audit.period')} value={filters.period} options={periodOptions} onChange={setFilter('period')} />
        </div>
        {admin && (
          <div className="filter f-project">
            <Select id="f-project" label={t('audit.project')} value={filters.projectId} options={projectOptions} onChange={setFilter('projectId')} />
          </div>
        )}
        <div className="filter f-group">
          <Select id="f-group" label={t('audit.group')} value={filters.groupId} options={groupOptions} onChange={setFilter('groupId')} />
        </div>
        <div className="filter f-action">
          <Select id="f-action" label={t('audit.action')} value={filters.action} options={actionOptions} onChange={setFilter('action')} />
        </div>
        <div className="filter f-person field">
          <label htmlFor="f-person" className="field-label">
            {t('audit.person')}
          </label>
          <input id="f-person" className="input" type="search" placeholder={t('audit.personPlaceholder')} value={personInput} onChange={(e) => setPersonInput(e.target.value)} />
        </div>
        <Button icon="download" data-tour="export" onClick={exportCsv} loading={exporting} success={exported} disabled={!total}>
          {t('audit.export')}
        </Button>
      </div>

      <div className="table-card">
        <div className="progress-track" aria-hidden="true">
          <AnimatePresence>{loading && data && <motion.span className="progress-bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}</AnimatePresence>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('audit.col.time')}</th>
                <th scope="col">{t('audit.col.action')}</th>
                {admin && <th scope="col">{t('audit.col.project')}</th>}
                <th scope="col">{t('audit.col.group')}</th>
                <th scope="col">{t('audit.col.target')}</th>
                <th scope="col">{t('audit.col.actor')}</th>
              </tr>
            </thead>
            <AnimatePresence mode="wait" initial={false} custom={direction}>
              <motion.tbody
                key={data?.key ?? 'loading'}
                custom={direction}
                className={loading && data ? 'is-loading' : ''}
                initial="enter"
                animate="center"
                exit="exit"
                variants={{
                  enter: (d) => ({ opacity: 0, x: d * 24 }),
                  center: { opacity: 1, x: 0, transition: { duration: 0.32, ease, staggerChildren: 0.022 } },
                  exit: (d) => ({ opacity: 0, x: d * -24, transition: { duration: 0.14 } }),
                }}
              >
                {!data
                  ? [0, 1, 2, 3, 4].map((i) => (
                      <tr key={i}>
                        {Array.from({ length: admin ? 6 : 5 }).map((_, j) => (
                          <td key={j}>
                            <Skeleton width={`${50 + ((i + j) % 3) * 15}%`} height={13} />
                          </td>
                        ))}
                      </tr>
                    ))
                  : entries.map((e) => {
                      const [pre, rest] = splitGroup(e.groupName);
                      const system = e.action === 'PROJECT_KEY_CHANGED' || e.action === 'CONFIG_CHANGED';
                      return (
                        <motion.tr key={e.id} className={system ? 'is-system' : ''} variants={{ enter: { opacity: 0, y: 6 }, center: { opacity: 1, y: 0, transition: { duration: 0.3, ease } } }}>
                          <td className="nowrap muted">{fmt.dateTime(e.createdAt)}</td>
                          <td>
                            <span className="action-cell">
                              <Marker action={e.action} />
                              {t(`audit.action.${e.action}`)}
                            </span>
                            <EntryTags entry={e} t={t} fmt={fmt} />
                          </td>
                          {admin && <td>{e.projectKey ?? <span className="muted">–</span>}</td>}
                          <td>
                            {e.action === 'PROJECT_KEY_CHANGED' ? (
                              t('audit.keyChange', { from: e.details?.from, to: e.details?.to, count: e.details?.affectedGroups ?? 0 })
                            ) : e.action === 'CONFIG_CHANGED' ? (
                              <span className="muted">{t('audit.configFields', { fields: (e.details?.changed ?? []).join(', ') })}</span>
                            ) : (
                              <span className="break">
                                <span className="gn-prefix">{pre}</span>
                                {rest}
                              </span>
                            )}
                          </td>
                          <td>{e.targetName ?? <span className="muted">–</span>}</td>
                          <td>
                            {e.actorName === 'system' ? (
                              <>
                                {t('audit.system')} <span className="muted">{t('audit.systemHint')}</span>
                              </>
                            ) : (
                              e.actorName
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
              </motion.tbody>
            </AnimatePresence>
          </table>
          <AnimatePresence>
            {data && !entries.length && (
              <motion.div className="table-empty" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <p>{error ?? t('audit.empty')}</p>
                {filtersActive && (
                  <Button variant="link" onClick={reset}>
                    {t('audit.reset')}
                  </Button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="table-foot">
          <span className="tabular">{total ? t('audit.range', { from, to, total }) : t('audit.rangeEmpty')}</span>
          <div className="row-8">
            <IconButton icon="chevronLeft" label={t('audit.prev')} className="icon-btn-outline" disabled={page === 0 || loading} onClick={() => go(-1)} />
            <IconButton icon="chevronRight" label={t('audit.next')} className="icon-btn-outline" disabled={to >= total || loading} onClick={() => go(1)} />
          </div>
        </div>
      </div>

      <div className="audit-notes">
        <span className="row-8">
          <Icon name="lock" size={14} />
          {t('audit.immutable')}
        </span>
        <span>{data?.retentionMonths ? t('audit.retentionMonths', { count: data.retentionMonths }) : t('audit.retentionNever')}</span>
      </div>
    </div>
  );
}
