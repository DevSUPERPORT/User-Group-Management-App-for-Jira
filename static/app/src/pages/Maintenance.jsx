/**
 * Kill-switch screens, shown when SUPERPORT has paused the app (APP_MAINTENANCE, decided on the server): the full
 * "temporarily unavailable" page and the read-only banner, both linking to the status page through Jira's
 * router.open. Purely informational: nothing here can change the mode.
 *
 * @file        static/app/src/pages/Maintenance.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { motion } from 'framer-motion';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from '../components/Icon.jsx';
import { Button } from '../components/primitives.jsx';
import { Footer, Logo } from '../components/Shell.jsx';
import { openUrl } from '../api/client.js';
import { ease } from '../motion.js';

// Used until the server has sent its own status URL.
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

const openStatus = (url) => openUrl(url || STATUS_PAGE_URL).catch(() => window.open(url || STATUS_PAGE_URL, '_blank', 'noopener'));

// Maintenance / safety visual in the app's design: the orange shield (as in the "shield" icon) with a pause mark,
// on the accent tint, with a slow pulse ring. Reduced motion is respected through the app's MotionConfig.
function SafetyMark() {
  return (
    <div className="maint-mark" aria-hidden="true">
      <motion.span className="maint-mark-ring" initial={{ scale: 0.85, opacity: 0.6 }} animate={{ scale: 1.35, opacity: 0 }} transition={{ duration: 2.4, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.6 }} />
      <motion.svg width="96" height="96" viewBox="0 0 96 96" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 320, damping: 20 }}>
        <circle cx="48" cy="48" r="46" fill="var(--accent-tint)" />
        <path d="M48 18l24 9v18c0 13.5-10.2 24-24 27-13.8-3-24-13.5-24-27V27z" fill="var(--accent-bright)" />
        <motion.g initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease, delay: 0.25 }}>
          <rect x="40" y="35" width="5.5" height="20" rx="2.75" fill="var(--on-accent)" />
          <rect x="50.5" y="35" width="5.5" height="20" rx="2.75" fill="var(--on-accent)" />
        </motion.g>
      </motion.svg>
    </div>
  );
}

/** Full page while the app is taken down (APP_MAINTENANCE=on). */
export function Maintenance({ statusUrl }) {
  const { t } = useI18n();
  return (
    <div className="page">
      <main className="container state-screen">
        <motion.div className="card state-card maint-card" role="alert" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease }}>
          <div className="maint-brand">
            <Logo />
            <span className="eyebrow">{t('appName')}</span>
          </div>
          <SafetyMark />
          <h1 className="h2">{t('maint.title')}</h1>
          <p className="muted">{t('maint.body')}</p>
          <Button variant="dark" icon="external" onClick={() => openStatus(statusUrl)}>
            {t('maint.status')}
          </Button>
        </motion.div>
      </main>
      <Footer />
    </div>
  );
}

/**
 * Banner above every page when the site's Marketplace licence is not active: the server refuses every change
 * (LICENSE_INACTIVE), so say so before anyone fills in a form. Jira admins get the hint where to fix it.
 */
export function LicenseBanner({ admin }) {
  const { t } = useI18n();
  return (
    <motion.div className="maint-banner" role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }}>
      <div className="container maint-banner-inner">
        <Icon name="shield" size={16} />
        <span className="maint-banner-text">
          {t('license.inactive')} {t(admin ? 'license.inactiveAdmin' : 'license.inactiveUser')}
        </span>
      </div>
    </motion.div>
  );
}

/** Slim banner above every page while changes are paused (APP_MAINTENANCE=readonly). */
export function ReadonlyBanner({ statusUrl }) {
  const { t } = useI18n();
  return (
    <motion.div className="maint-banner" role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }}>
      <div className="container maint-banner-inner">
        <Icon name="shield" size={16} />
        <span className="maint-banner-text">{t('maint.readonly')}</span>
        <Button variant="link" size="sm" icon="external" onClick={() => openStatus(statusUrl)}>
          {t('maint.status')}
        </Button>
      </div>
    </motion.div>
  );
}
