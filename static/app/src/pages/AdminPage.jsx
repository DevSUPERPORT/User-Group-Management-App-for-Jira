import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../api/client.js';
import { useI18n } from '../i18n/index.jsx';
import { Footer, Header, Tabs } from '../components/Shell.jsx';
import { Pill, Skeleton } from '../components/primitives.jsx';
import { AdminConfig } from '../features/admin/AdminConfig.jsx';
import { AuditLog } from '../features/audit/AuditLog.jsx';
import { DataTransfer } from '../features/admin/DataTransfer.jsx';
import { StateScreen } from './StateScreens.jsx';
import { ease } from '../motion.js';
import { Tour, TutorialButton, useTutorial } from '../features/tutorial/Tour.jsx';

const WIDTH = 880;

export function AdminPage() {
  const { t } = useI18n();
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('config');
  const [version, setVersion] = useState(0);
  const tour = useTutorial('admin', Boolean(boot));

  const load = useCallback(() => {
    setError(null);
    call('adminBootstrap').then(setBoot).catch(setError);
  }, []);
  useEffect(load, [load]);

  if (error) return <StateScreen error={error} onRetry={load} />;

  const wide = tab === 'audit';
  return (
    <div className="page">
      <Header
        title={t('config.title')}
        maxWidth={wide ? 1200 : WIDTH}
        actions={
          <>
            <TutorialButton
              disabled={!boot}
              onClick={() => {
                setTab('config');
                tour.start();
              }}
            />
            <Pill icon="shield">{t('config.badge')}</Pill>
          </>
        }
        tabs={
          <Tabs
            id="admin-tabs"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'config', label: t('tabs.config') },
              { value: 'audit', label: t('tabs.auditAll') },
            ]}
          />
        }
      />
      <motion.main
        className="container main"
        id="admin-tabs-panel"
        role="tabpanel"
        aria-labelledby={`admin-tabs-${tab}`}
        animate={{ maxWidth: wide ? 1200 : WIDTH }}
        initial={false}
        transition={{ duration: 0.45, ease }}
      >
        {boot && tab === 'config' && (
          <motion.p className="muted small stats-line" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {t('config.stats', { groups: boot.stats.managedGroups, projects: boot.stats.projects })}
          </motion.p>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease } }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.14 } }}
          >
            {tab === 'audit' ? (
              <AuditLog scope="admin" />
            ) : boot ? (
              <div className="stack-20">
                {/* Remounted after an import so the imported configuration is shown. */}
                <AdminConfig key={version} initial={boot} />
                <DataTransfer
                  onImported={() =>
                    call('adminBootstrap')
                      .then((next) => {
                        setBoot(next);
                        setVersion((v) => v + 1);
                      })
                      .catch(setError)
                  }
                />
              </div>
            ) : (
              <div className="stack-20">
                {[120, 150, 220, 130].map((h, i) => (
                  <div key={i} className="card section">
                    <Skeleton width="30%" height={18} />
                    <Skeleton width="55%" height={12} />
                    <Skeleton height={h - 70} radius={10} />
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.main>
      <Footer maxWidth={wide ? 1200 : WIDTH} />
      <AnimatePresence>{tour.open && <Tour surface="admin" onClose={tour.close} />}</AnimatePresence>
    </div>
  );
}
