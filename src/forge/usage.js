import { route } from '@forge/api';
import { call, check, mapLimit } from './http.js';

// UC-06: where is a group used in Jira? Every check stands alone and reports
// ok / error / unavailable; a failed check is never shown as "not used".

const PROJECT_CAP = 50;

const isGroupRef = (groupId, name) => (v) => {
  const s = JSON.stringify(v ?? null);
  return Boolean(v) && ((groupId && s.includes(groupId)) || (name && s.includes(`"${name}"`)));
};

async function allProjects() {
  const projects = [];
  let total = 0;
  for (let startAt = 0; startAt < PROJECT_CAP; startAt += 50) {
    const page = await call(route`/rest/api/3/project/search?startAt=${startAt}&maxResults=50`);
    projects.push(...(page.values ?? []));
    total = page.total ?? projects.length;
    if (page.isLast !== false) break;
  }
  return { projects: projects.slice(0, PROJECT_CAP), truncated: total > PROJECT_CAP };
}

// Friendly names for the rule keys of the new workflow editor.
const RULE_LABELS = {
  'system:restrict-issue-transition': 'restrictTransition',
  'system:restrict-from-all-users': 'restrictTransition',
  'system:check-permission-validator': 'validator',
  'system:update-field': 'postFunction',
};
const ruleKind = (rule, fallback) => RULE_LABELS[rule?.ruleKey] ?? fallback;

function collectRules(node, out = []) {
  if (!node) return out;
  for (const c of node.conditions ?? []) out.push(c);
  for (const g of node.conditionGroups ?? []) collectRules(g, out);
  return out;
}

