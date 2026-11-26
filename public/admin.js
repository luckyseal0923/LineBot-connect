const view = document.querySelector('#admin-view');
const nav = document.querySelector('#admin-nav');
const logout = document.querySelector('#admin-logout');
const sections = new Set(['overview', 'pending', 'users', 'usage', 'records', 'audit']);
const stamp = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei'
});
const numbers = new Intl.NumberFormat('zh-TW');
const accountStates = {
  pending: ['待審核', 'warning'],
  active: ['已核准', 'success'],
  disabled: ['已停用', 'neutral']
};
const sendStates = {
  accepted: ['LINE 已受理', 'success'],
  failed: ['發送失敗', 'danger'],
  unknown: ['結果未確認', 'warning'],
  sending: ['處理中', 'neutral'],
  queued: ['等候發送', 'neutral'],
  cancelled: ['已取消', 'neutral']
};
let controller;
let flash;

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
}

function time(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.valueOf()) ? stamp.format(date) : '—';
}

function count(value) {
  return value == null ? '—' : numbers.format(value);
}

function chip(label, tone = 'neutral') {
  return `<span class="chip chip-${tone}">${escapeHtml(label)}</span>`;
}

function heading(title, description, action = '') {
  return `<div class="page-heading"><div><h1 tabindex="-1">${title}</h1><p>${description}</p></div>${action}</div>`;
}

