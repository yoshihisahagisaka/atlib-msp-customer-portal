const test = require('node:test');
const assert = require('node:assert/strict');
const { safeHttpLogRedactions, safeHttpLogSerializers } = require('../dist/lib/httpLog');

test('access log serializer omits credentials and query values for success and error responses', () => {
  const request = { method: 'GET', url: '/api/secure-guard/admin/dnsfilter/organizations?token=secret&cursor=private', headers: { cookie: 'session=secret', authorization: 'Bearer secret' } };
  const safe = safeHttpLogSerializers.req(request);
  assert.deepEqual(safe, { method: 'GET', path: '/api/secure-guard/admin/dnsfilter/organizations' });
  for (const statusCode of [200, 401, 403, 500, 502]) assert.deepEqual(safeHttpLogSerializers.res({ statusCode }), { statusCode });
  assert.match(safeHttpLogRedactions.join(','), /cookie/); assert.match(safeHttpLogRedactions.join(','), /authorization/); assert.match(safeHttpLogRedactions.join(','), /set-cookie/);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});
