// MSP-only administration. DNSFilter registration is performed in its own console;
// the portal imports only confirmed MSP child Organizations on initial load/F5.
const sgNode = (id) => document.getElementById(id);
const sgStatus = (id, message) => { sgNode(id).textContent = message; };
const sgText = (value) => { const p = document.createElement('p'); p.textContent = value; return p; };

async function sgAdminFetch(path, options = {}) {
  const response = await fetch(`/api/secure-guard/admin${path}`, {
    credentials: 'include',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  if (response.status === 401) { location.href = '/secure-guard-login.html'; throw new Error('AUTH_REQUIRED'); }
  const bodyText = await response.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { throw new Error('RESPONSE_UNKNOWN'); }
  if (!response.ok) throw new Error(body?.error || 'REQUEST_FAILED');
  return body;
}

let sgOrganizations = [];
let sgSyncInFlight = false;
let sgDetailSequence = 0;
let sgInvitationAttempted = false;
const sgScope = sgNode('managed-organization-select');

function sgSelectedOrganization() { return sgOrganizations.find((org) => org.id === sgScope.value); }

function sgRenderOrganizations() {
  const before = sgScope.value;
  sgScope.replaceChildren(new Option('選択してください', ''));
  sgNode('organizations').replaceChildren();
  for (const org of sgOrganizations) {
    const available = org.status === 'active' && org.mappingStatus === 'active' && org.dnsfilterOrganizationId;
    const option = new Option(org.organizationName, org.id);
    option.disabled = !available;
    sgScope.add(option);
    const row = document.createElement('button'); row.type = 'button'; row.className = 'sg-admin-customer';
    row.disabled = !available || sgSyncInFlight;
    row.append(document.createTextNode(org.organizationName));
    const note = document.createElement('small');
    note.textContent = available ? '連携済み・有効' : '要確認（停止中またはDNSFilter連携未完了）';
    row.append(note);
    row.addEventListener('click', () => { sgScope.value = org.id; sgInvitationAttempted = false; sgStatus('invitation-status', ''); sgRenderOrganizationsSelection(); sgLoadDetails(); });
    row.dataset.organizationId = org.id;
    sgNode('organizations').append(row);
  }
  sgScope.value = sgOrganizations.some((org) => org.id === before && org.status === 'active' && org.mappingStatus === 'active') ? before : '';
  sgRenderOrganizationsSelection();
}

function sgRenderOrganizationsSelection() {
  for (const row of sgNode('organizations').children) row.setAttribute('aria-pressed', String(row.dataset.organizationId === sgScope.value));
}

async function sgLoadAudit() {
  try {
    const { events } = await sgAdminFetch('/audit');
    sgNode('audit-events').replaceChildren(...(events.length ? events.map((event) => sgText(`${new Date(event.createdAt).toLocaleString('ja-JP')} / ${event.organizationName || '全体'} / ${event.action} / ${event.result}`)) : [sgText('監査履歴はありません。')]));
    sgStatus('audit-status', '');
  } catch { sgStatus('audit-status', '監査履歴を取得できませんでした。'); }
}

let sgOverageLoading = false;
async function sgLoadOverageAlerts() {
  if (sgOverageLoading) return;
  sgOverageLoading = true;
  sgNode('refresh-overage-alerts').disabled = true;
  sgStatus('overage-alerts-status', '未解消の超過を取得しています。');
  const container = sgNode('overage-alerts');
  try {
    const data = await sgAdminFetch('/overage-alerts');
    if (!Array.isArray(data?.alerts)) throw new Error('INVALID_ALERTS');
    const cards = data.alerts.map((alert) => {
      const card = document.createElement('div');
      card.className = 'sg-overage-item';
      const heading = document.createElement('h3');
      heading.textContent = alert.organizationName;
      card.append(heading);
      card.append(sgText(`割当 ${alert.allocated}台 / 利用 ${alert.usage}台 / 超過 ${alert.overBy}台`));
      const notification = {
        pending: '通知待ち', attempting: '送信処理中',
        sent: '通知済み', needs_review: '送信要確認（自動再送しません）',
      }[alert.notificationStatus] || '通知状況不明';
      card.append(sgText(`検出: ${new Date(alert.openedAt).toLocaleString('ja-JP')} / 最終確認: ${new Date(alert.lastObservedAt).toLocaleString('ja-JP')}`));
      card.append(sgText(`対応: ${alert.handlingStatus === 'in_progress' ? '対応中' : '未対応'} / Slack: ${notification}`));

      const form = document.createElement('form');
      const choiceLabel = document.createElement('label');
      choiceLabel.textContent = '対応方針';
      const choice = document.createElement('select');
      choice.required = true;
      choice.append(
        new Option('選択してください', ''),
        new Option('不要な端末を整理する', 'reduce_clients'),
        new Option('割当ライセンス数を増やす', 'increase_allocation'),
      );
      choice.value = alert.responseChoice || '';
      choiceLabel.append(choice);
      const noteLabel = document.createElement('label');
      noteLabel.textContent = '対応メモ（任意・500文字以内）';
      const note = document.createElement('textarea');
      note.maxLength = 500;
      note.value = alert.responseNote || '';
      noteLabel.append(note);
      const save = document.createElement('button');
      save.type = 'submit';
      save.className = 'btn btn-secondary';
      save.textContent = '対応内容を記録';
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      form.append(choiceLabel, noteLabel, save, status);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!choice.value || save.disabled) return;
        save.disabled = true;
        status.textContent = '記録しています。';
        try {
          await sgAdminFetch(`/overage-alerts/${encodeURIComponent(alert.id)}/handling`, {
            method: 'PATCH',
            body: JSON.stringify({ responseChoice: choice.value, responseNote: note.value.trim() || null }),
          });
          await sgLoadOverageAlerts();
        } catch {
          // The server may have committed; do not silently issue another PATCH.
          status.textContent = '結果が不明です。再送する前に対応状況と監査履歴を確認してください。';
        }
      });
      card.append(form);
      return card;
    });
    container.replaceChildren(...(cards.length ? cards : [sgText('未解消の超過記録はありません。定期監視が未稼働の場合、未検出であることを意味しません。')]));
    sgStatus('overage-alerts-status', `未解消の超過 ${cards.length}件（直近の定期取得結果）`);
  } catch {
    container.replaceChildren();
    sgStatus('overage-alerts-status', '超過対応状況を取得できません。専用DBまたは定期監視が未稼働の可能性があります。');
  } finally {
    sgOverageLoading = false;
    sgNode('refresh-overage-alerts').disabled = false;
  }
}

