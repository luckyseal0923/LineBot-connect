const view = document.querySelector('#view');
const navigation = document.querySelector('#workspace-nav');
const navToggle = document.querySelector('#nav-toggle');
const accountLink = document.querySelector('#account-link');
const guestLink = document.querySelector('#guest-link');
const logoutButton = document.querySelector('#logout-button');
const consoleUrl = 'https://developers.line.biz/console/';
const pages = new Set(['overview', 'account', 'register', 'bot', 'recipients', 'messages', 'integrations']);
const webhookChecks = new Map();
const stamp = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei'
});
const notificationStates = {
  accepted: ['LINE 已受理', 'success'],
  failed: ['發送失敗', 'danger'],
  unknown: ['結果未確認', 'warning'],
  sending: ['處理中', 'neutral'],
  queued: ['等候發送', 'neutral'],
  cancelled: ['已取消', 'neutral']
};

let renderController;
let currentUsername;
let registration;

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
}

function dateTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.valueOf()) ? stamp.format(date) : '—';
}

function route() {
  const [page, query] = location.hash.slice(1).split('?', 2);
  return { page: pages.has(page) ? page : 'overview', params: new URLSearchParams(query) };
}

function goTo(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function replacePage(page) {
  history.replaceState(null, '', '#' + page);
  return page;
}

async function api(path, { data, signal } = {}) {
  const response = await fetch('/independent-api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || result.message || '接線站暫時無法連線，請稍後再試。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function buttonLink(text, href, style = 'primary') {
  return `<a class="button button-${style}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

function chip(label, tone = 'neutral') {
  return `<span class="chip chip-${tone}">${escapeHtml(label)}</span>`;
}

function pageHeading(title, description, action = '') {
  return `<div class="page-heading">
    <div><h1 tabindex="-1">${title}</h1><p>${description}</p></div>
    ${action}
  </div>`;
}

function emptyState(title, description, action = '') {
  return `<div class="empty-state"><h3>${title}</h3><p>${description}</p>${action}</div>`;
}

function report(target, message, tone = '') {
  target.textContent = message;
  target.dataset.tone = tone;
}

function copyField(id, label, value, buttonText) {
  return `<div class="copy-field">
    <label for="${id}">${label}</label>
    <div class="copy-controls">
      <input id="${id}" type="text" value="${escapeHtml(value)}" readonly>
      <button class="button button-secondary" type="button" data-copy="${id}">${buttonText}</button>
    </div>
    <p class="feedback" data-copy-status="${id}" role="status"></p>
  </div>`;
}

function bindCopyFields(container) {
  for (const button of container.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const input = document.getElementById(button.dataset.copy);
      const feedback = button.closest('.copy-field').querySelector('[data-copy-status]');
      try {
        await navigator.clipboard.writeText(input.value);
        report(feedback, '已複製。', 'success');
      } catch {
        input.focus();
        input.select();
        report(feedback, '已選取文字，請手動複製。');
      }
    });
  }
}

function closeMenu() {
  navToggle.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('is-open');
}

function setLayout(state, page, user) {
  document.documentElement.dataset.auth = state;
  const active = state === 'active';
  navigation.hidden = !active;
  navToggle.hidden = !active;
  accountLink.hidden = !active;
  logoutButton.hidden = !user;
  guestLink.hidden = state !== 'guest';
  accountLink.textContent = user?.displayName || '帳號';
  accountLink.setAttribute('aria-label', '我的帳號');
  if (page === 'account' && active) accountLink.setAttribute('aria-current', 'page');
  else accountLink.removeAttribute('aria-current');
  guestLink.href = page === 'register' ? '#account' : '#register';
  guestLink.textContent = page === 'register' ? '登入' : '申請帳號';
  for (const link of navigation.querySelectorAll('[data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  closeMenu();
}

async function render({ openOverviewIfApproved = false } = {}) {
  renderController?.abort();
  renderController = new AbortController();
  const { signal } = renderController;
  let { page, params } = route();
  view.innerHTML = '<p class="page-loading" role="status">正在載入…</p>';
  window.scrollTo(0, 0);

  let user;
  try {
    user = await api('me', { signal });
  } catch (error) {
    if (signal.aborted) return;
    if (error.status !== 401) {
      currentUsername = undefined;
      webhookChecks.clear();
      setLayout('unknown', 'account');
      view.innerHTML = `<section class="panel centered-status">
        <h1 tabindex="-1">暫時無法連線</h1>
        <p>登入狀態無法確認。請檢查網路後重新查詢。</p>
        <button class="button button-primary" id="retry" type="button">重新查詢</button>
      </section>`;
      view.querySelector('#retry').addEventListener('click', () => render());
      return;
    }
  }
  if (signal.aborted) return;

  if (user?.username !== currentUsername) webhookChecks.clear();
  currentUsername = user?.username;
  if (!user) {
    if (!['account', 'register'].includes(page)) page = replacePage('account');
    setLayout('guest', page);
    renderEntry(page);
  } else if (user.status !== 'active') {
    if (page !== 'account') page = replacePage('account');
    setLayout('pending', page, user);
    renderPending(user);
  } else {
    if (openOverviewIfApproved || page === 'register') {
      page = replacePage('overview');
      params = new URLSearchParams();
    }
    setLayout('active', page, user);
    if (page === 'account') renderProfile(user);
    if (page === 'overview') await renderOverview(signal);
    if (page === 'bot') await renderBots(params, signal);
    if (page === 'recipients') await renderRecipients(params, signal);
    if (page === 'messages') await renderMessages(params, signal);
    if (page === 'integrations') await renderIntegrations(signal);
  }
  if (!signal.aborted && (document.activeElement === document.body || document.activeElement === view)) {
    view.querySelector('h1')?.focus({ preventScroll: true });
  }
}

function renderEntry(page) {
  const signingUp = page === 'register';
  const heading = signingUp ? '申請接線站帳號' : '登入接線站';
  view.innerHTML = `<div class="entry-layout">
    <div class="entry-intro">
      <h2>用自己的 LINE Bot<br>發送通知</h2>
      <p>管理 LINE 官方帳號、配對收件對象，在同一個工作空間查閱傳訊紀錄。</p>
    </div>
    <section class="panel entry-card" aria-labelledby="entry-title">
      <h1 id="entry-title" tabindex="-1">${heading}</h1>
      <p class="muted">${signingUp ? '送出後由管理員審核。核准後即可設定 LINE Bot。' : '登入後進入總覽，繼續設定或發送通知。'}</p>
      <form id="${signingUp ? 'register-form' : 'login-form'}" class="form-stack">
        <div class="field"><label for="entry-username">帳號</label>
          <input id="entry-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32"
            ${signingUp ? 'pattern="[a-z0-9_]{3,32}" aria-describedby="username-rules"' : ''} required>
          ${signingUp ? '<small id="username-rules">3–32 字元，限小寫英文字母、數字與底線</small>' : ''}
        </div>
        ${signingUp ? '<label>顯示名稱<input name="displayName" autocomplete="name" maxlength="100" required></label>' : ''}
        <div class="field"><label for="entry-password">密碼</label>
          <input id="entry-password" name="password" type="password" autocomplete="${signingUp ? 'new-password' : 'current-password'}"
            ${signingUp ? 'minlength="8" maxlength="128" aria-describedby="password-rules"' : ''} required>
          ${signingUp ? '<small id="password-rules">至少 8 個字元</small>' : ''}
        </div>
        <button class="button button-primary button-full" type="submit">${signingUp ? '送出帳號申請' : '登入'}</button>
        <p id="auth-feedback" class="feedback" role="status"></p>
      </form>
      <p class="entry-switch">${signingUp ? '已有帳號？ <a href="#account">返回登入</a>' : '首次使用？ <a href="#register">申請帳號</a>'}</p>
      ${signingUp ? '<p class="muted small">請妥善保管密碼。現階段暫無自助找回密碼。</p>' : ''}
    </section>
  </div>`;
  const form = view.querySelector('form');
  const feedback = view.querySelector('#auth-feedback');
  if (!signingUp && registration) {
    form.elements.username.value = registration.username;
    report(feedback, '申請已送出。請登入查看審核狀態。', 'success');
    registration = undefined;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    report(feedback, '處理中…');
    try {
      await api(signingUp ? 'register' : 'login', { data });
      if (!form.isConnected) return;
      form.reset();
      if (signingUp) registration = { username: data.username };
      goTo(signingUp ? '#account' : '#overview');
    } catch (error) {
      report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

function renderPending(user) {
  view.innerHTML = `<section class="panel centered-status">
    ${chip('等待審核', 'warning')}
    <h1 tabindex="-1">帳號申請審核中</h1>
    <p>${escapeHtml(user.displayName)}（${escapeHtml(user.username)}），你的申請已送出。核准後可進入工作空間。</p>
    <p class="muted">如需了解審核進度，請聯絡平台管理員。</p>
    <button class="button button-primary" id="check-approval" type="button">重新查詢審核狀態</button>
  </section>`;
  view.querySelector('#check-approval').addEventListener('click', () => render({ openOverviewIfApproved: true }));
}

function renderProfile(user) {
  view.innerHTML = pageHeading('我的帳號', '接線站帳號與審核狀態。') +
    `<section class="panel profile-panel">
      <dl class="definition-grid">
        <div><dt>顯示名稱</dt><dd>${escapeHtml(user.displayName)}</dd></div>
        <div><dt>帳號</dt><dd>${escapeHtml(user.username)}</dd></div>
        <div><dt>帳號狀態</dt><dd>${chip('已核准', 'success')}</dd></div>
      </dl>
    </section>`;
}

function renderHistory(target, records, limit = records.length) {
  if (!records.length) {
    target.innerHTML = emptyState('尚無發送紀錄', '發送通知後，結果會出現在這裡。');
    return;
  }
  target.innerHTML = `<ul class="record-list">${records.slice(0, limit).map(record => {
    const [label, tone] = notificationStates[record.status] ?? notificationStates.unknown;
    return `<li>
      <div><strong>${escapeHtml(record.botName)} <span aria-hidden="true">→</span> ${escapeHtml(record.label)}</strong>
        <time datetime="${escapeHtml(record.createdAt)}">${dateTime(record.createdAt)}</time>
        ${record.integrationName ? `<small class="record-source">${escapeHtml(record.integrationName)}</small>` : ''}</div>
      ${chip(label, tone)}
    </li>`;
  }).join('')}</ul>`;
}

async function renderOverview(signal) {
  view.innerHTML = pageHeading('總覽', '在這裡接續設定 LINE Bot 或發送通知。') +
    `<section id="overview-next" class="next-card" aria-labelledby="next-heading">
      <h2 id="next-heading">你的下一步</h2>
      <p role="status">正在讀取工作空間…</p>
    </section>
    <section class="panel section-gap">
      <div class="section-heading"><h2>最近發送紀錄</h2>${buttonLink('查看紀錄', '#messages', 'quiet')}</div>
      <div id="overview-history"><p class="muted" role="status">正在載入紀錄…</p></div>
    </section>`;
  const [botsResponse, recipientsResponse, historyResponse] = await Promise.allSettled([
    api('bots', { signal }), api('recipients', { signal }), api('notifications', { signal })
  ]);
  if (signal.aborted) return;

  const next = view.querySelector('#overview-next');
  if (botsResponse.status === 'fulfilled' && !botsResponse.value.bots.some(bot => bot.enabled)) {
    const existing = botsResponse.value.bots.length > 0;
    const label = existing ? '開啟 Bot 設定' : '新增第一個 Bot';
    next.innerHTML = `<h2 id="next-heading">${label}</h2>
      <p>${existing ? '設定憑證以啟用 Bot，或新增其他 Bot。' : '準備 LINE 官方帳號的兩項憑證，接線站會產生專屬 Webhook 網址。'}</p>
      ${buttonLink(label, existing ? '#bot' : '#bot?setup=1')}`;
  } else if (botsResponse.status === 'fulfilled' && recipientsResponse.status === 'fulfilled') {
    const enabled = botsResponse.value.bots.filter(bot => bot.enabled);
    const ready = recipientsResponse.value.recipients.length > 0;
    const label = ready ? '發送通知' : '配對收件對象';
    const recipientPage = enabled.length === 1 ? '#recipients?bot=' + encodeURIComponent(enabled[0].id) : '#recipients';
    next.innerHTML = `<h2 id="next-heading">${ready ? '準備好發送通知' : '新增第一位收件對象'}</h2>
      <p>${ready ? '選擇 Bot 和已配對的收件對象，發送文字通知。' : '在 LINE 完成 Webhook 驗證後，請收件者把配對文字傳給 Bot。'}</p>
      <div class="button-row">${buttonLink(label, ready ? '#messages' : recipientPage)}
        ${ready ? buttonLink('接入數位平台', '#integrations', 'secondary') : ''}</div>`;
  } else {
    next.innerHTML = `<h2 id="next-heading">暫時無法讀取設定進度</h2>
      <p>你可以重新查詢，或使用選單開啟需要的頁面。</p>
      <button id="try-overview" type="button" class="button button-primary">重新查詢</button>`;
    next.querySelector('#try-overview').addEventListener('click', () => render());
  }

  const history = view.querySelector('#overview-history');
  if (historyResponse.status === 'fulfilled') renderHistory(history, historyResponse.value.notifications, 4);
  else history.innerHTML = '<p class="muted">暫時無法載入紀錄。</p>';
}

function confirmAction(title, description, label, signal) {
  if (signal.aborted) return Promise.resolve(false);
  const dialog = document.createElement('dialog');
  dialog.className = 'action-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>
    <form method="dialog" class="dialog-actions">
      <button class="button button-secondary" value="cancel" autofocus>取消</button>
      <button class="button button-danger" value="confirm">${escapeHtml(label)}</button>
    </form>`;
  view.append(dialog);
  return new Promise(resolve => {
    const cancel = () => dialog.close('cancel');
    signal.addEventListener('abort', cancel, { once: true });
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', cancel);
      const confirmed = dialog.returnValue === 'confirm' && !signal.aborted;
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    dialog.showModal();
  });
}

const webhookLabels = {
  verified: ['LINE 驗證通過', 'success', '已確認 LINE 可以連到這個 Bot 的 Webhook。'],
  verified_inactive: ['LINE 測試通過，尚未啟用', 'warning', '請回 LINE Developers 開啟 Use webhook。'],
  not_configured: ['LINE 尚未設定網址', 'warning', '請將下方 Webhook 網址貼到 LINE Developers 並儲存。'],
  url_mismatch: ['LINE 網址不同', 'warning', '請比對 LINE Developers 中的 Webhook URL。'],
  failed: ['LINE 驗證未通過', 'danger', '請確認 Webhook 網址和 Channel secret，或前往 LINE Developers 查看 Verify 的詳細結果。'],
  unavailable: ['暫時無法向 LINE 確認', 'neutral', '請稍後重試，或在 LINE Developers 按 Verify。']
};

function showWebhookState(target, bot) {
  if (!bot.enabled) {
    target.innerHTML = `${chip('LINE 驗證暫停')}<p class="muted small">重新啟用 Bot 後即可檢查。</p>`;
    return;
  }
  const check = webhookChecks.get(bot.id);
  if (!check) {
    target.innerHTML = `${chip('尚未在接線站檢查')}`;
    return;
  }
  const [label, tone, note] = webhookLabels[check.status] ?? webhookLabels.unavailable;
  target.innerHTML = `${chip(label, tone)}<p class="muted small">
    ${note} <time datetime="${escapeHtml(check.checkedAt)}">${dateTime(check.checkedAt)}</time>
  </p>`;
}

function bindWebhookControls(container, bot) {
  const status = container.querySelector('[data-webhook-state]');
  showWebhookState(status, bot);
  bindCopyFields(container);
  const button = container.querySelector('[data-check-webhook]');
  if (!button) return;
  const feedback = container.querySelector('[data-check-status]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    report(feedback, '正在向 LINE 檢查…');
    try {
      const result = await api('bot/webhook-check', { data: { botId: bot.id } });
      if (!container.isConnected) return;
      webhookChecks.set(bot.id, result);
      showWebhookState(status, bot);
      report(feedback, '');
      button.textContent = '重新檢查 LINE 驗證';
    } catch (error) {
      report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

function webhookDisplay(bot) {
  return `${copyField('webhook-' + escapeHtml(bot.id), '專屬 Webhook 網址', bot.webhookUrl, '複製網址')}
    <div class="webhook-status" data-webhook-state role="status"></div>
    ${bot.enabled ? `<div class="button-row">
      <button class="button button-secondary" type="button" data-check-webhook>檢查 LINE 驗證</button>
    </div><p class="feedback" data-check-status role="status"></p>` : ''}`;
}

function setupProgress(current) {
  return `<ol class="wizard-progress" aria-label="Bot 設定進度">
    ${['填寫憑證', '驗證 Webhook', '配對與測試'].map((label, index) => {
      const step = index + 1;
      return `<li ${step === current ? 'aria-current="step"' : ''} data-completed="${step < current}">
        <span aria-hidden="true">${step < current ? '✓' : step}</span>${label}</li>`;
    }).join('')}
  </ol>`;
}

function wizardHeading(description) {
  return pageHeading('設定 LINE Bot', description, buttonLink('返回 Bot 清單', '#bot', 'secondary'));
}

function renderCredentials(signal) {
  view.innerHTML = wizardHeading('新增 Bot，或用同一個 LINE 官方帳號更新憑證。') +
    `<section class="panel wizard-panel">
      ${setupProgress(1)}
      <h2>填寫 LINE 憑證</h2>
      <p>前往 <a class="text-link" href="${consoleUrl}" target="_blank" rel="noopener noreferrer">LINE Developers Console</a>，選擇你的 Messaging API channel。</p>
      <details class="help-block"><summary>還沒有 Messaging API channel？</summary>
        <p>先到 LINE 官方帳號管理後台啟用 Messaging API，再回到 LINE Developers 取得兩項憑證。</p>
      </details>
      <form id="bot-form" class="form-stack">
        <div class="field"><label for="bot-token">Channel access token</label>
          <input id="bot-token" name="accessToken" type="password" autocomplete="off" maxlength="4096" required aria-describedby="token-help">
          <small id="token-help">在 Messaging API 分頁取得或發行。</small>
        </div>
        <div class="field"><label for="bot-secret">Channel secret</label>
          <input id="bot-secret" name="channelSecret" type="password" autocomplete="off" maxlength="512" required aria-describedby="secret-help">
          <small id="secret-help">在 Basic settings 分頁取得。</small>
        </div>
        <div class="button-row"><button class="button button-primary" type="submit">儲存並取得 Webhook</button></div>
        <p class="feedback" id="bot-message" role="status"></p>
      </form>
    </section>`;
  const form = view.querySelector('#bot-form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    const feedback = view.querySelector('#bot-message');
    button.disabled = true;
    report(feedback, '正在驗證憑證…');
    try {
      const result = await api('bot', { data: Object.fromEntries(new FormData(form)) });
      if (signal.aborted || !form.isConnected) return;
      form.reset();
      if (!result.bot) {
        report(feedback, '已儲存。請從 Bot 清單查看 Webhook 網址。', 'success');
        return;
      }
      webhookChecks.delete(result.bot.id);
      replacePage('bot?setup=webhook&bot=' + encodeURIComponent(result.bot.id));
      renderWebhookStep(result.bot);
      view.querySelector('h1').focus();
    } catch (error) {
      report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

function renderWebhookStep(bot) {
  view.innerHTML = wizardHeading('將專屬網址貼到 LINE Developers，即可驗證兩端連線。') +
    `<section class="panel wizard-panel" id="webhook-step">
      ${setupProgress(2)}
      <h2>驗證 ${escapeHtml(bot.name)} 的 Webhook</h2>
      <ol class="instructions">
        <li>在 <a class="text-link" href="${consoleUrl}" target="_blank" rel="noopener noreferrer">LINE Developers Console</a> 開啟這個 Bot 的 Messaging API 分頁。</li>
        <li>把下方網址貼進 Webhook URL，儲存並開啟 Use webhook。</li>
        <li>在 LINE 按 Verify，或在此按「檢查 LINE 驗證」。改用新網址前，請先確認原網址是否仍有用途。</li>
      </ol>
      ${webhookDisplay(bot)}
      <div class="button-row wizard-actions">
        ${buttonLink('下一步：配對與測試', '#bot?setup=test&bot=' + encodeURIComponent(bot.id))}
      </div>
    </section>`;
  bindWebhookControls(view.querySelector('#webhook-step'), bot);
}

function renderTestStep(bot) {
  const query = '?bot=' + encodeURIComponent(bot.id);
  view.innerHTML = wizardHeading('先配對一位收件者，再送出一則測試通知。') +
    `<section class="panel wizard-panel">
      ${setupProgress(3)}
      <h2>用 ${escapeHtml(bot.name)} 發送測試通知</h2>
      <p>請收件者加入 Bot 好友，並在一對一聊天室貼上配對文字。配對完成後即可選擇對方發送。</p>
      <div class="button-row">
        ${buttonLink('前往配對收件對象', '#recipients' + query)}
        ${buttonLink('已配對，前往發送', '#messages' + query, 'secondary')}
      </div>
    </section>`;
}

async function renderBots(params, signal) {
  const step = params.get('setup');
  if (step === '1') {
    renderCredentials(signal);
    return;
  }
  view.innerHTML = pageHeading('我的 LINE Bot', '管理 Bot 與專屬 Webhook。', buttonLink('新增 Bot', '#bot?setup=1')) +
    '<div id="bot-list"><p class="page-loading" role="status">正在載入 LINE Bot…</p></div>';

  const list = view.querySelector('#bot-list');
  let bots;
  try {
    ({ bots } = await api('bots', { signal }));
  } catch {
    if (!signal.aborted) list.innerHTML = emptyState('暫時無法載入 LINE Bot', '請重新整理後再試。');
    return;
  }
  if (signal.aborted) return;
  const selected = bots.find(bot => bot.id === params.get('bot') && bot.enabled);
  if (selected && step === 'webhook') {
    renderWebhookStep(selected);
    return;
  }
  if (selected && step === 'test') {
    renderTestStep(selected);
    return;
  }
  if (!bots.length) {
    list.innerHTML = `<section class="panel">${emptyState('尚未設定 LINE Bot',
      '請先準備 LINE 官方帳號的 Channel access token 與 Channel secret。', buttonLink('開始設定', '#bot?setup=1'))}</section>`;
    return;
  }

  list.innerHTML = `<div class="bot-grid">${bots.map(bot => `<article class="panel bot-card">
    <div class="section-heading"><h2>${escapeHtml(bot.name)}</h2>
      ${bot.enabled ? chip('接線站已啟用', 'success') : chip('接線站已停用')}
    </div>
    ${webhookDisplay(bot)}
    <div class="button-row">
      ${bot.enabled ? buttonLink('配對收件對象', '#recipients?bot=' + encodeURIComponent(bot.id), 'primary') : ''}
      <details class="action-menu"><summary>更多操作</summary>
        ${buttonLink(bot.enabled ? '更新憑證' : '重新設定憑證', '#bot?setup=1', 'quiet')}
        ${bot.enabled ? '<button class="button button-danger-outline" type="button" data-disable-bot>停用 Bot</button>' : ''}
      </details>
    </div>
    <p class="feedback" data-bot-feedback role="status"></p>
  </article>`).join('')}</div>`;
  list.querySelectorAll('.bot-card').forEach((card, index) => {
    const bot = bots[index];
    bindWebhookControls(card, bot);
    const button = card.querySelector('[data-disable-bot]');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      const feedback = card.querySelector('[data-bot-feedback]');
      try {
        if (!await confirmAction('停用 LINE Bot', `停用「${bot.name}」後，這個 Bot 將暫停配對與發送。`, '確認停用', signal)) return;
        await api('bot/disable', { data: { botId: bot.id } });
        if (signal.aborted) return;
        webhookChecks.delete(bot.id);
        await renderBots(new URLSearchParams(), signal);
      } catch (error) {
        report(feedback, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function showPageError(target, message) {
  target.innerHTML = emptyState('暫時無法載入', escapeHtml(message),
    '<button type="button" class="button button-secondary" data-retry>重新查詢</button>');
  target.querySelector('[data-retry]').addEventListener('click', () => render());
}

async function renderRecipients(params, signal) {
  view.innerHTML = pageHeading('收件對象', '邀請收件者在 LINE 聊天室完成配對。') +
    '<div id="recipients-body"><p class="page-loading" role="status">正在載入收件對象…</p></div>';
  const body = view.querySelector('#recipients-body');
  let bots, recipients;
  try {
    const [botData, recipientData] = await Promise.all([api('bots', { signal }), api('recipients', { signal })]);
    bots = botData.bots.filter(bot => bot.enabled);
    recipients = recipientData.recipients;
  } catch (error) {
    if (!signal.aborted) showPageError(body, error.message);
    return;
  }
  if (signal.aborted) return;
  if (!bots.length) {
    body.innerHTML = `<section class="panel">${emptyState('先設定一個 LINE Bot',
      'Bot 啟用後，就能建立收件對象的配對文字。', buttonLink('前往 Bot 設定', '#bot'))}</section>`;
    return;
  }

  body.innerHTML = `<div class="split-layout">
    <section class="panel">
      <h2>新增配對</h2>
      <p class="muted">請收件者加 Bot 為好友，再到一對一聊天室傳送配對文字。</p>
      <form id="pair-form" class="form-stack">
        <label>LINE Bot<select name="botId" required>${option('', '請選擇 Bot')}${bots.map(bot => option(bot.id, bot.name)).join('')}</select></label>
        <label>收件對象名稱<input name="label" required maxlength="80"></label>
        <button class="button button-primary" type="submit">產生配對文字</button>
        <p id="pair-result" class="feedback" role="status"></p>
      </form>
      <div id="pair-preview" class="detail-block" hidden></div>
    </section>
    <section class="panel">
      <div class="section-heading"><h2>已配對收件對象</h2>
        <button id="refresh-recipients" class="button button-quiet" type="button">重新查詢</button>
      </div>
      <p id="recipient-feedback" class="feedback" role="status"></p>
      <div id="recipients-list"></div>
    </section>
  </div>`;

  const form = body.querySelector('#pair-form');
  const requested = bots.find(bot => bot.id === params.get('bot'));
  form.elements.botId.value = requested?.id || (bots.length === 1 ? bots[0].id : '');
  const list = body.querySelector('#recipients-list');
  const refresh = body.querySelector('#refresh-recipients');
  const feedback = body.querySelector('#recipient-feedback');
  const preview = body.querySelector('#pair-preview');
  let expiryTimer;

  function drawList(items) {
    if (!items.length) {
      list.innerHTML = emptyState('尚無收件對象', '產生配對文字並請收件者傳送後，按「重新查詢」。');
      return;
    }
    list.innerHTML = `<ul class="record-list">
      ${items.map((recipient, index) => `<li>
        <div><strong>${escapeHtml(recipient.label)}</strong><span>${escapeHtml(recipient.botName)}</span></div>
        <button class="button button-danger-outline" type="button" data-remove="${index}">移除</button>
      </li>`).join('')}
    </ul><div class="button-row spaced">${buttonLink('前往發送通知', '#messages', 'secondary')}</div>`;
    for (const button of list.querySelectorAll('[data-remove]')) {
      const recipient = items[Number(button.dataset.remove)];
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          const description = `移除「${recipient.label}」後，這個對象需重新配對才能再次接收通知。`;
          if (!await confirmAction('移除收件對象', description, '確認移除', signal)) return;
          await api('recipient/disable', { data: { recipientId: recipient.id } });
          if (!signal.aborted) await loadList('已移除收件對象。');
        } catch (error) {
          report(feedback, error.message, 'danger');
        } finally {
          button.disabled = false;
        }
      });
    }
  }

  async function loadList(message = '已更新收件對象。') {
    refresh.disabled = true;
    report(feedback, '正在查詢配對結果…');
    try {
      const data = await api('recipients', { signal });
      if (signal.aborted) return;
      drawList(data.recipients);
      report(feedback, message, 'success');
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      refresh.disabled = false;
    }
  }

  drawList(recipients);
  refresh.addEventListener('click', () => loadList());
  signal.addEventListener('abort', () => clearInterval(expiryTimer), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button');
    if (submit.disabled) return;
    const resultText = body.querySelector('#pair-result');
    const data = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    report(resultText, '正在產生配對文字…');
    try {
      const result = await api('recipient/pair', { data });
      if (signal.aborted || !form.isConnected) return;
      const expiresAt = Date.parse(result.expiresAt);
      const expiry = Number.isFinite(expiresAt) ? expiresAt : Date.now() + (result.expiresMinutes || 10) * 60_000;
      const bot = bots.find(item => item.id === data.botId);
      clearInterval(expiryTimer);
      preview.hidden = false;
      preview.innerHTML = `<h3>交給 ${escapeHtml(data.label.trim())} 的配對文字</h3>
        <p class="muted small">請傳送到「${escapeHtml(bot.name)}」的一對一聊天室。每組限用一次。</p>
        ${copyField('pair-code', '配對文字', result.message, '複製配對文字')}
        <p class="expiry-note">到期時間 ${dateTime(expiry)} <span id="pair-countdown"></span></p>
        <button class="button button-secondary" type="button" id="check-pairing">查詢配對結果</button>`;
      bindCopyFields(preview);
      preview.querySelector('#check-pairing').addEventListener('click', () => loadList());
      const countdown = preview.querySelector('#pair-countdown');
      const copyButton = preview.querySelector('[data-copy]');
      function updateExpiry() {
        const seconds = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
        const minutes = Math.floor(seconds / 60);
        countdown.textContent = seconds ? `（剩 ${minutes}:${String(seconds % 60).padStart(2, '0')}）` : '（已到期）';
        copyButton.disabled = !seconds;
        if (!seconds) clearInterval(expiryTimer);
      }
      expiryTimer = setInterval(updateExpiry, 1000);
      updateExpiry();
      report(resultText, '配對文字已產生。', 'success');
    } catch (error) {
      report(resultText, error.message, 'danger');
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderIntegrations(signal) {
  view.innerHTML = pageHeading('外部串接', '讓報名、簽核等數位平台在事件發生時，自動用你的 LINE Bot 發送通知。',
    buttonLink('查看發送紀錄', '#messages', 'secondary')) +
    '<div id="integration-workspace"><p class="page-loading" role="status">正在載入串接設定…</p></div>';
  const workspace = view.querySelector('#integration-workspace');
  let initial, recipients;
  try {
    [initial, { recipients }] = await Promise.all([api('integrations', { signal }), api('recipients', { signal })]);
  } catch (error) {
    if (!signal.aborted) showPageError(workspace, error.message);
    return;
  }
  if (signal.aborted) return;

  const path = 'integrations';
  const recipientOptions = selected => option('', '請選擇 Bot 與收件對象') + recipients.map(recipient =>
    `<option value="${escapeHtml(recipient.id)}"${recipient.id === selected ? ' selected' : ''}>${escapeHtml(recipient.botName)} ／ ${escapeHtml(recipient.label)}</option>`
  ).join('');
  const fields = (name, recipientId) => `
    <label>數位平台名稱<input name="name" required maxlength="80" value="${escapeHtml(name)}" placeholder="例如 課程報名平台"></label>
    <label>LINE Bot 與收件對象<select name="recipientId" required>${recipientOptions(recipientId)}</select></label>`;
  const firstRecipient = recipients.length === 1 ? recipients[0].id : '';
  const example = [
    '$headers = @{',
    '  Authorization = "Bearer $env:LINEBOT_INTEGRATION_KEY"',
    "  'Idempotency-Key' = 'signup-1042'",
    '}',
    `Invoke-RestMethod -Method Post -Uri '${initial.endpoint}' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body '{"message":"收到一筆新報名，請登入平台查看。"}'`
  ].join('\n');

  workspace.innerHTML = `
    <section class="panel integration-secret" id="integration-secret" aria-labelledby="integration-secret-title" hidden></section>
    <div class="split-layout integration-layout">
      <section class="panel" aria-labelledby="integration-create-title">
        <h2 id="integration-create-title">新增外部串接</h2>
        <p class="muted">選擇這個數位平台發送時要用的 Bot 和收件對象。</p>
        ${recipients.length ? `<form id="integration-create" class="form-stack">
          ${fields('', firstRecipient)}
          <button type="submit" class="button button-primary">建立並取得金鑰</button>
        </form>` : emptyState('先配對收件對象', '完成 LINE 配對後，即可建立串接。', buttonLink('前往配對', '#recipients'))}
      </section>
      <section class="panel" aria-labelledby="integration-list-title">
        <div class="section-heading"><h2 id="integration-list-title">我的串接</h2>
          <button type="button" class="button button-quiet" id="integration-refresh">重新查詢</button>
        </div>
        <p class="feedback" role="status" id="integration-feedback"></p>
        <div id="integration-list"></div>
      </section>
    </div>
    <section class="panel section-gap" aria-labelledby="integration-connect-title">
      <h2 id="integration-connect-title">設定數位平台</h2>
      <p class="muted">請在數位平台的後端保存串接金鑰。選好觸發時機，例如新報名送出，再由後端發送請求。</p>
      ${copyField('integration-endpoint', '發送網址（POST）', initial.endpoint, '複製網址')}
      <details class="integration-example copy-field">
        <summary>查看 PowerShell 呼叫範例</summary>
        <p class="muted small"><code>LINEBOT_INTEGRATION_KEY</code> 是後端環境變數。<code>Idempotency-Key</code> 請填每筆事件的固定編號，重試時沿用同一值。</p>
        <label for="integration-example-code">範例指令</label>
        <textarea id="integration-example-code" class="integration-code" rows="7" readonly>${escapeHtml(example)}</textarea>
        <button class="button button-secondary" type="button" data-copy="integration-example-code">複製範例</button>
        <p class="feedback" data-copy-status="integration-example-code" role="status"></p>
      </details>
      <p class="muted small">成功排隊後會收到傳訊編號，可用同一組金鑰查詢 <code>GET /api/v1/messages/{傳訊編號}</code>。</p>
    </section>`;

  const list = workspace.querySelector('#integration-list');
  const feedback = workspace.querySelector('#integration-feedback');
  const secret = workspace.querySelector('#integration-secret');
  const testKeys = new Map();
  let items = initial.integrations;
  let busy = false;

  function renderList() {
    if (!items.length) {
      list.innerHTML = emptyState('尚未建立串接', '新增串接後，即可取得供數位平台呼叫的金鑰。');
      return;
    }
    list.innerHTML = items.map(item => {
      const status = !item.keyTail ? ['金鑰已撤銷', 'neutral'] :
        !item.enabled ? ['已停用', 'neutral'] : item.targetReady ? ['啟用中', 'success'] : ['待重新配對或啟用 Bot', 'warning'];
      const action = (type, label, disabled = false) =>
        `<button type="button" class="button button-quiet" data-integration-action="${type}"${disabled ? ' disabled' : ''}>${label}</button>`;
      return `<article class="integration-item" data-integration-id="${escapeHtml(item.id)}">
        <div class="section-heading"><h3>${escapeHtml(item.name)}</h3>${chip(...status)}</div>
        <p class="muted small">${escapeHtml(item.botName)} → ${escapeHtml(item.recipientLabel)}</p>
        ${item.keyTail ? `<p class="muted small">金鑰尾碼 <code>${escapeHtml(item.keyTail)}</code></p>` : ''}
        <div class="button-row">
          ${action('test', '發送測試', !item.enabled || !item.targetReady)}
          ${item.enabled ? action('disable', '停用') : action('enable', '啟用', !item.targetReady || !item.keyTail)}
          ${action('rotate', item.keyTail ? '換發金鑰' : '產生新金鑰')}
          ${item.keyTail ? action('revoke', '撤銷金鑰') : ''}
        </div>
        ${recipients.length ? `<details class="integration-edit"><summary>修改名稱或收件人</summary>
          <form class="form-stack">${fields(item.name, item.recipientId)}
            <button class="button button-secondary" type="submit">儲存串接設定</button>
          </form></details>` : ''}
      </article>`;
    }).join('');
  }

  function hideSecret() {
    secret.replaceChildren();
    secret.hidden = true;
  }

  function showSecret(key) {
    secret.innerHTML = `<div class="section-heading"><h2 id="integration-secret-title" tabindex="-1">請保存串接金鑰</h2>
        <button class="button button-quiet" type="button" data-hide-key>關閉</button></div>
      <p class="muted">金鑰只會顯示這一次。請複製到數位平台的後端環境變數。</p>
      ${copyField('integration-key', '串接金鑰', key, '複製金鑰')}`;
    secret.querySelector('input').autocomplete = 'off';
    secret.hidden = false;
    bindCopyFields(secret);
    secret.querySelector('[data-hide-key]').addEventListener('click', hideSecret);
    secret.querySelector('h2').focus();
  }

  async function refreshList() {
    const updated = await api(path, { signal });
    if (!signal.aborted) {
      items = updated.integrations;
      renderList();
    }
  }

  async function change(button, route, data, success, after) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    report(feedback, '正在處理…');
    try {
      const result = await api(route, { data, signal });
      if (signal.aborted) return;
      if (result.apiKey) showSecret(result.apiKey);
      after?.();
      report(feedback, success, 'success');
      try { await refreshList(); }
      catch { if (!signal.aborted) report(feedback, `${success} 請重新查詢清單。`, 'warning'); }
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  const createForm = workspace.querySelector('#integration-create');
  createForm?.addEventListener('submit', event => {
    event.preventDefault();
    change(createForm.querySelector('button'), path, Object.fromEntries(new FormData(createForm)),
      '串接已建立。', () => createForm.reset());
  });
  list.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const id = form.closest('[data-integration-id]').dataset.integrationId;
    change(form.querySelector('button'), `${path}/${id}/edit`, Object.fromEntries(new FormData(form)), '已儲存串接設定。');
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-integration-action]');
    if (!button || busy) return;
    const item = items.find(entry => entry.id === button.closest('[data-integration-id]').dataset.integrationId);
    const action = button.dataset.integrationAction;
    const confirmation = {
      test: `將使用「${item.botName}」傳送測試通知給「${item.recipientLabel}」。確定發送？`,
      disable: '確定停用這個串接？等候發送的通知將取消。',
      rotate: '換發金鑰後，請將新的金鑰填回數位平台。現在換發？',
      revoke: '撤銷後，持有舊金鑰的數位平台會失去此串接的存取權。確定撤銷？'
    };
    if (confirmation[action] && !window.confirm(confirmation[action])) return;
    const success = {
      test: '測試通知已送出處理，請查看發送紀錄並向收件人確認。',
      disable: '串接已停用。', enable: '串接已啟用。',
      rotate: '新金鑰已產生。', revoke: '金鑰已撤銷。'
    };
    if (action === 'test' && !testKeys.has(item.id)) testKeys.set(item.id, 'test-' + crypto.randomUUID());
    const after = action === 'test' ? () => testKeys.delete(item.id) : action === 'revoke' ? hideSecret : undefined;
    change(button, `${path}/${item.id}/${action}`, action === 'test' ? { eventKey: testKeys.get(item.id) } : {}, success[action], after);
  });
  workspace.querySelector('#integration-refresh').addEventListener('click', async event => {
    if (busy) return;
    busy = true;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshList();
      if (!signal.aborted) report(feedback, '已更新串接清單。', 'success');
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  renderList();
  bindCopyFields(workspace);
}

async function renderMessages(params, signal) {
  view.innerHTML = pageHeading('發送與紀錄', '使用自己的 LINE Bot 發送文字通知。') +
    `<div class="split-layout message-layout">
      <section class="panel" aria-labelledby="compose-title">
        <h2 id="compose-title">發送通知</h2>
        <div id="compose"><p class="muted" role="status">正在載入收件對象…</p></div>
      </section>
      <section class="panel" aria-labelledby="history-title">
        <div class="section-heading"><h2 id="history-title" tabindex="-1">最近發送紀錄</h2>
          <button type="button" class="button button-quiet" id="refresh-history">重新查詢</button>
        </div>
        <p class="muted small">紀錄保存 30 天。送達情形請以收件者確認為準。</p>
        <p id="history-feedback" class="feedback" role="status"></p>
        <div id="notification-list"></div>
      </section>
    </div>`;

  const compose = view.querySelector('#compose');
  const list = view.querySelector('#notification-list');
  const refresh = view.querySelector('#refresh-history');
  const feedback = view.querySelector('#history-feedback');
  let requestNumber = 0;
  async function loadHistory() {
    const ownNumber = ++requestNumber;
    refresh.disabled = true;
    report(feedback, '正在更新紀錄…');
    try {
      const data = await api('notifications', { signal });
      if (!signal.aborted && ownNumber === requestNumber) {
        renderHistory(list, data.notifications);
        report(feedback, '');
      }
    } catch (error) {
      if (!signal.aborted && ownNumber === requestNumber) report(feedback, error.message, 'danger');
    } finally {
      if (ownNumber === requestNumber) refresh.disabled = false;
    }
  }
  refresh.addEventListener('click', loadHistory);
  const historyRequest = loadHistory();
  try {
    const { recipients } = await api('recipients', { signal });
    if (!signal.aborted) bindComposer(compose, recipients, params.get('bot'), signal, loadHistory);
  } catch (error) {
    if (!signal.aborted) showPageError(compose, error.message);
  }
  await historyRequest;
}

function bindComposer(target, recipients, requestedBot, signal, loadHistory) {
  if (!recipients.length) {
    target.innerHTML = emptyState('先配對收件對象', '收件者完成配對後，就能在這裡選擇對方。',
      buttonLink('前往配對', requestedBot ? '#recipients?bot=' + encodeURIComponent(requestedBot) : '#recipients'));
    return;
  }
  const bots = new Map(recipients.map(recipient => [recipient.botId, recipient.botName]));
  target.innerHTML = `<form id="send-form" class="form-stack">
    <label>LINE Bot<select name="botId" required>${option('', '請選擇 Bot')}
      ${[...bots].map(([id, name]) => option(id, name)).join('')}</select></label>
    <label>收件對象<select name="recipientId" required></select></label>
    <div class="field"><label for="message-text">訊息內容</label>
      <textarea id="message-text" name="message" required maxlength="2000" rows="6" aria-describedby="message-max"></textarea>
      <small id="message-max">最多 2,000 個字元</small></div>
    <button class="button button-primary" type="submit">預覽並發送</button>
    <p class="feedback" id="send-result" role="status"></p>
  </form>
  <dialog id="send-dialog" class="action-dialog" aria-labelledby="send-dialog-title">
    <h2 id="send-dialog-title">確認發送通知</h2>
    <dl class="definition-grid">
      <div><dt>LINE Bot</dt><dd data-confirm-bot></dd></div>
      <div><dt>收件對象</dt><dd data-confirm-recipient></dd></div>
    </dl>
    <p class="message-preview" data-confirm-message></p>
    <form method="dialog" class="dialog-actions">
      <button class="button button-secondary" value="cancel" autofocus>返回修改</button>
      <button class="button button-primary" value="send">確認發送</button>
    </form>
  </dialog>`;

  const form = target.querySelector('#send-form');
  const dialog = target.querySelector('#send-dialog');
  const result = target.querySelector('#send-result');
  const botSelect = form.elements.botId;
  const recipientSelect = form.elements.recipientId;
  const submit = form.querySelector('button');
  let draft;
  let sending = false;

  function syncRecipients() {
    const matches = recipients.filter(recipient => recipient.botId === botSelect.value);
    recipientSelect.innerHTML = option('', matches.length ? '請選擇收件對象' : '請先選擇 Bot') +
      matches.map(recipient => option(recipient.id, recipient.label)).join('');
    recipientSelect.disabled = !matches.length;
    if (matches.length === 1) recipientSelect.value = matches[0].id;
  }

  botSelect.value = bots.has(requestedBot) ? requestedBot : (bots.size === 1 ? bots.keys().next().value : '');
  botSelect.addEventListener('change', syncRecipients);
  syncRecipients();
  signal.addEventListener('abort', () => {
    if (dialog.open) dialog.close('cancel');
  }, { once: true });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending || dialog.open) return;
    const recipient = recipients.find(item => item.id === recipientSelect.value && item.botId === botSelect.value);
    const message = form.elements.message.value;
    if (!recipient || !message.trim()) {
      report(result, '請選擇收件對象並輸入訊息內容。', 'danger');
      return;
    }
    draft = { recipientId: recipient.id, message };
    dialog.querySelector('[data-confirm-bot]').textContent = recipient.botName;
    dialog.querySelector('[data-confirm-recipient]').textContent = recipient.label;
    dialog.querySelector('[data-confirm-message]').textContent = message;
    dialog.returnValue = '';
    dialog.showModal();
  });

  dialog.addEventListener('close', async () => {
    const data = draft;
    draft = undefined;
    if (dialog.returnValue !== 'send' || !data || signal.aborted) return;
    sending = true;
    submit.disabled = true;
    report(result, '正在發送通知…');
    try {
      const response = await api('notification/send', { data: { ...data, requestId: crypto.randomUUID() } });
      if (signal.aborted) return;
      if (response.status === 'accepted') {
        if (form.elements.message.value === data.message) form.elements.message.value = '';
        report(result, 'LINE 已受理。請向收件者確認是否收到。', 'success');
      } else if (response.status === 'failed') {
        report(result, '發送失敗。請檢查 Bot 設定與收件對象後再試。', 'danger');
      } else {
        report(result, '結果未確認。請先查看紀錄及收件情形，避免重複發送。', 'warning');
      }
    } catch (error) {
      const uncertain = !error.status || error.status >= 500;
      if (!signal.aborted) report(result, uncertain
        ? '結果未確認。請先查看紀錄及收件情形，避免重複發送。'
        : error.message, uncertain ? 'warning' : 'danger');
    } finally {
      if (!signal.aborted) await loadHistory();
      submit.disabled = false;
      sending = false;
    }
  });
}

navToggle.addEventListener('click', () => {
  const open = !navigation.classList.contains('is-open');
  navigation.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
});
navigation.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
document.querySelector('#skip-link').addEventListener('click', event => {
  event.preventDefault();
  view.focus();
});
logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await api('logout', { data: {} });
    webhookChecks.clear();
    currentUsername = undefined;
    goTo('#account');
  } catch (error) {
    let status = view.querySelector('#logout-feedback');
    if (!status) {
      status = document.createElement('p');
      status.id = 'logout-feedback';
      status.className = 'feedback';
      status.setAttribute('role', 'status');
      view.prepend(status);
    }
    report(status, error.message, 'danger');
  } finally {
    logoutButton.disabled = false;
  }
});
window.addEventListener('hashchange', () => render());
render();
