/**
 * The Forge environment type of the current invocation: 'DEVELOPMENT', 'STAGING' or 'PRODUCTION'.
 *
 * Read from the Forge runtime (getAppContext().environmentType, set by Atlassian for the invocation), falling back to
 * the resolver/action context's environmentType, which Forge also fills in. Nothing the browser or the Rovo chat
 * sends can change either value. Used only for the development-only test switch ("treat these accounts as project
 * admins"), which the service honours only when this returns 'DEVELOPMENT'.
 *
 * @file        src/forge/environment.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-19
 * @updated     2026-11-19
 */

import { getAppContext } from '@forge/api';

export function environmentTypeOf(context, runtime = getAppContext) {
  try {
    const fromRuntime = runtime()?.environmentType;
    if (fromRuntime) return String(fromRuntime).toUpperCase();
  } catch {
    // Not inside a Forge invocation (tests, local tools).
  }
  const fromContext = context?.environmentType;
  return fromContext ? String(fromContext).toUpperCase() : null;
}
