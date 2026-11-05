/**
 * Maps backend error codes to localized text.
 *
 * A details.reason gets its own error.reason.* text when one exists; otherwise the error.<code> text, then the
 * server message.
 *
 * @file        static/app/src/features/errors.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

export function errorText(t, err) {
  const reason = err?.details?.reason;
  if (reason) {
    const reasonKey = `error.reason.${reason}`;
    const reasonText = t(reasonKey, { message: err?.message ?? '', projects: (err?.details?.projects ?? []).join(', ') });
    if (reasonText !== reasonKey) return reasonText;
  }
  const code = err?.code ?? 'JIRA_ERROR';
  const key = `error.${code}`;
  const text = t(key, { message: err?.message ?? '' });
  return text === key ? err?.message ?? t('error.title') : text;
}