export async function jiraUsage({ groupId, name }) {
  const refers = isGroupRef(groupId, name);
  const holderMatches = (h) => h?.type === 'group' && (h.value === groupId || h.parameter === name || h.parameter === groupId || h.group?.groupId === groupId);
  const projectsOnce = (() => {
    let p;
    return () => (p ??= allProjects());
  })();

  const [permissionSchemes, workflows, projectRoles, notificationSchemes, issueSecurity, filters, dashboards] = await Promise.all([
    check('permissionSchemes', async () => {
      const res = await call(route`/rest/api/3/permissionscheme?expand=permissions,group`);
      const schemes = (res.permissionSchemes ?? [])
        .map((s) => ({ id: String(s.id), name: s.name, permissions: [...new Set((s.permissions ?? []).filter((p) => holderMatches(p.holder)).map((p) => p.permission))], projects: [] }))
        .filter((s) => s.permissions.length);
      if (schemes.length) {
        const { projects } = await projectsOnce();
        const byScheme = new Map(schemes.map((s) => [s.id, s]));
        await mapLimit(projects, 6, async (p) => {
          const assigned = await call(route`/rest/api/3/project/${p.id}/permissionscheme`).catch(() => null);
          const scheme = assigned && byScheme.get(String(assigned.id));
          if (scheme) scheme.projects.push({ key: p.key, name: p.name });
        });
      }
      return { items: schemes };
    }),

    // New workflow API: conditions/validators/actions carry ruleKey + parameters
    // (e.g. system:restrict-issue-transition with groupIds).
    check('workflows', async () => {
      const items = [];
      for (let startAt = 0; startAt < 500; startAt += 50) {
        const page = await call(route`/rest/api/3/workflows/search?startAt=${startAt}&maxResults=50&expand=values.transitions`);
        for (const wf of page.values ?? []) {
          for (const t of wf.transitions ?? []) {
            const kinds = new Set();
            for (const rule of collectRules(t.conditions)) if (refers(rule)) kinds.add(ruleKind(rule, 'condition'));
            for (const rule of t.validators ?? []) if (refers(rule)) kinds.add(ruleKind(rule, 'validator'));
            for (const rule of t.actions ?? []) if (refers(rule)) kinds.add(ruleKind(rule, 'postFunction'));
            if (kinds.size) {
              items.push({
                workflow: wf.name,
                transition: t.name,
                types: [...kinds],
                scope: wf.scope?.type === 'PROJECT' ? 'project' : 'global',
              });
            }
          }
        }
        if (page.isLast !== false) break;
      }
      return { items };
    }),

    check('projectRoles', async () => {
      const { projects, truncated } = await projectsOnce();
      const items = [];
      await mapLimit(projects, 6, async (p) => {
        const roles = await call(route`/rest/api/3/project/${p.id}/role`);
        for (const [roleName, url] of Object.entries(roles ?? {})) {
          const roleId = String(url).split('/').pop();
          const role = await call(route`/rest/api/3/project/${p.id}/role/${roleId}`);
          const hit = (role.actors ?? []).some((a) => a.type === 'atlassian-group-role-actor' && (a.actorGroup?.groupId === groupId || a.actorGroup?.name === name || a.name === name));
          if (hit) items.push({ projectKey: p.key, projectName: p.name, role: roleName });
        }
      });
      items.sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.role.localeCompare(b.role));
      return { items, truncated };
    }),

    check('notificationSchemes', async () => {
      const items = [];
      for (let startAt = 0; startAt < 300; startAt += 50) {
        const page = await call(route`/rest/api/3/notificationscheme?startAt=${startAt}&maxResults=50&expand=all`);
        for (const scheme of page.values ?? []) {
          const events = (scheme.notificationSchemeEvents ?? [])
            .filter((e) => (e.notifications ?? []).some((n) => n.notificationType === 'Group' && (n.group?.groupId === groupId || n.group?.name === name || n.parameter === name || n.parameter === groupId)))
            .map((e) => e.event?.name)
            .filter(Boolean);
          if (events.length) items.push({ id: String(scheme.id), name: scheme.name, events });
        }
        if (page.isLast !== false) break;
      }
      return { items };
    }),

    check('issueSecurity', async () => {
      const [schemesRes, membersRes] = await Promise.all([
        call(route`/rest/api/3/issuesecurityschemes`),
        call(route`/rest/api/3/issuesecurityschemes/level/member?maxResults=1000&expand=group`),
      ]);
      const schemeName = new Map((schemesRes.issueSecuritySchemes ?? []).map((s) => [String(s.id), s.name]));
      const levelIds = [...new Set((membersRes.values ?? []).filter((m) => holderMatches(m.holder)).map((m) => `${m.issueSecuritySchemeId}:${m.issueSecurityLevelId}`))];
      const items = [];
      for (const key of levelIds) {
        const [schemeId, levelId] = key.split(':');
        const level = await call(route`/rest/api/3/securitylevel/${levelId}`).catch(() => null);
        items.push({ scheme: schemeName.get(schemeId) ?? schemeId, level: level?.name ?? levelId });
      }
      return { items };
    }),

    check('filters', async () => {
      const items = [];
      for (let startAt = 0; startAt < 500; startAt += 100) {
        const page = await call(route`/rest/api/3/filter/search?startAt=${startAt}&maxResults=100&expand=sharePermissions,editPermissions,owner`);
        for (const f of page.values ?? []) {
          const share = (f.sharePermissions ?? []).some((p) => p.type === 'group' && (p.group?.groupId === groupId || p.group?.name === name));
          const edit = (f.editPermissions ?? []).some((p) => p.type === 'group' && (p.group?.groupId === groupId || p.group?.name === name));
          if (share || edit) items.push({ id: String(f.id), name: f.name, owner: f.owner?.displayName ?? null, access: edit ? 'edit' : 'view' });
        }
        if (page.isLast !== false) break;
      }
      return { items };
    }),

    check('dashboards', async () => {
      const items = [];
      for (let startAt = 0; startAt < 500; startAt += 100) {
        const page = await call(route`/rest/api/3/dashboard/search?startAt=${startAt}&maxResults=100&expand=sharePermissions,editPermissions,owner`);
        for (const d of page.values ?? []) {
          const share = (d.sharePermissions ?? []).some((p) => p.type === 'group' && (p.group?.groupId === groupId || p.group?.name === name));
          const edit = (d.editPermissions ?? []).some((p) => p.type === 'group' && (p.group?.groupId === groupId || p.group?.name === name));
          if (share || edit) items.push({ id: String(d.id), name: d.name, owner: d.owner?.displayName ?? null, access: edit ? 'edit' : 'view' });
        }
        if (page.isLast !== false) break;
      }
      return { items };
    }),
  ]);

  return { permissionSchemes, workflows, projectRoles, notificationSchemes, issueSecurity, filters, dashboards };
}
