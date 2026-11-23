/**
 * Project roles tab: the project's roles with their people and groups. Project admins add and remove people and groups
 * at once, with their own Jira rights (Jira's project settings allow the same), so nothing waits for a Jira admin.
 * Protected groups (admin, product access, the blocked list) are shown locked. Removing yourself is not offered (it
 * could take away your own project admin rights).
 *
 * @file        static/app/src/features/roles/RolesPanel.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { useCallback, useEffect, useState } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, IconButton, Pill, Skeleton } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, ease, spring } from '../../motion.js';
import { errorText } from '../errors.js';
import { UserPicker } from '../groups/UserPicker.jsx';
import { SuggestInput } from '../admin/SuggestInput.jsx';

function RolesSkeleton() {
  return (
    <div className="split" aria-hidden="true">
      <div className="group-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="group-item skeleton-card">
            <Skeleton width={140} height={14} />
          </div>
        ))}
      </div>
      <div className="card detail-card stack-12">
        <Skeleton width={180} height={22} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
      </div>
    </div>
  );
}

export function RolesPanel({ onOpenGroup }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [fresh, setFresh] = useState(() => new Set());

  const load = useCallback(() => {
    setError(null);
    return call('listRoles')
      .then((res) => {
        setData(res);
        setSelectedId((id) => (id && res.roles.some((r) => r.roleId === id) ? id : res.roles[0]?.roleId ?? null));
        return res;
      })
      .catch((err) => {
        setError(err);
        return null;
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="card section stack-12">
        <p className="notice notice-warn">
          <Icon name="alert" size={16} />
          <span>{error.details?.reason === 'ROLES_OFF' ? t('roles.off') : errorText(t, error)}</span>
        </p>
        {error.details?.reason !== 'ROLES_OFF' && <Button onClick={load}>{t('error.retry')}</Button>}
      </div>
    );
  }
  if (!data) return <RolesSkeleton />;

  const role = data.roles.find((r) => r.roleId === selectedId);
  const flash = (ids) => {
    setFresh(new Set(ids));
    setTimeout(() => setFresh(new Set()), 1800);
  };

  const add = async (accountIds, { undo = false } = {}) => {
    const roleId = role.roleId;
    const res = await call('addRoleMembers', { roleId, accountIds, ...(undo ? { reason: 'undo' } : {}) });
    const added = res.results.filter((r) => r.status === 'added');
    const already = res.results.filter((r) => r.status === 'already');
    const failed = res.results.filter((r) => r.status === 'failed');
    await load();
    flash(added.map((r) => r.accountId));
    if (undo) {
      notify({ type: 'info', title: t('notify.undone') });
    } else if (added.length || already.length) {
      notify({
        type: 'success',
        title: t('roles.added', { count: added.length, role: res.role.name }),
        description: already.length ? t('roles.already', { count: already.length }) : undefined,
        action: added.length ? { label: t('notify.undo'), onClick: () => undoAdd(roleId, added.map((r) => r.accountId)) } : undefined,
      });
    }
    if (failed.length && !res.consentRequired) {
      notify({ type: 'error', title: t('roles.failed', { count: failed.length }), description: errorText(t, { code: failed[0].code, message: failed[0].error }) });
    }
  };

  const undoAdd = async (roleId, accountIds) => {
    try {
      for (const accountId of accountIds) await call('removeRoleMember', { roleId, accountId, reason: 'undo' });
      await load();
      notify({ type: 'info', title: t('notify.undone') });
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    }
  };

  // Groups: this project's own groups are suggested first; protected groups never appear.
  const searchGroups = (q) =>
    call('searchRoleGroups', { query: q }).then((r) =>
      r.groups.map((g) => ({ id: g.groupId, label: g.name, sub: g.own ? t('roles.ownGroup') : undefined, value: g.groupId })),
    );

  const addGroups = async (groupIds, { undo = false } = {}) => {
    const roleId = role.roleId;
    const res = await call('addRoleGroups', { roleId, groupIds, ...(undo ? { reason: 'undo' } : {}) });
    const added = res.results.filter((r) => r.status === 'added');
    const already = res.results.filter((r) => r.status === 'already');
    const failed = res.results.filter((r) => r.status === 'failed');
    await load();
    flash(added.map((r) => `g:${r.groupId}`));
    if (undo) notify({ type: 'info', title: t('notify.undone') });
    else if (added.length) {
      notify({
        type: 'success',
        title: t('roles.groupAdded', { name: added[0].name, role: res.role.name }),
        action: { label: t('notify.undo'), onClick: () => removeGroup({ groupId: added[0].groupId, name: added[0].name }, { undo: true, roleId }) },
      });
    } else if (already.length) notify({ type: 'info', title: t('roles.groupAlready', { name: already[0].name }) });
    if (failed.length && !res.consentRequired) {
      notify({ type: 'error', title: t('roles.groupFailed', { name: failed[0].name }), description: errorText(t, { code: failed[0].code, message: failed[0].error }) });
    }
  };

  const removeGroup = async (group, { undo = false, roleId = role.roleId } = {}) => {
    setBusy(`g:${group.groupId}`);
    try {
      const res = await call('removeRoleGroup', { roleId, groupId: group.groupId, ...(undo ? { reason: 'undo' } : {}) });
      setConfirmId(null);
      await load();
      if (undo) notify({ type: 'info', title: t('notify.undone') });
      else {
        notify({
          type: 'success',
          title: t('roles.groupRemoved', { name: group.name, role: res.role.name }),
          action: res.alreadyDone ? undefined : { label: t('notify.undo'), onClick: () => addGroups([group.groupId], { undo: true }).catch((err) => notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) })) },
        });
      }
    } catch (err) {
      notify({ type: 'error', title: undo ? t('notify.undoFailed') : errorText(t, err), description: undo ? errorText(t, err) : undefined });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (person) => {
    const roleId = role.roleId;
    setBusy(person.accountId);
    try {
      const res = await call('removeRoleMember', { roleId, accountId: person.accountId });
      setConfirmId(null);
      await load();
      notify({
        type: 'success',
        title: t('roles.removed', { name: person.displayName, role: res.role.name }),
        action: res.alreadyDone ? undefined : { label: t('notify.undo'), onClick: () => add([person.accountId], { undo: true }).catch((err) => notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) })) },
      });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack-16" aria-labelledby="roles-title">
      <div className="card section stack-4">
        <h2 id="roles-title" className="h3">
          {t('roles.title')}
        </h2>
        <p className="muted small">{t('roles.hint')}</p>
      </div>

      {data.roles.length === 0 ? (
        <p className="card section muted">{t('roles.none')}</p>
      ) : (
        <LayoutGroup>
          <div className="split">
            <nav className="group-list" aria-label={t('roles.title')}>
              <ul className="group-items">
                {data.roles.map((r) => {
                  const selected = r.roleId === selectedId;
                  return (
                    <li key={r.roleId}>
                      <motion.button
                        type="button"
                        className={`group-item ${selected ? 'is-selected' : ''}`}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => {
                          setConfirmId(null);
                          setSelectedId(r.roleId);
                        }}
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.985 }}
                        transition={spring}
                      >
                        {selected && <span className="group-ring" />}
                        <span className="group-dot-slot">{selected && <span className="group-dot" />}</span>
                        <span className="group-item-text">
                          <span className="group-item-name">{r.name}</span>
                          <span className="group-item-meta">
                            {t('roles.people', { count: r.people.length })}
                            {r.groups.length > 0 && <> · {t('roles.groups', { count: r.groups.length })}</>}
                          </span>
                        </span>
                      </motion.button>
                    </li>
                  );
                })}
              </ul>
              <p className="hint-box">{t('roles.hintBox')}</p>
            </nav>

            <section className="card detail-card stack-16" aria-label={role?.name}>
              {/* Plain keyed fade-in (no exit): an exit here would keep the page's tab transition waiting. */}
                {role && (
                  <motion.div
                    key={role.roleId}
                    className="stack-16"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease } }}
                  >
                    <div className="stack-4">
                      <h3 className="h2">{role.name}</h3>
                      {role.description && <p className="muted">{role.description}</p>}
                      <p className="small">
                        <Icon name="check" size={14} /> {t('roles.instant')}
                      </p>
                    </div>

                    <div className="stack-8">
                      <UserPicker knownMemberIds={new Set(role.people.map((p) => p.accountId))} onSubmit={(ids) => add(ids)} />
                    </div>

                    <div className="stack-8">
                      <h4 className="eyebrow">{t('roles.peopleTitle', { count: role.people.length })}</h4>
                      {role.people.length === 0 ? (
                        <p className="muted small">{t('roles.noPeople')}</p>
                      ) : (
                        <ul className="member-list">
                          {role.people.map((p) => {
                            const self = p.accountId === data.me;
                            return (
                              <li key={p.accountId} className={`member-row ${fresh.has(p.accountId) ? 'is-fresh' : ''} ${confirmId === p.accountId ? 'is-confirming' : ''}`}>
                                <div className="member-main">
                                  <Avatar name={p.displayName} url={p.avatarUrl} />
                                  <span className="member-text">
                                    <span className="member-name">{p.displayName}</span>
                                    {self && <span className="muted small">{t('roles.you')}</span>}
                                  </span>
                                  {!self && (
                                    <span className="row-actions">
                                      <IconButton icon="close" label={t('roles.remove', { name: p.displayName })} aria-expanded={confirmId === p.accountId} onClick={() => setConfirmId((c) => (c === p.accountId ? null : p.accountId))} />
                                    </span>
                                  )}
                                </div>
                                {/* No exit animation: the row may disappear right after a removal, and an exit that never
                                    finishes would keep the page's tab transition waiting. */}
                                {confirmId === p.accountId && (
                                    <motion.div initial={collapse.initial} animate={collapse.animate}>
                                      <div className="confirm-inner">
                                        <div className="confirm-text">
                                          <strong>{t('roles.confirmRemove', { name: p.displayName, role: role.name })}</strong>
                                          <span className="muted small">{t('roles.confirmHint')}</span>
                                        </div>
                                        <div className="confirm-actions">
                                          <Button size="sm" onClick={() => setConfirmId(null)}>
                                            {t('members.cancel')}
                                          </Button>
                                          <Button size="sm" variant="danger" loading={busy === p.accountId} onClick={() => remove(p)}>
                                            {t('roles.removeButton')}
                                          </Button>
                                        </div>
                                      </div>
                                    </motion.div>
                                  )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    <div className="stack-8">
                      <h4 className="eyebrow">{t('roles.groupsCount', { count: role.groups.length })}</h4>
                      <SuggestInput
                        label={t('roles.addGroup')}
                        placeholder={t('roles.addGroupPlaceholder')}
                        buttonLabel={t('roles.addGroupButton')}
                        search={searchGroups}
                        noResults={t('roles.noGroupResults')}
                        onAdd={(groupId) => addGroups([groupId]).catch((err) => notify({ type: 'error', title: errorText(t, err) }))}
                      />
                      {role.groups.length === 0 ? (
                        <p className="muted small">{t('roles.noGroups')}</p>
                      ) : (
                        <ul className="member-list">
                          {role.groups.map((g) => {
                            const key = `g:${g.groupId ?? g.name}`;
                            return (
                              <li key={key} className={`member-row ${fresh.has(key) ? 'is-fresh' : ''} ${confirmId === key ? 'is-confirming' : ''}`}>
                                <div className="member-main">
                                  <span className="avatar group-avatar" aria-hidden="true">
                                    <Icon name="users" size={16} />
                                  </span>
                                  <span className="member-text">
                                    <span className="member-name">{g.name}</span>
                                    {g.locked && <span className="muted small">{t('roles.groupLocked')}</span>}
                                  </span>
                                  <span className="row-actions">
                                    {g.managed && onOpenGroup && (
                                      <Button size="sm" variant="link" onClick={() => onOpenGroup(g.groupId)}>
                                        {t('roles.openGroup')}
                                      </Button>
                                    )}
                                    {g.locked ? (
                                      <Pill icon="lock">{t('roles.locked')}</Pill>
                                    ) : (
                                      g.groupId && <IconButton icon="close" label={t('roles.removeGroup', { name: g.name })} aria-expanded={confirmId === key} onClick={() => setConfirmId((c) => (c === key ? null : key))} />
                                    )}
                                  </span>
                                </div>
                                {confirmId === key && (
                                  <motion.div initial={collapse.initial} animate={collapse.animate}>
                                    <div className="confirm-inner">
                                      <div className="confirm-text">
                                        <strong>{t('roles.confirmRemoveGroup', { name: g.name, role: role.name })}</strong>
                                        <span className="muted small">{t('roles.confirmGroupHint')}</span>
                                      </div>
                                      <div className="confirm-actions">
                                        <Button size="sm" onClick={() => setConfirmId(null)}>
                                          {t('members.cancel')}
                                        </Button>
                                        <Button size="sm" variant="danger" loading={busy === key} onClick={() => removeGroup(g)}>
                                          {t('roles.removeButton')}
                                        </Button>
                                      </div>
                                    </div>
                                  </motion.div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <p className="muted small">{t('roles.groupsHint')}</p>
                    </div>
                  </motion.div>
                )}
            </section>
          </div>
        </LayoutGroup>
      )}
    </section>
  );
}
