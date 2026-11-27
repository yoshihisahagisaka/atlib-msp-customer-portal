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

const mfaState = { token: null, flow: null, method: null };
const loginForm = document.getElementById('login-form');
const acceptForm = document.getElementById('accept-form');
const mfaSection = document.getElementById('mfa-section');

async function mfaRequest(path, data) {
  const response = await fetch('/api/secure-guard/auth' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'include',
  });
  if (!response.ok) {
    if (response.status === 429) {
      const error = document.getElementById('error');
      if (error) error.textContent = '認証コードの再送または試行上限です。後ほどやり直してください。';
    }
    throw new Error('MFA_REQUEST_DENIED');
  }
  return response.status === 204 ? null : response.json();
}

function startMfaFlow(data) {
  if (!mfaSection) return;
  if (loginForm) loginForm.hidden = true;
  if (acceptForm) acceptForm.hidden = true;
  mfaSection.hidden = false;
  mfaState.token = data.challengeToken ?? null;
  mfaState.flow = data.flow;
  mfaState.method = data.method ?? null;
  const methodForm = document.getElementById('mfa-method-form');
  const codeForm = document.getElementById('mfa-code-form');
  const instructions = document.getElementById('mfa-instructions');
  if (data.flow === 'MFA_LOGIN_REQUIRED') {
    instructions.textContent = '既に登録済みの個人アカウントです。通常のログイン画面からパスワードとMFAで認証してください。';
    const link = document.createElement('a');
    link.href = '/secure-guard-login.html';
    link.textContent = 'ログイン画面へ';
    mfaSection.appendChild(link);
    return;
  }
  if (data.flow === 'MFA_ENROLLMENT_REQUIRED') {
    instructions.textContent = '初回ログインにMFAの登録が必要です。認証方式を選択してください。';
    methodForm.hidden = false;
    codeForm.hidden = true;
  } else if (data.flow === 'MFA_REQUIRED') {
    instructions.textContent = data.method === 'email'
      ? '登録済みメールアドレスへ認証コードを送信しました。'
      : '認証アプリに表示される6桁のコードを入力してください。';
    methodForm.hidden = true;
    codeForm.hidden = false;
    document.getElementById('mfa-resend').hidden = data.method !== 'email';
  } else {
    mfaSection.hidden = true;
    showError();
  }
}

if (loginForm) loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const flow = await mfaRequest('/login', {
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
    });
    startMfaFlow(flow);
  } catch { showError(); }
});

if (acceptForm) acceptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return showError();
  // Invitation token is fragment-only, not persisted in local/sessionStorage.
  history.replaceState(null, '', '/secure-guard-accept.html');
  try {
    const flow = await mfaRequest('/invitations/accept', {
      token, password: document.getElementById('password').value,
    });
    startMfaFlow(flow);
  } catch { showError(); }
});

const mfaMethodForm = document.getElementById('mfa-method-form');
if (mfaMethodForm) mfaMethodForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!mfaState.token || mfaState.flow !== 'MFA_ENROLLMENT_REQUIRED') return showError();
  const method = document.getElementById('mfa-method').value;
  try {
    const result = await mfaRequest('/mfa/enroll/start', {
      challengeToken: mfaState.token, method,
    });
    mfaState.method = method;
    mfaMethodForm.hidden = true;
    document.getElementById('mfa-code-form').hidden = false;
    if (method === 'totp') {
      const url = new URL(result.otpauthUrl);
      const secret = url.searchParams.get('secret');
      if (!secret) throw new Error('MFA_TOTP_CONFIG_UNAVAILABLE');
      const details = document.getElementById('mfa-totp-details');
      details.hidden = false;
      details.textContent = '認証アプリで atLIB Secure Guard を登録し、次のキーを手動入力してください（再表示はできません）: ' + secret;
      document.getElementById('mfa-instructions').textContent = '登録した認証アプリの6桁のコードを入力してください。';
    } else {
      document.getElementById('mfa-instructions').textContent = '登録メールアドレスへ認証コードを送信しました。';
      document.getElementById('mfa-resend').hidden = false;
    }
  } catch { showError(); }
});

const mfaCodeForm = document.getElementById('mfa-code-form');
if (mfaCodeForm) mfaCodeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!mfaState.token) return showError();
  const code = document.getElementById('mfa-code').value;
  const isEnroll = mfaState.flow === 'MFA_ENROLLMENT_REQUIRED';
  try {
    const result = await mfaRequest(isEnroll ? '/mfa/enroll/verify' : '/mfa/verify', {
      challengeToken: mfaState.token, code,
    });
    mfaState.token = null;
    mfaCodeForm.hidden = true;
    document.getElementById('mfa-resend').hidden = true;
    document.getElementById('mfa-totp-details').hidden = true;
    if (isEnroll) {
      const backup = document.getElementById('mfa-backup');
      backup.hidden = false;
      document.getElementById('mfa-instructions').textContent = 'MFAの登録が完了しました。';
      document.getElementById('mfa-backup-codes').textContent = result.backupCodes.join('\n');
    } else {
      location.href = '/secure-guard-home.html';
    }
  } catch { showError(); }
});

