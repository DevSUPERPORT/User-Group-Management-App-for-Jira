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

// Group writes always run through the Atlassian Organization API (Atlassian does
// not let apps create groups through the Jira REST API). Every site connects its
// own organization here; the key is stored encrypted for this installation only
// and never comes back to the browser.
function OrgConnectionSection({ initialStatus }) {
  const { t, fmt } = useI18n();
  const notify = useNotify();
  const [conn, setConn] = useState(initialStatus ?? { configured: false });
  const [editing, setEditing] = useState(!initialStatus?.configured);
  const [orgId, setOrgId] = useState(initialStatus?.orgId ?? '');
  const [apiKey, setApiKey] = useState('');
  const [directories, setDirectories] = useState(null);
  const [directoryId, setDirectoryId] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const test = async () => {
    setTesting(true);
    try {
      setResult(await call('testOrgApi'));
    } catch (err) {
      setResult({ ok: false, error: { message: errorText(t, err) } });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (conn.configured) test();
  }, [conn.configured, conn.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeForm = () => {
    setEditing(false);
    setApiKey('');
    setFormError(null);
    setDirectories(null);
    setDirectoryId('');
  };

  const save = async (e) => {
    e.preventDefault();
    setFormError(null);
    if (!orgId.trim() || !apiKey.trim()) {
      setFormError(t('config.orgFieldsMissing'));
      return;
    }
    setSaving(true);
    try {
      const status = await call('saveOrgConnection', { orgId: orgId.trim(), apiKey: apiKey.trim(), directoryId: directoryId || null });
      setConn(status);
      setResult(null);
      closeForm();
      notify({ type: 'success', title: t('config.orgSaved') });
    } catch (err) {
      if (err.code === 'ORG_DIRECTORY_REQUIRED' && err.details?.directories?.length) {
        setDirectories(err.details.directories);
        setDirectoryId(err.details.directories[0].directoryId);
        setFormError(t('config.orgPickDirectory'));
      } else {
        setFormError(errorText(t, err));
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      setConn(await call('removeOrgConnection'));
      setConfirmRemove(false);
      setEditing(true);
      setResult(null);
      notify({ type: 'info', title: t('config.orgRemoved') });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err) });
    } finally {
      setSaving(false);
    }
  };

  const status = !conn.configured ? 'missing' : testing && !result ? 'checking' : result?.ok ? 'ok' : result ? 'error' : 'checking';
  const statusText = {
    missing: t('config.orgNotSet'),
    checking: t('config.orgChecking'),
    ok: t('config.orgOk', { name: conn.directoryName ?? conn.directoryId }),
    error: t('config.orgFail', { message: result?.error?.message ?? t('config.orgDirectoryGone') }),
  }[status];

  return (
    <Section id="sec-org" title={t('config.org')} hint={t('config.orgHint')} delay={0.08}>
      <div className={`org-status is-${status}`} role="status" aria-live="polite">
        <span className="org-status-light" aria-hidden="true" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={status + statusText} className="grow" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease }}>
            {statusText}
          </motion.span>
        </AnimatePresence>
        {conn.configured && (
          <Button size="sm" icon="refresh" onClick={test} loading={testing}>
            {t('config.orgTest')}
          </Button>
        )}
      </div>

      {conn.configured && !editing && (
        <div className="subsection org-details">
          <p className="small muted">
            {t('config.orgDetails', { orgId: conn.orgId })}
            {conn.updatedAt ? ` · ${t('config.orgSavedBy', { when: fmt.dateTime(conn.updatedAt), name: conn.updatedBy?.displayName ?? '–' })}` : ''}
          </p>
          {confirmRemove ? (
            <div className="org-actions">
              <span className="small grow">{t('config.orgRemoveConfirm')}</span>
              <Button size="sm" onClick={() => setConfirmRemove(false)}>
                {t('config.orgCancel')}
              </Button>
              <Button size="sm" variant="danger" loading={saving} onClick={remove}>
                {t('config.orgRemove')}
              </Button>
            </div>
          ) : (
            <div className="org-actions">
              <Button size="sm" onClick={() => setEditing(true)}>
                {t('config.orgReplace')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                {t('config.orgRemove')}
              </Button>
            </div>
          )}
        </div>
      )}

      <AnimatePresence initial={false}>
        {editing && (
          <motion.div {...collapse}>
            <form className="subsection org-form" onSubmit={save} noValidate>
              <p className="small">{t('config.orgHowTo')}</p>
              <div className="stack-6">
                <label htmlFor="org-id" className="label-strong">
                  {t('config.orgIdLabel')}
                </label>
                <input id="org-id" className="input" type="text" autoComplete="off" spellCheck={false} value={orgId} onChange={(e) => setOrgId(e.target.value)} />
                <span className="small muted">{t('config.orgIdHelp')}</span>
              </div>
              <div className="stack-6">
                <label htmlFor="org-key" className="label-strong">
                  {t('config.orgKeyLabel')}
                </label>
                <input id="org-key" className="input" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <span className="small muted">{t('config.orgKeyHelp')}</span>
              </div>
              {directories && (
                <div className="stack-6">
                  <label htmlFor="org-dir" className="label-strong">
                    {t('config.orgDirectoryLabel')}
                  </label>
                  <select id="org-dir" className="input" value={directoryId} onChange={(e) => setDirectoryId(e.target.value)}>
                    {directories.map((d) => (
                      <option key={d.directoryId} value={d.directoryId}>
                        {d.name ?? d.directoryId}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {formError && (
                <div className="notice notice-error" role="alert">
                  <Icon name="alert" size={18} />
                  <span>{formError}</span>
                </div>
              )}
              <div className="org-actions">
                <Button type="submit" variant="primary" loading={saving}>
                  {t('config.orgSave')}
                </Button>
                {conn.configured && <Button onClick={closeForm}>{t('config.orgCancel')}</Button>}
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

// Fixed entries of the block list: shown with a lock, no remove button.
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

export function AdminConfig({ initial, onSaved }) {
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

      <OrgConnectionSection initialStatus={initial.orgApi} />

      <Section id="sec-roles" title={t('config.roles')} hint={t('config.rolesHint')} delay={0.09}>
        <div className="stack-4">
          <Checkbox id="member-view" checked={draft.memberViewEnabled !== false} onChange={(v) => update({ memberViewEnabled: v })}>
            {t('config.memberView')}
          </Checkbox>
          <p className="muted small checkbox-hint">{t('config.memberViewWhere')}</p>
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
