// Single entry point for backend calls. Inside Jira the Forge bridge invokes the
// resolver; outside Forge (click-dummy) the same service runs in the browser.

export const DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO === 'true';
export const inForge = typeof window !== 'undefined' && Boolean(window.__bridge);

export class ApiError extends Error {
  constructor({ code, message, details }) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

let backendPromise;
function backend() {
  if (!backendPromise) {
    if (inForge || !DEMO) {
      backendPromise = import('@forge/bridge').then((b) => ({
        invoke: b.invoke,
        getContext: () => b.view.getContext(),
        enableTheme: () => b.view.theme.enable(),
        showFlag: b.showFlag,
        open: (url) => b.router.open(url),
        navigateToModule: (moduleKey, projectKey) => b.router.navigate({ target: 'module', moduleKey, ...(projectKey ? { projectKey } : {}) }),
        rovoEnabled: () => b.rovo.isEnabled(),
        openRovo: (prompt) => b.rovo.open({ type: 'forge', agentKey: 'gum-agent', agentName: 'Group & User Management', ...(prompt ? { prompt } : {}) }),
      }));
    } else {
      backendPromise = import('./demoBackend.js').then((m) => m.createDemoBackend());
    }
  }
  return backendPromise;
}

export async function call(name, payload = {}) {
  const b = await backend();
  const res = await b.invoke(name, payload);
  if (res && res.error) throw new ApiError(res.error);
  return res?.data;
}

export async function getContext() {
  return (await backend()).getContext();
}

export async function enableTheme() {
  const b = await backend();
  return b.enableTheme?.();
}

export async function nativeFlag(options) {
  const b = await backend();
  if (!b.showFlag) return null;
  return b.showFlag(options);
}

export async function openUrl(url) {
  const b = await backend();
  if (b.open) return b.open(url);
  window.open(url, '_blank', 'noopener');
}

// Opens another page of this app (e.g. "My groups" of a project, or the audit log).
export async function openModule(moduleKey, projectKey) {
  const b = await backend();
  if (b.navigateToModule) return b.navigateToModule(moduleKey, projectKey);
  // Click-dummy: the pages are switched with ?view=.
  const views = { 'gum-my-groups': 'member', 'gum-audit': 'auditor', 'gum-admin-page': 'admin', 'gum-project-settings': 'admin' };
  const url = new URL(window.location.href);
  url.searchParams.set('view', views[moduleKey] ?? 'admin');
  window.open(url.toString(), '_blank', 'noopener');
}

// Opens the Rovo chat with this app's agent, optionally with a prepared prompt.
export async function openRovo(prompt) {
  const b = await backend();
  if (!b.openRovo) return false;
  try {
    // Not every Jira page lets apps open the Rovo chat; the caller then explains the way there.
    if (b.rovoEnabled && !(await b.rovoEnabled())) return false;
    await b.openRovo(prompt);
    return true;
  } catch (err) {
    console.warn('Rovo could not be opened', err);
    return false;
  }
}
