// Secure Guard customer view: all data and changes remain server-side Membership-scoped.
const sgHomeNode = (id) => document.getElementById(id);
const sgHomeStatus = (id, value) => { sgHomeNode(id).textContent = value; };
const sgHomeRoles = { org_admin: '管理者', operator: '運用者', viewer: '閲覧者' };
let sgHomeMembership = null;
let sgHomeOverview = null;
let sgHomeSelectedAgentId = null;
let sgHomeInventorySequence = 0;
let sgHomeMembershipSequence = 0;
let sgHomeInvitationAttempted = false;
const sgHomeUnknownMemberActions = new Set();

async function sgHomeFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (sgHomeMembership) headers['X-Secure-Guard-Membership'] = sgHomeMembership.membershipId;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/secure-guard' + path, { credentials: 'include', ...options, headers });
  if (response.status === 401) {
    location.href = '/secure-guard-login.html';
    throw new Error('AUTH_REQUIRED');
  }
  const bodyText = await response.text();
  let data = null;
  try { data = bodyText ? JSON.parse(bodyText) : null; } catch { throw new Error('RESPONSE_UNKNOWN'); }
  if (!response.ok) throw new Error(data?.error || 'REQUEST_FAILED');
  return data;
}

function sgHomeCell(value) {
  const cell = document.createElement('td');
  cell.textContent = value ?? '—';
  return cell;
}

function sgHomeClearInventory() {
  sgHomeOverview = null;
  sgHomeSelectedAgentId = null;
  sgHomeNode('agent-detail').hidden = true;
  for (const id of ['agent-count', 'protected-count', 'other-count', 'site-count']) sgHomeStatus(id, '—');
  sgHomeStatus('fetched-at', 'データ未取得');
  sgHomeNode('agents').replaceChildren();
  sgHomeNode('sites').replaceChildren();
  sgHomeStatus('agent-list-status', '');
  sgHomeStatus('sites-status', '');
}

function sgHomeDrawAgents() {
  if (!sgHomeOverview) return;
  const overview = sgHomeOverview;
  const siteNames = new Map(overview.sites.map((site) => [site.id, site.name]));
  const filter = sgHomeNode('agent-filter').value.toLocaleLowerCase('ja').trim();
  const agents = overview.agents.filter((agent) => {
    const searchable = [agent.hostname, siteNames.get(agent.siteId) || agent.siteId, agent.status, agent.agentState].join(' ').toLocaleLowerCase('ja');
    return searchable.includes(filter);
  });
  const rows = agents.map((agent) => {
    const row = document.createElement('tr');
    if (agent.id === sgHomeSelectedAgentId) row.className = 'sg-home-selected-agent';
    const detailButton = document.createElement('button');
    detailButton.type = 'button'; detailButton.className = 'btn btn-secondary btn-small';
    detailButton.textContent = '表示';
    detailButton.setAttribute('aria-label', `${agent.hostname} の詳細を表示`);
    detailButton.addEventListener('click', () => {
      sgHomeSelectedAgentId = agent.id;
      sgHomeStatus('detail-hostname', agent.hostname);
      sgHomeStatus('detail-site', siteNames.get(agent.siteId) || agent.siteId);
      sgHomeStatus('detail-status', agent.status);
      sgHomeStatus('detail-agent-state', agent.agentState);
      sgHomeNode('agent-detail').hidden = false;
      sgHomeDrawAgents();
    });
    const actionCell = document.createElement('td'); actionCell.append(detailButton);
    row.append(
      sgHomeCell(agent.hostname),
      sgHomeCell(siteNames.get(agent.siteId) || agent.siteId),
      sgHomeCell(agent.status),
      sgHomeCell(agent.agentState),
      actionCell,
    );
    return row;
  });
  sgHomeNode('agents').replaceChildren(...rows);
  sgHomeStatus('agent-list-status', agents.length ? `表示 ${agents.length}件 / 登録 ${overview.agentCount}件` : '該当する端末はありません。');
}

function sgHomeDrawInventory(overview) {
  sgHomeOverview = overview;
  sgHomeSelectedAgentId = null;
  sgHomeNode('agent-detail').hidden = true;
  const protectedCount = overview.agents.filter((agent) => agent.status === 'active' && agent.agentState === 'protected').length;
  sgHomeStatus('organization-name', overview.organization.name);
  sgHomeStatus('role', `ご利用権限：${sgHomeRoles[overview.scope.role] || overview.scope.role}`);
  sgHomeStatus('agent-count', String(overview.agentCount));
  sgHomeStatus('protected-count', String(protectedCount));
  sgHomeStatus('other-count', String(overview.agentCount - protectedCount));
  sgHomeStatus('site-count', String(overview.siteCount));
  sgHomeStatus('fetched-at', `最終取得：${new Date(overview.fetchedAt).toLocaleString('ja-JP')}（リアルタイム状態ではありません）`);
  const siteNodes = overview.sites.map((site) => {
    const node = document.createElement('li');
    node.textContent = `${site.name} / 登録端末 ${site.agentCount}件`;
    return node;
  });
  sgHomeNode('sites').replaceChildren(...siteNodes);
  sgHomeStatus('sites-status', siteNodes.length ? '' : '登録済みSiteはありません。');
  sgHomeDrawAgents();
}

