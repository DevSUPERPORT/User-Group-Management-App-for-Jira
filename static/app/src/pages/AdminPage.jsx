/**
 * Jira admin page (jira:adminPage): loads adminBootstrap and shows the configuration tab (settings, compliance,
 * how group changes are made, data transfer), the changes that wait for a Jira admin (with a count on the tab and
 * in the header) and the audit log of all projects.
 *
 * @file        static/app/src/pages/AdminPage.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../api/client.js';
import { useI18n } from '../i18n/index.jsx';
import { Footer, Header, Tabs } from '../components/Shell.jsx';
import { Pill, Skeleton } from '../components/primitives.jsx';
import { Icon } from '../components/Icon.jsx';
import { AdminConfig } from '../features/admin/AdminConfig.jsx';
import { SetupCard } from '../features/admin/SetupCard.jsx';
import { AuditLog } from '../features/audit/AuditLog.jsx';
import { DataTransfer } from '../features/admin/DataTransfer.jsx';
import { ChangeQueue } from '../features/changes/ChangeQueue.jsx';
import { ConsentBanner } from '../features/changes/ConsentBanner.jsx';
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
  // Changes waiting for a Jira admin (Jira-admin mode): shown on the tab and in the header.
  const [waiting, setWaiting] = useState(0);
  // A new site gets the short setup checklist instead of the tour; the tour stays one click away ("Tutorial").
  const tour = useTutorial('admin', Boolean(boot), Boolean(boot?.setup?.dismissed));
  const showSetup = Boolean(boot?.setup && !boot.setup.dismissed);
  const reloadBoot = () =>
    call('adminBootstrap')
      .then((next) => {
        setBoot(next);
        setVersion((v) => v + 1);
      })
      .catch(() => {});
  const reopenSetup = () =>
    call('updateSetup', { step: 'reopen' })
      .then((res) => setBoot((b) => ({ ...b, setup: res.setup })))
      .catch(() => {});

  // On the first load the page opens on "Changes to apply" when something waits for a Jira admin.
  const firstLoad = useRef(true);
  const load = useCallback(() => {
    setError(null);
    call('adminBootstrap')
      .then((res) => {
        setBoot(res);
        const count = res.compliance?.pendingChanges ?? 0;
        setWaiting(count);
        if (firstLoad.current && count > 0) setTab('changes');
        firstLoad.current = false;
      })
      .catch(setError);
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
            {waiting > 0 && (
              <button type="button" className="pill pill-warn pill-button" onClick={() => setTab('changes')}>
                <Icon name="clock" size={14} />
                {t('changes.waitingBadge', { count: waiting })}
              </button>
            )}
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
              { value: 'changes', label: t('tabs.changes'), badge: waiting },
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
        <ConsentBanner />
        {boot && tab === 'config' && (
          <motion.p className="muted small stats-line" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {t('config.stats', { groups: boot.stats.managedGroups, projects: boot.stats.projects })}
            {!showSetup && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={reopenSetup}>
                  {t('setup.reopen')}
                </button>
              </>
            )}
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
            ) : tab === 'changes' ? (
              <ChangeQueue scope="admin" onCountChange={setWaiting} onApplied={() => call('adminBootstrap').then(setBoot).catch(() => {})} />
            ) : boot ? (
              <div className="stack-20">
                {showSetup && (
                  <SetupCard
                    key={`setup-${version}`}
                    initial={boot.setup}
                    onChange={(setup, { privilegedChanged = false } = {}) => {
                      if (privilegedChanged) reloadBoot();
                      else setBoot((b) => ({ ...b, setup }));
                    }}
                  />
                )}
                {/* Remounted after an import so the imported configuration is shown. */}
                <AdminConfig key={version} initial={boot} waiting={waiting} onOpenQueue={() => setTab('changes')} />
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
