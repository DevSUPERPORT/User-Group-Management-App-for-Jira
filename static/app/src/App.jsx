/**
 * Root component of the Custom UI: reads the Forge context to pick the surface (project settings, My groups,
 * auditor, admin) and the language, asks the server's kill switch first, and then renders the page, the read-only
 * banner or the "temporarily unavailable" page.
 *
 * @file        static/app/src/App.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { DEMO, availability, enableTheme, getContext, inForge, onMaintenance } from './api/client.js';
import { I18nProvider, resolveLanguage } from './i18n/index.jsx';
import { ToastProvider } from './components/Toaster.jsx';
import { ProjectPage } from './pages/ProjectPage.jsx';
import { AdminPage } from './pages/AdminPage.jsx';
import { MyGroupsPage } from './pages/MyGroupsPage.jsx';
import { AuditorPage } from './pages/AuditorPage.jsx';
import { DemoBar } from './pages/StateScreens.jsx';
import { Maintenance, ReadonlyBanner, STATUS_PAGE_URL } from './pages/Maintenance.jsx';

const SURFACES = { 'gum-admin-page': 'admin', 'gum-my-groups': 'member', 'gum-audit': 'auditor', 'gum-project-settings': 'project' };
const PAGES = { admin: AdminPage, member: MyGroupsPage, auditor: AuditorPage, project: ProjectPage };

export function App() {
  const [ctx, setCtx] = useState(null);
  // SUPERPORT's kill switch, as reported by the server: asked before a page loads, and updated whenever the
  // server refuses a call because the app was paused in the meantime.
  const [maintenance, setMaintenance] = useState({ mode: 'off', statusUrl: STATUS_PAGE_URL });

  useEffect(() => onMaintenance((m) => setMaintenance((prev) => ({ mode: m.mode === 'on' || prev.mode === 'on' ? 'on' : 'readonly', statusUrl: m.statusUrl || prev.statusUrl }))), []);

  useEffect(() => {
    Promise.all([getContext(), enableTheme().catch(() => {}), availability().catch(() => null)]).then(([context, , av]) => {
      const surface = SURFACES[context.moduleKey] ?? (context.extension?.type === 'jira:adminPage' ? 'admin' : 'project');
      const lang = resolveLanguage(context.locale);
      document.documentElement.lang = lang;
      if (av?.mode) setMaintenance({ mode: av.mode, statusUrl: av.statusUrl || STATUS_PAGE_URL });
      setCtx({ surface, lang });
    });
  }, []);

  if (!ctx) return null;
  const Page = PAGES[ctx.surface];
  return (
    <MotionConfig reducedMotion="user">
      <I18nProvider lang={ctx.lang}>
        <ToastProvider>
          {maintenance.mode === 'on' ? (
            <Maintenance statusUrl={maintenance.statusUrl} />
          ) : (
            <>
              {maintenance.mode === 'readonly' && <ReadonlyBanner statusUrl={maintenance.statusUrl} />}
              <Page />
            </>
          )}
          {DEMO && !inForge && <DemoBar surface={ctx.surface} lang={ctx.lang} />}
        </ToastProvider>
      </I18nProvider>
    </MotionConfig>
  );
}
