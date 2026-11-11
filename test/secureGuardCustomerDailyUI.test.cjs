const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function withCustomer(role, run) {
  const changes = [];
  const repo = {
    findActiveScope: async (userId, membershipId) => userId === 'user-1' && membershipId === 'member-1'
      ? { membershipId, customerOrganizationId: 'org-1', organizationName: 'Example', role }
      : null,
    listManagedMemberships: async (org) => {
      changes.push(['list', org]);
      return [{ id: 'member-2', email: 'someone@example.test', role: 'viewer', status: 'active' }];
    },
    updateMembershipRole: async (actor, org, member, newRole) => {
      changes.push(['role', actor, org, member, newRole]); return true;
    },
    revokeMembership: async (actor, scope, member) => {
      changes.push(['revoke', actor, scope.customerOrganizationId, member]); return true;
    },
  };
  const app = express();
  app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: {
      verifySession: () => ({ userId: 'user-1', sessionVersion: 1 }),
      verifyActiveSession: async () => ({ id: 'user-1', status: 'active', sessionVersion: 1 }),
      createInvitation: async (input) => { changes.push(['invite', input.customerOrganizationId, input.role]); return { token: 'fake' }; },
    },
    repo,
    inventoryClient: {},
    mailer: { sendSecureGuardInvitationEmail: async () => { changes.push(['mail']); } },
    portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/secure-guard`;
    const headers = { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'member-1', 'Content-Type': 'application/json' };
    await run({ base, headers, changes });
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('Customer daily UI retains scoped reads and gates queued Agent uninstall behind server capability', () => {
  const html = source('public/secure-guard-home.html');
  const js = source('public/js/secureGuardHome.js');
  const css = source('public/css/style.css');
  assert.match(html, /<script src="\/js\/secureGuardHome\.js"/);
  assert.match(html, /id="customer-inventory" hidden/);
  assert.match(js, /sgHomeFetch\('\/overview'\)/);
  assert.match(js, /sgHomeFetch\('\/memberships'\)/);
  assert.match(js, /sgHomeFetch\('\/memberships\/invitations'/);
  assert.match(js, /\/memberships\/\$\{encodeURIComponent\(member\.id\)\}/);
  assert.match(js, /状態は不明です/);
  assert.match(js, /sequence !== sgHomeInventorySequence/);
  assert.match(js, /sgHomeMembership\?\.role === 'org_admin'/);
  assert.match(html, /id="agent-uninstall-controls"[^>]*hidden/);
  assert.match(html, /id="uninstall-confirm-hostname"/);
  assert.match(html, /id="uninstall-ack"/);
  assert.match(js, /capabilities\?\.agentQueuedUninstall === true/);
  assert.match(js, /uninstall-status/);
  assert.match(js, /結果が不明です。再送せず管理者へ確認してください/);
  assert.doesNotMatch(js, /user_agents|queue_uninstall|soft.delete|deleteAgent/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(html, /管理者を2〜3名登録することを推奨します/);
  assert.doesNotMatch(html, /\d+円|円\/月/);
});

test('viewer and operator can read their own Memberships but cannot invite, change roles or revoke', async () => {
  for (const role of ['viewer', 'operator']) {
    await withCustomer(role, async ({ base, headers, changes }) => {
      const list = await fetch(`${base}/memberships`, { headers });
      assert.equal(list.status, 200);
      assert.equal((await list.json()).memberships.length, 1);
      const invite = await fetch(`${base}/memberships/invitations`, { method: 'POST', headers, body: JSON.stringify({ email: 'new@example.test', role: 'viewer' }) });
      assert.equal(invite.status, 403);
      const change = await fetch(`${base}/memberships/member-2`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'operator' }) });
      assert.equal(change.status, 403);
      const revoke = await fetch(`${base}/memberships/member-2/revoke`, { method: 'POST', headers });
      assert.equal(revoke.status, 403);
      assert.deepEqual(changes, [['list', 'org-1']]);
    });
  }
});

test('org_admin writes only through the server-resolved Customer Scope, and forged membership is rejected', async () => {
  await withCustomer('org_admin', async ({ base, headers, changes }) => {
    const forged = await fetch(`${base}/memberships`, { headers: { ...headers, 'X-Secure-Guard-Membership': 'another-org' } });
    assert.equal(forged.status, 403);
    const invite = await fetch(`${base}/memberships/invitations`, { method: 'POST', headers, body: JSON.stringify({ email: 'new@example.test', role: 'operator' }) });
    assert.equal(invite.status, 202);
    assert.equal(await invite.text(), '');
    const change = await fetch(`${base}/memberships/member-2`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'operator' }) });
    assert.equal(change.status, 204);
    const revoke = await fetch(`${base}/memberships/member-2/revoke`, { method: 'POST', headers });
    assert.equal(revoke.status, 204);
    assert.deepEqual(changes, [
      ['invite', 'org-1', 'operator'],
      ['mail'],
      ['role', 'user-1', 'org-1', 'member-2', 'operator'],
      ['revoke', 'user-1', 'org-1', 'member-2'],
    ]);
  });
});
