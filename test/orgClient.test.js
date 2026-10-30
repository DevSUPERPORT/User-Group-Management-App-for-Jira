import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Records every request and answers from a queue of [status, body] pairs.
const requests = [];
let replies = [];
const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

mock.module('@forge/api', {
  namedExports: {
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const [status, body] = replies.shift() ?? [500, { message: 'no reply queued' }];
      return reply(status, body);
    },
  },
});

const { createOrgClient, _test } = await import('../src/forge/orgClient.js');
_test.setRetryDelays([1, 1, 1]);

// Stand-in for Forge secret storage.
const secretMap = new Map();
const secrets = {
  get: async (k) => (secretMap.has(k) ? structuredClone(secretMap.get(k)) : undefined),
  set: async (k, v) => void secretMap.set(k, structuredClone(v)),
  delete: async (k) => void secretMap.delete(k),
};
const orgClient = createOrgClient({ secrets, now: () => 1000 });

const BASE = 'https://api.atlassian.com/admin/v2/orgs/org-1';

test('orgClient: nothing works before the site has stored a connection (no app-wide fallback)', async () => {
  process.env.ORG_ID = 'org-env';
  process.env.ORG_API_KEY = 'env-key';
  try {
    assert.equal(await orgClient.isConfigured(), false);
    assert.deepEqual(await orgClient.status(), { configured: false });
    requests.length = 0;
    await assert.rejects(orgClient.addMember('grp-1', 'acc-1'), { code: 'ORG_API_NOT_CONFIGURED' });
    assert.equal(requests.length, 0);
  } finally {
    delete process.env.ORG_ID;
    delete process.env.ORG_API_KEY;
  }
});

test('orgClient: connect validates the key, asks for a directory when there are several, never exposes the key', async () => {
  replies = [[401, { message: 'invalid key' }]];
  await assert.rejects(orgClient.connect({ orgId: 'org-1', apiKey: 'wrong' }), { code: 'ORG_API_UNAUTHORIZED' });
  assert.equal(await orgClient.isConfigured(), false);

  await assert.rejects(orgClient.connect({ orgId: '../x', apiKey: 'k' }), { code: 'BAD_REQUEST' });
  await assert.rejects(orgClient.connect({ orgId: 'org-1', apiKey: '  ' }), { code: 'BAD_REQUEST' });

  const two = [200, { data: [{ directoryId: 'dir-8', name: 'Partners' }, { directoryId: 'dir-9', name: 'SUPERPORT' }] }];
  replies = [two];
  await assert.rejects(orgClient.connect({ orgId: 'org-1', apiKey: 'secret-key' }), (err) => err.code === 'ORG_DIRECTORY_REQUIRED' && err.details.directories.length === 2);
  assert.equal(await orgClient.isConfigured(), false);

  requests.length = 0;
  replies = [two];
  const status = await orgClient.connect({ orgId: ' org-1 ', apiKey: 'secret-key', directoryId: 'dir-9' }, { accountId: 'u-admin', displayName: 'Admin' });
  assert.deepEqual(status, { configured: true, orgId: 'org-1', directoryId: 'dir-9', directoryName: 'SUPERPORT', updatedAt: 1000, updatedBy: { accountId: 'u-admin', displayName: 'Admin' } });
  assert.equal(JSON.stringify(status).includes('secret-key'), false);
  assert.equal(requests[0].url, `${BASE}/directories?limit=10`);
  assert.equal(requests[0].headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(await orgClient.status(), status);

  replies = [two];
  assert.deepEqual(await orgClient.check(), { directories: two[1].data, directoryId: 'dir-9' });
});

test('orgClient: create group posts name + description; falls back to search for the id', async () => {
  requests.length = 0;
  replies = [[201, { id: 'grp-1', name: 'atlassian-GMT-a' }]];
  assert.deepEqual(await orgClient.createGroup('atlassian-GMT-a', 'desc'), { groupId: 'grp-1', name: 'atlassian-GMT-a' });
  assert.equal(requests[0].url, `${BASE}/directories/dir-9/groups`);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { name: 'atlassian-GMT-a', description: 'desc' });

  requests.length = 0;
  replies = [
    [201, undefined],
    [200, { data: [{ id: 'grp-2', name: 'ATLASSIAN-GMT-b' }] }],
  ];
  assert.equal((await orgClient.createGroup('atlassian-GMT-b')).groupId, 'grp-2');
  assert.equal(requests[1].url, `${BASE}/directories/dir-9/groups/search`);
  assert.deepEqual(requests[1].body, { searchTerm: 'atlassian-GMT-b', limit: 20 });
});

