import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, useIsPresent } from 'framer-motion';
import { ease } from '../motion.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog with backdrop, focus trap, Escape to close and focus restore.
 * Render inside <AnimatePresence> for enter/exit animations.
 */
export function Modal({ labelledBy, onClose, children, initialFocus, width = 600 }) {
  const dialogRef = useRef(null);
  const restoreRef = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  // While closing, the layer must never block the page: inside Jira the exit
  // animation can stall (seen live after "Create group"), which left an invisible
  // full-page layer that swallowed every click and scroll.
  const isPresent = useIsPresent();

  useEffect(() => {
    const node = dialogRef.current;
    const target = initialFocus?.current ?? node?.querySelector(FOCUSABLE);
    target?.focus({ preventScroll: true });
    // Inside the Jira iframe the dialog may open below the fold.
    node?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const restore = restoreRef.current;
    return () => restore?.focus?.({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    if (!isPresent) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
    if (e.key === 'Tab') {
      const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div className={`modal-layer ${isPresent ? '' : 'is-leaving'}`} onKeyDown={onKeyDown} aria-hidden={isPresent ? undefined : true}>
      <motion.div
        className="modal-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.28, ease } }}
        exit={{ opacity: 0, transition: { duration: 0.2, ease } }}
        onClick={isPresent ? onClose : undefined}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="modal"
        style={{ maxWidth: width }}
        initial={{ opacity: 0, y: 28, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 32 } }}
        exit={{ opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.18, ease } }}
      >
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}
