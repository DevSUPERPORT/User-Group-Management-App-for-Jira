import { useCallback, useEffect, useState } from 'react';
import { call } from '../api/client.js';
import { useI18n } from '../i18n/index.jsx';
import { Footer, Header } from '../components/Shell.jsx';
import { Pill } from '../components/primitives.jsx';
import { AuditLog } from '../features/audit/AuditLog.jsx';
import { StateScreen } from './StateScreens.jsx';

// Auditors / ISO officers: read and export the full audit log. Nothing else.
export function AuditorPage() {
  const { t } = useI18n();
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    call('auditorBootstrap').then(setBoot).catch(setError);
  }, []);
  useEffect(load, [load]);

  if (error) return <StateScreen error={error} onRetry={load} />;

  return (
    <div className="page">
      <Header title={t('auditor.title')} actions={<Pill icon="lock">{t('auditor.badge')}</Pill>} />
      <main className="container main">{boot && <AuditLog scope="auditor" />}</main>
      <Footer />
    </div>
  );
}
