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
