import ResolverExport from '@forge/resolver';
import { createService } from './core/service.js';
import { toErrorPayload } from './core/errors.js';
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

const resolver = new Resolver();

function define(name, allowed) {
  resolver.define(name, async (req) => {
    const ctx = contextOf(req);
    if (!allowed.includes(ctx.surface)) return toErrorPayload(Object.assign(new Error('Not available here'), { code: 'FORBIDDEN' }));
    try {
      return { data: await service[name](ctx, req.payload ?? {}) };
    } catch (err) {
      return toErrorPayload(err);
    }
  });
}

PROJECT_FUNCTIONS.forEach((n) => define(n, ['project']));
SHARED_FUNCTIONS.forEach((n) => define(n, ['project', 'admin', 'auditor']));
TUTORIAL_FUNCTIONS.forEach((n) => define(n, ['project', 'admin', 'auditor', 'member']));
MEMBER_FUNCTIONS.forEach((n) => define(n, ['member']));
AUDITOR_FUNCTIONS.forEach((n) => define(n, ['auditor']));
ADMIN_FUNCTIONS.forEach((n) => define(n, ['admin']));

export const handler = resolver.getDefinitions();

// Daily scheduled trigger: removes audit entries older than the configured retention.
export async function retentionHandler() {
  await runMigrations();
  const result = await service.runRetention();
  console.log('Audit retention run', result);
  return { statusCode: 204 };
}

// Hourly scheduled trigger: ends time-limited memberships.
// Hourly: one batch of the Confluence page-restriction index (UC-06).
export async function confluenceIndexHandler() {
  const result = await service.runConfluenceIndex();
  console.log('Confluence index step', result);
  return { statusCode: 204 };
}

// Daily: optional removal of deactivated accounts (off by default).
export async function automationHandler() {
  await runMigrations();
  const result = await service.runAutomation();
  console.log('Automation run', result);
  return { statusCode: 204 };
}

export async function expiryHandler() {
  await runMigrations();
  const result = await service.runExpiry();
  console.log('Membership expiry run', result);
  return { statusCode: 204 };
}

// Install/upgrade trigger: creates or migrates the audit table.
export async function lifecycleHandler() {
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
