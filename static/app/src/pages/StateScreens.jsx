import { motion } from 'framer-motion';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from '../components/Icon.jsx';
import { Button, Skeleton } from '../components/primitives.jsx';
import { Footer, Logo } from '../components/Shell.jsx';
import { errorText } from '../features/errors.js';
import { ease } from '../motion.js';

const TITLES = { FORBIDDEN: 'error.noAccessTitle', NOT_ADMIN: 'error.noAccessTitle', PROJECT_NOT_ALLOWED: 'error.notAllowedTitle' };

export function StateScreen({ error, onRetry }) {
  const { t } = useI18n();
  const known = TITLES[error?.code];
  return (
    <div className="page">
      <main className="container state-screen">
        <motion.div className="card state-card" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease }}>
          <Logo />
          <h1 className="h2">{t(known ?? 'error.title')}</h1>
          <p className="muted">{errorText(t, error)}</p>
          {!known && (
            <Button variant="dark" icon="refresh" onClick={onRetry}>
              {t('error.retry')}
            </Button>
          )}
        </motion.div>
      </main>
      <Footer />
    </div>
  );
}

// A small composition of the design's dot grid with the "+" of the create action.
function EmptyArt() {
  const dots = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) dots.push([x, y]);
  return (
    <svg width="220" height="120" viewBox="0 0 220 120" aria-hidden="true" className="empty-art">
      {dots.map(([x, y], i) => (
        <motion.circle
          key={i}
          cx={22 + x * 22}
          cy={16 + y * 22}
          r="2"
          fill="var(--line-strong)"
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.15 + (Math.abs(x - 4) + Math.abs(y - 2)) * 0.05, duration: 0.35, ease }}
        />
      ))}
      <motion.g initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.5 }} style={{ originX: '110px', originY: '60px' }}>
        <rect x="88" y="38" width="44" height="44" rx="10" fill="var(--accent)" />
        <path d="M110 50v20M100 60h20" stroke="var(--on-accent)" strokeWidth="3" strokeLinecap="round" />
      </motion.g>
    </svg>
  );
}

export function EmptyGroups({ projectKey, onCreate }) {
  const { t } = useI18n();
  return (
    <div className="card empty-state">
      <EmptyArt />
      <h2 className="h2">{t('groups.emptyTitle', { key: projectKey })}</h2>
      <p className="muted">{t('groups.emptyText')}</p>
      <Button variant="primary" icon="plus" onClick={onCreate}>
        {t('project.create')}
      </Button>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="card detail-card" aria-hidden="true">
      <div className="stack-8">
        <Skeleton width="55%" height={26} />
        <Skeleton width="40%" height={14} />
        <Skeleton width="62%" height={12} />
      </div>
      <div className="usage-grid">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={96} radius={10} />
        ))}
      </div>
      <div className="stack-8">
        <Skeleton width={140} height={18} />
        <Skeleton height={44} radius={10} />
        {[0, 1, 2].map((i) => (
          <div key={i} className="member-row">
            <Skeleton width={36} height={36} radius={18} />
            <span className="member-text">
              <Skeleton width="40%" height={14} />
              <Skeleton width="55%" height={11} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DemoBar({ surface, lang }) {
  const { t } = useI18n();
  const link = (patch) => {
    const p = new URLSearchParams(window.location.search);
    Object.entries(patch).forEach(([k, v]) => p.set(k, v));
    return `?${p.toString()}`;
  };
  const dark = document.documentElement.dataset.colorMode === 'dark';
  return (
    <motion.nav className="demo-bar" aria-label={t('demo.label')} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.8, type: 'spring', stiffness: 300, damping: 26 }}>
      <span className="demo-label">
        <Icon name="settings" size={14} />
        {t('demo.label')}
      </span>
      <a href={link({ view: 'project' })} aria-current={surface === 'project' ? 'page' : undefined}>
        {t('demo.project')}
      </a>
      <a href={link({ view: 'admin' })} aria-current={surface === 'admin' ? 'page' : undefined}>
        {t('demo.admin')}
      </a>
      <a href={link({ view: 'member' })} aria-current={surface === 'member' ? 'page' : undefined}>
        {t('demo.member')}
      </a>
      <a href={link({ view: 'auditor' })} aria-current={surface === 'auditor' ? 'page' : undefined}>
        {t('demo.auditor')}
      </a>
      <span className="demo-sep" />
      <a href={link({ lang: 'de' })} aria-current={lang === 'de' ? 'true' : undefined}>
        DE
      </a>
      <a href={link({ lang: 'en' })} aria-current={lang === 'en' ? 'true' : undefined}>
        EN
      </a>
      <span className="demo-sep" />
      <a href={link({ theme: dark ? 'light' : 'dark' })}>{dark ? 'Light' : 'Dark'}</a>
    </motion.nav>
  );
}
