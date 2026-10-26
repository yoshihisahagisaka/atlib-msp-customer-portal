const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureGuardRepo } = require('../dist/services/secureGuardRepo');

function acceptingPool(userStatus) {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM customer_memberships m') && sql.includes('invite_token_hash')) {
        return { rows: [{ membership_id: 'membership-1', user_id: 'user-1', customer_organization_id: 'org-1', user_status: userStatus }] };
      }
      if (sql.includes('FROM portal_users WHERE id')) {
        return { rows: [{ id: 'user-1', email: 'person@example.test', password_hash: 'existing-hash', status: 'active', session_version: 7 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, queries };
}

test('accepting an added membership for an active identity does not update credentials or sessions', async () => {
  const fixture = acceptingPool('active');
  const repo = new SecureGuardRepo(fixture.pool);
  const user = await repo.acceptInvitation('token-hash', 'new-password-hash');
  assert.equal(user.sessionVersion, 7);
  assert.equal(fixture.queries.some((sql) => sql.includes('UPDATE portal_users')), false);
  assert.equal(fixture.queries.some((sql) => sql.includes("UPDATE customer_memberships")), true);
});

test('first invitation protection locks the organization and has a pending-invitation uniqueness backstop', () => {
  const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations', '011_secure_guard_identity_scope.sql'), 'utf8');
  const repo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'secureGuardRepo.ts'), 'utf8');
  assert.match(migration, /idx_customer_memberships_pending_initial_admin/);
  assert.match(migration, /WHERE is_initial_admin AND status = 'pending'/);
  assert.match(repo, /SELECT id FROM customer_organizations WHERE id = \$1 FOR UPDATE/);
  assert.match(repo, /INITIAL_ADMIN_INVITATION_PENDING/);
});

test('last-org-admin decision is serialized at the organization row', () => {
  const repo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'secureGuardRepo.ts'), 'utf8');
  const revokeMethod = repo.slice(repo.indexOf('async revokeMembership'), repo.indexOf('private async findOrCreateInvitedUser'));
  assert.match(revokeMethod, /SELECT id FROM customer_organizations WHERE id = \$1 FOR UPDATE/);
  assert.match(revokeMethod, /LAST_ORG_ADMIN/);
});

test('initial invitation reissue invalidates the previous token before replacement and audits both actions', () => {
  const repo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'secureGuardRepo.ts'), 'utf8');
  const method = repo.slice(repo.indexOf('async replaceInitialInvitation'), repo.indexOf('async revokeMembership'));
  assert.ok(method.indexOf('cancelPendingInitialInvitation') < method.indexOf('INSERT INTO customer_memberships'));
  assert.match(method, /initial_admin\.invitation\.cancelled/);
  assert.match(method, /initial_admin\.invitation\.reissued/);
  assert.match(method, /role = 'org_admin' AND status = 'active'/);
});
