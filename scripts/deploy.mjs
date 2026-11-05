/**
 * Production release of Group Self-Service for Jira, always as a tagged Forge build.
 *
 * The SUPERPORT kill switch (APP_MAINTENANCE) is flipped by redeploying the build that is live by its tag (ops
 * panel and the "App Status" Jira app). A plain `forge deploy` has no tag, so after one the app could no longer be
 * taken down ("Not released by tag"). This script therefore hands the release to the ops tool, which runs the
 * tests, builds the UI, uploads a tagged build, deploys that tag and records it.
 *
 * Usage: npm run deploy            (asks to type the app key)
 *        npm run deploy -- --yes   (no prompt)
 *
 * @file        scripts/deploy.mjs
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-05
 * @updated     2026-11-05
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const OPS_DIR = process.env.SUPERPORT_OPS_DIR || resolve(process.cwd(), '..', 'SUPERPORT-OPS');
const cli = resolve(OPS_DIR, 'src', 'cli.mjs');

if (!existsSync(cli)) {
  console.error(`✖ SUPERPORT ops tool not found at ${OPS_DIR} (set SUPERPORT_OPS_DIR).`);
  console.error('  Do not fall back to a plain "forge deploy -e production": an untagged build cannot be taken down.');
  process.exit(1);
}

const extra = process.argv.slice(2).filter((a) => a === '--yes' || a === '--skip-checks');
const res = spawnSync(process.execPath, [cli, 'release', 'group-self-service', '--env', 'production', ...extra], { cwd: OPS_DIR, stdio: 'inherit' });
process.exit(res.status ?? 1);