function link(label, href, style = 'secondary') {
  return `<a class="button button-${style}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function href(section, params = {}) {
  const query = new URLSearchParams([...Object.entries(params)].filter(([, value]) => value));
  return '#' + section + (query.size ? '?' + query : '');
}

function go(hash) {
  if (hash === location.hash) render();
  else location.hash = hash;
}

function route() {
  const [section, query] = location.hash.slice(1).split('?', 2);
  return { section: sections.has(section) ? section : 'overview', params: new URLSearchParams(query) };
}

async function request(path, { data, signal } = {}) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || result.message || '管理後台暫時無法連線。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function adminApi(path, options) {
  return request('/admin-api/' + path, options);
}

function report(target, message, tone = '') {
  target.textContent = message;
  target.dataset.tone = tone;
}

function setLayout(authenticated, section) {
  document.documentElement.dataset.auth = authenticated ? 'active' : 'guest';
  nav.hidden = !authenticated;
  logout.hidden = !authenticated;
  for (const item of nav.querySelectorAll('a')) {
    if (item.dataset.page === section) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

async function render() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const { section, params } = route();
  view.innerHTML = '<p class="page-loading" role="status">正在載入管理後台…</p>';
  window.scrollTo(0, 0);
  try {
    const pending = await adminApi('pending', { signal });
    if (signal.aborted) return;
    setLayout(true, section);
    if (section === 'overview') await renderOverview(pending.accounts, signal);
    if (section === 'pending') renderPending(pending.accounts, signal);
    if (section === 'users') {
      if (params.get('username')) await renderAccount(params, signal);
      else await renderUsers(params, signal);
    }
    if (section === 'usage') await renderUsage(params, signal);
    if (section === 'records') await renderRecords(params, signal);
    if (section === 'audit') await renderAudit(signal);
    if (signal.aborted) return;
    if (flash) {
      const status = document.createElement('p');
      status.className = 'feedback flash-banner';
      status.setAttribute('role', 'status');
      report(status, flash, 'success');
      view.prepend(status);
      flash = undefined;
    }
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401) {
      setLayout(false);
      renderLogin();
    } else {
      view.innerHTML = `<section class="panel centered-status"><h1 tabindex="-1">暫時無法載入</h1>
        <p>${escapeHtml(error.message)}</p>
        <button class="button button-primary" id="admin-retry" type="button">重新查詢</button>
      </section>`;
      view.querySelector('#admin-retry').addEventListener('click', () => render());
    }
  }
  if (!signal.aborted && document.activeElement === document.body) view.querySelector('h1')?.focus({ preventScroll: true });
}

function renderLogin() {
  view.innerHTML = `<section class="panel entry-card admin-entry">
    <h1 tabindex="-1">管理員登入</h1>
    <p class="muted">審核開發者帳號，查閱接線站用量和紀錄。</p>
    <form id="login-form" class="form-stack">
      <label>管理員帳號<input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label>密碼<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="button button-primary button-full" type="submit">登入</button>
      <p id="login-message" class="feedback" role="status"></p>
    </form>
  </section>`;
  const form = view.querySelector('#login-form');
  const feedback = view.querySelector('#login-message');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    report(feedback, '正在登入…');
    try {
      await request('/admin-session/login', { data: Object.fromEntries(new FormData(form)) });
      form.reset();
      go('#overview');
    } catch (error) {
      report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

function table(label, columns, rows, emptyMessage = '目前沒有符合的資料。') {
  if (!rows.length) return `<div class="empty-state table-empty"><p>${escapeHtml(emptyMessage)}</p></div>`;
  return `<div class="table-wrap"><table class="data-table">
    <caption class="sr-only">${escapeHtml(label)}</caption>
    <thead><tr>${columns.map(column => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function pager(section, params, data) {
  if (data.page < 2 && !data.hasNext) return '';
  const pageHref = page => href(section, { ...Object.fromEntries(params), page });
  return `<nav class="pager" aria-label="結果頁碼">
    ${data.page > 1 ? link('上一頁', pageHref(data.page - 1)) : ''}
    <span>第 ${data.page} 頁</span>
    ${data.hasNext ? link('下一頁', pageHref(data.page + 1)) : ''}
  </nav>`;
}

function state(user) {
  return chip(...(accountStates[user.status] ?? ['狀態未確認']));
}

function userLink(entry) {
  return `<a class="table-title" href="${escapeHtml(href('users', { username: entry.username }))}">${escapeHtml(entry.display_name)}</a>
    <small>${escapeHtml(entry.google_email || entry.username)}</small>`;
}

function reviewButton(status, index) {
  const [label, target, style] = status === 'pending'
    ? ['核准', 'active', 'primary'] : status === 'active'
      ? ['停用', 'disabled', 'danger-outline'] : ['重新啟用', 'active', 'secondary'];
  return `<button type="button" class="button button-${style}" data-review="${index}" data-target="${target}">${label}</button>`;
}

function bindReviewButtons(container, accounts, signal) {
  for (const button of container.querySelectorAll('[data-review]')) {
    const account = accounts[Number(button.dataset.review)];
    button.addEventListener('click', () => {
      if (signal.aborted) return;
      const label = button.textContent;
      const dialog = document.createElement('dialog');
      dialog.className = 'action-dialog';
      dialog.setAttribute('aria-labelledby', 'review-title');
      dialog.innerHTML = `<h2 id="review-title">${label}帳號</h2>
        <p>${escapeHtml(account.display_name)}（${escapeHtml(account.username)}）</p>
        <form class="form-stack">
          <label>${label}原因<textarea name="reason" maxlength="500" rows="3" required autofocus></textarea></label>
          <p class="feedback" role="status"></p>
          <div class="dialog-actions">
            <button class="button button-secondary" type="button" data-cancel>取消</button>
            <button class="button ${button.dataset.target === 'disabled' ? 'button-danger' : 'button-primary'}" type="submit">確認${label}</button>
          </div>
        </form>`;
      view.append(dialog);
      const form = dialog.querySelector('form');
      const submit = form.querySelector('[type="submit"]');
      const feedback = form.querySelector('[role="status"]');
      const cancel = form.querySelector('[data-cancel]');
      cancel.addEventListener('click', () => dialog.close());
      dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        cancel.disabled = true;
        report(feedback, '正在儲存…');
        try {
          const data = { username: account.username, status: button.dataset.target, reason: form.elements.reason.value };
          const response = await adminApi('review', { data });
          if (signal.aborted) return;
          flash = response.message;
          dialog.close();
          render();
        } catch (error) {
          report(feedback, error.message, 'danger');
        } finally {
          submit.disabled = false;
          cancel.disabled = false;
        }
      });
      dialog.showModal();
    });
  }
}

function pendingTable(accounts) {
  return table('待審申請', ['申請者', '申請時間', '操作'],
    accounts.map((account, index) => [userLink(account), time(account.created_at), reviewButton('pending', index)]),
    '目前沒有待審申請。');
}

async function renderOverview(pending, signal) {
  view.innerHTML = heading('管理總覽', '處理開發者帳號申請，掌握接線站的通知情形。') +
    `<section class="panel" id="pending-preview" aria-labelledby="admin-pending-title">
      <div class="section-heading"><div><h2 id="admin-pending-title">待審申請</h2>
        <p class="muted small">顯示最近的待審帳號</p></div>${link('查看待審清單', '#pending', pending.length ? 'primary' : 'secondary')}</div>
      ${pendingTable(pending.slice(0, 4))}
    </section>
    <section class="section-gap" aria-labelledby="admin-summary-title">
      <div class="section-heading"><h2 id="admin-summary-title">接線站使用情形</h2></div>
      <div class="metric-grid" id="summary"><p role="status">正在載入統計…</p></div>
    </section>`;
  bindReviewButtons(view.querySelector('#pending-preview'), pending.slice(0, 4), signal);
  const from = new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  let summary;
  try {
    ({ summary } = await adminApi('summary', { signal }));
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401) throw error;
    view.querySelector('#summary').innerHTML = '<p class="feedback" data-tone="danger">統計暫時無法取得，可繼續審核帳號。</p>';
    return;
  }
  if (signal.aborted) return;
  const cards = [
    ['待審申請', 'pending', '#pending'],
    ['使用者', 'accounts', '#users'],
    ['啟用中 Bot', 'active_bots', '#usage'],
    ['近 30 天發送紀錄', 'notifications_30d', href('records', { from })],
    ['近 30 天失敗或未確認', 'attention_30d', href('records', { status: 'attention', from })]
  ];
  view.querySelector('#summary').innerHTML = cards.map(([label, key, url]) =>
    `<a class="metric-card" href="${escapeHtml(url)}" data-attention="${['pending', 'attention_30d'].includes(key) && summary[key] > 0}">
      <span>${label}</span><strong>${count(summary[key])}</strong></a>`).join('');
}

