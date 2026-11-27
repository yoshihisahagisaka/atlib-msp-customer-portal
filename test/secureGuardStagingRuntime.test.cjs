const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runStaging(envOverrides = {}) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    SECURE_GUARD_STAGING_ISOLATED: 'true',
    SECURE_GUARD_DB_MODE: 'dedicated',
    SECURE_GUARD_DB_REQUIRE_DEDICATED: 'true',
    SECURE_GUARD_DB_NAME: 'secure_guard_staging',
    SECURE_GUARD_DB_HOST: '127.0.0.1',
    SECURE_GUARD_DB_USER: 'secure_guard_runtime_staging',
    SECURE_GUARD_DB_PASSWORD: 'local-synthetic-password',
    SECURE_GUARD_JWT_SECRET: 'local-synthetic-session-key-for-test-only-48chars',
    SECURE_GUARD_BASE_URL: 'https://secure-guard.example.test/',
    ...envOverrides,
  };
  // Nothing from Portal, Zabbix, Google OAuth, SMTP, DNSFilter, or cloud Secrets is inherited.
  return spawn(process.execPath, [path.join(__dirname, '../dist/server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(url, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Staging server exited before readiness');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) return;
    } catch { /* only loopback readiness polling */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Staging server never became ready');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Staging server did not stop'));
    }, 3000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`Staging stop failed: ${code} ${signal}`));
    });
    child.kill('SIGTERM');
  });
}

test('one shared Secure Guard process starts without Portal/Zabbix/SMTP/OAuth and denies unsafe routes', async () => {
  const port = await unusedPort();
  const child = runStaging({ PORT: String(port) });
  let errorOutput = '';
  child.stderr.on('data', (chunk) => { errorOutput += String(chunk); });
  child.stdout.resume();
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitReady(`${base}/healthz`, child);
    const root = await fetch(base, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/secure-guard-login.html');
    assert.equal((await fetch(`${base}/secure-guard-login.html`)).status, 200);
    // Public assets are an explicit Secure Guard allowlist, not the entire legacy Portal directory.
    for (const url of ['/css/style.css', '/js/secureGuard.js', '/js/secureGuardHome.js', '/js/secureGuardAdmin.js']) {
      assert.equal((await fetch(base + url)).status, 200, url);
    }
    for (const url of ['/js/api.js', '/js/not-a-guard-script.js', '/secure-guard-accept.html']) {
      assert.equal((await fetch(base + url)).status, 404, url);
    }
    assert.equal((await fetch(`${base}/secure-guard-home.html`)).status, 401);
    assert.equal((await fetch(`${base}/secure-guard-admin.html`)).status, 401);

    // Legacy Portal and legacy admin endpoints are never mounted in this mode.
    for (const url of ['/login.html', '/api/auth/me', '/api/hosts', '/api/admin/settings', '/admin/settings.html']) {
      assert.equal((await fetch(base + url)).status, 404, url);
    }
    assert.equal((await fetch(`${base}/api/secure-guard/overview`)).status, 401);
    // No upstream credential means a forged client cannot read any customer inventory.
    for (const url of [
      '/api/secure-guard/admin/dnsfilter/organizations',
      '/api/secure-guard/admin/organizations/00000000-0000-4000-8000-000000000000/sites',
      '/api/secure-guard/agents/00000000-0000-4000-8000-000000000000/queued-uninstall',
      '/api/secure-guard/memberships/invitations',
      '/api/secure-guard/auth/invitations/accept',
      '/api/secure-guard/auth/mfa/recovery',
      '/api/secure-guard/auth/mfa/reauth/start',
      '/api/secure-guard/auth/mfa/reauth/verify',
      '/api/secure-guard/memberships/00000000-0000-4000-8000-000000000002/mfa/reset',
    ]) {
      const response = await fetch(base + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 503, url);
      assert.deepEqual(await response.json(), { error: 'SECURE_GUARD_STAGING_WRITES_DISABLED' });
    }
    assert.equal(errorOutput, '');
  } finally {
    await stop(child);
  }
});

test('isolated Staging fails closed when dedicated mode or its own JWT secret is missing', async () => {
  for (const override of [
    { SECURE_GUARD_DB_MODE: 'legacy' },
    { SECURE_GUARD_DB_REQUIRE_DEDICATED: 'false' },
    { SECURE_GUARD_JWT_SECRET: '' },
    { SECURE_GUARD_BASE_URL: 'http://example.test/' },
  ]) {
    const child = runStaging({ PORT: '0', ...override });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fail-closed startup hung')); }, 5000);
      child.once('exit', (code) => { clearTimeout(timer); assert.notEqual(code, 0); resolve(); });
    });
    assert.match(stderr, /Fatal startup error:/);
  }
});
