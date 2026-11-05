/**
 * Forge entry point: registers every Custom UI resolver for its allowed surfaces behind the SUPERPORT kill switch
 * (READS allow-list), the availability resolver, the scheduled and install triggers, and re-exports the Rovo
 * handlers named in manifest.yml. Project, account and site ids come from the Forge context (contextOf), never
 * from the payload.
 *
 * @file        src/index.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import ResolverExport from '@forge/resolver';
import { createService, isLicenseInactive } from './core/service.js';
import { AppError, ErrorCodes, toErrorPayload } from './core/errors.js';
import { maintenanceMode, requireAvailable, STATUS_PAGE_URL } from './core/maintenance.js';
import { jiraClient } from './forge/jiraClient.js';
import { createOrgClient } from './forge/orgClient.js';
import { confluenceClient } from './forge/confluenceClient.js';
import { kvsSecrets, kvsStore } from './forge/kvsStore.js';
import { runMigrations, sqlAudit } from './forge/sqlAudit.js';

// The package is "type": "module", so the bundler hands over the CommonJS exports
// object of @forge/resolver as the default import; the class sits on .default.
const Resolver = ResolverExport.default ?? ResolverExport;

const service = createService({ jira: jiraClient, org: createOrgClient({ secrets: kvsSecrets }), confluence: confluenceClient, store: kvsStore, audit: sqlAudit });

const ADMIN_MODULE = 'gum-admin-page';
const MEMBER_MODULE = 'gum-my-groups';
const AUDITOR_MODULE = 'gum-audit';

// Builds the trusted call context. Project and account ids come from Forge,
// never from the payload sent by the browser.
function contextOf(req) {
  const ext = req.context?.extension ?? {};
  const moduleKey = req.context?.moduleKey;
  const surface =
    moduleKey === ADMIN_MODULE || ext.type === 'jira:adminPage'
      ? 'admin'
      : moduleKey === MEMBER_MODULE
        ? 'member'
        : moduleKey === AUDITOR_MODULE
          ? 'auditor'
          : 'project';
  return {
    accountId: req.context?.accountId,
    projectId: ext.project?.id ? String(ext.project.id) : null,
    surface,
    license: req.context?.license ?? null,
    cloudId: req.context?.cloudId ?? null,
  };
}

const PROJECT_FUNCTIONS = [
  'bootstrap',
  'checkName',
  'createGroup',
  'accessMatrix',
  'applyAccessChanges',
  'getGroup',
  'getMembers',
  'updateDescription',
  'searchUsers',
  'addMembers',
  'removeMember',
  'removeMembers',
  'setExpiry',
  'resolveUsers',
  'exportMembers',
  'getUsage',
  'listRequests',
  'decideRequest',
  'reopenRequest',
  'completeReview',
];
const SHARED_FUNCTIONS = ['queryAudit', 'auditFilterOptions', 'exportAudit'];
const TUTORIAL_FUNCTIONS = ['tutorialState', 'markTutorialSeen'];
const MEMBER_FUNCTIONS = ['myGroups', 'requestAccess', 'withdrawRequest'];
const AUDITOR_FUNCTIONS = ['auditorBootstrap'];
// exportData / importData: Jira admin page only, and the service checks "Administer Jira" on every call.
const ADMIN_FUNCTIONS = ['adminBootstrap', 'saveConfig', 'exportData', 'importData', 'searchGroups', 'searchProjects', 'testOrgApi', 'saveOrgConnection', 'removeOrgConnection', 'previewDeactivatedCleanup', 'rebuildConfluenceIndex'];

// Resolvers that only read. They may refresh the app's own caches and bookkeeping (group discovery, where-used
// cache, the export's audit entry), but never change a group, a membership, a request or a setting.
// Everything else counts as a write: a new resolver is refused in read-only mode unless it is listed here on purpose.
const READS = new Set([
  'bootstrap',
  'checkName',
  'accessMatrix',
  'getGroup',
  'getMembers',
  'searchUsers',
  'resolveUsers',
  'exportMembers',
  'getUsage',
  'listRequests',
  'queryAudit',
  'auditFilterOptions',
  'exportAudit',
  'tutorialState',
  'myGroups',
  'auditorBootstrap',
  'adminBootstrap',
  'exportData',
  'searchGroups',
  'searchProjects',
  'testOrgApi',
  'previewDeactivatedCleanup',
]);

const resolver = new Resolver();

// Every resolver passes the kill switch first (src/core/maintenance.js), before the context or the payload is
// looked at, so nothing a caller sends can switch it off or get around it.
function define(name, allowed) {
  resolver.define(name, async (req) => {
    try {
      requireAvailable(READS.has(name) ? 'read' : 'write');
    } catch (err) {
      return toErrorPayload(err);
    }
    const ctx = contextOf(req);
    if (!allowed.includes(ctx.surface)) return toErrorPayload(Object.assign(new Error('Not available here'), { code: 'FORBIDDEN' }));
    try {
      return { data: await service[name](ctx, req.payload ?? {}) };
    } catch (err) {
      return toErrorPayload(err);
    }
  });
}

// The UI asks first, so it can show "temporarily unavailable" or the read-only banner before loading anything.
// Signed-in callers only; it reports the mode and never changes it.
resolver.define('availability', async (req) => {
  if (!req.context?.accountId) return toErrorPayload(new AppError(ErrorCodes.FORBIDDEN, 'Not signed in'));
  // licensed: false only when Forge reports an inactive Marketplace licence (no context.license = not a paid
  // production install, e.g. development). The UI then shows a banner up front instead of failing on save.
  return { data: { mode: maintenanceMode(), statusUrl: STATUS_PAGE_URL, licensed: !isLicenseInactive(req.context?.license) } };
});

PROJECT_FUNCTIONS.forEach((n) => define(n, ['project']));
SHARED_FUNCTIONS.forEach((n) => define(n, ['project', 'admin', 'auditor']));
TUTORIAL_FUNCTIONS.forEach((n) => define(n, ['project', 'admin', 'auditor', 'member']));
MEMBER_FUNCTIONS.forEach((n) => define(n, ['member']));
AUDITOR_FUNCTIONS.forEach((n) => define(n, ['auditor']));
ADMIN_FUNCTIONS.forEach((n) => define(n, ['admin']));

export const handler = resolver.getDefinitions();

// Scheduled triggers and the install trigger follow the kill switch too: "on" stops all of them; "readonly" stops
// the ones that change groups (expiry, automatic removal) and keeps the app's own housekeeping (audit retention the
// customer configured, the Confluence restriction index), which changes nothing in Jira or the organization.
function skipped(job, allowedIn) {
  const mode = maintenanceMode();
  if (allowedIn.includes(mode)) return false;
  console.log(`${job} skipped: APP_MAINTENANCE=${mode}`);
  return true;
}

// Daily scheduled trigger: removes audit entries older than the configured retention.
export async function retentionHandler() {
  if (skipped('Audit retention', ['off', 'readonly'])) return { statusCode: 204 };
  await runMigrations();
  const result = await service.runRetention();
  console.log('Audit retention run', result);
  return { statusCode: 204 };
}

// Hourly scheduled trigger: ends time-limited memberships.
// Hourly: one batch of the Confluence page-restriction index (UC-06).
export async function confluenceIndexHandler() {
  if (skipped('Confluence index', ['off', 'readonly'])) return { statusCode: 204 };
  const result = await service.runConfluenceIndex();
  console.log('Confluence index step', result);
  return { statusCode: 204 };
}

// Daily: optional removal of deactivated accounts (off by default).
export async function automationHandler() {
  if (skipped('Automation', ['off'])) return { statusCode: 204 };
  await runMigrations();
  const result = await service.runAutomation();
  console.log('Automation run', result);
  return { statusCode: 204 };
}

export async function expiryHandler() {
  if (skipped('Membership expiry', ['off'])) return { statusCode: 204 };
  await runMigrations();
  const result = await service.runExpiry();
  console.log('Membership expiry run', result);
  return { statusCode: 204 };
}

// Install/upgrade trigger: creates or migrates the audit table.
// While the app is down it is skipped; the audit table is also migrated lazily on its first use.
export async function lifecycleHandler() {
  if (skipped('SQL migrations', ['off', 'readonly'])) return;
  const applied = await runMigrations();
  console.log('SQL migrations applied', applied);
}

// Rovo actions (see src/rovo.js).
export {
  listGroups as rovoListGroups,
  groupDetails as rovoGroupDetails,
  whereUsed as rovoWhereUsed,
  auditLog as rovoAuditLog,
  complianceCheck as rovoComplianceCheck,
  createGroup as rovoCreateGroup,
  addMembers as rovoAddMembers,
  removeMembers as rovoRemoveMembers,
  setEndDate as rovoSetEndDate,
  updateDescription as rovoUpdateDescription,
  decideRequest as rovoDecideRequest,
  personAccess as rovoPersonAccess,
  copyAccess as rovoCopyAccess,
  offboardPerson as rovoOffboardPerson,
  copyMembers as rovoCopyMembers,
  undoLastChange as rovoUndoLastChange,
} from './rovo.js';