function renderPending(accounts, signal) {
  view.innerHTML = heading('待審申請', '帳號核准後，開發者可自行新增數位平台。') +
    `<section class="panel">${pendingTable(accounts)}</section>`;
  bindReviewButtons(view, accounts, signal);
}

async function filteredList(container, list, params, signal, draw) {
  try {
    const data = await adminApi(list + '?' + params, { signal });
    if (!signal.aborted) draw(data);
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401) throw error;
    container.innerHTML = `<p class="feedback" role="status" data-tone="danger">${escapeHtml(error.message)}</p>`;
  }
}

function filterSubmit(form, section) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(data)) {
      if (key !== 'bot') data[key] = data[key].trim();
    }
    go(href(section, data));
  });
}

async function renderUsers(params, signal) {
  view.innerHTML = heading('使用者', '以帳號或顯示名稱找到使用者，查看其 Bot 和發送紀錄。') +
    `<section class="panel">
      <form id="user-filters" class="filters">
        <label>帳號或顯示名稱<input name="q" type="search" maxlength="100" value="${escapeHtml(params.get('q'))}"></label>
        <label>帳號狀態<select name="status">
          <option value="">全部狀態</option><option value="pending">待審核</option>
          <option value="active">已核准</option><option value="disabled">已停用</option>
        </select></label>
        <div class="button-row"><button type="submit" class="button button-primary">搜尋</button>${link('清除', '#users', 'quiet')}</div>
      </form>
      <div id="user-results"><p class="muted" role="status">正在搜尋使用者…</p></div>
    </section>`;
  const form = view.querySelector('#user-filters');
  form.elements.status.value = params.get('status') ?? '';
  filterSubmit(form, 'users');
  const results = view.querySelector('#user-results');
  await filteredList(results, 'accounts', params, signal, data => {
    results.innerHTML = table('使用者', ['使用者', '狀態', '建立時間', '啟用中 Bot', '近 30 天平台發送', '操作'],
      data.items.map((account, index) => [
        userLink(account), state(account), time(account.created_at), count(account.active_bots),
        count(account.notifications_30d),
        account.status === 'pending' ? link('前往審核', '#pending', 'quiet') : reviewButton(account.status, index)
      ])) + pager('users', params, data);
    bindReviewButtons(results, data.items, signal);
  });
}

function quota(bot) {
  if (!bot.enabled) return chip('已停用');
  if (bot.usage_status === 'ok' && bot.total_usage != null) return `<strong>${count(bot.total_usage)} 則</strong>`;
  return bot.usage_status === 'unavailable' ? chip('查詢失敗', 'warning') : chip('尚未取得');
}

