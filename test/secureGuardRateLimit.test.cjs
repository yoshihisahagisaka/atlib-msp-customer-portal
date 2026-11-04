const test = require('node:test');
const assert = require('node:assert/strict');
const { LoginRateLimiter, checkLoginRateLimitFor, createIpRateLimiter } = require('../dist/middleware/rateLimit');

function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}

test('account limiter rejects the sixth failed Secure Guard login attempt', () => {
  const limiter = new LoginRateLimiter();
  for (let index = 0; index < 5; index += 1) limiter.recordFailure('person@example.test');
  const res = response();
  checkLoginRateLimitFor(limiter)({ body: { email: 'PERSON@example.test' } }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 429);
});

test('IP limiter rejects requests above its configured window limit', () => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, maxRequests: 1 });
  let continued = false;
  limiter({ ip: '192.0.2.1' }, response(), () => { continued = true; });
  assert.equal(continued, true);
  const res = response();
  limiter({ ip: '192.0.2.1' }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 429);
});
