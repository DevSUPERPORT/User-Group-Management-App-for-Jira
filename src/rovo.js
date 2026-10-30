// Forge wiring of the Rovo actions (logic in rovoActions.js).
import { createService } from './core/service.js';
import { jiraClient } from './forge/jiraClient.js';
import { orgClient } from './forge/orgClient.js';
import { confluenceClient } from './forge/confluenceClient.js';
import { kvsStore } from './forge/kvsStore.js';
import { sqlAudit } from './forge/sqlAudit.js';
import { createRovoActions } from './rovoActions.js';

// Tags every audit entry written during a Rovo action.
const rovoAudit = {
  ...sqlAudit,
  append: (entry) => sqlAudit.append({ ...entry, details: { ...(entry.details ?? {}), via: 'rovo' } }),
};

const actions = createRovoActions(createService({ jira: jiraClient, org: orgClient, confluence: confluenceClient, store: kvsStore, audit: rovoAudit }));

export const { listGroups, groupDetails, whereUsed, auditLog, complianceCheck, createGroup, addMembers, removeMembers, setEndDate, updateDescription, decideRequest, personAccess, copyAccess, offboardPerson, copyMembers, undoLastChange } = actions;
