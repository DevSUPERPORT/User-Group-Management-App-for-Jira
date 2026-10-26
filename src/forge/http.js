import { asApp } from '@forge/api';
import { AppError, ErrorCodes } from '../core/errors.js';

// Shared request helper for Jira and Confluence calls made as the app.

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function send(product, path, { method = 'GET', body, notFound } = {}) {
  const request = product === 'confluence' ? asApp().requestConfluence : asApp().requestJira;
  const res = await request(path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (res.ok) return json;

  const message =
    [...(json?.errorMessages ?? []), ...Object.values(json?.errors ?? {})].join(' ') || json?.message || text || `HTTP ${res.status}`;
  if (res.status === 404 && notFound) throw new AppError(notFound, message);
  if (/already a member/i.test(message)) throw new AppError('ALREADY_MEMBER', message);
  if (/managed (externally|by)|identity provider|scim|synced|synchroni[sz]ed/i.test(message)) {
    throw new AppError(ErrorCodes.GROUP_READ_ONLY, message);
  }
  throw new AppError(ErrorCodes.JIRA_ERROR, message, { status: res.status });
}

export const call = (path, options) => send('jira', path, options);
export const callConfluence = (path, options) => send('confluence', path, options);

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Runs one usage check; a failure is reported as such and never as "not used".
export async function check(name, fn) {
  try {
    return { status: 'ok', ...(await fn()) };
  } catch (err) {
    console.warn(`Usage check "${name}" failed`, err?.code, err?.message, JSON.stringify(err?.details ?? null));
    const httpStatus = err?.details?.status ?? null;
    return { status: httpStatus === 401 || httpStatus === 403 ? 'unavailable' : 'error', items: [], error: { message: err?.message ?? String(err), status: httpStatus } };
  }
}