test('orgClient: memberships, 409 -> ALREADY_MEMBER, 404 -> resolve by name and retry', async () => {
  requests.length = 0;
  replies = [[204]];
  await orgClient.addMember('grp-1', 'acc-1', 'atlassian-GMT-a');
  assert.equal(requests[0].url, `${BASE}/directories/dir-9/groups/grp-1/memberships`);
  assert.deepEqual(requests[0].body, { accountId: 'acc-1' });

  replies = [[409, { message: 'already a member' }]];
  await assert.rejects(orgClient.addMember('grp-1', 'acc-1', 'atlassian-GMT-a'), { code: 'ALREADY_MEMBER' });

  // A freshly created group can answer 404 for a moment: retried, no name lookup.
  requests.length = 0;
  replies = [[404, { message: 'not found' }], [404, { message: 'not found' }], [204]];
  await orgClient.addMember('grp-new', 'acc-1', 'atlassian-GMT-a');
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.url.endsWith('/groups/grp-new/memberships')));

  // Still unknown after all retries: resolved once by name.
  requests.length = 0;
  const notFound = [404, { message: 'not found' }];
  replies = [notFound, notFound, notFound, notFound, [200, { data: [{ id: 'grp-real', name: 'atlassian-GMT-a' }] }], [204]];
  await orgClient.removeMember('jira-id', 'acc-1', 'atlassian-GMT-a');
  assert.equal(requests[5].method, 'DELETE');
  assert.equal(requests[5].url, `${BASE}/directories/dir-9/groups/grp-real/memberships/acc-1`);
});

test('orgClient: auth failures and IdP metadata', async () => {
  replies = [[401, { message: 'invalid key' }]];
  await assert.rejects(orgClient.addMember('grp-1', 'acc-1'), { code: 'ORG_API_UNAUTHORIZED' });

  replies = [[200, { data: { id: 'grp-1', externalSynced: true, managedBy: 'okta', managementAccess: { modifiable: false } } }]];
  assert.deepEqual(await orgClient.getGroupMeta('grp-1'), { externalSynced: true, managedBy: 'okta', modifiable: false });
});

test('orgClient: groupExists asks once by id, then by name, without retries', async () => {
  requests.length = 0;
  replies = [[200, { data: { id: 'grp-1' } }]];
  assert.equal(await orgClient.groupExists('grp-1', 'atlassian-GMT-a'), true);
  assert.equal(requests.length, 1);

  requests.length = 0;
  replies = [[404, { message: 'not found' }], [200, { data: [] }]];
  assert.equal(await orgClient.groupExists('grp-gone', 'atlassian-GMT-gone'), false);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, `${BASE}/directories/dir-9/groups/search`);

  replies = [[500, { message: 'boom' }]];
  await assert.rejects(orgClient.groupExists('grp-1', 'x'), { code: 'ORG_API_ERROR' });
});

test('orgClient: disconnect removes the stored connection', async () => {
  assert.deepEqual(await orgClient.disconnect(), { configured: false });
  assert.equal(secretMap.size, 0);
  await assert.rejects(orgClient.removeMember('grp-1', 'acc-1'), { code: 'ORG_API_NOT_CONFIGURED' });
});
