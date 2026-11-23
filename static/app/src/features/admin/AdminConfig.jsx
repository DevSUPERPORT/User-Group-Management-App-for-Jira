/**
 * Configuration tab of the Jira admin page: how group changes are made (Jira admins apply them; read-only), the TEST
 * ONLY switch (development environment only), project scope, block list, IdP read-only
 * groups, auditor groups, member view, time limits, AI features (Rovo agent), requests, reviews, automation and scope guard, saved together
 * and undoable.
 *
 * @file        static/app/src/features/admin/AdminConfig.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-19
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call, openModule } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Checkbox } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse, ease, snappy, spring } from '../../motion.js';
import { errorText } from '../errors.js';
import { SuggestInput } from './SuggestInput.jsx';
import { AutomationSettings, ComplianceCards } from './Governance.jsx';
import { isFixedEntry } from '../../../../../src/core/blocklist.js';

function Section({ id, title, hint, children, delay = 0 }) {
  return (
    <motion.section
      aria-labelledby={id}
      className="card section"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay } }}
    >
      <div className="stack-4">
        <h2 id={id} className="h3">
          {title}
        </h2>
        {hint && <p className="muted small">{hint}</p>}
      </div>
      {children}
    </motion.section>
  );
}

function RadioCard({ name, id, checked, onSelect, children, layoutGroup }) {
  return (
    <div className={`radio-card ${checked ? 'is-checked' : ''}`} onClick={onSelect}>
      {checked && <motion.span layoutId={`${layoutGroup}-ring`} className="radio-ring" transition={spring} />}
      <input id={id} type="radio" name={name} checked={checked} onChange={onSelect} />
      <span className="radio-dot" aria-hidden="true">
        <AnimatePresence>{checked && <motion.span className="radio-dot-inner" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy} />}</AnimatePresence>
      </span>
      {children}
    </div>
  );
}

function Chips({ items, render = (x) => x, onRemove, removeLabel, keyOf = (x) => x }) {
  return (
    <ul className="chip-list">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.li
            key={keyOf(item)}
            layout
            className="chip chip-lg"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.14 } }}
            transition={snappy}
          >
            {render(item)}
            <button type="button" className="chip-x" aria-label={removeLabel(item)} onClick={() => onRemove(item)}>
              <Icon name="close" size={13} strokeWidth={2.4} />
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

// How group changes are made (read-only): Jira admins apply them as themselves; project admins' changes and automatic
// removals wait under "Changes to apply". The app does not use organization API keys (Marketplace requirement).
// How group changes are made, and "Apply project admins' changes automatically" (privileged admin, like CSUM's
// privileged user): a Jira admin lets the app act with their own account (Forge offline impersonation) for project
// admins' changes and the scheduled removals. Switched on only for oneself; any Jira admin can stop it.
function ChangeModeSection({ waiting, onOpenQueue, privileged: initialPrivileged, me }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [privileged, setPrivileged] = useState(initialPrivileged ?? { on: false, paused: false });
  const [busy, setBusy] = useState(null);
  const run = async (name) => {
    setBusy(name);
    try {
      const res = await call(name);
      setPrivileged(res.privileged);
      notify({ type: 'success', title: t(res.privileged.on ? 'config.autoSwitchedOn' : 'config.autoSwitchedOff') });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };
  const mine = privileged.accountId && privileged.accountId === me;
  const state = privileged.on ? 'is-ok' : privileged.paused ? 'is-error' : '';
  return (
    <Section id="sec-mode" title={t('config.mode')} hint={t('config.modeHint')} delay={0.06}>
      <div className="row-between wrap mode-now">
        <span className="small">
          <span className="org-status-light inline" data-mode="jiraAdmin" aria-hidden="true" />
          {t(privileged.on ? 'config.modeNowAutomatic' : 'config.modeNowJiraAdmin')}
          {waiting > 0 ? ` · ${t('config.modeWaiting', { count: waiting })}` : ''}
        </span>
        {waiting > 0 && (
          <Button size="sm" icon="arrowRight" onClick={onOpenQueue}>
            {t('config.modeOpenQueue')}
          </Button>
        )}
      </div>
      <div className="subsection stack-12" id="auto-changes">
        <div className="stack-4">
          <h3 className="label-strong">{t('config.auto')}</h3>
          <p className="muted small">{t('config.autoHint')}</p>
        </div>
        <div className={`org-status ${state}`} role="status">
          <span className="org-status-light" aria-hidden="true" />
          <span className="small grow">
            {privileged.on
              ? t(mine ? 'config.autoOnMine' : 'config.autoOn', { name: privileged.displayName, date: fmt.date(privileged.setAt) })
              : privileged.paused
                ? t('config.autoPaused', { name: privileged.displayName, reason: t(`config.autoPausedReason.${privileged.pausedReason ?? 'NOT_ADMIN'}`, { name: privileged.displayName }) })
                : t('config.autoOff')}
          </span>
          <span className="org-actions">
            {(!privileged.on || !mine) && (
              <Button size="sm" variant={privileged.on ? 'secondary' : 'dark'} icon="check" loading={busy === 'setPrivilegedAdmin'} disabled={Boolean(busy)} onClick={() => run('setPrivilegedAdmin')}>
                {t(privileged.on || privileged.paused ? 'config.autoUseMineInstead' : 'config.autoUseMine')}
              </Button>
            )}
            {(privileged.on || privileged.paused) && (
              <Button size="sm" variant="link" loading={busy === 'clearPrivilegedAdmin'} disabled={Boolean(busy)} onClick={() => run('clearPrivilegedAdmin')}>
                {t('config.autoStop')}
              </Button>
            )}
          </span>
        </div>
        <p className="muted small">{t('config.autoSafety')}</p>
      </div>
    </Section>
  );
}

// TEST ONLY (Forge development environment only; the server ignores the list everywhere else and never sends it):
// accounts treated as project admins on project pages and in Rovo, to test the project-admin flow with one account.
function TestProjectAdminsSection({ accounts, onChange, me }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const add = (id) => {
    const v = String(id ?? '').trim();
    if (v && !accounts.includes(v)) onChange([...accounts, v]);
    setValue('');
  };
  return (
    <motion.section aria-labelledby="sec-test" className="card section test-only" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay: 0.07 } }}>
      <div className="stack-4">
        <h2 id="sec-test" className="h3 test-only-title">
          <Icon name="alert" size={18} />
          {t('config.test')}
        </h2>
        <p className="muted small">{t('config.testHint')}</p>
      </div>
      {accounts.length ? (
        <Chips items={accounts} render={(id) => (id === me ? t('config.testMe', { id }) : id)} onRemove={(id) => onChange(accounts.filter((x) => x !== id))} removeLabel={(id) => t('config.testRemove', { name: id })} />
      ) : (
        <p className="muted small">{t('config.testEmpty')}</p>
      )}
      <form
        className="row-8 wrap"
        onSubmit={(e) => {
          e.preventDefault();
          add(value);
        }}
      >
        <label htmlFor="test-account" className="sr-only">
          {t('config.testLabel')}
        </label>
        <input id="test-account" className="input grow" placeholder={t('config.testLabel')} value={value} spellCheck={false} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="sm" disabled={!value.trim()}>
          {t('config.testAdd')}
        </Button>
        {me && !accounts.includes(me) && (
          <Button size="sm" variant="ghost" onClick={() => add(me)}>
            {t('config.testAddMe')}
          </Button>
        )}
      </form>
    </motion.section>
  );
}

function LockedChips({ items }) {
  const { t } = useI18n();
  return (
    <motion.ul className="chip-list" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.02 } } }}>
      {items.map((item) => (
        <motion.li
          key={item}
          className="chip chip-lg chip-locked"
          title={t('config.fixedTitle')}
          variants={{ initial: { opacity: 0, scale: 0.85 }, animate: { opacity: 1, scale: 1, transition: snappy } }}
        >
          <Icon name="lock" size={13} />
          <span>{item}</span>
          <span className="sr-only">{t('config.fixedTitle')}</span>
        </motion.li>
      ))}
    </motion.ul>
  );
}

const addUnique = (list, v) => (list.some((x) => x.toLowerCase() === v.toLowerCase()) ? list : [...list, v]);

export function AdminConfig({ initial, onSaved, waiting = 0, onOpenQueue }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [saved, setSaved] = useState(initial.config);
  const [draft, setDraft] = useState(initial.config);
  const [months, setMonths] = useState(String(initial.config.retentionMonths ?? 24));
  const [showProducts, setShowProducts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const effective = useMemo(() => ({ ...draft, retentionMonths: draft.retentionMonths === null ? null : Number(months) || 0 }), [draft, months]);
  const dirty = JSON.stringify(effective) !== JSON.stringify(saved);
  const monthsInvalid = effective.retentionMonths !== null && (effective.retentionMonths < 1 || effective.retentionMonths > 600);
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const searchGroups = (q) => call('searchGroups', { query: q }).then((r) => r.groups.map((g) => ({ id: g.groupId, label: g.name, value: g.name })));
  const searchProjects = (q) =>
    call('searchProjects', { query: q }).then((r) =>
      r.projects.filter((p) => !draft.allowedProjects.some((a) => a.id === p.id)).map((p) => ({ id: p.id, label: `${p.key} · ${p.name}`, value: p })),
    );

  const applySaved = (config) => {
    setSaved(config);
    setDraft(config);
    setMonths(String(config.retentionMonths ?? 24));
    onSaved?.(config);
  };

  // Restores the configuration as it was before the last save.
  const undoSave = async (previous) => {
    try {
      const res = await call('saveConfig', { config: previous, reason: 'undo' });
      applySaved(res.config);
      notify({ type: 'info', title: t('notify.undone') });
    } catch (err) {
      notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) });
    }
  };

  const save = async () => {
    if (monthsInvalid) return;
    setSaving(true);
    try {
      const res = await call('saveConfig', { config: effective });
      applySaved(res.config);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1200);
      notify({
        type: 'success',
        title: t('config.saved'),
        action: res.changed?.length ? { label: t('notify.undo'), onClick: () => undoSave(res.previous) } : undefined,
      });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err), action: { label: t('notify.retry'), onClick: save } });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setMonths(String(saved.retentionMonths ?? 24));
  };

  return (
    <div className="stack-20">
      {initial.compliance && <ComplianceCards compliance={initial.compliance} confluence={initial.confluence ?? { available: false }} />}

      <Section id="sec-retention" title={t('config.retention')} hint={t('config.retentionHint')}>
        <fieldset className="radio-group">
          <legend className="sr-only">{t('config.retention')}</legend>
          <RadioCard name="retention" id="ret-never" layoutGroup="ret" checked={draft.retentionMonths === null} onSelect={() => update({ retentionMonths: null })}>
            <label htmlFor="ret-never" className="grow">
              {t('config.never')}
            </label>
            <span className="muted small">{t('config.default')}</span>
          </RadioCard>
          <RadioCard name="retention" id="ret-months" layoutGroup="ret" checked={draft.retentionMonths !== null} onSelect={() => draft.retentionMonths === null && update({ retentionMonths: Number(months) || 24 })}>
            <label htmlFor="ret-months">{t('config.deleteAfter')}</label>
            <input
              className={`input input-num ${monthsInvalid ? 'is-invalid' : ''}`}
              type="number"
              min="1"
              max="600"
              aria-label={t('config.monthsLabel')}
              value={months}
              onFocus={() => draft.retentionMonths === null && update({ retentionMonths: Number(months) || 24 })}
              onChange={(e) => setMonths(e.target.value)}
            />
            <span>{t('config.months')}</span>
          </RadioCard>
        </fieldset>
      </Section>

      <Section id="sec-naming" title={t('config.naming')} hint={t('config.namingHint')} delay={0.05}>
        <div className="naming" aria-label="atlassian-PROJECTKEY-name">
          <span className="seg seg-first muted">atlassian-</span>
          <span className="seg seg-key">PROJECTKEY</span>
          <span className="seg muted">-</span>
          <span className="seg seg-name">
            name<span className="caret" aria-hidden="true" />
          </span>
        </div>
        <p className="muted small">{t('config.namingNote')}</p>
      </Section>

      <ChangeModeSection waiting={waiting} onOpenQueue={onOpenQueue} privileged={initial.privileged} me={initial.user?.accountId} />

      {initial.development && <TestProjectAdminsSection accounts={draft.testProjectAdmins ?? []} onChange={(v) => update({ testProjectAdmins: v })} me={initial.user?.accountId} />}

      <Section id="sec-roles" title={t('config.roles')} hint={t('config.rolesHint')} delay={0.09}>
        <div className="stack-4">
          <Checkbox id="member-view" checked={draft.memberViewEnabled !== false} onChange={(v) => update({ memberViewEnabled: v })}>
            {t('config.memberView')}
          </Checkbox>
          <p className="muted small checkbox-hint">{t('config.memberViewWhere')}</p>
          <Checkbox id="roles-on" checked={draft.rolesEnabled !== false} onChange={(v) => update({ rolesEnabled: v })}>
            {t('config.rolesTab')}
          </Checkbox>
          <p className="muted small checkbox-hint">{t('config.rolesTabHint')}</p>
          <Checkbox id="expiry-on" checked={draft.expiryEnabled !== false} onChange={(v) => update({ expiryEnabled: v })}>
            {t('config.expiry')}
          </Checkbox>
          <Checkbox id="scope-guard" checked={draft.scopeGuard !== 'warn'} onChange={(v) => update({ scopeGuard: v ? 'block' : 'warn' })}>
            {t('config.scopeGuard')}
          </Checkbox>
          <p className="muted small checkbox-hint">{t('config.scopeGuardHint')}</p>
        </div>
        <div className="subsection">
          <div className="stack-4">
            <h3 className="label-strong">{t('config.auditors')}</h3>
            <p className="muted small">{t('config.auditorsHint')}</p>
            <div>
              <Button size="sm" icon="external" onClick={() => openModule('gum-audit')}>
                {t('config.openAuditPage')}
              </Button>
            </div>
          </div>
          <Chips
            items={draft.auditorGroups ?? []}
            onRemove={(g) => update({ auditorGroups: (draft.auditorGroups ?? []).filter((x) => x !== g) })}
            removeLabel={(g) => t('config.unblock', { name: g })}
          />
          <SuggestInput
            label={t('config.auditorAdd')}
            placeholder={t('config.auditorPlaceholder')}
            buttonLabel={t('config.idpButton')}
            search={searchGroups}
            noResults={t('config.noResults')}
            onAdd={(v) => update({ auditorGroups: addUnique(draft.auditorGroups ?? [], v) })}
          />
        </div>
      </Section>

      {/* Own section so the AI switch is easy to find; off by default (also for installations that never saved it). */}
      <Section id="sec-ai" title={t('config.ai')} delay={0.1}>
        <div className="stack-4">
          <Checkbox id="ai-on" checked={draft.aiEnabled === true} onChange={(v) => update({ aiEnabled: v })}>
            {t('config.aiToggle')}
          </Checkbox>
          <p className="muted small checkbox-hint">{t('config.aiHint')}</p>
          {initial.aiStopped && (
            <p className="notice notice-warn">
              <Icon name="alert" size={16} />
              <span>{t('config.aiStopped')}</span>
            </p>
          )}
        </div>
      </Section>

      <Section id="sec-governance" title={t('config.governance')} hint={t('config.governanceHint')} delay={0.1}>
        <AutomationSettings draft={draft} update={update} />
      </Section>

      <Section id="sec-blocked" title={t('config.blocked')} hint={t('config.blockedHint')} delay={0.1}>
        <div className="fixed-block">
          <div className="row-between wrap">
            <h3 className="label-strong row-8">
              <Icon name="lock" size={15} />
              {t('config.fixed')}
            </h3>
            <span className="muted small">{t('config.fixedCount', { count: initial.defaults.coreBlockedGroups.length + initial.defaults.productAccessPatterns.length })}</span>
          </div>
          <p className="muted small">{t('config.fixedHint')}</p>
          <LockedChips items={initial.defaults.coreBlockedGroups} />
          <Button variant="link" size="sm" onClick={() => setShowProducts((s) => !s)} aria-expanded={showProducts}>
            {t('config.productGroups', { count: initial.defaults.productAccessPatterns.length })}
            <motion.span animate={{ rotate: showProducts ? 180 : 0 }} transition={{ duration: 0.2 }} style={{ display: 'inline-flex' }}>
              <Icon name="chevronDown" size={16} />
            </motion.span>
          </Button>
          <AnimatePresence initial={false}>
            {showProducts && (
              <motion.div {...collapse}>
                <LockedChips items={initial.defaults.productAccessPatterns} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="stack-12">
          <div className="stack-4">
            <h3 className="label-strong">{t('config.extraBlocked')}</h3>
            <p className="muted small">{t('config.extraBlockedHint')}</p>
          </div>
          {draft.blockedGroups.length > 0 && (
            <Chips items={draft.blockedGroups} onRemove={(g) => update({ blockedGroups: draft.blockedGroups.filter((x) => x !== g) })} removeLabel={(g) => t('config.unblock', { name: g })} />
          )}
          <SuggestInput
            label={t('config.blockAdd')}
            placeholder={t('config.blockPlaceholder')}
            buttonLabel={t('config.blockButton')}
            search={searchGroups}
            allowFree
            noResults={t('config.noResults')}
            onAdd={(v) =>
              isFixedEntry(v) ? notify({ type: 'info', title: t('config.alreadyFixed', { name: v }) }) : update({ blockedGroups: addUnique(draft.blockedGroups, v) })
            }
          />
        </div>
        <div className="stack-4">
          <Checkbox id="idp-ro" checked={draft.idpReadOnly} onChange={(v) => update({ idpReadOnly: v })}>
            {t('config.idp')}
          </Checkbox>
          <AnimatePresence initial={false}>
            {draft.idpReadOnly && (
              <motion.div {...collapse}>
                <div className="subsection">
                  <div className="stack-4">
                    <h3 className="label-strong">{t('config.idpGroups')}</h3>
                    <p className="muted small">{t('config.idpHint')}</p>
                  </div>
                  <Chips items={draft.idpGroups} onRemove={(g) => update({ idpGroups: draft.idpGroups.filter((x) => x !== g) })} removeLabel={(g) => t('config.unblock', { name: g })} />
                  <SuggestInput
                    label={t('config.idpAdd')}
                    placeholder={t('config.blockPlaceholder')}
                    buttonLabel={t('config.idpButton')}
                    search={searchGroups}
                    allowFree
                    noResults={t('config.noResults')}
                    onAdd={(v) => update({ idpGroups: addUnique(draft.idpGroups, v) })}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Section>

      <Section id="sec-projects" title={t('config.projects')} delay={0.15}>
        <fieldset className="radio-group">
          <legend className="sr-only">{t('config.projects')}</legend>
          <RadioCard name="projects" id="proj-all" layoutGroup="proj" checked={draft.projectsMode === 'all'} onSelect={() => update({ projectsMode: 'all' })}>
            <label htmlFor="proj-all" className="grow">
              {t('config.allProjects')}
            </label>
          </RadioCard>
          <RadioCard name="projects" id="proj-some" layoutGroup="proj" checked={draft.projectsMode === 'selected'} onSelect={() => update({ projectsMode: 'selected' })}>
            <label htmlFor="proj-some" className="grow">
              {t('config.someProjects')}
            </label>
          </RadioCard>
        </fieldset>
        <AnimatePresence initial={false}>
          {draft.projectsMode === 'selected' && (
            <motion.div {...collapse}>
              <div className="subsection">
                {draft.allowedProjects.length ? (
                  <Chips
                    items={draft.allowedProjects}
                    keyOf={(p) => p.id}
                    render={(p) => (
                      <>
                        <strong>{p.key}</strong>&nbsp;<span className="muted">{p.name}</span>
                      </>
                    )}
                    onRemove={(p) => update({ allowedProjects: draft.allowedProjects.filter((x) => x.id !== p.id) })}
                    removeLabel={(p) => t('config.unblock', { name: p.key })}
                  />
                ) : (
                  <p className="notice notice-warn">
                    <Icon name="alert" size={16} />
                    <span>{t('config.noProjects')}</span>
                  </p>
                )}
                <SuggestInput
                  label={t('config.projectSearch')}
                  placeholder={t('config.projectSearch')}
                  buttonLabel={t('config.idpButton')}
                  search={searchProjects}
                  noResults={t('config.noResults')}
                  onAdd={(p) => update({ allowedProjects: [...draft.allowedProjects, p] })}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Section>

      <div className="save-bar">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={dirty ? 'dirty' : 'clean'}
            className={`save-state ${dirty ? 'is-dirty' : ''}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease }}
          >
            {dirty && <span className="pulse-dot" />}
            {dirty ? t('config.dirty') : t('config.clean')}
          </motion.span>
        </AnimatePresence>
        <div className="row-12">
          <Button onClick={discard} disabled={!dirty || saving}>
            {t('config.discard')}
          </Button>
          <Button variant="primary" onClick={save} disabled={(!dirty && !justSaved) || monthsInvalid} loading={saving} success={justSaved}>
            {t('config.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
