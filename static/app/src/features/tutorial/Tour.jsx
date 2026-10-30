import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion, useIsPresent } from 'framer-motion';
import { DEMO, call, inForge } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Button } from '../../components/primitives.jsx';
import { Icon } from '../../components/Icon.jsx';
import { ease } from '../../motion.js';
import { TOURS, TUTORIAL_VERSIONS } from './steps.js';

const GAP = 14; // between target and card
const PAD = 6; // spotlight padding around the target
const EDGE = 16; // minimum distance to the page edge

/**
 * Opens the tour once per user and surface, as soon as the page has loaded.
 * `start` reopens it from the "Tutorial" button.
 */
export function useTutorial(surface, ready) {
  const [open, setOpen] = useState(false);
  const checked = useRef(false);

  useEffect(() => {
    if (!ready || checked.current) return;
    checked.current = true;
    // Click-dummy: ?tour=off for screenshots and automated UI checks.
    if (DEMO && !inForge && new URLSearchParams(window.location.search).get('tour') === 'off') return;
    call('tutorialState')
      .then((res) => {
        if (!res?.seenVersion || res.seenVersion < TUTORIAL_VERSIONS[surface]) setOpen(true);
      })
      .catch(() => {});
  }, [ready, surface]);

  const close = useCallback(
    (completed) => {
      setOpen(false);
      call('markTutorialSeen', { version: TUTORIAL_VERSIONS[surface], completed }).catch(() => {});
    },
    [surface],
  );

  return { open, start: useCallback(() => setOpen(true), []), close };
}

export function TutorialButton({ onClick, disabled }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost" icon="help" className="tour-button" data-tour="help" onClick={onClick} disabled={disabled}>
      {t('tour.button')}
    </Button>
  );
}

// Target position in document coordinates, so the spotlight stays put while
// Jira scrolls the page around the app's iframe.
function measure(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
}

