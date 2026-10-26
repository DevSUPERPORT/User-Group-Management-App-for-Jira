import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useI18n } from '../i18n/index.jsx';
import { ease } from '../motion.js';

const MARK =
  'm1041.1,852.78c20.92-47.16,31.4-97.7,31.4-151.66v-2.12c0-53.92-10.31-104.46-30.88-151.66-20.57-47.16-49.15-88.13-85.66-122.91-36.55-34.78-79.47-62.1-128.8-81.98-49.33-19.83-102.68-29.8-160.19-29.8s-111.04,10.13-160.71,30.36c-49.67,20.22-92.76,47.85-129.32,83.02-36.55,35.12-65.26,76.26-86.18,123.43-20.96,47.21-31.4,97.75-31.4,151.66v2.17c0,53.92,10.26,104.46,30.88,151.66,20.57,47.16,49.11,88.17,85.66,122.91,16.23,15.44,34.19,28.85,52.93,41.36,65.3-52.18,147.01-84.68,237.1-84.68s170.71,32.06,235.81,83.62c18.85-12.67,36.88-26.27,53.14-41.89,36.55-35.12,65.26-76.26,86.23-123.47Zm-370.99,9.56c-88.62,0-160.46-71.84-160.46-160.46s71.84-160.45,160.46-160.45,160.45,71.84,160.45,160.45-71.84,160.46-160.45,160.46Z';

export function Logo() {
  return (
    <motion.div
      className="logo"
      initial={{ scale: 0.6, opacity: 0, rotate: -8 }}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 22, delay: 0.05 }}
    >
      <motion.svg width="28" height="28" viewBox="0 0 1331.86 1331.86" aria-hidden="true" initial={{ y: 6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5, ease, delay: 0.18 }}>
        <path fill="currentColor" d={MARK} />
      </motion.svg>
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
