const test = require('node:test');
const assert = require('node:assert/strict');
const { compareConfirmedLicenseUsage } = require('../dist/services/secureGuardLicenseOverage');
const { sendSecureGuardOverageSlack } = require('../dist/services/secureGuardOverageSlack');

test('no invented counts: missing or invalid official usage remains UNKNOWN', () => {
  assert.equal(compareConfirmedLicenseUsage(null, 350).status, 'unknown');
  assert.equal(compareConfirmedLicenseUsage(355, null).status, 'unknown');
  assert.equal(compareConfirmedLicenseUsage(-1, 350).status, 'unknown');
  assert.equal(compareConfirmedLicenseUsage(355.5, 350).status, 'unknown');
  assert.deepEqual(compareConfirmedLicenseUsage(350, 350),
    { status: 'within_allocation', usage: 350, allocated: 350, overBy: 0 });
  assert.deepEqual(compareConfirmedLicenseUsage(355, 350),
    { status: 'overage', usage: 355, allocated: 350, overBy: 5 });
  assert.deepEqual(compareConfirmedLicenseUsage(2, 0),
    { status: 'overage', usage: 2, allocated: 0, overBy: 2 });
});

test('Slack disabled until a dedicated webhook is configured', async () => {
  let called = false;
  const event = { organizationName: 'Example', usage: 355, allocated: 350, checkedAt: '2026-11-04T04:00:00Z' };
  const delivery = await sendSecureGuardOverageSlack(undefined, event, async () => { called = true; return { ok: true }; });
  assert.equal(delivery, 'not_configured');
  assert.equal(called, false);
});

test('Slack adapter reports success only after successful POST', async () => {
  const event = { organizationName: 'Test @channel\nExample', usage: 355, allocated: 350, checkedAt: '2026-11-04T04:00:00Z' };
  let postBody;
  const send = async (_url, init) => { postBody = JSON.parse(init.body); return { ok: true }; };
  assert.equal(await sendSecureGuardOverageSlack('https://example.test/webhook', event, send), 'sent');
  assert.match(postBody.text, /超過: 5台/);
  assert.doesNotMatch(postBody.text, /@channel/);
});

test('non-2xx, transport failure and invalid events cannot be recorded as sent', async () => {
  const e = { organizationName: 'Example', usage: 355, allocated: 350, checkedAt: '2026-11-04T04:00:00Z' };
  assert.equal(await sendSecureGuardOverageSlack('https://example.test/webhook', e, async () => ({ ok: false })), 'failed');
  assert.equal(await sendSecureGuardOverageSlack('https://example.test/webhook', e, async () => { throw new Error('fail'); }), 'failed');
  assert.equal(await sendSecureGuardOverageSlack('https://example.test/webhook', { ...e, usage: 350 }, async () => assert.fail('should not send')), 'failed');
});
