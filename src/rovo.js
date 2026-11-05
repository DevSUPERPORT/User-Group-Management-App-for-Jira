/**
 * Forge wiring of the Rovo actions (logic in rovoActions.js).
 *
 * Builds the service with the real Forge adapters and an audit log that tags every entry "via Rovo", and exports
 * the actions that src/index.js hands to the manifest.
 *
 * @file        src/rovo.js
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

import { createService } from './core/service.js';
import { jiraClient } from './forge/jiraClient.js';
import { createOrgClient } from './forge/orgClient.js';
import { confluenceClient } from './forge/confluenceClient.js';
import { kvsSecrets, kvsStore } from './forge/kvsStore.js';
import { sqlAudit } from './forge/sqlAudit.js';
import { createRovoActions } from './rovoActions.js';

// Tags every audit entry written during a Rovo action.
const rovoAudit = {
  ...sqlAudit,
  append: (entry) => sqlAudit.append({ ...entry, details: { ...(entry.details ?? {}), via: 'rovo' } }),
};

const actions = createRovoActions(createService({ jira: jiraClient, org: createOrgClient({ secrets: kvsSecrets }), confluence: confluenceClient, store: kvsStore, audit: rovoAudit }));

export const { listGroups, groupDetails, whereUsed, auditLog, complianceCheck, createGroup, addMembers, removeMembers, setEndDate, updateDescription, decideRequest, personAccess, copyAccess, offboardPerson, copyMembers, undoLastChange } = actions;