function botsTable(bots, includeOwner) {
  const identities = new Set();
  const duplicateName = bots.some(bot => {
    const key = JSON.stringify([bot.username, bot.bot_name]);
    const duplicate = identities.has(key);
    identities.add(key);
    return duplicate;
  });
  const explanation = duplicateName
    ? '<p class="muted small">同一帳號有同名 Bot 時，依名稱查詢會顯示這些 Bot 的發送紀錄。</p>'
    : '';
  const columns = [
    ...(includeOwner ? ['使用者'] : []), 'Bot 名稱', '狀態', '最後更新', '近 30 天發送',
    'LINE 當月用量', '查詢時間', '發送紀錄'
  ];
  return explanation + table('LINE Bot 與用量', columns, bots.map(bot => [
    ...(includeOwner ? [userLink(bot)] : []), `<strong>${escapeHtml(bot.bot_name)}</strong>`,
    bot.enabled ? chip('已啟用', 'success') : chip('已停用'),
    time(bot.updated_at), count(bot.notifications_30d), quota(bot), time(bot.usage_checked_at),
    link('查看紀錄', href('records', { username: bot.username, bot: bot.bot_name }), 'quiet')
  ]), '目前沒有 LINE Bot。');
}

async function renderAccount(params, signal) {
  const username = params.get('username');
  const { items: accounts } = await adminApi('accounts?' + new URLSearchParams({ username }), { signal });
  if (signal.aborted) return;
  const user = accounts[0];
  const back = link('返回使用者', '#users');
  if (!user) {
    view.innerHTML = heading('找不到使用者', '請確認帳號後再查詢。', back);
    return;
  }
  view.innerHTML = heading(escapeHtml(user.display_name), '帳號 ' + escapeHtml(user.username), back) +
    `<section class="panel">
      <dl class="definition-grid">
        <div><dt>帳號狀態</dt><dd>${state(user)}</dd></div>
        <div><dt>建立時間</dt><dd>${time(user.created_at)}</dd></div>
        <div><dt>姓名</dt><dd>${escapeHtml(user.full_name || '尚未填寫')}</dd></div>
        <div><dt>電話</dt><dd>${escapeHtml(user.phone || '尚未填寫')}</dd></div>
        <div><dt>服務醫院</dt><dd>${escapeHtml(user.hospital || '尚未填寫')}</dd></div>
        <div><dt>職稱</dt><dd>${escapeHtml(user.job_title || '尚未填寫')}</dd></div>
        <div><dt>單位</dt><dd>${escapeHtml(user.department || '尚未填寫')}</dd></div>
        <div><dt>啟用中 Bot</dt><dd>${count(user.active_bots)}</dd></div>
        <div><dt>近 30 天平台發送</dt><dd>${count(user.notifications_30d)}</dd></div>
      </dl>
      <div class="button-row spaced">
        ${link('查看此帳號的發送紀錄', href('records', { username }), 'primary')}
        ${reviewButton(user.status, 0)}
      </div>
    </section>
    <section class="panel section-gap">
      <h2>此帳號的 LINE Bot</h2>
      <p class="muted">官方當月用量以表中的查詢時間為準。</p>
      <div id="account-bots"><p class="muted" role="status">正在載入 LINE Bot…</p></div>
    </section>`;
  bindReviewButtons(view, [user], signal);
  const target = view.querySelector('#account-bots');
  await filteredList(target, 'bots', params, signal, data => {
    target.innerHTML = botsTable(data.items, false) + pager('users', params, data);
  });
}

async function renderUsage(params, signal) {
  view.innerHTML = heading('LINE 用量', '查閱各 Bot 的 LINE 官方用量與接線站發送次數。') +
    `<section class="panel">
      <p class="muted">官方當月用量為 LINE 回報的約略數字，以查詢時間為準，包含從 LINE 官方帳號管理平台發送的訊息。接線站則統計近 30 天的發送紀錄。</p>
      <div id="usage-results"><p class="muted" role="status">正在載入用量…</p></div>
    </section>`;
  const target = view.querySelector('#usage-results');
  await filteredList(target, 'bots', params, signal, data => {
    target.innerHTML = botsTable(data.items, true) + pager('usage', params, data);
  });
}

