import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button, Spinner } from '../../components/primitives.jsx';
import { ease } from '../../motion.js';

/**
 * Text input with async suggestions. Enter adds the active suggestion or, when
 * `allowFree` is set, the typed text (e.g. a wildcard pattern).
 * search(query) -> Promise<[{ id, label, sub?, value }]>
 */
export function SuggestInput({ label, placeholder, buttonLabel, search, onAdd, allowFree = false, noResults }) {
  const uid = useId();
  const inputId = `sg-${uid}`;
  const listId = `${inputId}-list`;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setItems([]);
      return undefined;
    }
    setLoading(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      search(q)
        .then((res) => {
          if (id !== reqRef.current) return;
          setItems(res);
          setActive(allowFree ? -1 : 0);
        })
        .catch(() => id === reqRef.current && setItems([]))
        .finally(() => id === reqRef.current && setLoading(false));
    }, 220);
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDoc = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const commit = (item) => {
    const value = item ? item.value : allowFree ? query.trim() : null;
    if (!value) return;
    onAdd(value);
    setQuery('');
    setItems([]);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(allowFree ? -1 : 0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(items[active]);
    } else if (e.key === 'Escape') setOpen(false);
  };

  const showList = open && query.trim().length > 0 && (items.length > 0 || (!loading && noResults));

  return (
    <div className="picker-row" ref={rootRef}>
      <div className="field grow">
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
        <div className="input-wrap">
          <input
            id={inputId}
            className="input"
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            autoComplete="off"
          />
          {loading && (
            <span className="input-spinner">
              <Spinner size={16} />
            </span>
          )}
        </div>
        <AnimatePresence>
          {showList && (
            <motion.ul
              id={listId}
              role="listbox"
              className="popover picker-list"
              initial={{ opacity: 0, y: -6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease } }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            >
              {items.length === 0 ? (
                <li className="option is-static muted">{noResults}</li>
              ) : (
                items.map((it, i) => (
                  <li
                    key={it.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`option ${i === active ? 'is-active' : ''}`}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => commit(it)}
                  >
                    {i === active && <motion.span layoutId={`${listId}-hl`} className="option-hl" transition={{ type: 'spring', stiffness: 700, damping: 48 }} />}
                    <span className="user-option-text">
                      <span>{it.label}</span>
                      {it.sub && <span className="muted small">{it.sub}</span>}
                    </span>
                  </li>
                ))
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
      <Button onClick={() => commit(items[active])} disabled={!query.trim() || (!allowFree && !items[active])}>
        {buttonLabel}
      </Button>
    </div>
  );
}
