import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { call } from '../api/client.js';
import { useI18n } from '../i18n/index.jsx';
import { Footer, Header, Tabs } from '../components/Shell.jsx';
import { Button } from '../components/primitives.jsx';
import { useNotify } from '../components/Toaster.jsx';
import { GroupList, GroupListSkeleton } from '../features/groups/GroupList.jsx';
import { GroupDetail } from '../features/groups/GroupDetail.jsx';
import { CreateGroupDialog } from '../features/groups/CreateGroupDialog.jsx';
import { AuditLog } from '../features/audit/AuditLog.jsx';
import { RequestsPanel } from '../features/requests/RequestsPanel.jsx';
import { PeoplePanel } from '../features/people/PeoplePanel.jsx';
import { DetailSkeleton, EmptyGroups, StateScreen } from './StateScreens.jsx';
import { ease } from '../motion.js';
import { errorText } from '../features/errors.js';
import { Tour, TutorialButton, useTutorial } from '../features/tutorial/Tour.jsx';

const TAB_ORDER = ['groups', 'people', 'requests', 'audit'];

export function ProjectPage() {
  const { t } = useI18n();
  const notify = useNotify();
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);
  const [groups, setGroups] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('groups');
  const [tabDir, setTabDir] = useState(1);
  const [auditPreset, setAuditPreset] = useState(null);
  const [creating, setCreating] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const [pending, setPending] = useState(0);
  const tour = useTutorial('project', Boolean(boot));

  const load = useCallback(() => {
    setError(null);
    call('bootstrap')
      .then((res) => {
        setBoot(res);
        setGroups(res.groups);
        setPending(res.pendingRequests ?? 0);
        setSelectedId((id) => id ?? res.groups[0]?.groupId ?? null);
      })
      .catch(setError);
  }, []);

  useEffect(load, [load]);

  const switchTab = (next) => {
    setTabDir(TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(tab) ? 1 : -1);
    if (next === 'groups') setAuditPreset(null);
    setTab(next);
  };

  const openAudit = (groupId) => {
    setAuditPreset({ groupId });
    setTabDir(1);
    setTab('audit');
  };

  const onCountChange = useCallback((groupId, count) => {
    setGroups((gs) => gs.map((g) => (g.groupId === groupId ? { ...g, memberCount: count } : g)));
  }, []);

  const onGroupUpdate = useCallback((groupId, patch) => {
    setGroups((gs) => gs.map((g) => (g.groupId === groupId ? { ...g, ...patch } : g)));
  }, []);

  const onCreated = (group) => {
    setCreating(false);
    setGroups((gs) => [...gs, group].sort((a, b) => a.namePart.localeCompare(b.namePart)));
    setQuery('');
    setSelectedId(group.groupId);
    setHighlightId(group.groupId);
    setTimeout(() => setHighlightId(null), 2600);
    notify({ type: 'success', title: t('notify.created', { name: group.name }) });
    if (group.copied) {
      notify({ type: group.copied.failed.length ? 'error' : 'success', title: t('notify.copied', { count: group.copied.added, from: group.copied.from }), description: group.copied.failed.length ? t('notify.copyFailed', { names: group.copied.failed.map((f) => f.displayName).join(', ') }) : undefined });
    }
    if (group.addMeError) notify({ type: 'error', title: t('notify.addMeFailed'), description: errorText(t, group.addMeError) });
  };

  if (error) return <StateScreen error={error} onRetry={load} />;

  const project = boot?.project;
  const selected = groups.find((g) => g.groupId === selectedId);

  return (
    <div className="page">
      <Header
        title={project ? t('project.title', { key: project.key }) : ' '}
        actions={
          <>
            <TutorialButton
              disabled={!boot}
              onClick={() => {
                switchTab('groups');
                tour.start();
              }}
            />
            <Button variant="primary" icon="plus" data-tour="create" onClick={() => setCreating(true)} disabled={!boot}>
              {t('project.create')}
            </Button>
          </>
        }
        tabs={
          <Tabs
            id="project-tabs"
            value={tab}
            onChange={switchTab}
            items={[
              { value: 'groups', label: t('tabs.groups') },
              { value: 'people', label: t('tabs.people') },
              { value: 'requests', label: t('tabs.requests'), badge: pending },
              { value: 'audit', label: t('tabs.audit') },
            ]}
          />
        }
      />

      <main className="container main" id="project-tabs-panel" role="tabpanel" aria-labelledby={`project-tabs-${tab}`}>
        <AnimatePresence mode="wait" initial={false} custom={tabDir}>
          <motion.div
            key={tab}
            custom={tabDir}
            variants={{
              enter: (d) => ({ opacity: 0, x: d * 28 }),
              center: { opacity: 1, x: 0, transition: { duration: 0.36, ease } },
              exit: (d) => ({ opacity: 0, x: d * -28, transition: { duration: 0.16, ease } }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {tab === 'audit' ? (
              <AuditLog scope="project" preset={auditPreset} />
            ) : tab === 'people' ? (
              <PeoplePanel
                onCountsChange={(counts) => setGroups((gs) => gs.map((g) => (counts[g.groupId] !== undefined ? { ...g, memberCount: counts[g.groupId] } : g)))}
                onOpenGroup={(groupId) => {
                  setSelectedId(groupId);
                  switchTab('groups');
                }}
              />
            ) : tab === 'requests' ? (
              <RequestsPanel onPendingChange={setPending} onMembershipChange={(groupId, delta) => setGroups((gs) => gs.map((g) => (g.groupId === groupId && g.memberCount !== null ? { ...g, memberCount: g.memberCount + delta } : g)))} />
            ) : !boot ? (
              <div className="split">
                <GroupListSkeleton />
                <DetailSkeleton />
              </div>
            ) : groups.length === 0 ? (
              <EmptyGroups projectKey={project.key} onCreate={() => setCreating(true)} />
            ) : (
              <LayoutGroup>
                <div className="split">
                  <GroupList groups={groups} selectedId={selectedId} onSelect={setSelectedId} query={query} onQuery={setQuery} highlightId={highlightId} />
                  <section aria-label={selected?.name} className="card detail-card">
                    <AnimatePresence mode="wait" initial={false}>
                      {selected ? (
                        <motion.div
                          key={selected.groupId}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease } }}
                          exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease } }}
                        >
                          <GroupDetail group={selected} project={project} expiryEnabled={boot.config.expiryEnabled !== false} reviewInterval={boot.config.reviewIntervalMonths} onCountChange={onCountChange} onGroupUpdate={onGroupUpdate} onOpenAudit={openAudit} />
                        </motion.div>
                      ) : (
                        <motion.p key="none" className="muted" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                          {t('groups.selectHint')}
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </section>
                </div>
              </LayoutGroup>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <Footer />

      <AnimatePresence>{tour.open && <Tour surface="project" onClose={tour.close} />}</AnimatePresence>
      <AnimatePresence>{creating && boot && <CreateGroupDialog project={project} prefix={boot.prefix} groups={groups} onClose={() => setCreating(false)} onCreated={onCreated} />}</AnimatePresence>
    </div>
  );
}
