import { AnimatePresence, motion } from 'framer-motion';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { GroupName, Pill, Skeleton } from '../../components/primitives.jsx';
import { ease, spring } from '../../motion.js';

export function GroupList({ groups, selectedId, onSelect, query, onQuery, highlightId }) {
  const { t } = useI18n();
  const q = query.trim().toLowerCase();
  const visible = q ? groups.filter((g) => g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q)) : groups;

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = visible.findIndex((g) => g.groupId === selectedId);
    const next = visible[Math.min(visible.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      onSelect(next.groupId);
      document.getElementById(`group-${next.groupId}`)?.focus();
    }
  };

  return (
    <section aria-label={t('tabs.groups')} className="group-list">
      <label htmlFor="group-search" className="eyebrow">
        {t('groups.listLabel', { count: groups.length })}
      </label>
      <div className="input-icon">
        <Icon name="search" size={18} />
        <input id="group-search" className="input" type="search" placeholder={t('groups.search')} value={query} onChange={(e) => onQuery(e.target.value)} autoComplete="off" />
      </div>

      <motion.ul className="group-items" onKeyDown={onKeyDown} initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.045, delayChildren: 0.1 } } }}>
        <AnimatePresence mode="popLayout" initial={false}>
          {visible.map((g) => {
            const selected = g.groupId === selectedId;
            return (
              <motion.li
                key={g.groupId}
                layout="position"
                variants={{ initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease } } }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
                transition={spring}
              >
                <motion.button
                  id={`group-${g.groupId}`}
                  type="button"
                  className={`group-item ${selected ? 'is-selected' : ''} ${g.groupId === highlightId ? 'is-new' : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(g.groupId)}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.985 }}
                  transition={spring}
                >
                  {selected && <motion.span layoutId="group-ring" className="group-ring" transition={spring} />}
                  <span className="group-dot-slot">{selected && <motion.span layoutId="group-dot" className="group-dot" transition={spring} />}</span>
                  <span className="group-item-text">
                    <span className="group-item-name">
                      <GroupName prefix={g.prefix} name={g.namePart} />
                    </span>
                    <span className="group-item-meta">
                      {g.syncing ? t('groups.syncing') : g.memberCount === null || g.memberCount === undefined ? t('groups.membersUnknown') : t('groups.members', { count: g.memberCount })}
                      {g.legacyKey && <> · {t('groups.legacyKey', { key: g.legacyKey })}</>}
                    </span>
                  </span>
                  {g.readOnly ? <Pill icon="lock">{t('groups.idp')}</Pill> : g.reviewDue ? <Pill icon="calendar" tone="warn">{t('groups.reviewDue')}</Pill> : null}
                </motion.button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </motion.ul>

      <AnimatePresence>
        {q && visible.length === 0 && (
          <motion.p className="muted small" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {t('groups.noMatch', { query })}
          </motion.p>
        )}
      </AnimatePresence>

      <p className="hint-box">{t('groups.hint')}</p>
    </section>
  );
}

export function GroupListSkeleton() {
  return (
    <div className="group-list" aria-hidden="true">
      <Skeleton width={110} height={12} />
      <Skeleton height={44} radius={10} />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="group-item skeleton-card">
          <span className="group-item-text">
            <Skeleton width={`${70 - i * 8}%`} height={15} />
            <Skeleton width="34%" height={12} />
          </span>
        </div>
      ))}
    </div>
  );
}
