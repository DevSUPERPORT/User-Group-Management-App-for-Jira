// Demo data for the click-dummy, mirroring the SUPERPORT app design:
// project PROJ (formerly PRJ) with reviewer, admins, externe (IdP) and qa groups.

const FIRST = ['Anna', 'Eleni', 'Jonas', 'Max', 'Lena', 'Sofia', 'Lukas', 'Mia', 'Felix', 'Emma', 'Paul', 'Hannah', 'Leon', 'Clara', 'Noah', 'Marie', 'Elias', 'Lea', 'Ben', 'Nora', 'Dimitris', 'Katerina', 'Yusuf', 'Aylin', 'Mateo', 'Ines', 'Oskar', 'Frieda', 'Tom', 'Ida', 'Henrik', 'Zoe', 'Nikos', 'Lina', 'Theo', 'Greta', 'Anton', 'Mila', 'Jakob', 'Romy'];
const LAST = ['Beispiel', 'Papadaki', 'Weber', 'Muster', 'Koch', 'Schulz', 'Wagner', 'Becker', 'Hoffmann', 'Schäfer', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hartmann', 'Lange', 'Georgiou', 'Nikolaou', 'Demir', 'Yılmaz', 'García', 'Costa', 'Lindqvist', 'Berg', 'Fischer', 'Vogel', 'Jensen', 'Martin', 'Alexiou', 'Keller', 'Roth', 'Frank', 'Huber', 'Lorenz', 'Seidel', 'Kraus'];

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z]/g, '');