async function sgHomeLoadInventory() {
  const sequence = ++sgHomeInventorySequence;
  const membershipId = sgHomeMembership?.membershipId;
  sgHomeStatus('inventory-status', '端末情報を取得しています。');
  sgHomeNode('refresh-inventory').disabled = true;
  try {
    const result = await sgHomeFetch('/overview');
    if (sequence !== sgHomeInventorySequence || membershipId !== sgHomeMembership?.membershipId) return;
    sgHomeDrawInventory(result);
    sgHomeStatus('inventory-status', result.agentCount === 0 ? '取得成功：登録端末は0件です。' : '');
  } catch {
    if (sequence !== sgHomeInventorySequence || membershipId !== sgHomeMembership?.membershipId) return;
    sgHomeClearInventory();
    sgHomeStatus('inventory-status', '端末情報を取得できませんでした。0件ではなく、現在の状態は不明です。');
  } finally {
    if (sequence === sgHomeInventorySequence) sgHomeNode('refresh-inventory').disabled = false;
  }
}

function sgHomeRenderMemberships(memberships) {
  const isAdmin = sgHomeMembership?.role === 'org_admin';
  sgHomeNode('administrator-guidance').hidden = !isAdmin;
  sgHomeNode('customer-invitation-form').hidden = !isAdmin;
  sgHomeNode('membership-action-heading').hidden = !isAdmin;
  const rows = memberships.map((member) => {
    const row = document.createElement('tr');
    row.append(sgHomeCell(member.email));
    if (isAdmin) {
      const roleCell = document.createElement('td');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${member.email}の権限`);
      for (const [value, label] of Object.entries(sgHomeRoles)) select.add(new Option(label, value));
      select.value = member.role;
      roleCell.append(select);
      row.append(roleCell);
    } else row.append(sgHomeCell(sgHomeRoles[member.role] || member.role));
    row.append(sgHomeCell(member.status));
    if (isAdmin) {
      const actions = document.createElement('td');
      actions.className = 'sg-home-member-actions';
      const update = document.createElement('button');
      update.type = 'button'; update.className = 'btn btn-secondary btn-small'; update.textContent = '権限を保存';
      const revoke = document.createElement('button');
      revoke.type = 'button'; revoke.className = 'btn btn-danger btn-small'; revoke.textContent = '利用を停止';
      const unknown = sgHomeUnknownMemberActions.has(member.id);
      update.disabled = unknown || member.status !== 'active';
      revoke.disabled = unknown || member.status !== 'active';
      const roleSelect = row.querySelector('select');
      update.addEventListener('click', async () => {
        if (roleSelect.value === member.role) return;
        await sgHomeChangeMembership(member, 'role', roleSelect.value, [update, revoke]);
      });
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`${member.email} の利用を停止しますか？\nログインできなくなります。最後の管理者は停止できません。`)) return;
        await sgHomeChangeMembership(member, 'revoke', null, [update, revoke]);
      });
      actions.append(update, revoke);
      row.append(actions);
    }
    return row;
  });
  sgHomeNode('membership-list').replaceChildren(...rows);
  sgHomeStatus('membership-status', memberships.length ? `利用者 ${memberships.length}名` : '登録済み利用者はいません。');
}

async function sgHomeLoadMemberships() {
  const sequence = ++sgHomeMembershipSequence;
  const membershipId = sgHomeMembership?.membershipId;
  sgHomeStatus('membership-status', '利用者を取得しています。');
  sgHomeNode('refresh-memberships').disabled = true;
  try {
    const { memberships } = await sgHomeFetch('/memberships');
    if (sequence !== sgHomeMembershipSequence || membershipId !== sgHomeMembership?.membershipId) return;
    sgHomeRenderMemberships(memberships);
  } catch {
    if (sequence !== sgHomeMembershipSequence || membershipId !== sgHomeMembership?.membershipId) return;
    sgHomeNode('membership-list').replaceChildren();
    sgHomeStatus('membership-status', '利用者情報を取得できませんでした。');
  } finally {
    if (sequence === sgHomeMembershipSequence) sgHomeNode('refresh-memberships').disabled = false;
  }
}

async function sgHomeChangeMembership(member, operation, newRole, buttons) {
  if (sgHomeMembership?.role !== 'org_admin' || sgHomeUnknownMemberActions.has(member.id)) return;
  const membershipId = sgHomeMembership.membershipId;
  sgHomeUnknownMemberActions.add(member.id);
  for (const button of buttons) button.disabled = true;
  sgHomeStatus('membership-status', '利用者情報を更新しています。');
  try {
    if (operation === 'role') await sgHomeFetch(`/memberships/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
    else await sgHomeFetch(`/memberships/${encodeURIComponent(member.id)}/revoke`, { method: 'POST' });
    if (sgHomeMembership?.membershipId !== membershipId) return;
    sgHomeUnknownMemberActions.delete(member.id);
    await sgHomeLoadMemberships();
  } catch {
    if (sgHomeMembership?.membershipId === membershipId) sgHomeStatus('membership-status', '更新結果を確認できません。利用者一覧と管理者へ確認するまで、同じ操作を再送しないでください。');
  }
}

function sgHomeSelectMembership(membership) {
  sgHomeMembership = membership;
  sessionStorage.setItem('secureGuardMembershipId', membership.membershipId);
  ++sgHomeInventorySequence; ++sgHomeMembershipSequence;
  sgHomeInvitationAttempted = false;
  sgHomeUnknownMemberActions.clear();
  sgHomeNode('customer-invitation-form').querySelector('button[type="submit"]').disabled = false;
  sgHomeStatus('customer-invitation-status', '');
  sgHomeStatus('organization-name', membership.organizationName);
  sgHomeStatus('role', `ご利用権限：${sgHomeRoles[membership.role] || membership.role}`);
  sgHomeClearInventory();
  sgHomeNode('membership-list').replaceChildren();
  sgHomeStatus('membership-status', '');
  sgHomeNode('administrator-guidance').hidden = true;
  sgHomeNode('customer-invitation-form').hidden = true;
  sgHomeNode('membership-action-heading').hidden = true;
  sgHomeLoadInventory();
  sgHomeLoadMemberships();
}

sgHomeNode('scope').addEventListener('change', () => {
  const membership = sgHomeAvailableMemberships.find((item) => item.membershipId === sgHomeNode('scope').value);
  if (membership) sgHomeSelectMembership(membership);
});
sgHomeNode('agent-filter').addEventListener('input', sgHomeDrawAgents);
sgHomeNode('refresh-inventory').addEventListener('click', sgHomeLoadInventory);
sgHomeNode('refresh-memberships').addEventListener('click', sgHomeLoadMemberships);
let sgHomeAvailableMemberships = [];

sgHomeNode('customer-invitation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sgHomeMembership?.role !== 'org_admin' || sgHomeInvitationAttempted) return;
  const membershipId = sgHomeMembership.membershipId;
  sgHomeInvitationAttempted = true;
  const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
  sgHomeStatus('customer-invitation-status', '招待を送信しています。');
  try {
    await sgHomeFetch('/memberships/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: sgHomeNode('customer-invitation-email').value, role: sgHomeNode('customer-invitation-role').value }),
    });
    if (sgHomeMembership?.membershipId !== membershipId) return;
    event.target.reset();
    sgHomeInvitationAttempted = false;
    button.disabled = false;
    sgHomeStatus('customer-invitation-status', '招待を受け付けました。');
    await sgHomeLoadMemberships();
  } catch {
    if (sgHomeMembership?.membershipId === membershipId) sgHomeStatus('customer-invitation-status', '招待結果が不明です。二重送信を避け、利用者一覧とメール配送状況を確認してください。');
  }
});

