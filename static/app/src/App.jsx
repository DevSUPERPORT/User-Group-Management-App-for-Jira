import { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { DEMO, enableTheme, getContext, inForge } from './api/client.js';
import { I18nProvider, resolveLanguage } from './i18n/index.jsx';
import { ToastProvider } from './components/Toaster.jsx';
import { ProjectPage } from './pages/ProjectPage.jsx';
import { AdminPage } from './pages/AdminPage.jsx';
import { MyGroupsPage } from './pages/MyGroupsPage.jsx';
import { AuditorPage } from './pages/AuditorPage.jsx';
import { DemoBar } from './pages/StateScreens.jsx';

const SURFACES = { 'gum-admin-page': 'admin', 'gum-my-groups': 'member', 'gum-audit': 'auditor', 'gum-project-settings': 'project' };
const PAGES = { admin: AdminPage, member: MyGroupsPage, auditor: AuditorPage, project: ProjectPage };

export function App() {
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    Promise.all([getContext(), enableTheme().catch(() => {})]).then(([context]) => {
      const surface = SURFACES[context.moduleKey] ?? (context.extension?.type === 'jira:adminPage' ? 'admin' : 'project');
      const lang = resolveLanguage(context.locale);
      document.documentElement.lang = lang;
      setCtx({ surface, lang });
    });
  }, []);

  if (!ctx) return null;
  const Page = PAGES[ctx.surface];
  return (
    <MotionConfig reducedMotion="user">
      <I18nProvider lang={ctx.lang}>
        <ToastProvider>
          <Page />
          {DEMO && !inForge && <DemoBar surface={ctx.surface} lang={ctx.lang} />}
        </ToastProvider>
      </I18nProvider>
    </MotionConfig>
  );
}
