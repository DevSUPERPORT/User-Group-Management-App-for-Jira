/**
 * "Grant access" for Jira-admin mode: group changes run with the signed-in Jira admin's own rights (Forge asUser),
 * which Jira lets the user allow once. The grantAccess resolver lets Forge's own authentication error through, so
 * Jira shows its "Allow access" prompt; when it does not (or the call fails otherwise), the user is told to reload
 * the page and allow access there.
 *
 * @file        static/app/src/features/changes/consent.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import { call } from '../../api/client.js';

export const isConsentError = (err) => err?.code === 'USER_CONSENT_REQUIRED' || err?.details?.reason === 'CONSENT';

export async function requestConsent(t, notify) {
  try {
    await call('grantAccess');
    notify({ type: 'success', title: t('changes.granted') });
    return true;
  } catch {
    notify({ type: 'info', title: t('changes.consentTitle'), description: t('changes.grantFallback') });
    return false;
  }
}

// The toast action for an error: "Grant access" when the error is a missing consent, otherwise the given fallback.
export function consentAction(t, notify, err, fallback) {
  if (!isConsentError(err)) return fallback;
  return { label: t('changes.grant'), onClick: () => requestConsent(t, notify) };
}