sgHomeNode('logout').addEventListener('click', async () => {
  try {
    await sgHomeFetch('/auth/logout', { method: 'POST' });
    sessionStorage.removeItem('secureGuardMembershipId');
    location.href = '/secure-guard-login.html';
  } catch { sgHomeStatus('error', 'ログアウトを完了できませんでした。もう一度お試しください。'); }
});

(async () => {
  try {
    const me = await sgHomeFetch('/me');
    sgHomeNode('msp-admin-link').hidden = !me.mspAdmin;
    sgHomeAvailableMemberships = me.memberships;
    if (!me.memberships.length) {
      sessionStorage.removeItem('secureGuardMembershipId');
      if (me.mspAdmin) sgHomeNode('msp-admin-notice').hidden = false;
      else sgHomeStatus('error', '利用可能な顧客Organizationがありません。管理者へご連絡ください。');
      return;
    }
    const scope = sgHomeNode('scope');
    for (const member of me.memberships) scope.add(new Option(member.organizationName, member.membershipId));
    sgHomeNode('scope-section').hidden = me.memberships.length === 1;
    const previous = sessionStorage.getItem('secureGuardMembershipId');
    const selected = me.memberships.find((member) => member.membershipId === previous) || me.memberships[0];
    scope.value = selected.membershipId;
    sgHomeNode('customer-inventory').hidden = false;
    sgHomeSelectMembership(selected);
  } catch { sgHomeStatus('error', '利用情報を取得できませんでした。時間をおいて再読み込みしてください。'); }
})();
