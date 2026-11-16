/**
 * Whether the page may show AI entry points ("Ask Rovo", the Rovo hint in the tour). The server sends the effective
 * state in bootstrap's config.ai (the Jira admin's switch AND no SUPERPORT stop via AI_BUDGET); anything else, a
 * missing or failed bootstrap included, counts as off.
 *
 * @file        static/app/src/features/ai.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

export const aiOn = (boot) => boot?.config?.ai === true;
