const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');
const { runSecureGuardOverageCheck } = require('../dist/services/secureGuardOverageMonitor');
const { SecureGuardOverageStore } = require('../dist/services/secureGuardOverageStore');
const { compareConfirmedLicenseUsage } = require('../dist/services/secureGuardLicenseOverage');

const orgId = '11111111-1111-4111-8111-111111111111';
const org = { id: orgId, organizationName: 'Customer', status: 'active', mappingStatus: 'active', dnsfilterOrganizationId: '10220954' };
const observedAt = '2026-11-04T06:00:00.000Z';
const cookie = 'secure_guard_session=test';

async function withApp(grant, overageStore, run) {
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: {
      verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }),
      verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }),
    },
    repo: { hasActiveMspAdminGrant: async () => grant, listManagedOrganizations: async () => [org] },
    overageStore, inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

const endpoint = '/api/secure-guard/admin/overage-alerts';
const jsonHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
test('only explicit MSP administrator may list and record human response', async () => {
  const updates = [];
  const store = { listOpen: async () => [{ id: '12', organizationName: 'Customer', overBy: 1 }],
    markInProgress: async (...args) => { updates.push(args); return true; } };
  await withApp(true, store, async (base) => {
    const list = await fetch(base + endpoint, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).alerts[0].overBy, 1);
    const success = await fetch(base + endpoint + '/12/handling', {
      method: 'PATCH', headers: jsonHeaders,
      body: JSON.stringify({ responseChoice: 'reduce_clients', responseNote: '顧客へ確認' }),
    });
    assert.equal(success.status, 204);
    for (const invalid of [
      { responseChoice: 'auto_increase' }, { responseChoice: 'reduce_clients', price: 200 },
      { responseChoice: 'reduce_clients', responseNote: 'x'.repeat(501) },
    ]) {
      assert.equal((await fetch(base + endpoint + '/12/handling', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal((await fetch(base + endpoint + '/bad-id/handling', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ responseChoice: 'reduce_clients' }) })).status, 400);
  });
  assert.deepEqual(updates, [['msp-user', '12', 'reduce_clients', '顧客へ確認']]);
  await withApp(false, store, async (base) => {
    assert.equal((await fetch(base + endpoint, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(base + endpoint + '/12/handling', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ responseChoice: 'increase_allocation' }) })).status, 403);
  });
  assert.equal(updates.length, 1);
  await withApp(true, undefined, async (base) => {
    assert.equal((await fetch(base + endpoint, { headers: { Cookie: cookie } })).status, 503);
  });
});

test('monitor opens once, remains same episode, resolves on confirmed normal usage; no Slack without approved webhook', async () => {
  const episode = { active: false, history: [], claims: 0 };
  let usage = 2;
  const input = {
    repo: { listManagedOrganizations: async () => [org, { ...org, id: 'inactive', status: 'suspended' }] },
    client: { getRoamingUsage: async (id) => {
      assert.equal(id, '10220954');
      return { roamingClientsInUse: usage, dnsfilterAllocatedRoamingClients: 1, retrievedAt: observedAt };
    } },
    store: {
      observe: async (id, dnsfilterId, comparison) => {
        assert.equal(id, orgId); assert.equal(dnsfilterId, '10220954');
        episode.history.push(comparison.status);
        if (comparison.status === 'overage') {
          const result = episode.active ? 'updated' : 'opened';
          episode.active = true;
          return result;
        }
        if (episode.active) { episode.active = false; return 'resolved'; }
        return 'normal';
      },
      reconcileStaleNotifications: async () => 0,
      claimPendingNotification: async () => { episode.claims++; throw Error('must not be called'); },
      completeNotification: async () => { throw Error('must not be called'); },
    },
  };
  const first = await runSecureGuardOverageCheck(input);
  const again = await runSecureGuardOverageCheck(input);
  usage = 1;
  const normal = await runSecureGuardOverageCheck(input);
  assert.equal(first.opened, 1); assert.equal(again.opened, 0);
  assert.equal(normal.resolved, 1);
  assert.equal(episode.claims, 0);
  assert.deepEqual(episode.history, ['overage', 'overage', 'within_allocation']);
});

test('unavailable DNSFilter reading preserves episode status and does not send Slack', async () => {
  let observation = 0;
  const result = await runSecureGuardOverageCheck({
    repo: { listManagedOrganizations: async () => [org] },
    client: { getRoamingUsage: async () => { throw Error('DNSFilter unavailable'); } },
    store: { observe: async () => { observation++; }, reconcileStaleNotifications: async () => 0, claimPendingNotification: async () => null, completeNotification: async () => undefined },
  });
  assert.equal(result.unavailable, 1);
  assert.equal(result.checked, 0);
  assert.equal(observation, 0);
});

