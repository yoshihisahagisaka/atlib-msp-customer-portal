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

function renderList(id, items, text) {
  const list = document.getElementById(id);
  list.replaceChildren(...items.map((item) => {
    const node = document.createElement('li');
    node.textContent = text(item);
    return node;
  }));
}

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
    let agents = [];
    const renderAgents = () => {
      const filter = (document.getElementById('agent-filter').value || '').toLocaleLowerCase('ja');
      renderList('agents', agents.filter((agent) => `${agent.hostname} ${agent.siteId} ${agent.status} ${agent.agentState}`.toLocaleLowerCase('ja').includes(filter)), (agent) => `${agent.hostname} / Site ${agent.siteId} / ${agent.status} / ${agent.agentState}`);
    };
    document.getElementById('agent-filter').addEventListener('input', renderAgents);
    const render = async () => {
      sessionStorage.setItem('secureGuardMembershipId', scopeSelect.value);
      const [overview, sites] = await Promise.all([secureGuardFetch('/overview'), secureGuardFetch('/sites')]);
      const agentResponse = await secureGuardFetch('/agents');
      agents = agentResponse.agents;
      document.getElementById('organization-name').textContent = overview.organization.name;
      document.getElementById('role').textContent = overview.scope.role;
      document.getElementById('summary').textContent = `登録Site ${overview.siteCount} 件、登録Agent ${overview.agentCount} 件`;
      document.getElementById('fetched-at').textContent = `最終取得日時: ${new Date(overview.fetchedAt).toLocaleString('ja-JP')}（現在のリアルタイム状態ではありません）`;
      renderList('protection', Object.entries(overview.protection), ([state, count]) => `保護状態 ${state}: ${count} 件`);
      renderList('sites', sites.sites, (site) => `${site.name} / Agent ${site.agentCount} 件 / Policy情報: ${site.policy ?? 'APIから取得できる情報なし'}`);
      renderAgents();
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
