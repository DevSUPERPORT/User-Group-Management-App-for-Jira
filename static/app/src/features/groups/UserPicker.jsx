import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { call } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Button, Spinner } from '../../components/primitives.jsx';
import { ease, snappy } from '../../motion.js';

// UC-03: user picker (search by name or email), several people at once.
export function UserPicker({ knownMemberIds, onSubmit }) {
  const { t } = useI18n();
  const uid = useId();
  const inputId = `picker-${uid}`;
  const listId = `${inputId}-list`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      call('searchUsers', { query: q })
        .then((res) => {
          if (id !== reqRef.current) return;
          setResults(res.users);
          setActive(0);
        })
        .catch(() => id === reqRef.current && setResults([]))
        .finally(() => id === reqRef.current && setSearching(false));
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const isMember = (u) => knownMemberIds.has(u.accountId);
  const isPicked = (u) => selected.some((s) => s.accountId === u.accountId);

  const pick = (u) => {
    if (!u || isMember(u)) return;
    setSelected((s) => (isPicked(u) ? s.filter((x) => x.accountId !== u.accountId) : [...s, u]));
    setQuery('');
    setResults([]);
    inputRef.current?.focus();
  };

  const submit = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      await onSubmit(selected.map((s) => s.accountId));
      setDone(true);
      setSelected([]);
      setQuery('');
      setTimeout(() => setDone(false), 900);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // With text typed, Enter only ever picks; it submits only from an empty input.
      if (query.trim()) {
        if (results[active] && !searching) pick(results[active]);
      } else submit();
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !query && selected.length) {
      setSelected((s) => s.slice(0, -1));
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="picker-row" ref={rootRef}>
      <div className="field grow">
        <label htmlFor={inputId} className="field-label">
          {t('members.add')}
        </label>
        <div className={`input picker ${open ? 'is-open' : ''}`} onClick={() => inputRef.current?.focus()}>
          <AnimatePresence initial={false}>
            {selected.map((u) => (
              <motion.span
                key={u.accountId}
                className="chip"
                layout
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
                transition={snappy}
              >
                <Avatar name={u.displayName} url={u.avatarUrl} size={22} />
                {u.displayName}
                <button type="button" className="chip-x" aria-label={t('members.removeChip', { name: u.displayName })} onClick={() => pick(u)}>
                  <Icon name="close" size={12} strokeWidth={2.4} />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
            placeholder={selected.length ? '' : t('members.addPlaceholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            autoComplete="off"
          />
          {searching && <Spinner size={16} />}
        </div>
        <AnimatePresence>
          {showList && (
            <motion.ul
              id={listId}
              role="listbox"
              className="popover picker-list"
              initial={{ opacity: 0, y: -6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease } }}
            >
              {query.trim().length < 2 ? (
                <li className="option is-static muted">{t('members.typeMore')}</li>
              ) : results.length === 0 && !searching ? (
                <li className="option is-static muted">{t('members.noUsers')}</li>
              ) : results.length === 0 ? (
                <li className="option is-static muted">{t('members.searching')}</li>
              ) : (
                results.map((u, i) => {
                  const member = isMember(u);
                  return (
                    <motion.li
                      key={u.accountId}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={isPicked(u)}
                      aria-disabled={member || undefined}
                      className={`option user-option ${i === active ? 'is-active' : ''} ${member ? 'is-disabled' : ''}`}
                      onPointerEnter={() => setActive(i)}
                      onClick={() => pick(u)}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0, transition: { duration: 0.22, ease, delay: i * 0.02 } }}
                    >
                      {i === active && <span className="option-hl" />}
                      <Avatar name={u.displayName} url={u.avatarUrl} size={30} dim={!u.active} />
                      <span className="user-option-text">
                        <span>{u.displayName}</span>
                        <span className="muted small">{u.email ?? t('members.emailHidden')}</span>
                      </span>
                      {member ? <span className="muted small">{t('members.already')}</span> : isPicked(u) ? <Icon name="check" size={16} className="option-check" /> : null}
                    </motion.li>
                  );
                })
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
      <Button variant="dark" onClick={submit} disabled={!selected.length} loading={busy} success={done}>
        {selected.length > 1 ? t('members.addButtonN', { count: selected.length }) : t('members.addButton')}
      </Button>
    </div>
  );
}
