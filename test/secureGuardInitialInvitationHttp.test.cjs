const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

async function withApp(input, run) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter(input));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function baseInput(overrides = {}) {
  return {
    identityService: {
      verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }),
      verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }),
      replaceInitialInvitation: async () => ({ token: 'new-token', expiresAt: new Date() }),
    },
    repo: {
      hasActiveMspAdminGrant: async () => true,
      cancelInitialInvitation: async () => true,
      listActiveMemberships: async () => [],
      findActiveScope: async () => null,
    },
    mailer: { sendSecureGuardInvitationEmail: async () => {} },
    portalBaseUrl: 'https://portal.example.test',
    ...overrides,
  };
}

test('HTTP cancellation is limited to an explicit MSP administrator and passes only the organization identifier', async () => {
  let call;
  const input = baseInput({
    repo: {
      ...baseInput().repo,
      cancelInitialInvitation: async (actorUserId, organizationId) => { call = { actorUserId, organizationId }; return true; },
    },
  });
  await withApp(input, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/admin/initial-memberships/invitations/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'secure_guard_session=test' },
      body: JSON.stringify({ customerOrganizationId: '00000000-0000-4000-8000-000000000001' }),
    });
    assert.equal(response.status, 204);
  });
  assert.deepEqual(call, { actorUserId: 'msp-user', organizationId: '00000000-0000-4000-8000-000000000001' });
});

test('HTTP reissue reports delivery uncertainty without returning its token or creating a second request', async () => {
  let reissues = 0;
  const input = baseInput({
    identityService: { ...baseInput().identityService, replaceInitialInvitation: async () => { reissues += 1; return { token: 'new-token', expiresAt: new Date() }; } },
    mailer: { sendSecureGuardInvitationEmail: async () => { throw new Error('delivery failed'); } },
  });
  await withApp(input, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/admin/initial-memberships/invitations/reissue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'secure_guard_session=test' },
      body: JSON.stringify({ customerOrganizationId: '00000000-0000-4000-8000-000000000001', email: 'person@example.test' }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: 'INVITATION_DELIVERY_UNCONFIRMED' });
    assert.equal(JSON.stringify(body).includes('new-token'), false);
  });
  assert.equal(reissues, 1);
});

test('HTTP initial invitation recovery rejects callers without an MSP grant', async () => {
  const input = baseInput({ repo: { ...baseInput().repo, hasActiveMspAdminGrant: async () => false } });
  await withApp(input, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/admin/initial-memberships/invitations/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'secure_guard_session=test' },
      body: JSON.stringify({ customerOrganizationId: '00000000-0000-4000-8000-000000000001' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'MSP_SCOPE_DENIED' });
  });
});
