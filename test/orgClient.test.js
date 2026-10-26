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

process.env.ORG_ID = 'org-1';
process.env.ORG_API_KEY = 'secret-key';
const { orgClient, _test } = await import('../src/forge/orgClient.js');
_test.setRetryDelays([1, 1, 1]);

const BASE = 'https://api.atlassian.com/admin/v2/orgs/org-1';

test('orgClient: configuration, directory discovery and auth header', async () => {
  assert.equal(orgClient.isConfigured(), true);
  requests.length = 0;
  replies = [[200, { data: [{ directoryId: 'dir-9', name: 'SUPERPORT' }] }]];
  const res = await orgClient.check();
  assert.deepEqual(res.directories, [{ directoryId: 'dir-9', name: 'SUPERPORT' }]);
  assert.equal(res.directoryId, 'dir-9');
  assert.equal(requests[0].url, `${BASE}/directories?limit=10`);
  assert.equal(requests[0].headers.Authorization, 'Bearer secret-key');
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
