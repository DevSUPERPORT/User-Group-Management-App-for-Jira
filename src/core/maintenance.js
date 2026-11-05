/**
 * Kill switch for incidents (e.g. a vulnerability): SUPERPORT can take the app down for every customer at once.
 *
 * The switch is the Forge environment variable APP_MAINTENANCE of the app's environment:
 *   off (or unset) - normal operation
 *   readonly       - everything can be viewed, nothing can be changed (no group or membership changes, no
 *                    settings, no automatic removals)
 *   on             - the app refuses every request; the UI shows "temporarily unavailable"
 *
 * Who can flip it: only the app's owner, with the Forge CLI / developer console (`forge variables set`) followed by
 * a deploy - in practice through the SUPERPORT ops panel. Customers, Jira admins and anyone who reads the Custom UI
 * bundle cannot: the value lives in Atlassian's runtime, is read only on the server, and the app has no resolver,
 * setting or URL that changes it. The app never contacts Statuspage and holds no Statuspage or Forge credentials.
 *
 * Fail closed: a value that isn't one of the three known ones is treated as "on".
 *
 * @file        src/core/maintenance.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { AppError, ErrorCodes } from './errors.js';

/** Public status page shown to users while the app is unavailable. */
export const STATUS_PAGE_URL = 'https://superapps.statuspage.io';

const VAR = 'APP_MAINTENANCE';

/** 'off' | 'readonly' | 'on', read from the server's environment on every call (never cached, never from a payload). */
export function maintenanceMode(env = process.env) {
  const raw = String(env?.[VAR] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'readonly' || raw === 'read-only') return 'readonly';
  return 'on';
}

// Same wording as the UI's maint.* texts (static/app/src/i18n/en.js), plus the status page link; Rovo relays it as is.
export const UNAVAILABLE_MESSAGE = `Group Self-Service for Jira is temporarily unavailable. We've paused Group Self-Service for Jira for maintenance to keep your data safe. Nothing you've saved is lost, and we'll be back as soon as possible. Status page: ${STATUS_PAGE_URL}`;
export const READONLY_MESSAGE = `Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible. Status page: ${STATUS_PAGE_URL}`;

/**
 * Throws when the app is down (any request) or read-only (requests that change something).
 * Call first in every resolver, Rovo action and scheduled trigger; when unsure, the kind is 'write'.
 */
export function requireAvailable(kind = 'write', env = process.env) {
  const mode = maintenanceMode(env);
  if (mode === 'on') {
    throw new AppError(ErrorCodes.UNAVAILABLE, UNAVAILABLE_MESSAGE, { reason: 'APP_UNAVAILABLE', mode, statusUrl: STATUS_PAGE_URL });
  }
  if (mode === 'readonly' && kind !== 'read') {
    throw new AppError(ErrorCodes.UNAVAILABLE, READONLY_MESSAGE, { reason: 'CHANGES_PAUSED', mode, statusUrl: STATUS_PAGE_URL });
  }
}