const same = (a, b) => a === b || (a && b && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

function place(rect, card, docWidth) {
  const width = Math.min(380, docWidth - 2 * EDGE);
  const height = card?.height ?? 240;
  const clampX = (x) => Math.max(EDGE, Math.min(x, docWidth - width - EDGE));
  if (!rect) return { top: window.scrollY + 96, left: clampX((docWidth - width) / 2), width };
  const right = rect.left + rect.width;
  if (docWidth - right - EDGE >= width + GAP) return { top: rect.top, left: right + GAP, width };
  if (rect.left - EDGE >= width + GAP) return { top: rect.top, left: rect.left - GAP - width, width };
  const left = clampX(rect.left + rect.width / 2 - width / 2);
  // Tall targets: put the card above when there is room, so it stays near the top of the target.
  if (rect.height > 280 && rect.top - height - GAP >= EDGE) return { top: rect.top - height - GAP, left, width };
  return { top: rect.top + rect.height + GAP, left, width };
}

export function Tour({ surface, onClose }) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  // Optional steps (e.g. "Request access" when requests are off) are dropped if their target is missing.
  const [steps] = useState(() => TOURS[surface].filter((s) => !s.optional || document.querySelector(s.target)));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const [card, setCard] = useState(null);
  const [docWidth, setDocWidth] = useState(() => document.documentElement.clientWidth);
  const cardRef = useRef(null);
  const anchorRef = useRef(null);
  const cardBelowRef = useRef(true);
  const primaryRef = useRef(null);
  const restoreRef = useRef(document.activeElement);
  // Closing must never leave a click-catching layer behind (see Modal).
  const isPresent = useIsPresent();

  const step = steps[index];
  const last = index === steps.length - 1;
  const key = (part) => `tour.${surface}.${step.id}.${part}`;

  // Follow the target while content loads, animates or the window resizes.
  useEffect(() => {
    let frame;
    const tick = () => {
      const next = measure(step.target);
      setRect((prev) => (same(prev, next) ? prev : next));
      setDocWidth((w) => (w === document.documentElement.clientWidth ? w : document.documentElement.clientWidth));
      const box = cardRef.current?.getBoundingClientRect();
      if (box) setCard((prev) => (prev && Math.abs(prev.height - box.height) < 1 ? prev : { height: box.height }));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [step.target]);

  // Bring target and card into view (inside Jira this scrolls the host page too).
  // An invisible anchor spans where both end up, so the scroll does not chase
  // the card while it is still animating.
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
    const reveal = (behavior) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const fits = box.height <= window.innerHeight - 2 * EDGE;
      // Too tall for the window: keep the card (the anchor's bottom or top end) fully visible.
      const block = fits ? 'center' : cardBelowRef.current ? 'end' : 'start';
      const topOk = box.top >= -1;
      const bottomOk = box.bottom <= window.innerHeight + 1;
      const visible = block === 'center' ? topOk && bottomOk : block === 'end' ? bottomOk && box.bottom > 0 : topOk && box.top < window.innerHeight;
      if (behavior === 'auto' && visible) return;
      anchor.scrollIntoView({ block, behavior });
    };
    // Wait for the card's new content (its height moves the anchor), then scroll.
    // Smooth scrolling can be cut short by layout changes, so check once more.
    const first = setTimeout(() => reveal(reduce ? 'auto' : 'smooth'), 320);
    const second = setTimeout(() => reveal('auto'), 1100);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
    };
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const restore = restoreRef.current;
    return () => restore?.focus?.({ preventScroll: true });
  }, []);

  const finish = (completed) => onClose(completed);
  const next = () => (last ? finish(true) : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'ArrowRight' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      back();
    } else if (e.key === 'Tab') {
      // Keep focus inside the card.
      const items = [...cardRef.current.querySelectorAll('button:not([disabled])')];
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    }
  };

  const pos = place(rect, card, docWidth);
  // Without a target the spotlight shrinks to a point behind the card: the page is simply dimmed.
  const spot = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD, opacity: 1 }
    : { top: pos.top + 60, left: pos.left + pos.width / 2, width: 0, height: 0, opacity: 1 };
  const cardHeight = card?.height ?? 240;
  const spanTop = Math.min(spot.top, pos.top);
  const spanBottom = Math.max(spot.top + spot.height, pos.top + cardHeight);
  // The card ends the span only when it sits below the target; beside a tall target
  // it is top-aligned, and scrolling to the span's end would hide it.
  cardBelowRef.current = pos.top + cardHeight >= spot.top + spot.height;
  const move = reduce ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 32 };
  const points = Array.from({ length: step.points ?? 0 }, (_, i) => t(key(`p${i + 1}`)));

  return createPortal(
    <div className={`tour-layer ${isPresent ? '' : 'is-leaving'}`} onKeyDown={isPresent ? onKeyDown : undefined}>
      <motion.div className="tour-catcher" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
      <div ref={anchorRef} className="tour-anchor" style={{ top: spanTop - EDGE, height: spanBottom - spanTop + 2 * EDGE }} aria-hidden="true" />
      <motion.div
        className={`tour-spot ${rect ? 'has-target' : ''}`}
        aria-hidden="true"
        initial={{ ...spot, opacity: 0 }}
        animate={spot}
        exit={{ opacity: 0, transition: { duration: 0.18 } }}
        transition={move}
      />
      <motion.div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={{ width: pos.width }}
        initial={{ top: pos.top, left: pos.left, opacity: 0, y: 12, scale: 0.97 }}
        animate={{ top: pos.top, left: pos.left, opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16, ease } }}
        transition={move}
      >
        <div className="tour-progress" aria-hidden="true">
          <motion.span className="tour-progress-bar" animate={{ width: `${((index + 1) / steps.length) * 100}%` }} transition={{ duration: reduce ? 0 : 0.4, ease }} />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step.id}
            className="tour-content"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.26, ease } }}
            exit={{ opacity: 0, x: -10, transition: { duration: 0.12 } }}
          >
            <div className="row-between">
              <span className="eyebrow" aria-live="polite">
                {t('tour.step', { current: index + 1, total: steps.length })}
              </span>
              <button type="button" className="tour-close" aria-label={t('tour.close')} onClick={() => finish(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <h2 id="tour-title" className="tour-title">
              {t(key('title'))}
            </h2>
            <p id="tour-body" className="tour-body">
              {t(key('body'))}
            </p>
            {points.length > 0 && (
              <ul className="tour-points">
                {points.map((p) => (
                  <li key={p}>
                    <Icon name="check" size={14} />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        </AnimatePresence>
        <div className="tour-actions">
          {index === 0 ? (
            <Button variant="ghost" size="sm" onClick={() => finish(false)}>
              {t('tour.skip')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" icon="chevronLeft" onClick={back}>
              {t('tour.back')}
            </Button>
          )}
          <Button ref={primaryRef} variant="primary" size="sm" onClick={next}>
            {index === 0 ? t('tour.start') : last ? t('tour.finish') : t('tour.next')}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
