/**
 * 管理画面共通ナビゲーション。/api/staff/sessionでログイン状態を取得し、
 * 未ログインならGoogleログインへリダイレクトする（サーバー側のrequireStaffAuthが本筋の保護で、
 * これはUX向上のための二重チェック。未ログイン状態でも各APIは401を返すため、実害はない）。
 */
async function initAdminNav(activePage) {
  const nav = document.getElementById('admin-nav');
  if (!nav) return;

  let session;
  try {
    const res = await fetch('/api/staff/session', { credentials: 'include' });
    session = await res.json();
  } catch {
    session = { authenticated: false };
  }

  if (!session.authenticated) {
    location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
    return;
  }

  const links = [
    { href: '/admin/customer-applications.html', page: 'customer-applications', label: '顧客申込み' },
    { href: '/admin/onboard-customer.html', page: 'onboard-customer', label: '顧客オンボーディング' },
    { href: '/admin/ops-history.html', page: 'ops-history', label: '運用対応履歴' },
    { href: '/admin/report-settings.html', page: 'report-settings', label: 'レポート設定' },
    { href: '/admin/monthly-reports.html', page: 'monthly-reports', label: '月次レポート' },
  ];
  if (session.role === 'admin') {
    links.push({ href: '/admin/settings.html', page: 'settings', label: '設定' });
  }

  nav.innerHTML = `
    <div class="brand">atLIB Admin</div>
    <div class="links">
      <span class="company" id="admin-nav-email"></span>
      ${links.map((l) => `<a href="${l.href}" data-page="${l.page}">${l.label}</a>`).join('')}
      <a href="/auth/logout" class="logout">ログアウト</a>
    </div>
  `;

  nav.querySelectorAll('a[data-page]').forEach((a) => {
    if (a.dataset.page === activePage) a.classList.add('active');
  });

  document.getElementById('admin-nav-email').textContent = session.email;
}
