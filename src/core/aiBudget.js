/**
 * SUPERPORT's AI stop: SUPERPORT can turn the AI features (the Rovo agent) off for every customer at once.
 *
 * The switch is the Forge environment variable AI_BUDGET of the app's environment, set by SUPERPORT's App Status
 * app (followed by a deploy, like APP_MAINTENANCE). Contract for Rovo-only apps (kind "rovo"):
 *   {"stop":false} - AI features follow the customer's own switch (config.aiEnabled)
 *   {"stop":true}  - AI features off on every site, whatever the customer's switch says
 * Unset, empty, invalid JSON or any other shape counts as {"stop":false} (fail open for parsing: the customer's
 * switch still defaults to off) and is logged once per value. Other fields are ignored.
 *
 * Customers cannot change it: the value lives in Atlassian's runtime and is read only on the server.
 *
 * @file        src/core/aiBudget.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

const VAR = 'AI_BUDGET';
const warned = new Set();

/** What every Rovo action answers while SUPERPORT has stopped the AI features. */
export const AI_STOPPED_MESSAGE = 'AI features of this app are temporarily turned off by the app vendor. Please try again later.';

/** True only when AI_BUDGET is a JSON object with stop === true (read on every call, never cached). */
export function vendorAiStop(env = globalThis.process?.env, warn = console.warn) {
  const raw = String(env?.[VAR] ?? '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.stop === 'boolean') return parsed.stop === true;
  if (!warned.has(raw)) {
    warned.add(raw);
    warn(`${VAR} is ${raw ? 'not {"stop":true|false}' : 'not set'}; AI features are not stopped by the vendor.`);
  }
  return false;
}

/**
 * Whether AI features are effectively on: the Jira admin's switch (config.aiEnabled, off unless saved as true) AND
 * no vendor stop. The pages show AI entry points ("Ask Rovo", the Rovo hint in the tour) only when this is true.
 */
export function aiActive(config, env = globalThis.process?.env, warn = console.warn) {
  return config?.aiEnabled === true && !vendorAiStop(env, warn);
}