async function sgLoadDetails() {
  const sequence = ++sgDetailSequence;
  const org = sgSelectedOrganization();
  sgNode('initial-invitation-form').querySelector('button[type="submit"]').disabled = !org || sgInvitationAttempted || sgSyncInFlight;
  sgNode('site-list').replaceChildren();
  sgNode('membership-list').replaceChildren();
  sgNode('selected-license-allocation').value = org?.allocatedLicenses ?? '';
  sgNode('save-license-allocation').disabled = !org || sgSyncInFlight;
  sgNode('check-license-status').disabled = !org || sgSyncInFlight;
  if (!org) {
    sgStatus('selected-organization-summary', '顧客を選択してください。');
    sgStatus('sites-status', ''); sgStatus('membership-status', ''); sgStatus('selected-license-status', '');
    return;
  }
  sgStatus('selected-organization-summary', `${org.organizationName} / DNSFilter連携済み`);
  sgStatus('sites-status', '取得中です。'); sgStatus('membership-status', '取得中です。');
  sgStatus('selected-license-status', `割当数: ${org.allocatedLicenses ?? '未設定'} / 使用数: 未確認`);
  const [sites, memberships] = await Promise.allSettled([
    sgAdminFetch(`/organizations/${org.id}/sites`),
    sgAdminFetch(`/organizations/${org.id}/memberships`),
  ]);
  if (sequence !== sgDetailSequence) return;
  if (sites.status === 'fulfilled') {
    const items = sites.value.sites;
    sgNode('site-list').replaceChildren(...(items.length ? items.map((site) => sgText(site.name)) : [sgText('登録済みSiteはありません。')]));
    sgStatus('sites-status', `Site ${items.length}件`);
  } else sgStatus('sites-status', 'Siteの取得に失敗しました。');
  if (memberships.status === 'fulfilled') {
    const items = memberships.value.memberships;
    sgNode('membership-list').replaceChildren(...(items.length ? items.map((m) => sgText(`${m.email} / ${m.role} / ${m.status}`)) : [sgText('招待済み利用者はありません。')]));
    sgStatus('membership-status', `利用者 ${items.length}件`);
  } else sgStatus('membership-status', '利用者の取得に失敗しました。');
}