const resendMfa = document.getElementById('mfa-resend');
if (resendMfa) resendMfa.addEventListener('click', async () => {
  if (!mfaState.token || mfaState.method !== 'email') return showError();
  try {
    resendMfa.disabled = true;
    await mfaRequest('/mfa/email/resend', { challengeToken: mfaState.token });
    document.getElementById('mfa-instructions').textContent = '新しい認証コードを送信しました。以前のコードは無効です。';
  } catch { showError(); }
  finally { resendMfa.disabled = false; }
});

const mfaDone = document.getElementById('mfa-done');
if (mfaDone) mfaDone.addEventListener('click', () => {
  document.getElementById('mfa-backup-codes').textContent = '';
  location.href = '/secure-guard-home.html';
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
function adminStatus(id, message = '') { const node = document.getElementById(id); if (node) node.textContent = message; }
function adminList(id, items, render, emptyMessage) { const node = document.getElementById(id); node.replaceChildren(...(items.length ? items.map(render) : [adminText(emptyMessage)])); }
const adminOrganizationList = document.getElementById('organizations');
if (adminOrganizationList) {
  let managedOrganizations = [];
  const selectedOrganization = () => document.getElementById('managed-organization-select').value;
  const loadSitesAndPolicies = async () => {
    const id = selectedOrganization(); const siteForm = document.getElementById('site-form');
    if (!id) { siteForm.hidden = true; return; }
    adminStatus('site-policy-status', '取得中です。');
    try { const [policies, sites] = await Promise.all([adminFetch(`/organizations/${id}/policies`), adminFetch(`/organizations/${id}/sites`)]); adminList('policy-list', policies.policies, (p) => adminText(`${p.name} (${p.global ? 'Global / 適用可否の事前確認必須' : 'Organization'})`), '利用可能なPolicyはありません。'); const select = document.getElementById('site-policy'); select.replaceChildren(...policies.policies.map((p) => { const option = document.createElement('option'); option.value = p.id; option.textContent = `${p.name}${p.global ? ' (Global)' : ''}`; return option; })); adminList('site-list', sites.sites, (s) => adminText(`Site: ${s.name}`), '登録済みSiteはありません。'); adminStatus('site-policy-status', '取得しました。'); siteForm.hidden = false; } catch { adminStatus('site-policy-status', 'Site・Policyを取得できませんでした。'); siteForm.hidden = true; }
  };
  const renderAdmin = async () => {
    try {
      const [organizationResult, auditResult] = await Promise.allSettled([adminFetch('/organizations'), adminFetch('/audit')]);
      if (organizationResult.status !== 'fulfilled') { adminStatus('organizations-status', 'Organization一覧を取得できませんでした。'); return; }
      const organizationData = organizationResult.value; managedOrganizations = organizationData.organizations; const organizations = document.getElementById('organizations'); organizations.replaceChildren();
      const scope = document.getElementById('managed-organization-select'); const before = scope.value; scope.replaceChildren(); scope.append(new Option('選択してください', ''));
      for (const org of organizationData.organizations) {
        const row = document.createElement('div'); row.className = 'card';
        row.append(adminText(`${org.organizationName} / ${org.status} / DNSFilter: ${org.dnsfilterOrganizationId ?? '未設定'} / ID: ${org.id}`));
        const licenseStatus = adminText(`割当数: ${org.allocatedLicenses ?? '未設定'} / 使用数: 未確認 / 判定: UNKNOWN${org.licenseSnapshotUpdatedAt ? ` / 転記: ${new Date(org.licenseSnapshotUpdatedAt).toLocaleString('ja-JP')}` : ''}`);
        const allocation = document.createElement('input'); allocation.type = 'number'; allocation.min = '0'; allocation.step = '1'; allocation.value = org.allocatedLicenses ?? ''; allocation.placeholder = 'DNSFilter画面の割当数';
        const saveAllocation = document.createElement('button'); saveAllocation.type = 'button'; saveAllocation.className = 'btn btn-small'; saveAllocation.textContent = '割当数を転記';
        saveAllocation.onclick = async () => { const value = Number(allocation.value); if (!Number.isSafeInteger(value) || value < 0) { licenseStatus.textContent = '割当数は0以上の整数で入力してください。'; return; } try { await adminFetch(`/organizations/${org.id}/license-allocation`, { method: 'PATCH', body: JSON.stringify({ allocatedLicenses: value }) }); await renderAdmin(); } catch { licenseStatus.textContent = '割当数を保存できませんでした。'; } };
        const checkLicense = document.createElement('button'); checkLicense.type = 'button'; checkLicense.className = 'btn btn-small'; checkLicense.textContent = '使用数・超過を確認';
        checkLicense.onclick = async () => { licenseStatus.textContent = 'ライセンス状態を確認中です。'; try { const value = await adminFetch(`/organizations/${org.id}/license-status`); licenseStatus.textContent = `割当数: ${value.allocation.value ?? '未設定'} / 使用数: ${value.usage.value ?? '取得不可'} / 判定: ${value.status}${value.overage === null ? '' : ` / 超過: ${value.overage}`} / 確認: ${new Date(value.usage.checkedAt).toLocaleString('ja-JP')}`; } catch { licenseStatus.textContent = '割当数: 未確認 / 使用数: 取得不可 / 判定: UNKNOWN'; } };
        row.append(licenseStatus, allocation, saveAllocation, checkLicense);
        const stop = document.createElement('button'); stop.className = 'btn btn-small'; stop.textContent = org.status === 'active' ? '停止' : '有効化';
        stop.onclick = async () => { try { await adminFetch(`/organizations/${org.id}`, { method: 'PATCH', body: JSON.stringify({ status: org.status === 'active' ? 'suspended' : 'active' }) }); await renderAdmin(); } catch { adminErrorMessage(); } };
        row.append(stop); organizations.append(row); scope.append(new Option(org.organizationName, org.id));
      }
      scope.value = managedOrganizations.some((o) => o.id === before) ? before : ''; adminStatus('organizations-status', managedOrganizations.length ? '' : 'atLIB管理対象Organizationはまだ登録されていません。');
      if (auditResult.status === 'fulfilled') { adminList('audit-events', auditResult.value.events, (event) => adminText(`${new Date(event.createdAt).toLocaleString('ja-JP')} / ${event.organizationName ?? '全体'} / ${event.action} / ${event.result}`), '監査履歴はありません。'); adminStatus('audit-status'); }
      else { document.getElementById('audit-events').replaceChildren(); adminStatus('audit-status', '監査履歴を取得できませんでした。'); }
    } catch { adminErrorMessage(); }
  };
  document.getElementById('organization-import-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await adminFetch('/dnsfilter/organizations/import', { method: 'POST', body: JSON.stringify({ organizationName: document.getElementById('import-organization-name').value, dnsfilterOrganizationId: document.getElementById('import-dnsfilter-organization-id').value }) }); event.target.reset(); await renderAdmin(); } catch { adminErrorMessage(); } });
  document.getElementById('provisioning-recovery-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const localId = document.getElementById('recovery-organization-id').value; await adminFetch(`/organizations/${localId}/provisioning-recovery`, { method: 'POST', body: JSON.stringify({ dnsfilterOrganizationId: document.getElementById('recovery-dnsfilter-organization-id').value }) }); event.target.reset(); await renderAdmin(); } catch { adminErrorMessage(); } });
  document.getElementById('initial-invitation-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await adminFetch('/initial-memberships/invitations', { method: 'POST', body: JSON.stringify({ customerOrganizationId: document.getElementById('initial-organization-id').value, email: document.getElementById('initial-email').value }) }); } catch { adminErrorMessage(); } });
  document.getElementById('managed-organization-select').addEventListener('change', () => loadSitesAndPolicies());
  document.getElementById('refresh-dnsfilter-organizations').addEventListener('click', async () => { adminStatus('dnsfilter-organizations-status', '取得中です。'); try { const data = await adminFetch('/dnsfilter/organizations'); adminList('dnsfilter-organizations', data.organizations, (o) => adminText(`${o.name} / ID: ${o.id}`), 'MSP配下の顧客Organizationはありません。'); adminStatus('dnsfilter-organizations-status', '取得しました。'); } catch { document.getElementById('dnsfilter-organizations').replaceChildren(); adminStatus('dnsfilter-organizations-status', 'DNSFilter Organization一覧を取得できませんでした。'); } });
  let siteCreationAttempted = false;
  document.getElementById('site-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (siteCreationAttempted) return;
    const organizationId = selectedOrganization();
    const policyIds = [...document.getElementById('site-policy').selectedOptions].map((o) => o.value);
    const data = {
      name: document.getElementById('site-name').value,
      policyIds,
      blockPageId: document.getElementById('site-block-page-id').value,
      externalId: document.getElementById('site-external-id').value,
    };
    if (!organizationId || policyIds.length === 0) { adminStatus('site-policy-status', '対象OrganizationとPolicyを選択してください。'); return; }
    siteCreationAttempted = true;
    event.target.querySelector('button[type="submit"]').disabled = true;
    adminStatus('site-policy-status', 'Site作成要求を送信中です。再送しないでください。');
    try {
      const site = await adminFetch(`/organizations/${organizationId}/sites`, { method: 'POST', body: JSON.stringify(data) });
      adminStatus('site-policy-status', `Site ${site.id} の作成・read-backが確認できました。追加作成は別の承認・操作で行ってください。`);
    } catch {
      adminStatus('site-policy-status', '作成結果が不明です。DNSFilterでSite一覧を確認してください。同じ画面から再送しないでください。');
    }
  });
  renderAdmin();
}
