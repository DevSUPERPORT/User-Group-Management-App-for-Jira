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
 * @updated     2026-11-19
 */

import ResolverExport from '@forge/resolver';
import { createService, isLicenseInactive } from './core/service.js';
import { AppError, ErrorCodes, toErrorPayload } from './core/errors.js';
import { maintenanceMode, requireAvailable, STATUS_PAGE_URL } from './core/maintenance.js';
import { jiraClient } from './forge/jiraClient.js';
import { isConsentError, jiraUserWriter } from './forge/jiraUserWriter.js';
import { environmentTypeOf } from './forge/environment.js';
import { confluenceClient } from './forge/confluenceClient.js';
import { kvsSecrets, kvsStore } from './forge/kvsStore.js';
import { runMigrations, sqlAudit } from './forge/sqlAudit.js';

// The package is "type": "module", so the bundler hands over the CommonJS exports
// object of @forge/resolver as the default import; the class sits on .default.
const Resolver = ResolverExport.default ?? ResolverExport;

// jiraUser: group writes as the signed-in Jira admin (Jira-admin mode); the service hands it only to Jira admins.
const service = createService({ jira: jiraClient, secrets: kvsSecrets, jiraUser: jiraUserWriter, confluence: confluenceClient, store: kvsStore, audit: sqlAudit });

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
    // From the Forge runtime (fallback: Forge's context). Only the development-only test switch looks at it.
    environmentType: environmentTypeOf(req.context),
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
  // Jira-admin mode: pending changes. Applying and rejecting re-check "Jira admin" in the service.
  'listChanges',
  'applyChanges',
  'rejectChanges',
  'withdrawChanges',
  // Project roles: changes run with the project admin's own Jira rights (asUser) and apply at once.
  'listRoles',
  'addRoleMembers',
  'removeRoleMember',
  'searchRoleGroups',
  'addRoleGroups',
  'removeRoleGroup',
];
const SHARED_FUNCTIONS = ['queryAudit', 'auditFilterOptions', 'exportAudit'];
const TUTORIAL_FUNCTIONS = ['tutorialState', 'markTutorialSeen'];
// The admin page's queue ("Changes to apply") and the consent prompt for writes as the signed-in user.
const CHANGE_ADMIN_FUNCTIONS = ['listChanges', 'applyChanges', 'rejectChanges'];
const CONSENT_FUNCTIONS = ['grantAccess'];
const MEMBER_FUNCTIONS = ['myGroups', 'requestAccess', 'withdrawRequest'];
const AUDITOR_FUNCTIONS = ['auditorBootstrap'];
// exportData / importData: Jira admin page only, and the service checks "Administer Jira" on every call.
const ADMIN_FUNCTIONS = ['adminBootstrap', 'saveConfig', 'setPrivilegedAdmin', 'clearPrivilegedAdmin', 'updateSetup', 'exportData', 'importData', 'searchGroups', 'searchProjects', 'previewDeactivatedCleanup', 'rebuildConfluenceIndex'];

// Resolvers that only read. They may refresh the app's own caches and bookkeeping (group discovery, where-used
// cache, the export's audit entry), but never change a group, a membership, a request or a setting.
// Everything else counts as a write: a new resolver is refused in read-only mode unless it is listed here on purpose.
const READS = new Set([
  'bootstrap',
  'listRoles',
  'searchRoleGroups',
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
  'previewDeactivatedCleanup',
  'listChanges',
  'grantAccess',
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
    await purgeLegacyKeyOnce();
    try {
      return { data: await service[name](ctx, req.payload ?? {}) };
    } catch (err) {
      // "Grant access": Forge's own authentication error must reach the platform so it shows the "Allow access"
      // prompt. Everywhere else a missing consent comes back as USER_CONSENT_REQUIRED for the UI.
      if (name === 'grantAccess' && isConsentError(err)) throw err.name === 'NEEDS_AUTHENTICATION_ERR' ? err : err.cause;
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

PROJECT_FUNCTIONS.filter((n) => !CHANGE_ADMIN_FUNCTIONS.includes(n)).forEach((n) => define(n, ['project']));
CHANGE_ADMIN_FUNCTIONS.forEach((n) => define(n, ['project', 'admin']));
CONSENT_FUNCTIONS.forEach((n) => define(n, ['project', 'admin']));
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
  await purgeLegacyKey(); // daily fallback in case the install/upgrade trigger did not run
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

// Deletes an organization API key stored by versions up to 3.17 (see service.purgeLegacyOrgConnection). Runs even while
// the app is down: removing a credential the app must not keep is always allowed.
async function purgeLegacyKey() {
  try {
    const res = await service.purgeLegacyOrgConnection();
    if (res.removed) console.log('Stored organization API key removed (no longer supported)');
  } catch (err) {
    console.warn('Removing the stored organization API key failed, retrying on the next run', err?.message);
  }
}

// Also once per runtime instance on the first app call: a minor-version deploy does not fire the upgrade trigger.
let legacyPurge = null;
function purgeLegacyKeyOnce() {
  if (!legacyPurge) legacyPurge = purgeLegacyKey();
  return legacyPurge;
}

// Install/upgrade trigger: removes a legacy organization API key, then creates or migrates the audit table.
// While the app is down the migration is skipped; the audit table is also migrated lazily on its first use.
export async function lifecycleHandler() {
  await purgeLegacyKey();
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