async function sgSynchronize() {
  if (sgSyncInFlight) return;
  sgSyncInFlight = true;
  sgScope.disabled = true;
  for (const row of sgNode('organizations').children) row.disabled = true;
  sgNode('initial-invitation-form').querySelector('button[type="submit"]').disabled = true;
  sgNode('save-license-allocation').disabled = true;
  sgNode('check-license-status').disabled = true;
  sgNode('retry-organization-sync').hidden = true;
  sgStatus('organizations-status', 'DNSFilter配下のOrganizationを同期中です。');
  try {
    const result = await sgAdminFetch('/dnsfilter/organizations/sync', { method: 'POST' });
    sgOrganizations = result.organizations;
    sgRenderOrganizations();
    await sgLoadDetails();
    const s = result.sync;
    sgStatus('organizations-status', `同期完了：新規 ${s.imported}件、既存 ${s.skipped}件、失敗 ${s.failed}件、要確認 ${s.needsReview}件。${s.needsReview ? '要確認の連携は自動変更していません。' : ''}`);
    sgNode('retry-organization-sync').hidden = s.failed === 0;
  } catch {
    sgStatus('organizations-status', '同期結果を確認できません。取り込み途中の可能性があるため、既存一覧と監査を確認してください。');
    sgNode('retry-organization-sync').hidden = false;
    try { sgOrganizations = (await sgAdminFetch('/organizations')).organizations; sgRenderOrganizations(); await sgLoadDetails(); }
    catch { sgStatus('admin-error', '既存の顧客一覧も取得できませんでした。'); }
  } finally {
    sgSyncInFlight = false;
    sgScope.disabled = false;
    for (const row of sgNode('organizations').children) {
      const org = sgOrganizations.find((item) => item.id === row.dataset.organizationId);
      row.disabled = !org || org.status !== 'active' || org.mappingStatus !== 'active' || !org.dnsfilterOrganizationId;
    }
    const selected = sgSelectedOrganization();
    sgNode('initial-invitation-form').querySelector('button[type="submit"]').disabled = !selected || sgInvitationAttempted;
    sgNode('save-license-allocation').disabled = !selected;
    sgNode('check-license-status').disabled = !selected;
  }
  await sgLoadAudit();
}

sgScope.addEventListener('change', () => { sgInvitationAttempted = false; sgStatus('invitation-status', ''); sgRenderOrganizationsSelection(); sgLoadDetails(); });
sgNode('retry-organization-sync').addEventListener('click', sgSynchronize);
sgNode('refresh-overage-alerts').addEventListener('click', sgLoadOverageAlerts);

sgNode('initial-invitation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const org = sgSelectedOrganization();
  if (!org || sgInvitationAttempted || sgSyncInFlight) return;
  sgInvitationAttempted = true;
  event.target.querySelector('button[type="submit"]').disabled = true;
  sgStatus('invitation-status', '初期管理者の招待を送信しています。');
  try {
    await sgAdminFetch('/initial-memberships/invitations', { method: 'POST', body: JSON.stringify({ customerOrganizationId: org.id, email: sgNode('initial-email').value }) });
    await sgLoadDetails();
    sgStatus('invitation-status', '招待を受け付けました。登録状況を更新しました。');
  } catch (error) {
    sgStatus('invitation-status', error.message === 'INVITATION_DELIVERY_UNCONFIRMED'
      ? '招待情報は保存された可能性があります。メール配送結果が不明なため再送せず、監査・招待状況を確認してください。'
      : '招待結果が不明です。重複招待を避けるため、確認前に再送しないでください。');
  }
});

sgNode('save-license-allocation').addEventListener('click', async () => {
  const org = sgSelectedOrganization(); if (!org || sgSyncInFlight) return;
  const field = sgNode('selected-license-allocation');
  if (field.value.trim() === '' || !Number.isSafeInteger(Number(field.value)) || Number(field.value) < 0) {
    sgStatus('selected-license-status', '割当数は0以上の整数で入力してください。'); return;
  }
  try {
    await sgAdminFetch(`/organizations/${org.id}/license-allocation`, { method: 'PATCH', body: JSON.stringify({ allocatedLicenses: Number(field.value) }) });
    org.allocatedLicenses = Number(field.value);
    sgStatus('selected-license-status', `割当数: ${org.allocatedLicenses} / 使用数: 未確認（保存しました）`);
  } catch { sgStatus('selected-license-status', '割当数を保存できませんでした。'); }
});

sgNode('check-license-status').addEventListener('click', async () => {
  const org = sgSelectedOrganization(); if (!org || sgSyncInFlight) return;
  sgStatus('selected-license-status', '使用数を確認しています。');
  try {
    const value = await sgAdminFetch(`/organizations/${org.id}/license-status`);
    sgStatus('selected-license-status', `割当数: ${value.allocation.value ?? '未設定'} / 使用数: ${value.usage.value ?? '取得不可'} / 判定: ${value.status}${value.overage === null ? '' : ` / 超過: ${value.overage}`} / 確認: ${new Date(value.usage.checkedAt).toLocaleString('ja-JP')}`);
  } catch { sgStatus('selected-license-status', '使用数を確認できませんでした（UNKNOWN）。'); }
});

sgNode('provisioning-recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await sgAdminFetch(`/organizations/${sgNode('recovery-organization-id').value}/provisioning-recovery`, {
      method: 'POST', body: JSON.stringify({ dnsfilterOrganizationId: sgNode('recovery-dnsfilter-organization-id').value }),
    });
    event.target.reset(); await sgSynchronize();
  } catch { sgStatus('admin-error', '復旧結果が不明です。確認するまで同じ操作を再送しないでください。'); }
});

// Exactly one sync attempt on initial load or F5; no timer or automatic retries.
sgSynchronize().then(sgLoadOverageAlerts);
