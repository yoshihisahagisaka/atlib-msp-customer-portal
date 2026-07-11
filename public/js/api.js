async function apiFetch(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });

  if (res.status === 401) {
    if (!location.pathname.endsWith('/login.html')) {
      location.href = '/login.html';
    }
    throw new Error('Not authenticated');
  }

  if (!res.ok) {
    let message = 'エラーが発生しました';
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // レスポンスボディがない場合は既定メッセージのまま
    }
    throw new Error(message);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function initAppNav(activePage) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;

  nav.innerHTML = `
    <div class="brand">atLIB InfraVision ポータル</div>
    <div class="links">
      <span class="company" id="nav-company"></span>
      <a href="/notifications.html" data-page="notifications">通知設定</a>
      <a href="/maintenance.html" data-page="maintenance">メンテナンス</a>
      <a href="/hosts.html" data-page="hosts">機器管理</a>
      <a href="/topology.html" data-page="topology">トポロジー</a>
      <button class="logout" id="nav-logout">ログアウト</button>
    </div>
  `;

  nav.querySelectorAll('a[data-page]').forEach((a) => {
    if (a.dataset.page === activePage) a.classList.add('active');
  });

  document.getElementById('nav-logout').addEventListener('click', async () => {
    await apiFetch('/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  try {
    const me = await apiFetch('/auth/me');
    document.getElementById('nav-company').textContent = me.companyName;
  } catch {
    // apiFetchが401時に自動でログイン画面へリダイレクトするため、ここでは何もしない
  }
}
