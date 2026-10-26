// One motion vocabulary for the whole app: quick, springy, never bouncy.
export const ease = [0.22, 1, 0.36, 1];

export const spring = { type: 'spring', stiffness: 520, damping: 42, mass: 0.9 };
export const softSpring = { type: 'spring', stiffness: 320, damping: 34 };
export const snappy = { type: 'spring', stiffness: 700, damping: 45 };

export const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.36, ease } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease } },
};

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.24, ease } },
  exit: { opacity: 0, transition: { duration: 0.14, ease } },
};

export const listParent = (stagger = 0.035, delay = 0) => ({
  initial: {},
  animate: { transition: { staggerChildren: stagger, delayChildren: delay } },
});

export const listChild = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.34, ease } },
};

export const collapse = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto', transition: { height: { duration: 0.32, ease }, opacity: { duration: 0.24, delay: 0.06 } } },
  exit: { opacity: 0, height: 0, transition: { height: { duration: 0.26, ease }, opacity: { duration: 0.12 } } },
};

export const shake = { x: [0, -7, 7, -4, 4, 0], transition: { duration: 0.38 } };
