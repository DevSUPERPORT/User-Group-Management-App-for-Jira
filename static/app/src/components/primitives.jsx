import { forwardRef, useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useReducedMotion } from 'framer-motion';
import { Icon } from './Icon.jsx';
import { ease, snappy } from '../motion.js';

export function Spinner({ size = 16 }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// Check mark that draws itself.
export function DrawCheck({ size = 14, strokeWidth = 3, delay = 0 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <motion.path
        d="M5 12l5 5L20 7"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.36, ease, delay }}
      />
    </svg>
  );
}

/**
 * Button with press feedback and morphing loading / success states.
 * variant: primary | dark | secondary | ghost | link | danger
 */
export const Button = forwardRef(function Button(
  { variant = 'secondary', icon, loading = false, success = false, children, className = '', disabled, type = 'button', size, ...rest },
  ref,
) {
  const state = success ? 'success' : loading ? 'loading' : 'idle';
  return (
    <motion.button
      ref={ref}
      type={type}
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      whileTap={disabled || loading ? undefined : { scale: 0.97 }}
      transition={snappy}
      {...rest}
    >
      <span className="btn-inner" data-state={state}>
        {icon && <Icon name={icon} size={18} />}
        <span>{children}</span>
      </span>
      <AnimatePresence>
        {state !== 'idle' && (
          <motion.span
            className="btn-overlay"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.18, ease }}
          >
            {state === 'loading' ? <Spinner size={18} /> : <DrawCheck size={20} />}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
});

export function IconButton({ icon, label, className = '', size = 18, ...rest }) {
  return (
    <motion.button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} whileTap={{ scale: 0.9 }} transition={snappy} {...rest}>
      <Icon name={icon} size={size} />
    </motion.button>
  );
}

// Animated number: counts from the previous value to the next.
export function CountUp({ value, duration = 0.7 }) {
  const ref = useRef(null);
  const prev = useRef(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const node = ref.current;
    if (!node || value === null || value === undefined) return undefined;
    if (reduce) {
      node.textContent = value.toLocaleString();
      prev.current = value;
      return undefined;
    }
    const controls = animate(prev.current, value, {
      duration,
      ease,
      onUpdate: (v) => {
        node.textContent = Math.round(v).toLocaleString();
      },
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);
  return <span ref={ref} className="tabular">{value === null || value === undefined ? '–' : '0'}</span>;
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function Avatar({ name, url, size = 36, dim = false }) {
  const [failed, setFailed] = useState(false);
  const hash = [...(name ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span className={`avatar ${dim ? 'is-dim' : ''}`} data-tone={hash % 6} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : initials(name)}
    </span>
  );
}

export function Skeleton({ width = '100%', height = 14, radius = 6, style }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

export function Checkbox({ id, checked, onChange, children, disabled }) {
  return (
    <label htmlFor={id} className={`check ${disabled ? 'is-disabled' : ''}`}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="check-box" aria-hidden="true">
        <AnimatePresence initial={false}>
          {checked && (
            <motion.svg key="c" width="14" height="14" viewBox="0 0 24 24" fill="none" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <motion.path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.22, ease }} />
            </motion.svg>
          )}
        </AnimatePresence>
      </span>
      <span>{children}</span>
    </label>
  );
}

export function Pill({ icon, children, tone = 'soft' }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function GroupName({ prefix, name }) {
  return (
    <>
      <span className="gn-prefix">{prefix}</span>
      <span className="gn-name">{name}</span>
    </>
  );
}
