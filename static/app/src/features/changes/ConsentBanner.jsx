/**
 * "Allow access" notice for Jira-admin mode. Jira admins' changes run with their own rights (Forge asUser), which
 * Jira lets each user allow once. Any call that comes back with "access not allowed yet" (a single change, a batch
 * in the People table, an access review, a new group, the change queue) raises this notice on the page, so the
 * admin can allow access right there and then repeat the action.
 *
 * @file        static/app/src/features/changes/ConsentBanner.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { onConsentRequired } from '../../api/client.js';
import { useI18n } from '../../i18n/index.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button } from '../../components/primitives.jsx';
import { useNotify } from '../../components/Toaster.jsx';
import { collapse } from '../../motion.js';
import { requestConsent } from './consent.js';

export function ConsentNotice({ onGranted }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  return (
    <motion.div className="notice notice-warn consent-notice" role="alert" {...collapse}>
      <Icon name="key" size={18} />
      <span className="grow stack-4">
        <strong>{t('changes.consentTitle')}</strong>
        <span className="small">{t('changes.consentText')}</span>
      </span>
      <Button
        size="sm"
        variant="dark"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const ok = await requestConsent(t, notify);
          setBusy(false);
          if (ok) onGranted?.();
        }}
      >
        {t('changes.grant')}
      </Button>
    </motion.div>
  );
}

// Shown on a page once any call reported that access is not allowed yet; hidden again after access was granted.
export function ConsentBanner() {
  const [needed, setNeeded] = useState(false);
  useEffect(() => onConsentRequired(() => setNeeded(true)), []);
  return <AnimatePresence initial={false}>{needed && <ConsentNotice onGranted={() => setNeeded(false)} />}</AnimatePresence>;
}
