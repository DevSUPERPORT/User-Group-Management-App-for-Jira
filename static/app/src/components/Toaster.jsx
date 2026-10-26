import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icon.jsx';
import { DrawCheck } from './primitives.jsx';
import { inForge, nativeFlag } from '../api/client.js';

const ToastContext = createContext(() => {});

const UNDO_WINDOW = 10000;

// Inside Jira, notifications use native Jira flags (the app iframe grows with its
// content, so a fixed toast could sit outside the viewport); their actions carry
// "Undo" / "Retry". The click-dummy renders its own toasts.
//
// notify({ type, title, description, action: { label, onClick } })
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    ({ type = 'success', title, description, action }) => {
      const id = ++seq.current;
      if (inForge) {
        let closeFlag = null;
        const flag = nativeFlag({
          id,
          title,
          description,
          type,
          isAutoDismiss: type !== 'error' && !action,
          actions: action
            ? [
                {
                  text: action.label,
                  onClick: () => {
                    closeFlag?.();
                    action.onClick();
                  },
                },
              ]
            : undefined,
        });
        Promise.resolve(flag).then((f) => {
          closeFlag = () => f?.close?.();
          if (action) setTimeout(() => closeFlag?.(), UNDO_WINDOW);
        });
        return;
      }
      setToasts((ts) => [...ts.slice(-3), { id, type, title, description, action }]);
      setTimeout(() => dismiss(id), action ? UNDO_WINDOW : type === 'error' ? 7000 : 4200);
    },
    [dismiss],
  );

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              className={`toast toast-${t.type}`}
              initial={{ opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 460, damping: 34 } }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
            >
              <span className="toast-icon">{t.type === 'success' ? <DrawCheck size={14} delay={0.1} /> : <Icon name={t.type === 'error' ? 'alert' : 'info'} size={15} />}</span>
              <span className="toast-text">
                <strong>{t.title}</strong>
                {t.description && <span>{t.description}</span>}
              </span>
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    dismiss(t.id);
                    t.action.onClick();
                  }}
                >
                  {t.action.label}
                  <span className="toast-timer" style={{ animationDuration: `${UNDO_WINDOW}ms` }} aria-hidden="true" />
                </button>
              )}
              <button type="button" className="toast-close" aria-label="×" onClick={() => dismiss(t.id)}>
                <Icon name="close" size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useNotify() {
  return useContext(ToastContext);
}
