/**
 * Main page for project admins in the project settings: tabs for groups, people, access requests and the project's
 * audit log, with create group, member view, "Ask Rovo" (only while AI features are effectively on) and the tour.
 * Jira-admin mode: a tab with the changes that wait for a Jira admin ("Changes to apply" for Jira admins, "Waiting
 * for Jira admin" for project admins), requested groups in the group list and a notice that changes wait.
 *
 * @file        static/app/src/pages/ProjectPage.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { adminPageUrl, call, openModule, openRovo } from '../api/client.js';
import { RolesPanel } from '../features/roles/RolesPanel.jsx';
import { aiOn } from '../features/ai.js';
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
import { ChangeQueue } from '../features/changes/ChangeQueue.jsx';
import { ConsentBanner } from '../features/changes/ConsentBanner.jsx';
import { Icon } from '../components/Icon.jsx';
import { DetailSkeleton, EmptyGroups, StateScreen } from './StateScreens.jsx';
import { ease } from '../motion.js';
import { errorText } from '../features/errors.js';
import { Tour, TutorialButton, useTutorial } from '../features/tutorial/Tour.jsx';

const TAB_ORDER = ['groups', 'people', 'requests', 'changes', 'audit'];
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
  // AI entry points ("Ask Rovo", the Rovo hint in the tour) only while AI is effectively on; off until bootstrap says so.
  const [ai, setAi] = useState(false);
  // Jira-admin mode: waiting changes (count for the tab) and new groups that wait for a Jira admin.
  const [changes, setChanges] = useState({ pending: 0, mine: 0, canApply: false });
  const [pendingGroups, setPendingGroups] = useState([]);
  const tour = useTutorial('project', Boolean(boot));
  const applyBoot = (res) => {
    setChanges(res.changes ?? { pending: 0, mine: 0, canApply: false });
    setPendingGroups(res.pendingGroups ?? []);
  };

  const load = useCallback(() => {
    setError(null);
    call('bootstrap')
      .then((res) => {
        setBoot(res);
        setAi(aiOn(res));
        applyBoot(res);
        setGroups(res.groups);
        setPending(res.pendingRequests ?? 0);
        setSelectedId((id) => id ?? res.groups[0]?.groupId ?? null);
      })
      .catch((err) => {
        setAi(false);
        setError(err);
      });
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
          // Also picks up a changed AI switch (a Jira admin saved it, or SUPERPORT stopped AI) without a reload.
          setAi(aiOn(res));
          applyBoot(res);
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

  // Withdraws the caller's own waiting changes (e.g. a requested group).
  const withdraw = async (refs) => {
    try {
      const res = await call('withdrawChanges', { refs });
      const done = res.results.filter((r) => r.status === 'withdrawn').map((r) => r.ref);
      setPendingGroups((gs) => gs.filter((g) => !done.includes(g.ref)));
      setChanges((c) => ({ ...c, pending: res.pendingCount, mine: Math.max(0, c.mine - done.length) }));
      notify({ type: 'info', title: t('notify.withdrawnN', { count: done.length }) });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    }
  };

  const onCreated = (group) => {
    setCreating(0);
    if (group.pending) {
      // Jira-admin mode, project admin: the group is created once a Jira admin applies it.
      const entry = { ref: group.change.ref, name: group.name, prefix: group.prefix, namePart: group.namePart, description: group.description, requestedBy: group.change.requestedBy, requestedAt: group.change.requestedAt, members: group.change.create?.members?.length ?? 0 };
      setPendingGroups((gs) => [...gs, entry]);
      setChanges((c) => ({ ...c, pending: c.pending + 1, mine: c.mine + 1 }));
      notify({ type: 'info', title: t('notify.pendingCreate', { name: group.name }), description: t('notify.pendingHint'), action: { label: t('notify.withdraw'), onClick: () => withdraw([group.change.ref]) } });
      return;
    }
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

  // A project admin sends their Jira admin the link to the admin page, where the waiting changes are.
  const copyAdminLink = async () => {
    const url = await adminPageUrl().catch(() => null);
    if (!url) return notify({ type: 'info', title: t('pending.linkManual') });
    try {
      await navigator.clipboard.writeText(url);
      notify({ type: 'success', title: t('pending.linkCopied') });
    } catch {
      // Clipboard blocked in the Jira frame: show the address to copy by hand.
      notify({ type: 'info', title: t('pending.linkShow'), description: url });
    }
  };

  if (error) return <StateScreen error={error} onRetry={load} />;

  const project = boot?.project;
  const selected = groups.find((g) => g.groupId === selectedId);
  const pendingWrites = boot?.changeMode?.writes === 'pending';
  const showChanges = Boolean(boot) && (boot.changeMode?.effective === 'jiraAdmin' || changes.pending > 0);
  const me = boot?.user?.accountId;

  return (
    <div className="page">
      <Header
        title={project ? t('project.title', { key: project.key }) : ' '}
        actions={
          <>
            <Button variant="ghost" icon="eye" disabled={!boot} title={t('project.memberViewHint')} onClick={() => openModule('gum-my-groups', project?.key)}>
              {t('project.memberView')}
            </Button>
            {ai && (
              <Button variant="ghost" icon="sparkle" title={t('project.askRovoHint')} onClick={() => openRovo(t('project.rovoPrompt', { key: project?.key })).then((ok) => ok || notify({ type: 'info', title: t('project.rovoUnavailable') }))}>
                {t('project.askRovo')}
              </Button>
            )}
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
              ...(boot?.rolesEnabled !== false ? [{ value: 'roles', label: t('tabs.roles') }] : []),
              { value: 'requests', label: t('tabs.requests'), badge: pending },
              ...(showChanges ? [{ value: 'changes', label: changes.canApply ? t('tabs.changes') : t('tabs.waiting'), badge: changes.canApply ? changes.pending : changes.mine }] : []),
              { value: 'audit', label: t('tabs.audit') },
            ]}
          />
        }
      />

      <main className="container main" id="project-tabs-panel" role="tabpanel" aria-labelledby={`project-tabs-${tab}`}>
        {boot?.user?.testProjectAdmin && (
          <p className="notice notice-error test-only-banner" role="status">
            <Icon name="alert" size={16} />
            <span>{t('pending.testNotice')}</span>
          </p>
        )}
        <ConsentBanner />
        {pendingWrites && tab !== 'changes' && tab !== 'roles' && (
          <div className="notice pending-banner row-between wrap" role="status">
            <span className="row-8">
              <Icon name="clock" size={16} />
              <span>{t('pending.modeNotice')}</span>
            </span>
            <Button size="sm" variant="link" icon="copy" onClick={copyAdminLink}>
              {t('pending.copyLink')}
            </Button>
          </div>
        )}
        {changes.canApply && (changes.pendingAll ?? 0) > 0 && tab !== 'changes' && (
          <div className="notice notice-warn pending-banner row-between wrap" role="status">
            <span className="row-8">
              <Icon name="clock" size={16} />
              <span>{t('pending.adminNotice', { count: changes.pendingAll })}</span>
            </span>
            <Button size="sm" variant="dark" icon="arrowRight" onClick={() => openModule('gum-admin-page')}>
              {t('pending.openQueue')}
            </Button>
          </div>
        )}
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
            ) : tab === 'changes' ? (
              <ChangeQueue
                scope="project"
                onCountChange={(n) => setChanges((c) => ({ ...c, pending: n }))}
                onApplied={() => call('bootstrap').then((res) => { applyBoot(res); setGroups(res.groups); }).catch(() => {})}
              />
            ) : tab === 'people' ? (
              <PeoplePanel
                pendingWrites={pendingWrites}
                onCountsChange={(counts) => setGroups((gs) => gs.map((g) => (counts[g.groupId] !== undefined ? { ...g, memberCount: counts[g.groupId] } : g)))}
                onOpenGroup={(groupId) => {
                  setSelectedId(groupId);
                  switchTab('groups');
                }}
              />
            ) : tab === 'roles' ? (
              <RolesPanel
                onOpenGroup={(groupId) => {
                  setSelectedId(groupId);
                  switchTab('groups');
                }}
              />
            ) : tab === 'requests' ? (
              <RequestsPanel pendingWrites={pendingWrites} onPendingChange={setPending} onMembershipChange={(groupId, delta) => setGroups((gs) => gs.map((g) => (g.groupId === groupId && g.memberCount !== null ? { ...g, memberCount: g.memberCount + delta } : g)))} />
            ) : !boot ? (
              <div className="split">
                <GroupListSkeleton />
                <DetailSkeleton />
              </div>
            ) : groups.length === 0 && pendingGroups.length === 0 ? (
              <EmptyGroups projectKey={project.key} onCreate={() => setCreating(Date.now())} />
            ) : (
              <LayoutGroup>
                <div className="split">
                  <GroupList groups={groups} selectedId={selectedId} onSelect={setSelectedId} query={query} onQuery={setQuery} highlightId={highlightId} pendingGroups={pendingGroups} me={me} onWithdraw={(ref) => withdraw([ref])} />
                  <section aria-label={selected?.name} className="card detail-card">
                    <AnimatePresence mode="wait" initial={false}>
                      {selected ? (
                        <motion.div
                          key={selected.groupId}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease } }}
                          exit={{ opacity: 0, y: -6, transition: { duration: 0.14, ease } }}
                        >
                          <GroupDetail group={selected} project={project} pendingWrites={pendingWrites} canApply={changes.canApply} me={me} onChangesChanged={() => call('bootstrap').then(applyBoot).catch(() => {})} expiryEnabled={boot.config.expiryEnabled !== false} reviewInterval={boot.config.reviewIntervalMonths} onCountChange={onCountChange} onGroupUpdate={onGroupUpdate} onOpenAudit={openAudit} />
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

      <AnimatePresence>{tour.open && <Tour surface="project" ai={ai} onClose={tour.close} />}</AnimatePresence>
      <AnimatePresence>{creating > 0 && boot && <CreateGroupDialog key={creating} project={project} prefix={boot.prefix} groups={groups} pendingMode={pendingWrites} onClose={() => setCreating(0)} onCreated={onCreated} />}</AnimatePresence>
    </div>
  );
}
