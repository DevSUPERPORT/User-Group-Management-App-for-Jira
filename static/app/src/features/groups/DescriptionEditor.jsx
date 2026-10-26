import { useEffect, useState } from 'react';

// The editor mounts only after the view has animated out, so it focuses itself
// on mount (cursor at the end) instead of relying on an effect in the parent.
const focusAtEnd = (el) => {
  if (!el || el.dataset.focused) return;
  el.dataset.focused = '1';
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
};
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Button, IconButton } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { ease } from '../../motion.js';
import { errorText } from '../errors.js';

const MAX = 500;

// Inline editor for a group's description (the app's own text for the group).
export function DescriptionEditor({ group, onSaved }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(group.description ?? '');
  const [saving, setSaving] = useState(false);
  const text = group.description ?? '';

  useEffect(() => {
    setEditing(false);
    setValue(group.description ?? '');
  }, [group.groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    setValue(text);
    setEditing(true);
  };

  const persist = async (next, reason = null) => {
    const res = await call('updateDescription', { groupId: group.groupId, description: next, reason });
    onSaved(res.description);
    return res;
  };

  const save = async () => {
    if (value.trim() === text.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await persist(value);
      setEditing(false);
      notify({
        type: 'success',
        title: t('notify.descriptionSaved'),
        action: {
          label: t('notify.undo'),
          onClick: () =>
            persist(res.previous, 'undo')
              .then(() => notify({ type: 'info', title: t('notify.undone') }))
              .catch((err) => notify({ type: 'error', title: t('notify.undoFailed'), description: errorText(t, err) })),
        },
      });
    } catch (err) {
      notify({ type: 'error', title: errorText(t, err), action: { label: t('notify.retry'), onClick: save } });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="desc">
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div
            key="edit"
            className="desc-edit"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease } }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
          >
            <label htmlFor={`desc-${group.groupId}`} className="sr-only">
              {t('detail.descriptionLabel')}
            </label>
            <textarea
              ref={focusAtEnd}
              id={`desc-${group.groupId}`}
              className="input textarea desc-area"
              rows={3}
              maxLength={MAX}
              placeholder={t('detail.descriptionPlaceholder')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              aria-describedby={`desc-keys-${group.groupId}`}
            />
            <div className="desc-bar">
              <span id={`desc-keys-${group.groupId}`} className="muted small">
                {t('detail.descriptionKeys')} · {value.length}/{MAX}
              </span>
              <span className="row-8">
                <Button size="sm" onClick={() => setEditing(false)} disabled={saving}>
                  {t('detail.descriptionCancel')}
                </Button>
                <Button size="sm" variant="dark" onClick={save} loading={saving} disabled={value.trim() === text.trim()}>
                  {t('detail.descriptionSave')}
                </Button>
              </span>
            </div>
          </motion.div>
        ) : text ? (
          <motion.div
            key={`view-${text}`}
            className="desc-view"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.25, ease } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          >
            <p className="desc-text">{text}</p>
            <IconButton icon="pencil" size={16} label={t('detail.editDescription')} className="icon-btn-sm desc-pencil" onClick={start} />
          </motion.div>
        ) : (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
            <Button variant="link" size="sm" icon="plus" className="desc-add" onClick={start}>
              {t('detail.addDescription')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

