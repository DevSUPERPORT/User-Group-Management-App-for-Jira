import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Checkbox, DrawCheck, IconButton, Spinner } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Select } from '../../components/Select.jsx';
import { NAME_PART_MAX, validateNamePart } from '../../../../../src/core/naming.js';
import { ease, shake } from '../../motion.js';
import { errorText } from '../errors.js';

const MAX_DESCRIPTION = 500;

// Typing help: uppercase becomes lowercase, spaces become hyphens.
const normalize = (v) => v.toLowerCase().replace(/\s+/g, '-');

// UC-01: create a group under the fixed prefix atlassian-<KEY>-.
export function CreateGroupDialog({ project, prefix, groups = [], onClose, onCreated }) {
  const { t } = useI18n();
  const [namePart, setNamePart] = useState('');
  const [description, setDescription] = useState('');
  const [addMe, setAddMe] = useState(true);
  // "Start with the members of …": saves re-adding everyone for a similar group.
  const [copyFrom, setCopyFrom] = useState('');
  const copySource = groups.find((g) => g.groupId === copyFrom);
  const [check, setCheck] = useState({ status: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const inputRef = useRef(null);
  const fieldControls = useAnimationControls();
  const reqRef = useRef(0);

  useEffect(() => {
    setSubmitError(null);
    if (!namePart) {
      setCheck({ status: 'idle' });
      return undefined;
    }
    const local = validateNamePart(namePart);
    if (local) {
      setCheck({ status: 'bad', reason: local });
      return undefined;
    }
    setCheck({ status: 'checking' });
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      call('checkName', { namePart })
        .then((res) => {
          if (id !== reqRef.current) return;
          setCheck(res.available ? { status: 'ok' } : { status: 'bad', reason: res.reason, conflict: res.conflict });
        })
        .catch((err) => id === reqRef.current && setCheck({ status: 'error', message: errorText(t, err) }));
    }, 320);
    return () => clearTimeout(timer);
  }, [namePart]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e?.preventDefault();
    if (check.status !== 'ok' || submitting || success) {
      fieldControls.start(shake);
      if (!namePart) setCheck({ status: 'bad', reason: 'EMPTY' });
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const group = await call('createGroup', { namePart, description, addMe, copyFromGroupId: copyFrom || null });
      setSuccess(true);
      setTimeout(() => onCreated(group), 650);
    } catch (err) {
      if (err.code === 'NAME_TAKEN') setCheck({ status: 'bad', reason: 'TAKEN', conflict: err.details?.conflict });
      else setSubmitError(errorText(t, err));
      fieldControls.start(shake);
    } finally {
      setSubmitting(false);
    }
  };

  const statusContent = {
    idle: { icon: <span className="status-dot" />, text: t('create.idle'), tone: 'muted' },
    checking: { icon: <Spinner size={16} />, text: t('create.checking'), tone: 'muted' },
    ok: {
      icon: (
        <span className="status-icon status-icon-ok">
          <DrawCheck size={12} strokeWidth={3.4} delay={0.05} />
        </span>
      ),
      text: t('create.available'),
      tone: 'ok',
    },
    bad: {
      icon: (
        <span className="status-icon status-icon-bad">
          <Icon name="close" size={12} strokeWidth={3} />
        </span>
      ),
      text: t(`create.reason.${check.reason}`, { conflict: check.conflict ?? '' }),
      tone: 'bad',
    },
    error: { icon: <Icon name="alert" size={16} />, text: check.message, tone: 'bad' },
  }[check.status];

  return (
    <Modal labelledBy="create-title" onClose={onClose} initialFocus={inputRef}>
      <form className="dialog-body" onSubmit={submit} noValidate>
        <div className="row-between start">
          <div className="stack-6">
            <div className="eyebrow with-dot">
              <span className="dot" />
              {t('create.eyebrow', { key: project.key })}
            </div>
            <h1 id="create-title" className="h1">
              {t('create.title')}
            </h1>
          </div>
          <IconButton icon="close" size={20} label={t('create.close')} onClick={onClose} />
        </div>

        <div className="stack-8">
          <label htmlFor="group-name" className="label-strong">
            {t('create.name')}
          </label>
          <motion.div animate={fieldControls} className={`prefixed ${check.status === 'bad' ? 'is-invalid' : ''} ${check.status === 'ok' ? 'is-valid' : ''}`}>
            <span className="prefixed-lock">
              <Icon name="lock" size={14} />
              {prefix}
            </span>
            <input
              ref={inputRef}
              id="group-name"
              type="text"
              value={namePart}
              maxLength={NAME_PART_MAX + 5}
              onChange={(e) => setNamePart(normalize(e.target.value))}
              aria-describedby="name-help name-status"
              aria-invalid={check.status === 'bad' || undefined}
              autoComplete="off"
              spellCheck="false"
            />
          </motion.div>
          <p id="name-help" className="muted small">
            {t('create.nameHelp')}
          </p>
        </div>

        <div className="preview">
          <div className="eyebrow">{t('create.preview')}</div>
          <div className="preview-name">
            <span className="gn-prefix">{prefix}</span>
            <AnimatePresence mode="popLayout" initial={false}>
              {namePart ? (
                <motion.span key="name" className="gn-name" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {namePart}
                </motion.span>
              ) : (
                <motion.span key="ph" className="preview-placeholder" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  name
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div id="name-status" className="preview-status" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={`${check.status}-${check.reason ?? ''}`}
                className={`status status-tone-${statusContent.tone}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease } }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              >
                {statusContent.icon}
                {statusContent.text}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>

        <div className="stack-8">
          <label htmlFor="group-desc" className="label-strong">
            {t('create.description')} <span className="muted normal">{t('create.optional')}</span>
          </label>
          <textarea
            id="group-desc"
            className="input textarea"
            rows={3}
            maxLength={MAX_DESCRIPTION}
            placeholder={t('create.descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="counter muted small" aria-hidden="true">
            {description.length}/{MAX_DESCRIPTION}
          </span>
        </div>

        {groups.length > 0 && (
          <div className="stack-8">
            <Select
              id="copy-from"
              label={t('create.copyFrom')}
              value={copyFrom}
              onChange={setCopyFrom}
              options={[
                { value: '', label: t('create.copyNone') },
                ...groups.filter((g) => !g.syncing).map((g) => ({ value: g.groupId, label: g.memberCount === null || g.memberCount === undefined ? g.name : `${g.name} · ${t('groups.members', { count: g.memberCount })}` })),
              ]}
            />
            <AnimatePresence initial={false}>
              {copySource && (
                <motion.p className="muted small" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                  {t('create.copyHint', { count: copySource.memberCount ?? 0 })}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        )}

        <Checkbox id="add-me" checked={addMe} onChange={setAddMe}>
          {t('create.addMe')}
        </Checkbox>

        <div className="notice">
          <Icon name="info" size={18} />
          <span>{t('create.note')}</span>
        </div>

        <AnimatePresence>
          {submitError && (
            <motion.div className="notice notice-error" role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Icon name="alert" size={18} />
              <span>{submitError}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="actions">
          <Button onClick={onClose}>{t('create.cancel')}</Button>
          <Button type="submit" variant="primary" loading={submitting} success={success} aria-disabled={check.status !== 'ok' || undefined} className={check.status !== 'ok' ? 'is-soft-disabled' : ''}>
            {t('create.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