export function createSeed(now = Date.now()) {
  const users = {};
  FIRST.forEach((first, i) => {
    const last = LAST[i];
    const accountId = `u-${slug(first)}-${slug(last)}`;
    users[accountId] = {
      accountId,
      displayName: `${first} ${last}`,
      email: i % 7 === 5 ? null : `${slug(first)}.${slug(last)}@example.com`,
      avatarUrl: null,
      active: i !== 12 && i !== 27,
    };
  });
  // The signed-in project admin of the demo.
  users['u-me'] = { accountId: 'u-me', displayName: 'George Papasotiriou', email: 'george@example.com', avatarUrl: null, active: true };
  users['u-admin'] = { accountId: 'u-admin', displayName: 'Dominik Admin', email: 'dominik@example.com', avatarUrl: null, active: true };

  const ids = Object.keys(users).filter((id) => id.startsWith('u-') && id !== 'u-me' && id !== 'u-admin');
  const pick = (from, n) => ids.slice(from, from + n);

  const groups = {
    'g-admins': { groupId: 'g-admins', name: 'atlassian-PROJ-admins', members: ['u-me', ...pick(10, 2)] },
    'g-reviewer': { groupId: 'g-reviewer', name: 'atlassian-PROJ-reviewer', members: [...pick(0, 4), ...pick(14, 8)] },
    'g-externe': { groupId: 'g-externe', name: 'atlassian-PROJ-externe', members: pick(22, 5) },
    'g-qa': { groupId: 'g-qa', name: 'atlassian-PRJ-qa', members: [...pick(1, 1), ...pick(30, 6)] },
    'g-big': { groupId: 'g-big', name: 'atlassian-PROJ-alle-entwickler', members: ids.slice(0, 38) },
    'g-other': { groupId: 'g-other', name: 'atlassian-OPS-oncall', members: pick(5, 3) },
    'g-site': { groupId: 'g-site', name: 'site-admins', members: ['u-admin'] },
    'g-jsw': { groupId: 'g-jsw', name: 'jira-software-users-superport', members: ids },
  };

  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo, h = 10, m = 0) => {
    const d = new Date(now - daysAgo * day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const me = { accountId: 'u-me', displayName: 'George Papasotiriou' };
  const groupRec = (g, projectId, key, description, createdAt, extra = {}) => ({
    groupId: g.groupId,
    name: g.name,
    projectId,
    keyAtCreation: key,
    description,
    createdAt,
    createdBy: me,
    ...extra,
  });

  const store = {
    // Stored key is PRJ: opening the page detects the key change to PROJ.
    'project:10001': { id: '10001', key: 'PRJ', previousKeys: [], groupIds: ['g-admins', 'g-reviewer', 'g-qa', 'g-big'] },
    'group:g-admins': groupRec(groups['g-admins'], '10001', 'PROJ', 'Projekt-Administration und Freigabe von Releases', at(40)),
    'group:g-reviewer': groupRec(groups['g-reviewer'], '10001', 'PROJ', 'Reviewer für Freigaben im PROJ-Workflow', at(2, 15, 58)),
    'group:g-qa': groupRec(groups['g-qa'], '10001', 'PRJ', 'Qualitätssicherung und Abnahmetests', at(60)),
    'group:g-big': groupRec(groups['g-big'], '10001', 'PROJ', 'Alle Entwicklerinnen und Entwickler im Projekt', at(30)),
  };

  // Two time-limited memberships, one ending soon, to show the end-date badges.
  store[`expiry:g-reviewer:${ids[14]}`] = { groupId: 'g-reviewer', accountId: ids[14], projectId: '10001', expiresAt: now + 4 * day, setAt: at(10), setBy: me };
  store[`expiry:g-reviewer:${ids[15]}`] = { groupId: 'g-reviewer', accountId: ids[15], projectId: '10001', expiresAt: now + 60 * day, setAt: at(10), setBy: me };

  const n = (id) => users[id].displayName;
  const audit = [
    { id: 'a1', createdAt: at(1, 9, 41), projectId: '10001', projectKey: 'PROJ', action: 'MEMBER_ADDED', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', targetAccountId: ids[2], targetName: n(ids[2]), actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a2', createdAt: at(2, 16, 5), projectId: '10001', projectKey: 'PROJ', action: 'MEMBER_REMOVED', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', targetAccountId: ids[4], targetName: n(ids[4]), actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a3', createdAt: at(2, 15, 58), projectId: '10001', projectKey: 'PROJ', action: 'GROUP_CREATED', groupId: 'g-reviewer', groupName: 'atlassian-PROJ-reviewer', actorAccountId: 'u-me', actorName: me.displayName, details: { description: 'Reviewer für Freigaben im PROJ-Workflow' } },
    { id: 'a4', createdAt: at(9, 10, 2), projectId: '10001', projectKey: 'PRJ', action: 'MEMBER_ADDED', groupId: 'g-qa', groupName: 'atlassian-PRJ-qa', targetAccountId: ids[1], targetName: n(ids[1]), actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a5', createdAt: at(30, 11, 20), projectId: '10001', projectKey: 'PROJ', action: 'GROUP_CREATED', groupId: 'g-big', groupName: 'atlassian-PROJ-alle-entwickler', actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a6', createdAt: at(40, 8, 15), projectId: '10001', projectKey: 'PRJ', action: 'GROUP_CREATED', groupId: 'g-admins', groupName: 'atlassian-PROJ-admins', actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a7', createdAt: at(60, 14, 30), projectId: '10001', projectKey: 'PRJ', action: 'GROUP_CREATED', groupId: 'g-qa', groupName: 'atlassian-PRJ-qa', actorAccountId: 'u-me', actorName: me.displayName, details: null },
    { id: 'a8', createdAt: at(3, 13, 12), projectId: '10002', projectKey: 'OPS', action: 'MEMBER_ADDED', groupId: 'g-other', groupName: 'atlassian-OPS-oncall', targetAccountId: ids[6], targetName: n(ids[6]), actorAccountId: 'u-admin', actorName: 'Dominik Admin', details: null },
  ];
  for (let i = 0; i < 26; i++) {
    const uid = ids[(i * 7) % ids.length];
    audit.push({
      id: `ah${i}`,
      createdAt: at(10 + i * 2, 9 + (i % 8), (i * 13) % 60),
      projectId: '10001',
      projectKey: 'PRJ',
      action: i % 4 === 3 ? 'MEMBER_REMOVED' : 'MEMBER_ADDED',
      groupId: 'g-big',
      groupName: 'atlassian-PROJ-alle-entwickler',
      targetAccountId: uid,
      targetName: n(uid),
      actorAccountId: 'u-me',
      actorName: me.displayName,
      details: null,
    });
  }

  const ok = (items, extra = {}) => ({ status: 'ok', items, ...extra });
  const none = () => ok([]);
  const usage = {
    'g-reviewer': {
      permissionSchemes: ok([{ id: '1', name: 'PROJ Standard', permissions: ['BROWSE_PROJECTS', 'TRANSITION_ISSUES', 'ADD_COMMENTS'], projects: [{ key: 'PROJ', name: 'Superport Plattform' }] }]),
      workflows: ok([
        { workflow: 'PROJ Review', transition: 'Freigeben', types: ['restrictTransition'], scope: 'global' },
        { workflow: 'Software Simplified Workflow for Project PROJ', transition: 'Backlog', types: ['restrictTransition'], scope: 'global' },
      ]),
      projectRoles: ok([{ projectKey: 'PROJ', projectName: 'Superport Plattform', role: 'Reviewers' }]),
      notificationSchemes: ok([{ id: '10000', name: 'PROJ Notifications', events: ['Issue Resolved', 'Issue Commented'] }]),
      issueSecurity: none(),
      filters: ok([{ id: '10100', name: 'Offene Reviews', owner: 'George Papasotiriou', access: 'view' }]),
      dashboards: none(),
    },
    'g-admins': {
      permissionSchemes: ok([
        { id: '1', name: 'PROJ Standard', permissions: ['ADMINISTER_PROJECTS', 'DELETE_ISSUES'], projects: [{ key: 'PROJ', name: 'Superport Plattform' }] },
        { id: '2', name: 'Release Management', permissions: ['MANAGE_SPRINTS_PERMISSION'], projects: [{ key: 'PROJ', name: 'Superport Plattform' }] },
      ]),
      workflows: none(),
      projectRoles: ok([{ projectKey: 'PROJ', projectName: 'Superport Plattform', role: 'Administrators' }]),
      notificationSchemes: none(),
      issueSecurity: ok([{ scheme: 'PROJ Security', level: 'Nur Admins' }]),
      filters: none(),
      dashboards: ok([{ id: '10200', name: 'Release-Cockpit', owner: 'George Papasotiriou', access: 'edit' }]),
    },
    // Also grants access in another project (OPS): the scope guard keeps PROJ's
    // project admins from adding people to it.
    'g-big': {
      permissionSchemes: ok([{ id: '3', name: 'Shared Engineering', permissions: ['BROWSE_PROJECTS', 'EDIT_ISSUES'], projects: [{ key: 'PROJ', name: 'Superport Plattform' }, { key: 'OPS', name: 'Operations' }] }]),
      workflows: none(),
      projectRoles: ok([{ projectKey: 'OPS', projectName: 'Operations', role: 'Developers' }]),
      notificationSchemes: none(),
      issueSecurity: none(),
      filters: none(),
      dashboards: none(),
    },
  };

  // Fake Confluence: spaces with group permissions and pages with restrictions.
  const confluence = {
    spaces: [
      { id: 's1', key: 'PROJ', name: 'Superport Plattform Doku', permissions: { 'g-reviewer': ['read:space', 'create:page'], 'g-admins': ['read:space', 'administer:space'] } },
      { id: 's2', key: 'HR', name: 'Personal', permissions: {} },
    ],
    pages: [
      { id: 'p1', title: 'Release-Freigaben', spaceId: 's1', restrictions: [{ groupId: 'g-reviewer', name: 'atlassian-PROJ-reviewer', operation: 'update' }] },
      { id: 'p2', title: 'Architektur', spaceId: 's1', restrictions: [] },
      { id: 'p3', title: 'Admin-Handbuch', spaceId: 's1', restrictions: [{ groupId: 'g-admins', name: 'atlassian-PROJ-admins', operation: 'read' }, { groupId: 'g-admins', name: 'atlassian-PROJ-admins', operation: 'update' }] },
      { id: 'p4', title: 'Onboarding', spaceId: 's2', restrictions: [] },
      { id: 'p5', title: 'Review-Checkliste', spaceId: 's1', restrictions: [{ groupId: 'g-reviewer', name: 'atlassian-PROJ-reviewer', operation: 'read' }] },
    ],
  };

  return {
    jira: {
      projects: {
        '10001': { id: '10001', key: 'PROJ', name: 'Superport Plattform', avatarUrl: null },
        '10002': { id: '10002', key: 'OPS', name: 'Operations', avatarUrl: null },
        '10003': { id: '10003', key: 'MKT', name: 'Marketing Website', avatarUrl: null },
      },
      users,
      groups,
      perms: { 'u-me': { jiraAdmin: true, projectAdminOf: ['10001'] }, 'u-admin': { jiraAdmin: true, projectAdminOf: [] } },
      usage,
      confluence,
      idpGroups: ['g-externe'],
    },
    store: {
      ...store,
      config: {
        retentionMonths: null,
        blockedGroups: ['atlassian-PROJ-legacy-*'],
        idpReadOnly: true,
        idpGroups: ['atlassian-PROJ-externe'],
        projectsMode: 'all',
        allowedProjects: [],
        memberViewEnabled: true,
        auditorGroups: ['iso-auditors'],
        expiryEnabled: true,
      },
    },
    audit,
  };
}
