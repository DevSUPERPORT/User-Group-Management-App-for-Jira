import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icon.jsx';
import { ease } from '../motion.js';

/**
 * Accessible listbox select (button + popup listbox) with animated popover.
 * options: [{ value, label }]
 */
export function Select({ id, label, value, options, onChange }) {
  const autoId = useId();
  const btnId = id ?? `sel-${autoId}`;
  const listId = `${btnId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const choose = (opt) => {
    onChange(opt.value);
    setOpen(false);
    rootRef.current?.querySelector('button')?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="field" ref={rootRef}>
      <label className="field-label" id={`${btnId}-label`} htmlFor={btnId}>
        {label}
      </label>
      <div className="select">
        <button
          id={btnId}
          type="button"
          className={`input select-trigger ${open ? 'is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={`${btnId}-label ${btnId}`}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="select-value">{current?.label}</span>
          <motion.span className="select-chevron" animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.22, ease }}>
            <Icon name="chevronDown" size={18} />
          </motion.span>
        </button>
        <AnimatePresence>
          {open && (
            <motion.ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-labelledby={`${btnId}-label`}
              aria-activedescendant={`${listId}-${active}`}
              className="popover select-list"
              onKeyDown={onKeyDown}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease } }}
              exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
            >
              {options.map((o, i) => (
                <li
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={`option ${i === active ? 'is-active' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  {i === active && <motion.span layoutId={`${listId}-hl`} className="option-hl" transition={{ type: 'spring', stiffness: 700, damping: 48 }} />}
                  <span className="option-label">{o.label}</span>
                  {o.value === value && <Icon name="check" size={16} className="option-check" />}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
