/**
 * Validates manifest.yml against the Forge schema without needing a registered app
 * (`forge lint` requires the app id from `forge register`).
 *
 * Run by `npm run validate`.
 *
 * @file        scripts/validate-manifest.cjs
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

const { validate } = require('@forge/manifest');
const path = require('node:path');

validate(false, path.join(__dirname, '..', 'manifest.yml')).then((r) => {
  if (r.success) {
    console.log('manifest.yml is valid');
    return;
  }
  for (const e of r.errors ?? []) console.error(`- ${e.message}`);
  process.exit(1);
});
