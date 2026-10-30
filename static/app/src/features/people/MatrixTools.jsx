import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button } from '../../components/primitives.jsx';
import { ease } from '../../motion.js';

const fold = (s) =>
  (s ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Button with a searchable popover list, for the people table's tool bar.
 * items: [{ id, label, sub?, disabled? }]
 * Single pick (onPick) or, with `checked` + `onToggle`, a checkbox list.
 */
export function MenuButton({ label, icon, items, onPick, checked, onToggle, footer, placeholder, emptyText, disabled, size = 'sm', align = 'left' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listId = `menu-${useId()}`;
  const multi = Boolean(onToggle);

  useEffect(() => {
    if (!open) return undefined;
    setQ('');
    setActive(0);
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    // After the opening click has finished (the button keeps focus otherwise).
    const focusTimer = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 40);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', onDoc);
    };
  }, [open]);

  const f = fold(q.trim());
  const shown = items.filter((it) => !f || fold(it.label).includes(f) || fold(it.sub).includes(f));

  const choose = (it) => {
    if (!it || it.disabled) return;
    if (multi) onToggle(it.id);
    else {
      onPick(it.id);
      setOpen(false);
    }
  };

  return (
    <div className={`menu ${align === 'right' ? 'menu-right' : ''}`} ref={rootRef}>
      <Button size={size} icon={icon} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <Icon name="chevronDown" size={14} className="menu-chevron" />
      </Button>
      {/* Rendered only while open (no exit animation), so it never sits on top of other controls. */}
      {open && (
        <motion.div className="popover menu-pop" initial={{ opacity: 0, y: -6, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease } }}>
          <div className="input-icon menu-search">
            <Icon name="search" size={16} />
            <input
              ref={inputRef}
              className="input input-sm"
              value={q}
              placeholder={placeholder ?? t('matrix.search')}
              aria-label={placeholder ?? t('matrix.search')}
              aria-controls={listId}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(shown.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  choose(shown[active]);
                } else if (e.key === 'Escape') setOpen(false);
              }}
            />
          </div>
          <ul id={listId} role="listbox" aria-multiselectable={multi || undefined} className="menu-list">
            {shown.length === 0 && <li className="option is-static muted small">{emptyText ?? t('matrix.noResults')}</li>}
            {shown.map((it, i) => {
              const on = multi && checked?.has(it.id);
              return (
                <li
                  key={it.id}
                  role="option"
                  aria-selected={multi ? on : i === active}
                  aria-disabled={it.disabled || undefined}
                  className={`option menu-option ${i === active ? 'is-active' : ''} ${it.disabled ? 'is-disabled' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(it)}
                >
                  {multi && <span className={`menu-check ${on ? 'is-on' : ''}`}>{on && <Icon name="check" size={12} strokeWidth={3} />}</span>}
                  <span className="member-text">
                    <span className="break">{it.label}</span>
                    {it.sub && <span className="muted small break">{it.sub}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {footer && <div className="menu-footer">{footer({ close: () => setOpen(false) })}</div>}
        </motion.div>
      )}
    </div>
  );
}

// Which groups the people table shows as columns. Stored per project in this
// browser only; a convenience, never a permission.
export function loadHidden(projectKey) {
  try {
    const raw = window.localStorage.getItem(`gum.matrix.hidden.${projectKey}`);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveHidden(projectKey, hidden) {
  try {
    window.localStorage.setItem(`gum.matrix.hidden.${projectKey}`, JSON.stringify([...hidden]));
  } catch {
    // Storage blocked (private window, previews): the choice lasts for this visit.
  }
}