test('DB store serializes episodes and rejects stale/out-of-order readings after resolution', async () => {
  const statements = [];
  let activeId = null;
  let latest = null;
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('SELECT o.id')) return { rows: [{ id: orgId }] };
      if (sql.includes('SELECT id, last_observed_at, resolved_at')) {
        return { rows: latest ? [{ id: 1, last_observed_at: latest, resolved_at: activeId ? null : new Date(latest) }] : [] };
      }
      if (sql.includes('INSERT INTO secure_guard_overage_alerts')) {
        activeId = 1; latest = values[4];
      }
      if (sql.includes('UPDATE secure_guard_overage_alerts SET')) {
        if (sql.includes("handling_status = 'resolved'")) {
          activeId = null; latest = values[1];
        } else latest = values[4];
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new SecureGuardOverageStore({ connect: async () => client });
  const over = compareConfirmedLicenseUsage(2, 1);
  const later = '2026-11-04T06:00:01.000Z';
  const resolvedAt = '2026-11-04T06:00:02.000Z';
  assert.equal(await store.observe(orgId, '10220954', over, observedAt), 'opened');
  assert.equal(await store.observe(orgId, '10220954', over, later), 'updated');
  assert.equal(await store.observe(orgId, '10220954', compareConfirmedLicenseUsage(1, 1), resolvedAt), 'resolved');
  assert.equal(await store.observe(orgId, '10220954', over, observedAt), 'stale');
  assert.equal(await store.observe(orgId, '10220954', compareConfirmedLicenseUsage(null, 1), resolvedAt), 'unavailable');
  assert.equal(statements.filter((s) => s.sql.includes('INSERT INTO secure_guard_overage_alerts')).length, 1);
  assert.equal(statements.filter((s) => s.sql.includes('COMMIT')).length, 4);
});

test('one Slack attempt per claimed episode records success or manual-review failure, with no actual webhook call', async () => {
  for (const delivery of ['sent', 'failed']) {
    const calls = { claims: 0, sends: 0, completions: [] };
    const result = await runSecureGuardOverageCheck({
      repo: { listManagedOrganizations: async () => [org] },
      client: { getRoamingUsage: async () => ({ roamingClientsInUse: 2, dnsfilterAllocatedRoamingClients: 1, retrievedAt: observedAt }) },
      store: {
        observe: async () => 'updated',
        reconcileStaleNotifications: async () => 0,
        claimPendingNotification: async () => (++calls.claims === 1
          ? { id: '12', organizationName: 'Customer', usage: 2, allocated: 1, checkedAt: observedAt } : null),
        completeNotification: async (id, state) => { calls.completions.push([id, state]); },
      },
      slackWebhook: 'https://test-only.invalid/no-post',
      sendSlack: async (webhook, message) => {
        assert.equal(webhook, 'https://test-only.invalid/no-post');
        assert.equal(message.usage, 2); assert.equal(message.allocated, 1);
        calls.sends++;
        return delivery;
      },
    });
    assert.equal(calls.sends, 1);
    assert.deepEqual(calls.completions, [['12', delivery === 'sent' ? 'sent' : 'needs_review']]);
    assert.equal(result.notificationsSent, delivery === 'sent' ? 1 : 0);
    assert.equal(result.notificationsNeedReview, delivery === 'sent' ? 0 : 1);
  }
});

test('one-shot job is disabled without explicit opt-in and needs no secrets to refuse execution', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const env = { ...process.env };
  delete env.SECURE_GUARD_OVERAGE_JOB_ENABLED;
  delete env.SECURE_GUARD_LICENSE_ALERT_SLACK_WEBHOOK;
  const processResult = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist/jobs/secureGuardOverageOnce.js')], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(processResult.status, 2);
  assert.match(processResult.stderr, /job is disabled/);
});

test('interrupted Slack attempt is marked for human review and is never auto-retried', async () => {
  const queries = [];
  const store = new SecureGuardOverageStore({ query: async (sql) => {
    queries.push(sql);
    return { rowCount: 2, rows: [] };
  } });
  assert.equal(await store.reconcileStaleNotifications(), 2);
  assert.match(queries[0], /notification_status = 'attempting'/);
  assert.match(queries[0], /notification_status = 'needs_review'/);
  assert.match(queries[0], /15 minutes/);

  const summary = await runSecureGuardOverageCheck({
    repo: { listManagedOrganizations: async () => [] },
    client: { getRoamingUsage: async () => { throw Error('no GET expected'); } },
    store: {
      observe: async () => { throw Error('no observation expected'); },
      reconcileStaleNotifications: async () => 2,
      claimPendingNotification: async () => { throw Error('no webhook, no claims'); },
      completeNotification: async () => { throw Error('no webhook, no send'); },
    },
  });
  assert.equal(summary.notificationsNeedReview, 2);
  assert.equal(summary.notificationsSent, 0);
});
