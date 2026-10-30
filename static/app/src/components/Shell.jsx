import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useI18n } from '../i18n/index.jsx';
import { ease } from '../motion.js';

// The app icon: people in a circle on the orange tile (same as static/icons/group-self-service.svg).
export function Logo() {
  return (
    <motion.div
      className="logo"
      initial={{ scale: 0.6, opacity: 0, rotate: -8 }}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 22, delay: 0.05 }}
    >
      <svg width="44" height="44" viewBox="0 0 1920 1920" aria-hidden="true">
        <rect width="1920" height="1920" rx="420" fill="#e34a04" />
        <motion.g initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5, ease, delay: 0.18 }}>
          <g fill="none" stroke="#fff" strokeWidth="83" strokeLinecap="round">
            <circle cx="960" cy="960" r="675" />
            <circle cx="600" cy="840" r="105" />
            <circle cx="1320" cy="840" r="105" />
            <path d="M660 1350a300 300 0 0 1 600 0M690 1080A260 260 0 0 0 390 1238M1230 1080A260 260 0 0 1 1530 1238" />
          </g>
          <circle cx="960" cy="780" r="165" fill="#fff" />
        </motion.g>
      </svg>
    </motion.div>
  );
}

// Header with the design's dot grid. Near the pointer the dots light up in the
// accent colour (a masked second dot layer that follows the cursor).
function DotField() {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || reduce) return undefined;
    let frame = 0;
    const move = (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`);
        ref.current.style.setProperty('--my', `${e.clientY - r.top}px`);
        ref.current.style.setProperty('--glow', '1');
      });
    };
    const leave = () => ref.current?.style.setProperty('--glow', '0');
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [reduce]);
  return (
    <div ref={ref} className="dotfield" aria-hidden="true">
      <div className="dotfield-base" />
      <div className="dotfield-glow" />
    </div>
  );
}

export function Header({ title, actions, tabs, maxWidth = 1200 }) {
  const { t } = useI18n();
  return (
    <header className="app-header">
      <DotField />
      <div className="container header-inner" style={{ maxWidth }}>
        <div className="header-row">
          <div className="brand">
            <Logo />
            <div className="brand-text">
              <motion.div className="eyebrow" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, ease, delay: 0.12 }}>
                {t('appName')}
              </motion.div>
              <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.18 }}>
                {title}
              </motion.h1>
            </div>
          </div>
          {actions && (
            <motion.div className="header-actions" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease, delay: 0.26 }}>
              {actions}
            </motion.div>
          )}
        </div>
        {tabs}
      </div>
    </header>
  );
}

export function Tabs({ items, value, onChange, id = 'tabs' }) {
  const onKeyDown = (e) => {
    const idx = items.findIndex((i) => i.value === value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = items[(idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
      onChange(next.value);
      document.getElementById(`${id}-${next.value}`)?.focus();
    }
  };
  return (
    <nav className="tabs" role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            id={`${id}-${item.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${id}-panel`}
            tabIndex={selected ? 0 : -1}
            className={`tab ${selected ? 'is-selected' : ''}`}
            onClick={() => onChange(item.value)}
          >
            {item.label}
            <AnimatePresence initial={false}>
              {item.badge > 0 && (
                <motion.span key="badge" className="tab-badge" initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 30 }}>
                  {item.badge}
                </motion.span>
              )}
            </AnimatePresence>
            {selected && <motion.span layoutId={`${id}-underline`} className="tab-underline" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
          </button>
        );
      })}
    </nav>
  );
}

export function Footer({ maxWidth = 1200 }) {
  const { t } = useI18n();
  return (
    <footer className="container app-footer" style={{ maxWidth }}>
      <span className="dot" />
      <span>{t('madeBy')}</span>
    </footer>
  );
}
