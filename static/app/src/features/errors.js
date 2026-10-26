// Maps backend error codes to localized text.
export function errorText(t, err) {
  const reason = err?.details?.reason;
  if (reason) {
    const reasonKey = `error.reason.${reason}`;
    const reasonText = t(reasonKey, { message: err?.message ?? '' });
    if (reasonText !== reasonKey) return reasonText;
  }
  const code = err?.code ?? 'JIRA_ERROR';
  const key = `error.${code}`;
  const text = t(key, { message: err?.message ?? '' });
  return text === key ? err?.message ?? t('error.title') : text;
}