function recordDetail(record) {
  const [label, tone] = sendStates[record.status] ?? sendStates.unknown;
  const dialog = document.createElement('dialog');
  dialog.className = 'action-dialog';
  dialog.setAttribute('aria-labelledby', 'record-title');
  dialog.innerHTML = `<h2 id="record-title">發送紀錄詳情</h2>
    <dl class="definition-grid">
      <div><dt>使用者</dt><dd>${escapeHtml(record.display_name)}（${escapeHtml(record.username)}）</dd></div>
      <div><dt>LINE Bot</dt><dd>${escapeHtml(record.bot_name)}</dd></div>
      <div><dt>收件對象</dt><dd>${escapeHtml(record.recipient_label)}</dd></div>
      <div><dt>發送來源</dt><dd>${escapeHtml(record.integration_name ?? '接線站手動發送')}</dd></div>
      <div><dt>狀態</dt><dd>${chip(label, tone)}</dd></div>
      <div><dt>發送時間</dt><dd>${time(record.created_at)}</dd></div>
      <div><dt>處理完成</dt><dd>${time(record.completed_at)}</dd></div>
      <div><dt>LINE 狀態碼</dt><dd>${escapeHtml(record.line_status ?? '—')}</dd></div>
    </dl>
    <form method="dialog" class="dialog-actions"><button class="button button-secondary" autofocus>關閉</button></form>`;
  view.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

async function renderRecords(params, signal) {
  const val = name => escapeHtml(params.get(name));
  view.innerHTML = heading('發送紀錄', '可依帳號、Bot 名稱、發送日期和狀態查詢。') +
    `<section class="panel">
      <form id="record-filters" class="filters record-filters">
        <label>使用者帳號<input name="username" value="${val('username')}" maxlength="32" pattern="[a-z0-9_]{3,32}"></label>
        <label>Bot 名稱<input name="bot" value="${val('bot')}" maxlength="200"></label>
        <label>起始日期<input name="from" type="date" value="${val('from')}"></label>
        <label>結束日期<input name="to" type="date" value="${val('to')}"></label>
        <label>發送狀態<select name="status">
          <option value="">全部狀態</option><option value="accepted">LINE 已受理</option>
          <option value="failed">發送失敗</option><option value="unknown">結果未確認</option>
          <option value="queued">等候發送</option><option value="sending">處理中</option>
          <option value="cancelled">已取消</option><option value="attention">失敗或未確認</option>
        </select></label>
        <div class="button-row"><button class="button button-primary" type="submit">套用篩選</button>${link('清除', '#records', 'quiet')}</div>
      </form>
      <p class="muted small">使用臺灣時間。紀錄只包含發送資訊和狀態，收訊請以收件者確認為準。</p>
      <div id="record-results"><p class="muted" role="status">正在查詢發送紀錄…</p></div>
    </section>`;
  const form = view.querySelector('#record-filters');
  form.elements.status.value = params.get('status') ?? '';
  filterSubmit(form, 'records');
  const target = view.querySelector('#record-results');
  await filteredList(target, 'notifications', params, signal, data => {
    target.innerHTML = table('發送紀錄', ['時間', '使用者', 'Bot', '收件對象名稱', '來源', '狀態', 'LINE 狀態碼', '詳情'],
      data.items.map((item, index) => [
        time(item.created_at), userLink(item), escapeHtml(item.bot_name), escapeHtml(item.recipient_label),
        escapeHtml(item.integration_name ?? '手動發送'),
        chip(...(sendStates[item.status] ?? sendStates.unknown)), escapeHtml(item.line_status ?? '—'),
        `<button class="button button-quiet" type="button" data-record="${index}">查看詳情</button>`
      ])) + pager('records', params, data);
    for (const button of target.querySelectorAll('[data-record]')) {
      button.addEventListener('click', () => recordDetail(data.items[Number(button.dataset.record)]));
    }
  });
}

async function renderAudit(signal) {
  const { audit } = await adminApi('audit', { signal });
  if (signal.aborted) return;
  view.innerHTML = heading('操作紀錄', '最近 100 筆帳號審核與狀態變更。') +
    `<section class="panel">${table('操作紀錄', ['時間', '帳號', '變更', '原因', '資料庫角色'],
      audit.map(item => [
        time(item.reviewed_at), escapeHtml(item.username),
        escapeHtml((accountStates[item.old_status]?.[0] ?? item.old_status) + ' → ' + (accountStates[item.new_status]?.[0] ?? item.new_status)),
        escapeHtml(item.reason), escapeHtml(item.actor)
      ]))}</section>`;
}

document.querySelector('#admin-skip').addEventListener('click', event => {
  event.preventDefault();
  view.focus();
});
logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await request('/admin-session/logout', { data: {} });
    flash = undefined;
    history.replaceState(null, '', '#overview');
    render();
  } catch (error) {
    const status = document.createElement('p');
    status.className = 'feedback';
    status.setAttribute('role', 'status');
    report(status, error.message, 'danger');
    view.prepend(status);
  } finally {
    logout.disabled = false;
  }
});
window.addEventListener('hashchange', render);
render();
