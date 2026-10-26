async function secureGuardFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const membershipId = sessionStorage.getItem('secureGuardMembershipId');
  if (membershipId) headers['X-Secure-Guard-Membership'] = membershipId;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/secure-guard' + path, { ...options, headers, credentials: 'include' });
  if (response.status === 401) {
    location.href = '/secure-guard-login.html';
    throw new Error('AUTH_REQUIRED');
  }
  if (!response.ok) throw new Error('REQUEST_FAILED');
  return response.status === 204 ? null : response.json();
}

function showError() { const node = document.getElementById('error'); if (node) node.textContent = '処理を完了できませんでした。'; }

const loginForm = document.getElementById('login-form');
if (loginForm) loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await secureGuardFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }) });
    location.href = '/secure-guard-home.html';
  } catch { showError(); }
});

const acceptForm = document.getElementById('accept-form');
if (acceptForm) acceptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return showError();
  try {
    await secureGuardFetch('/auth/invitations/accept', { method: 'POST', body: JSON.stringify({ token, password: document.getElementById('password').value }) });
    history.replaceState(null, '', '/secure-guard-home.html');
    location.href = '/secure-guard-home.html';
  } catch { showError(); }
});

const scopeSelect = document.getElementById('scope');
if (scopeSelect) (async () => {
  try {
    const me = await secureGuardFetch('/me');
    for (const membership of me.memberships) {
      const option = document.createElement('option');
      option.value = membership.membershipId;
      option.textContent = membership.organizationName;
      scopeSelect.appendChild(option);
    }
    const previous = sessionStorage.getItem('secureGuardMembershipId');
    const selected = me.memberships.some((item) => item.membershipId === previous) ? previous : me.memberships[0]?.membershipId;
    if (!selected) return showError();
    scopeSelect.value = selected;
    sessionStorage.setItem('secureGuardMembershipId', selected);
    const renderList = (id, items, text) => {
      const list = document.getElementById(id);
      list.replaceChildren(...items.map((item) => {
        const node = document.createElement('li');
        node.textContent = text(item);
        return node;
      }));
    };
    const render = async () => {
      sessionStorage.setItem('secureGuardMembershipId', scopeSelect.value);
      const overview = await secureGuardFetch('/overview');
      document.getElementById('organization-name').textContent = overview.organization.name;
      document.getElementById('role').textContent = overview.scope.role;
      const observation = document.getElementById('observation');
      if (overview.observation.status !== 'verified') {
        observation.textContent = '検証済みの観測結果は現在表示できません。現在のリアルタイム保護状態を示すものではありません。';
        renderList('sites', [], () => '');
        renderList('agents', [], () => '');
        return;
      }
      observation.textContent = `C2観測結果（${new Date(overview.observation.observedAt).toLocaleString('ja-JP')}）：DryRun、変更 ${overview.observation.mutations} 件、Site ${overview.observation.siteCount} 件、Agent ${overview.observation.agentCount} 件。これは現在のリアルタイム保護状態ではありません。`;
      const [sites, agents] = await Promise.all([secureGuardFetch('/sites'), secureGuardFetch('/agents')]);
      renderList('sites', sites.sites, (site) => `Site ${site.displayOrder}：Agent ${site.agentCount} 件`);
      renderList('agents', agents.agents, (agent) => `Agent ${agent.displayOrder}：Site ${agent.siteDisplayOrder}、状態 ${agent.status} / ${agent.agentState}`);
    };
    scopeSelect.addEventListener('change', () => { render().catch(showError); });
    await render();
  } catch { showError(); }
})();

const logout = document.getElementById('logout');
if (logout) logout.addEventListener('click', async () => {
  await secureGuardFetch('/auth/logout', { method: 'POST' });
  sessionStorage.removeItem('secureGuardMembershipId');
  location.href = '/secure-guard-login.html';
});
