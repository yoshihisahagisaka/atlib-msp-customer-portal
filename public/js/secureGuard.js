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

function showMspAdminHome() {
  sessionStorage.removeItem('secureGuardMembershipId');
  document.getElementById('scope-section').hidden = true;
  document.getElementById('customer-inventory').hidden = true;
  document.getElementById('msp-admin-notice').hidden = false;
}

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
    const adminLink = document.getElementById('msp-admin-link');
    if (me.mspAdmin && adminLink) adminLink.hidden = false;
    for (const membership of me.memberships) {
      const option = document.createElement('option');
      option.value = membership.membershipId;
      option.textContent = membership.organizationName;
      scopeSelect.appendChild(option);
    }
    const previous = sessionStorage.getItem('secureGuardMembershipId');
    const selected = me.memberships.some((item) => item.membershipId === previous) ? previous : me.memberships[0]?.membershipId;
    if (!selected) {
      if (me.mspAdmin) return showMspAdminHome();
      return showError();
    }
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
      const overview = await secureGuardFetch('/overview');
      agents = overview.agents;
      document.getElementById('organization-name').textContent = overview.organization.name;
      document.getElementById('role').textContent = overview.scope.role;
      document.getElementById('summary').textContent = `登録Site ${overview.siteCount} 件、登録Agent ${overview.agentCount} 件`;
      document.getElementById('fetched-at').textContent = `最終取得日時: ${new Date(overview.fetchedAt).toLocaleString('ja-JP')}（現在のリアルタイム状態ではありません）`;
      renderList('protection', Object.entries(overview.protection), ([state, count]) => `保護状態 ${state}: ${count} 件`);
      renderList('sites', overview.sites, (site) => `${site.name} / Agent ${site.agentCount} 件 / Policy情報: ${site.policy ?? 'APIから取得できる情報なし'}`);
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

const adminError = document.getElementById('admin-error');
function adminErrorMessage() { if (adminError) adminError.textContent = '処理を完了できませんでした。'; }
async function adminFetch(path, options = {}) { return secureGuardFetch(`/admin${path}`, options); }
function adminText(value) { const node = document.createElement('p'); node.textContent = value ?? '—'; return node; }
const organizationForm = document.getElementById('organization-form');
if (organizationForm) {
  let managedOrganizations = [];
  const selectedOrganization = () => document.getElementById('managed-organization-select').value;
  const loadSitesAndPolicies = async () => {
    const id = selectedOrganization(); const siteForm = document.getElementById('site-form');
    if (!id) { siteForm.hidden = true; return; }
    try { const [policies, sites] = await Promise.all([adminFetch(`/organizations/${id}/policies`), adminFetch(`/organizations/${id}/sites`)]); const policyList = document.getElementById('policy-list'); policyList.replaceChildren(...policies.policies.map((p) => adminText(`${p.name} (${p.global ? 'Global' : 'Organization'})`))); const select = document.getElementById('site-policy'); select.replaceChildren(...policies.policies.map((p) => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; return option; })); document.getElementById('site-list').replaceChildren(...sites.sites.map((s) => adminText(`Site: ${s.name}`))); siteForm.hidden = false; } catch { adminErrorMessage(); }
  };
  const renderAdmin = async () => {
    try {
      const [organizationData, auditData] = await Promise.all([adminFetch('/organizations'), adminFetch('/audit')]);
      managedOrganizations = organizationData.organizations; const organizations = document.getElementById('organizations'); organizations.replaceChildren();
      const scope = document.getElementById('managed-organization-select'); const before = scope.value; scope.replaceChildren(); scope.append(new Option('選択してください', ''));
      for (const org of organizationData.organizations) {
        const row = document.createElement('div'); row.className = 'card';
        row.append(adminText(`${org.organizationName} / ${org.status} / DNSFilter: ${org.dnsfilterOrganizationId ?? '未設定'} / ID: ${org.id}`));
        const stop = document.createElement('button'); stop.className = 'btn btn-small'; stop.textContent = org.status === 'active' ? '停止' : '有効化';
        stop.onclick = async () => { try { await adminFetch(`/organizations/${org.id}`, { method: 'PATCH', body: JSON.stringify({ status: org.status === 'active' ? 'suspended' : 'active' }) }); await renderAdmin(); } catch { adminErrorMessage(); } };
        row.append(stop); organizations.append(row); scope.append(new Option(org.organizationName, org.id));
      }
      scope.value = managedOrganizations.some((o) => o.id === before) ? before : '';
      const audit = document.getElementById('audit-events'); audit.replaceChildren(...auditData.events.map((event) => adminText(`${new Date(event.createdAt).toLocaleString('ja-JP')} / ${event.organizationName ?? '全体'} / ${event.action} / ${event.result}`)));
    } catch { adminErrorMessage(); }
  };
  organizationForm.addEventListener('submit', async (event) => { event.preventDefault(); try { const name = document.getElementById('organization-name').value; await adminFetch('/dnsfilter/organizations', { method: 'POST', body: JSON.stringify({ organizationName: name }) }); organizationForm.reset(); await renderAdmin(); } catch { adminErrorMessage(); } });
  document.getElementById('organization-import-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await adminFetch('/dnsfilter/organizations/import', { method: 'POST', body: JSON.stringify({ organizationName: document.getElementById('import-organization-name').value, dnsfilterOrganizationId: document.getElementById('import-dnsfilter-organization-id').value }) }); event.target.reset(); await renderAdmin(); } catch { adminErrorMessage(); } });
  document.getElementById('initial-invitation-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await adminFetch('/initial-memberships/invitations', { method: 'POST', body: JSON.stringify({ customerOrganizationId: document.getElementById('initial-organization-id').value, email: document.getElementById('initial-email').value }) }); } catch { adminErrorMessage(); } });
  document.getElementById('managed-organization-select').addEventListener('change', () => loadSitesAndPolicies());
  document.getElementById('refresh-dnsfilter-organizations').addEventListener('click', async () => { try { const data = await adminFetch('/dnsfilter/organizations'); document.getElementById('dnsfilter-organizations').replaceChildren(...data.organizations.map((o) => adminText(`${o.name} / ID: ${o.id}`))); } catch { adminErrorMessage(); } });
  document.getElementById('site-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const policyIds = [...document.getElementById('site-policy').selectedOptions].map((o) => o.value); await adminFetch(`/organizations/${selectedOrganization()}/sites`, { method: 'POST', body: JSON.stringify({ name: document.getElementById('site-name').value, policyIds }) }); event.target.reset(); await loadSitesAndPolicies(); } catch { adminErrorMessage(); } });
  renderAdmin();
}
