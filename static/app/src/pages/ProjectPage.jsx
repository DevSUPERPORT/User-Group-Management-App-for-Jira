import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { call, openModule, openRovo } from '../api/client.js';
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
const REFRESH_MS = 10000;

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
  // A number per opening: a fresh dialog every time, never a still-closing one.
  const [creating, setCreating] = useState(0);
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

  // Keeps the group list current, e.g. groups deleted in Atlassian Administration
  // disappear by themselves: right away when the user comes back to this tab or
  // window (deleting happens in another tab), and every 10 seconds while it is open.
  // Quiet: no loading state, selection and search stay; paused while the page is
  // hidden, a dialog or the tour is open, or on other tabs.
  const busy = Boolean(creating) || tour.open || tab !== 'groups' || !boot;
  useEffect(() => {
    if (busy) return undefined;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      call('bootstrap')
        .then((res) => {
          setGroups(res.groups);
          setPending(res.pendingRequests ?? 0);
          setSelectedId((id) => (res.groups.some((g) => g.groupId === id) ? id : res.groups[0]?.groupId ?? null));
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(refresh, REFRESH_MS);
    const onReturn = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [busy]);

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
    setCreating(0);
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
            <Button variant="ghost" icon="eye" disabled={!boot} title={t('project.memberViewHint')} onClick={() => openModule('gum-my-groups', project?.key)}>
              {t('project.memberView')}
            </Button>
            <Button variant="ghost" icon="sparkle" disabled={!boot} title={t('project.askRovoHint')} onClick={() => openRovo(t('project.rovoPrompt', { key: project?.key })).then((ok) => ok || notify({ type: 'info', title: t('project.rovoUnavailable') }))}>
              {t('project.askRovo')}
            </Button>
            <TutorialButton
              disabled={!boot}
              onClick={() => {
                switchTab('groups');
                tour.start();
              }}
            />
            <Button variant="primary" icon="plus" data-tour="create" onClick={() => setCreating(Date.now())} disabled={!boot}>
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
              <EmptyGroups projectKey={project.key} onCreate={() => setCreating(Date.now())} />
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
      <AnimatePresence>{creating > 0 && boot && <CreateGroupDialog key={creating} project={project} prefix={boot.prefix} groups={groups} onClose={() => setCreating(0)} onCreated={onCreated} />}</AnimatePresence>
    </div>
  );
}
