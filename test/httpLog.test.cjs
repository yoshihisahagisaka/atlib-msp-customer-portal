const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { safeHttpLogRedactions, safeHttpLogSerializers } = require('../dist/lib/httpLog');

test('access log serializer omits credentials and query values for success and error responses', () => {
  const request = { method: 'GET', url: '/api/secure-guard/admin/dnsfilter/organizations?token=secret&cursor=private', headers: { cookie: 'session=secret', authorization: 'Bearer secret' } };
  const safe = safeHttpLogSerializers.req(request);
  assert.deepEqual(safe, { method: 'GET', path: '/api/secure-guard/admin/dnsfilter/organizations' });
  for (const statusCode of [200, 401, 403, 500, 502]) assert.deepEqual(safeHttpLogSerializers.res({ statusCode }), { statusCode });
  assert.match(safeHttpLogRedactions.join(','), /cookie/); assert.match(safeHttpLogRedactions.join(','), /authorization/); assert.match(safeHttpLogRedactions.join(','), /set-cookie/);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});

test('pino-http emits only the method, path, status, and timing across auth and upstream failures', async () => {
  const output = new PassThrough(); let logs = '';
  output.on('data', (chunk) => { logs += chunk.toString('utf8'); });
  const app = express(); app.use(pinoHttp({ logger: pino(output), serializers: safeHttpLogSerializers, redact: safeHttpLogRedactions }));
  for (const status of [200, 401, 403, 500, 502]) app.get(`/status-${status}`, (_req, res) => res.status(status).end());
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    for (const status of [200, 401, 403, 500, 502]) await fetch(`http://127.0.0.1:${server.address().port}/status-${status}?access_token=private`, { headers: { Cookie: 'secure_guard_session=secret', Authorization: 'Bearer secret', 'Set-Cookie': 'ignored=secret' } });
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  assert.doesNotMatch(logs, /secret|private|access_token|authorization|cookie/i);
  for (const status of [200, 401, 403, 500, 502]) assert.match(logs, new RegExp(`\\"statusCode\\":${status}`));
  assert.match(logs, /responseTime/);
});
