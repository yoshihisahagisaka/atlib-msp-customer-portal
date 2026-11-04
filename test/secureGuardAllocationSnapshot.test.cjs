const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');
const { SecureGuardRepo } = require('../dist/services/secureGuardRepo');

const orgId = '11111111-1111-4111-8111-111111111111';
const cookie = 'secure_guard_session=test';

async function withRouter(admin, repo, run) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: {
      verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }),
      verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }),
    },
    repo: { hasActiveMspAdminGrant: async () => admin, ...repo },
    inventoryClient: {},
    mailer: {},
    portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function patch(base, value, organizationId = orgId) {
  const response = await fetch(base + '/api/secure-guard/admin/organizations/' + organizationId + '/allocation-snapshot', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
}

test('MSP-only transfer keeps zero separate from missing and never calls DNSFilter', async () => {
  const calls = [];
  const repo = {
    setAllocationSnapshot: async (...args) => {
      calls.push(args);
      return {
        allocatedRcLicensesSnapshot: args[2],
        allocationSnapshotUpdatedAt: '2026-11-04T00:00:00.000Z',
        allocationSnapshotUpdatedBy: args[0],
      };
    },
  };
  await withRouter(true, repo, async (base) => {
    assert.equal((await patch(base, { allocatedRcLicensesSnapshot: 0 })).status, 200);
    assert.equal((await patch(base, { allocatedRcLicensesSnapshot: 350 })).body.allocatedRcLicensesSnapshot, 350);
  });
  assert.deepEqual(calls, [
    ['msp-user', orgId, 0],
    ['msp-user', orgId, 350],
  ]);
  await withRouter(false, repo, async (base) => {
    assert.equal((await patch(base, { allocatedRcLicensesSnapshot: 350 })).status, 403);
  });
  assert.equal(calls.length, 2);
});

test('invalid quantities and malformed Organization IDs cannot write', async () => {
  let calls = 0;
  await withRouter(true, {
    setAllocationSnapshot: async () => { calls++; return {}; },
  }, async (base) => {
    for (const value of [null, -1, 0.5, '1', 2147483648]) {
      assert.equal((await patch(base, { allocatedRcLicensesSnapshot: value })).status, 400);
    }
    assert.equal((await patch(base, {}, orgId)).status, 400);
    assert.equal((await patch(base, { allocatedRcLicensesSnapshot: 1 }, 'bad-id')).status, 400);
  });
  assert.equal(calls, 0);
});

test('no active mapping returns 404 and DB failure never pretends success', async () => {
  await withRouter(true, { setAllocationSnapshot: async () => null }, async (base) => {
    assert.deepEqual(await patch(base, { allocatedRcLicensesSnapshot: 1 }),
      { status: 404, body: { error: 'ORGANIZATION_NOT_FOUND' } });
  });
  await withRouter(true, { setAllocationSnapshot: async () => { throw Error('db'); } }, async (base) => {
    assert.deepEqual(await patch(base, { allocatedRcLicensesSnapshot: 1 }),
      { status: 500, body: { error: 'ALLOCATION_SNAPSHOT_UNAVAILABLE' } });
  });
});

test('repo uses active mapped Organization lock and records one audit in the same transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT o.id')) return { rows: [{ id: orgId }] };
      if (sql.includes('UPDATE customer_organizations SET')) {
        return { rows: [{
          dnsfilter_allocated_rc_licenses_snapshot: 0,
          license_snapshot_updated_at: new Date('2026-11-04T00:00:00.000Z'),
          license_snapshot_updated_by: 'msp-user',
        }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const repo = new SecureGuardRepo({ connect: async () => client });
  const result = await repo.setAllocationSnapshot('msp-user', orgId, 0);
  assert.equal(result.allocatedRcLicensesSnapshot, 0);
  assert.match(calls[1].sql, /m\.status = 'active'/);
  assert.match(calls[1].sql, /FOR UPDATE OF o/);
  assert.match(calls[3].sql, /secure_guard_audit_events/);
  assert.deepEqual(calls.map((c) => c.sql === 'RELEASE' ? 'RELEASE' : c.sql.split(' ')[0]),
    ['BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT', 'RELEASE']);
});

test('missing active DNSFilter mapping does not save reference quantity', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  const repo = new SecureGuardRepo({ connect: async () => client });
  assert.equal(await repo.setAllocationSnapshot('msp-user', orgId, 1), null);
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'ROLLBACK');
});
