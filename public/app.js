const view = document.querySelector('#view');
const navigation = document.querySelector('#workspace-nav');
const platformNav = document.querySelector('#platform-nav');
const platformContext = document.querySelector('#platform-context');
const platformContextName = document.querySelector('#platform-context-name');
const platformContextBot = document.querySelector('#platform-context-bot');
const brandHome = document.querySelector('#brand-home');
const accountLink = document.querySelector('#account-link');
const guestLink = document.querySelector('#guest-link');
const logoutButton = document.querySelector('#logout-button');
const consoleUrl = 'https://developers.line.biz/console/';
const workspacePages = new Set(['overview', 'bot', 'recipients', 'integrations', 'messages']);
const pages = new Set(['platforms', 'account', 'register', ...workspacePages]);
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
let currentPlatform;
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
  let [page, query] = location.hash.slice(1).split('?', 2);
  if (page === 'connect') {
    page = 'integrations';
    history.replaceState(null, '', '#' + page + (query ? '?' + query : ''));
  }
  return { page: pages.has(page) ? page : 'platforms', params: new URLSearchParams(query) };
}

function goTo(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function workspaceLink(hash, platformId = currentPlatform?.id) {
  const [page, query] = hash.slice(1).split('?', 2);
  if (!platformId || !workspacePages.has(page)) return hash;
  const params = new URLSearchParams(query);
  if (!params.has('platform')) params.set('platform', platformId);
  return '#' + page + '?' + params;
}

function platformLink(page, platform) {
  return workspaceLink('#' + page, platform.id);
}

function replacePage(page) {
  history.replaceState(null, '', workspaceLink('#' + page));
  return page;
}

function platformName(platform) {
  return platform.name || '平台名稱待補';
}

async function api(path, { data, signal, unscoped = false } = {}) {
  const scoped = /^(bots|bot(?:\/.*)?|recipients|recipient\/.*|notifications|notification\/.*|integrations(?:\/.*)?|platforms\/line-setup)(?:\?|$)/.test(path);
  if (currentPlatform && scoped && !unscoped) path += (path.includes('?') ? '&' : '?') + 'platform=' + encodeURIComponent(currentPlatform.id);
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
  return `<a class="button button-${style}" href="${escapeHtml(workspaceLink(href))}">${escapeHtml(text)}</a>`;
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

function setLayout(state, page, user) {
  document.documentElement.dataset.auth = state;
  const active = state === 'active';
  const scoped = active && currentPlatform && workspacePages.has(page);
  navigation.hidden = !scoped;
  platformNav.hidden = !scoped;
  platformContext.hidden = !scoped;
  if (scoped) {
    platformContextName.textContent = platformName(currentPlatform);
    platformContextBot.hidden = Boolean(currentPlatform.name || !currentPlatform.botName);
    platformContextBot.textContent = currentPlatform.botName || '';
  }
  brandHome.href = active ? '#platforms' : '#account';
  accountLink.hidden = !active;
  logoutButton.hidden = !user;
  guestLink.hidden = state !== 'guest';
  accountLink.textContent = user?.displayName || '我的帳號';
  accountLink.setAttribute('aria-label', '我的帳號');
  if (page === 'account' && active) accountLink.setAttribute('aria-current', 'page');
  else accountLink.removeAttribute('aria-current');
  guestLink.href = page === 'register' ? '#account' : '#register';
  guestLink.textContent = page === 'register' ? '返回登入' : '申請帳號';
  for (const link of navigation.querySelectorAll('[data-page]')) {
    link.href = workspaceLink('#' + link.dataset.page);
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function render({ openPlatformsIfApproved = false } = {}) {
  renderController?.abort();
  renderController = new AbortController();
  const { signal } = renderController;
  let { page, params } = route();
  if (!workspacePages.has(page) || params.get('platform') !== currentPlatform?.id) {
    platformNav.hidden = true;
    platformContext.hidden = true;
  }
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

  if (user?.username !== currentUsername) { webhookChecks.clear(); currentPlatform=undefined; }
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
    currentPlatform = undefined;
    if (openPlatformsIfApproved || page === 'register') {
      page = replacePage('platforms');
      params = new URLSearchParams();
    }
    if (workspacePages.has(page)) {
      try {
        const { platforms } = await api('platforms', { signal });
        if (signal.aborted) return;
        const requested = params.get('platform');
        const legacyBot = params.get('bot');
        currentPlatform = requested
          ? platforms.find(platform => platform.id === requested)
          : legacyBot && platforms.find(platform => platform.botId === legacyBot);
        if (!currentPlatform) {
          page = replacePage('platforms');
          params = new URLSearchParams();
        } else if (!requested) {
          replacePage(page + '?' + params);
        }
      } catch (error) {
        if (!signal.aborted) {
          setLayout('active', page, user);
          showPageError(view, error.message);
        }
        return;
      }
    }
    setLayout('active', page, user);
    if (page === 'account') renderProfile(user);
    if (page === 'overview') await renderOverview(signal);
    if (page === 'platforms') await renderPlatforms(signal);
    if (page === 'bot') await renderBots(params, signal);
    if (page === 'recipients') await renderRecipients(signal);
    if (page === 'messages') await renderMessages(signal);
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
      <h2>讓數位平台的事件<br>變成 LINE 通知</h2>
      <p>每個平台綁定自己的 LINE Bot，分開管理事件、收件者與發送紀錄。</p>
      <div class="entry-flow" aria-label="數位平台透過事件串接通知 LINE 收件者">
        <span>數位平台</span><span aria-hidden="true">→</span><span>事件串接</span><span aria-hidden="true">→</span><span>LINE 收件者</span>
      </div>
    </div>
    <section class="panel entry-card" aria-labelledby="entry-title">
      <h1 id="entry-title" tabindex="-1">${heading}</h1>
      <p class="muted">${signingUp ? '帳號核准後，就能自行新增數位平台。' : '登入後，選擇你要管理的數位平台。'}</p>
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
      goTo(signingUp ? '#account' : '#platforms');
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
    <p>${escapeHtml(user.displayName)}（${escapeHtml(user.username)}），帳號核准後即可新增數位平台並設定通知。</p>
    <p class="muted">如需了解審核進度，請聯絡平台管理員。</p>
    <button class="button button-primary" id="check-approval" type="button">重新查詢審核狀態</button>
  </section>`;
  view.querySelector('#check-approval').addEventListener('click', () => render({ openPlatformsIfApproved: true }));
}

function renderProfile(user) {
  view.innerHTML = pageHeading('我的帳號', '接線站帳號與審核狀態。', buttonLink('返回數位平台', '#platforms', 'secondary')) +
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
    target.innerHTML = emptyState('尚無發送紀錄', '這個平台的通知送出後，會在這裡顯示處理結果。');
    return;
  }
  target.innerHTML = `<ul class="record-list">${records.slice(0, limit).map(record => {
    const [label, tone] = notificationStates[record.status] ?? notificationStates.unknown;
    return `<li>
      <div><strong>${escapeHtml(record.label)}</strong>
        <span class="record-source">${escapeHtml(record.integrationName || '手動發送')}</span></div>
      <div class="record-status">${chip(label, tone)}
        <time datetime="${escapeHtml(record.createdAt)}">${dateTime(record.createdAt)}</time></div>
    </li>`;
  }).join('')}</ul>`;
}

function integrationStatus(item) {
  if (!item.keyTail) return ['Webhook 已撤銷', 'neutral'];
  if (!item.enabled) return ['已停用', 'neutral'];
  return item.targetReady ? ['啟用中', 'success'] : ['收件者或 Bot 無法使用', 'warning'];
}

function integrationName(item) {
  return item.eventName || item.name || '事件名稱待設定';
}

async function renderOverview(signal) {
  const platform = currentPlatform;
  view.innerHTML = pageHeading('平台總覽', '查看這個平台的通知路線與發送狀態。') +
    `<div id="overview-summary" class="summary-grid" aria-label="平台設定"><p class="muted" role="status">正在載入平台設定…</p></div>
    <div id="overview-next"></div>
    <section class="panel section-gap" aria-labelledby="overview-map-title">
      <div class="section-heading"><div><h2 id="overview-map-title">通知路線圖</h2>
        <p class="muted small">點選事件可凸顯它的路線。</p></div>${buttonLink('管理串接', '#integrations', 'secondary')}</div>
      <div id="overview-map"><p class="muted" role="status">正在載入通知路線…</p></div>
    </section>
    <section class="panel section-gap" aria-labelledby="overview-history-title">
      <div class="section-heading"><h2 id="overview-history-title">最近發送紀錄</h2>${buttonLink('查看紀錄', '#messages', 'quiet')}</div>
      <div id="overview-history"><p class="muted" role="status">正在載入紀錄…</p></div>
    </section>`;
  const [recipientResult, integrationResult, historyResult] = await Promise.allSettled([
    api('recipients', { signal }), api('integrations', { signal }), api('notifications', { signal })
  ]);
  if (signal.aborted) return;

  const recipients = recipientResult.value?.recipients;
  const integrations = integrationResult.value?.integrations;
  const liveCount = integrations?.filter(item => integrationStatus(item)[1] === 'success').length;
  const summaryCard = (label, content, hash) => `<a class="summary-card" href="${escapeHtml(workspaceLink(hash))}">
    <span>${label}</span>${content}</a>`;
  view.querySelector('#overview-summary').innerHTML =
    summaryCard('LINE Bot', `<strong>${escapeHtml(platform.botName || '尚未連結')}</strong>${platform.botId
      ? chip(platform.botEnabled ? '已啟用' : '已停用', platform.botEnabled ? 'success' : 'neutral') : ''}`, '#bot') +
    summaryCard('已配對收件者', `<strong class="indicator-value">${recipients ? (recipients.length === 200 ? '200+' : recipients.length) : '—'}</strong>`, '#recipients') +
    summaryCard('可發送的事件串接', `<strong class="indicator-value">${integrations ? liveCount : '—'}</strong>${integrations
      ? `<small>共 ${integrations.length} 組</small>` : ''}`, '#integrations');

  const next = view.querySelector('#overview-next');
  let nextAction;
  if (!platform.botEnabled) nextAction = ['設定 LINE Bot', '連結並啟用 Bot 後，就能邀請收件者完成配對。', '#bot'];
  else if (recipients && !recipients.length) nextAction = ['配對第一位收件者', '請收件者將配對文字傳給這個平台的 Bot。', '#recipients'];
  else if (recipients && integrations && !integrations.length) nextAction = ['建立第一組事件串接', '為事件指定收件者並取得專用金鑰。', '#integrations'];
  if (nextAction) {
    const [label, description, destination] = nextAction;
    next.innerHTML = `<section class="next-card" aria-labelledby="next-heading">
      <div><h2 id="next-heading">${label}</h2><p>${description}</p></div>${buttonLink(label, destination)}
    </section>`;
  }

  const map = view.querySelector('#overview-map');
  if (integrations) renderRouteMap(map, integrations, platform, signal);
  else map.innerHTML = '<p class="feedback" data-tone="danger">暫時無法載入通知路線。重新整理後可再試一次。</p>';

  const history = view.querySelector('#overview-history');
  if (historyResult.status === 'fulfilled') renderHistory(history, historyResult.value.notifications, 4);
  else history.innerHTML = '<p class="feedback" data-tone="danger">暫時無法載入紀錄。</p>';
}

function renderRouteMap(target, integrations, platform, signal) {
  if (!integrations.length) {
    target.innerHTML = emptyState('尚未建立通知路線', '新增事件串接後，這裡會顯示事件與收件者的對應。');
    return;
  }
  const people = new Map();
  const routes = integrations.map(item => {
    people.set(item.recipientId, { label: item.recipientLabel, active: item.targetReady });
    const [label, tone] = integrationStatus(item);
    return { item, label, tone, ready: tone === 'success' };
  });
  target.innerHTML = `<div class="route-graph">
    <div class="route-canvas" role="group" aria-label="${escapeHtml(platformName(platform))}的通知路線">
      <svg class="route-lines" aria-hidden="true"></svg>
      <div class="route-column"><h3>外部平台</h3>
        <div class="route-node route-source"><strong>${escapeHtml(platformName(platform))}</strong><small>事件觸發</small></div>
      </div>
      <div class="route-column route-station"><h3>LINEBOT 接線站</h3>
        <p class="route-bot">LINE Bot · ${escapeHtml(platform.botName)}</p>
        ${routes.map(({ item, label, tone }) => `<button type="button" class="route-node route-integration" aria-pressed="false">
          <span class="route-event-name"><strong>${escapeHtml(integrationName(item))}</strong>
            ${!item.eventName ? '<small>舊名稱待確認</small>' : ''}</span>
          ${chip(label, tone)}<span class="sr-only">，設定的收件者為 ${escapeHtml(item.recipientLabel)}</span>
        </button>`).join('')}
      </div>
      <div class="route-column"><h3>收件者</h3>
        ${[...people.values()].map(person => `<div class="route-node route-person"><strong>${escapeHtml(person.label)}</strong>
          ${person.active ? '' : '<small>目前無法接收</small>'}</div>`).join('')}
      </div>
    </div>
    ${routes.some(route => !route.ready) ? '<p class="route-legend small"><span>可發送</span><span class="unavailable">暫無法發送</span></p>' : ''}
    <p class="route-description" aria-live="polite"></p>
  </div>`;

  const canvas = target.querySelector('.route-canvas');
  const svg = canvas.querySelector('.route-lines');
  const source = canvas.querySelector('.route-source');
  const buttons = [...canvas.querySelectorAll('.route-integration')];
  const recipientElements = canvas.querySelectorAll('.route-person');
  const personNodes = new Map([...people.keys()].map((id, index) => [id, recipientElements[index]]));
  const description = target.querySelector('.route-description');
  let selected = -1;

  function draw() {
    const bounds = svg.getBoundingClientRect();
    if (!canvas.isConnected || !bounds.width) return;
    svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    svg.replaceChildren();

    const line = (from, to, ready, highlighted) => {
      const start = from.getBoundingClientRect();
      const end = to.getBoundingClientRect();
      const x1 = start.right - bounds.left, y1 = start.top + start.height / 2 - bounds.top;
      const x2 = end.left - bounds.left, y2 = end.top + end.height / 2 - bounds.top;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      path.classList.add('route-line');
      path.classList.toggle('is-unavailable', !ready);
      path.classList.toggle('is-highlighted', highlighted);
      path.classList.toggle('is-dimmed', selected >= 0 && !highlighted);
      svg.append(path);
    };
    const drawRoute = index => {
      const { item, ready } = routes[index];
      line(source, buttons[index], ready, selected === index);
      line(buttons[index], personNodes.get(item.recipientId), ready, selected === index);
    };
    routes.forEach((_, index) => { if (index !== selected) drawRoute(index); });
    if (selected >= 0) drawRoute(selected);
  }

  buttons.forEach((button, index) => button.addEventListener('click', () => {
    selected = selected === index ? -1 : index;
    buttons.forEach((item, key) => item.setAttribute('aria-pressed', String(key === selected)));
    const route = routes[selected];
    source.classList.toggle('is-highlighted', Boolean(route));
    for (const [id, node] of personNodes) node.classList.toggle('is-highlighted', id === route?.item.recipientId);
    description.textContent = route ? `${integrationName(route.item)} → ${route.item.recipientLabel}（${route.label}）` : '';
    draw();
  }));
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  for (const button of buttons) observer.observe(button);
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  draw();
}

async function renderPlatforms(signal) {
  view.innerHTML = pageHeading('我的數位平台', '選擇要管理的平台。每個平台各自使用一個 LINE Bot。',
    '<button class="button button-primary" type="button" id="new-platform">新增數位平台</button>') +
    `<p id="platform-feedback" class="feedback flash-banner" role="status"></p>
    <div id="platform-list"><p class="page-loading" role="status">正在載入平台…</p></div>
    <dialog class="action-dialog" id="platform-dialog" aria-labelledby="platform-dialog-title">
      <h2 id="platform-dialog-title">新增數位平台</h2>
      <p class="muted">建立後即可設定這個平台的 LINE Bot。</p>
      <form id="platform-create" class="form-stack">
        <label>數位平台名稱<input name="name" maxlength="80" required placeholder="例如 課程報名平台" autofocus></label>
        <p class="feedback" role="status"></p>
        <div class="dialog-actions">
          <button class="button button-secondary" type="button" data-close>取消</button>
          <button class="button button-primary" type="submit">建立平台</button>
        </div>
      </form>
    </dialog>`;

  const list = view.querySelector('#platform-list');
  const status = view.querySelector('#platform-feedback');
  const dialog = view.querySelector('#platform-dialog');
  const form = view.querySelector('#platform-create');
  const close = form.querySelector('[data-close]');
  const createButton = form.querySelector('[type="submit"]');
  const createFeedback = form.querySelector('.feedback');
  let savingSettings = false;

  function platformCard(platform, unlinkedBots) {
    const connection = !platform.botId ? 'missing' : platform.botEnabled ? 'ready' : 'off';
    const [label, tone] = connection === 'ready' ? ['Bot 已啟用', 'success']
      : connection === 'missing' ? ['尚未連結 Bot', 'warning'] : ['Bot 已停用', 'neutral'];
    return `<article class="panel platform-card" data-platform-id="${escapeHtml(platform.id)}" data-connection="${connection}">
      <div class="section-heading"><h2 tabindex="-1">${escapeHtml(platformName(platform))}</h2>${chip(label, tone)}</div>
      <p class="muted small">${platform.botId ? 'LINE Bot · ' + escapeHtml(platform.botName) : '連結 LINE Bot 後即可配對收件者。'}</p>
      <div class="button-row">
        ${buttonLink('進入平台', platformLink('overview', platform), 'secondary')}
        ${platform.botId ? buttonLink('事件串接', platformLink('integrations', platform), 'quiet')
          : buttonLink('設定 LINE Bot', platformLink('bot?setup=1', platform), 'quiet')}
      </div>
      <details class="card-settings"><summary>平台設定</summary>
        <form class="form-stack platform-form" data-platform-action="rename">
          <label>平台名稱<input name="name" required maxlength="80" value="${escapeHtml(platform.name)}" placeholder="請填寫平台名稱"></label>
          <button class="button button-secondary" type="submit">儲存名稱</button>
        </form>
        ${!platform.botId && unlinkedBots.length ? `<form class="form-stack platform-form" data-platform-action="attach">
          <label>連結既有 LINE Bot<select name="botId" required>${option('', '選擇尚未連結的 Bot')}
            ${unlinkedBots.map(bot => option(bot.id, bot.name)).join('')}</select></label>
          <button class="button button-secondary" type="submit">連結 Bot</button>
        </form>` : ''}
        <p class="feedback" data-platform-status role="status"></p>
      </details>
    </article>`;
  }

  async function load(focusId) {
    const { platforms } = await api('platforms', { signal });
    let unlinkedBots = [];
    if (platforms.some(platform => !platform.botId)) {
      const data = await api('bots', { signal, unscoped: true }).catch(() => null);
      const linked = new Set(platforms.map(platform => platform.botId));
      unlinkedBots = (data?.bots || []).filter(bot => !linked.has(bot.id));
    }
    if (signal.aborted) return;
    list.innerHTML = platforms.length
      ? `<div class="platform-grid">${platforms.map(platform => platformCard(platform, unlinkedBots)).join('')}</div>`
      : emptyState('尚未建立數位平台', '用右上角的「新增數位平台」開始設定通知。');
    if (focusId) {
      const card = [...list.querySelectorAll('.platform-card')].find(card => card.dataset.platformId === focusId);
      card?.querySelector('h2').focus();
    }
  }

  view.querySelector('#new-platform').addEventListener('click', () => {
    form.reset();
    report(createFeedback, '');
    dialog.showModal();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (createButton.disabled) event.preventDefault(); });
  signal.addEventListener('abort', () => { if (dialog.open) dialog.close(); }, { once: true });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (createButton.disabled) return;
    createButton.disabled = close.disabled = true;
    report(createFeedback, '正在建立平台…');
    try {
      const { id } = await api('platforms', { data: { name: new FormData(form).get('name') }, signal });
      if (signal.aborted) return;
      dialog.close();
      goTo(platformLink('overview', { id }));
    } catch (error) {
      if (!signal.aborted) report(createFeedback, error.message, 'danger');
    } finally {
      createButton.disabled = close.disabled = false;
    }
  });

  list.addEventListener('submit', async event => {
    const settings = event.target.closest('[data-platform-action]');
    if (!settings) return;
    event.preventDefault();
    if (savingSettings) return;
    const card = settings.closest('[data-platform-id]');
    const { platformId } = card.dataset;
    const button = settings.querySelector('button');
    const feedback = card.querySelector('[data-platform-status]');
    savingSettings = button.disabled = true;
    const action = settings.dataset.platformAction;
    const success = action === 'rename' ? '平台名稱已儲存。' : 'LINE Bot 已連結。';
    try {
      const data = { id: platformId, ...Object.fromEntries(new FormData(settings)) };
      await api('platforms/' + action, { data, signal });
      if (signal.aborted) return;
      report(status, success, 'success');
      try { await load(platformId); }
      catch { if (!signal.aborted) report(status, success + '請重新整理以查看結果。', 'warning'); }
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      savingSettings = button.disabled = false;
    }
  });
  try { await load(); }
  catch (error) { if (!signal.aborted) showPageError(list, error.message); }
}

function confirmAction(title, description, label, signal, style = 'danger') {
  if (signal.aborted) return Promise.resolve(false);
  const dialog = document.createElement('dialog');
  dialog.className = 'action-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>
    <form method="dialog" class="dialog-actions">
      <button class="button button-secondary" value="cancel" autofocus>取消</button>
      <button class="button button-${style}" value="confirm">${escapeHtml(label)}</button>
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

function bindWebhookControls(container, bot, signal) {
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
      const result = await api('bot/webhook-check', { data: { botId: bot.id }, signal });
      if (signal.aborted || !container.isConnected) return;
      webhookChecks.set(bot.id, result);
      showWebhookState(status, bot);
      report(feedback, '');
      button.textContent = '重新檢查 LINE 驗證';
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
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

function wizardHeading(description, action = '') {
  const back = buttonLink('返回 Bot 設定', '#bot', 'secondary');
  return pageHeading('設定 LINE Bot', description, action ? `<div class="button-row">${action}${back}</div>` : back);
}

function renderCredentials(signal) {
  const description = currentPlatform.botId
    ? '請使用已連結的 LINE 官方帳號更新憑證。'
    : '把這個平台專用的 LINE 官方帳號連到接線站。';
  view.innerHTML = wizardHeading(description, buttonLink('LINE 開設資料', '#bot?setup=profile', 'secondary')) +
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
      const result = await api('bot', { data: Object.fromEntries(new FormData(form)), signal });
      if (signal.aborted || !form.isConnected) return;
      form.reset();
      if (!result.bot) {
        report(feedback, '已儲存。請返回 Bot 設定查看 Webhook 網址。', 'success');
        return;
      }
      webhookChecks.delete(result.bot.id);
      replacePage('bot?setup=webhook&bot=' + encodeURIComponent(result.bot.id));
      renderWebhookStep(result.bot, signal);
      view.querySelector('h1').focus();
    } catch (error) {
      report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

function renderWebhookStep(bot, signal) {
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
  bindWebhookControls(view.querySelector('#webhook-step'), bot, signal);
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

async function renderLineSetup(signal) {
  const endpoint = 'platforms/line-setup';
  const fields = [
    ['accountName', 'LINE 官方帳號名稱', 80],
    ['organization', '公司或事業者名稱', 120],
    ['region', '公司所在國家或地區', 80],
    ['contactEmail', '業務聯絡電子郵件', 254, 'email'],
    ['industry', '業種（主類別）', 80],
    ['subIndustry', '業種（子類別）', 80],
    ['providerName', '服務提供者名稱（Provider）', 100]
  ];
  view.innerHTML = pageHeading('LINE 開設資料', '先填好這個平台的官方帳號資料，之後可讓 AI 代填 LINE 申請表。',
    buttonLink('返回 Bot 設定', '#bot', 'secondary')) +
    '<section class="panel line-setup-panel" id="line-setup-panel"><p class="page-loading" role="status">正在載入開設資料…</p></section>';
  const panel = view.querySelector('#line-setup-panel');
  let details;
  try {
    ({ lineSetup: details } = await api(endpoint, { signal }));
  } catch (error) {
    if (!signal.aborted) showPageError(panel, error.message);
    return;
  }
  if (signal.aborted) return;
  panel.innerHTML = `<form id="line-setup-form" class="form-stack">
    <div class="line-setup-fields">
      ${fields.map(([name, label, limit, type = 'text']) => `<label>${label}
        <input type="${type}" name="${name}" maxlength="${limit}" value="${escapeHtml(details[name])}">
      </label>`).join('')}
      <label class="line-setup-purpose">使用目的
        <textarea name="purpose" rows="3" maxlength="240">${escapeHtml(details.purpose)}</textarea>
      </label>
    </div>
    <div class="button-row"><button type="submit" class="button button-primary">儲存開設資料</button></div>
    <p class="feedback" role="status"></p>
  </form>`;
  const form = panel.querySelector('form');
  const button = form.querySelector('button');
  const feedback = form.querySelector('.feedback');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    report(feedback, '正在儲存…');
    try {
      const { lineSetup } = await api(endpoint, { data: Object.fromEntries(new FormData(form)), signal });
      if (signal.aborted) return;
      for (const field of form.querySelectorAll('input, textarea')) field.value = lineSetup[field.name] || '';
      report(feedback, '已儲存開設資料。', 'success');
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

async function renderBots(params, signal) {
  const step = params.get('setup');
  if (step === 'profile') return renderLineSetup(signal);
  if (step === '1') {
    renderCredentials(signal);
    return;
  }
  view.innerHTML = pageHeading('LINE Bot 設定', '設定這個平台的 LINE 官方帳號與 Webhook。',
    buttonLink('LINE 開設資料', '#bot?setup=profile', 'secondary')) +
    '<div id="bot-list"><p class="page-loading" role="status">正在載入 LINE Bot…</p></div>';

  const list = view.querySelector('#bot-list');
  let bot;
  try {
    const { bots } = await api('bots', { signal });
    bot = bots.find(bot => bot.id === currentPlatform.botId);
  } catch (error) {
    if (!signal.aborted) showPageError(list, error.message);
    return;
  }
  if (signal.aborted) return;
  if (!bot) {
    list.innerHTML = `<section class="panel">${emptyState('尚未連結 LINE Bot',
      '請準備 LINE 官方帳號的 Channel access token 與 Channel secret。',
      `<div class="button-row">${buttonLink('開始設定', '#bot?setup=1')}${buttonLink('連結既有 Bot', '#platforms', 'quiet')}</div>`)}</section>`;
    return;
  }
  const requestedBot = params.get('bot');
  if (bot.enabled && (!requestedBot || requestedBot === bot.id)) {
    if (step === 'webhook') {
      renderWebhookStep(bot, signal);
      return;
    }
    if (step === 'test') {
      renderTestStep(bot);
      return;
    }
  }

  list.innerHTML = `<div class="workspace-columns">
    <section class="panel bot-card" aria-labelledby="linked-bot-title">
      <div class="section-heading"><h2 id="linked-bot-title">${escapeHtml(bot.name)}</h2>
        ${bot.enabled ? chip('已啟用', 'success') : chip('已停用')}</div>
      ${webhookDisplay(bot)}
    </section>
    <section class="panel" aria-labelledby="bot-actions-title">
      <h2 id="bot-actions-title">${bot.enabled ? '配對與測試' : '重新啟用 Bot'}</h2>
      <p class="muted">${bot.enabled
        ? '驗證 Webhook 後，邀請收件者和這個 Bot 完成配對。'
        : '請用原 LINE 官方帳號重新儲存憑證，即可恢復配對與發送。'}</p>
      <div class="button-row spaced">${bot.enabled
        ? buttonLink('配對收件者', '#recipients')
        : buttonLink('重新設定憑證', '#bot?setup=1')}</div>
      ${bot.enabled ? `<details class="action-menu spaced"><summary>Bot 管理</summary>
        <div class="button-row">
          ${buttonLink('更新憑證', '#bot?setup=1', 'secondary')}
          <button class="button button-danger-outline" type="button" data-disable-bot>停用 Bot</button>
        </div>
      </details>` : ''}
      <p class="feedback" data-bot-feedback role="status"></p>
    </section>
  </div>`;

  bindWebhookControls(list.querySelector('.bot-card'), bot, signal);
  const button = list.querySelector('[data-disable-bot]');
  button?.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const feedback = list.querySelector('[data-bot-feedback]');
    try {
      if (!await confirmAction('停用 LINE Bot', `停用「${bot.name}」後，這個平台將暫停配對與發送。`, '確認停用', signal)) return;
      await api('bot/disable', { data: { botId: bot.id }, signal });
      if (signal.aborted) return;
      webhookChecks.delete(bot.id);
      await renderBots(new URLSearchParams(), signal);
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      button.disabled = false;
    }
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

async function renderRecipients(signal) {
  const platform = currentPlatform;
  view.innerHTML = pageHeading('收件對象', '管理這個平台已配對的 LINE 收件者。') +
    '<div id="recipients-body"><p class="page-loading" role="status">正在載入收件對象…</p></div>';
  const body = view.querySelector('#recipients-body');
  if (!platform.botEnabled) {
    body.innerHTML = `<section class="panel">${emptyState('先啟用平台的 LINE Bot',
      'Bot 啟用後，就能建立收件者的配對文字。', buttonLink('前往 Bot 設定', '#bot'))}</section>`;
    return;
  }
  let recipients;
  try {
    ({ recipients } = await api('recipients', { signal }));
  } catch (error) {
    if (!signal.aborted) showPageError(body, error.message);
    return;
  }
  if (signal.aborted) return;
  body.innerHTML = `<div class="workspace-columns">
    <section class="panel" aria-labelledby="paired-title">
      <div class="section-heading"><h2 id="paired-title">已配對名單</h2>
        <button id="refresh-recipients" class="button button-quiet" type="button">重新查詢</button>
      </div>
      <p id="recipient-feedback" class="feedback" role="status"></p>
      <div id="recipients-list"></div>
    </section>
    <section class="panel" aria-labelledby="pair-title">
      <h2 id="pair-title">邀請收件者</h2>
      <p class="muted">請對方加入「${escapeHtml(platform.botName)}」為好友，在一對一聊天室傳送配對文字。</p>
      <form id="pair-form" class="form-stack">
        <label>收件對象名稱<input name="label" required maxlength="80" placeholder="例如 課程承辦人"></label>
        <button class="button button-primary" type="submit">產生配對文字</button>
        <p id="pair-result" class="feedback" role="status"></p>
      </form>
      <div id="pair-preview" class="detail-block" hidden></div>
    </section>
  </div>`;

  const form = body.querySelector('#pair-form');
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
        <div><strong>${escapeHtml(recipient.label)}</strong></div>
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
          await api('recipient/disable', { data: { recipientId: recipient.id }, signal });
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
    const label = new FormData(form).get('label').trim();
    submit.disabled = true;
    report(resultText, '正在產生配對文字…');
    try {
      const result = await api('recipient/pair', { data: { botId: platform.botId, label }, signal });
      if (signal.aborted || !form.isConnected) return;
      const expiresAt = Date.parse(result.expiresAt);
      const expiry = Number.isFinite(expiresAt) ? expiresAt : Date.now() + (result.expiresMinutes || 10) * 60_000;
      clearInterval(expiryTimer);
      preview.hidden = false;
      preview.innerHTML = `<h3 tabindex="-1">交給「${escapeHtml(label)}」的配對文字</h3>
        <p class="muted small">請對方將這段文字傳給「${escapeHtml(platform.botName)}」。每組限用一次。</p>
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
      preview.querySelector('h3').focus();
      report(resultText, '配對文字已產生。', 'success');
    } catch (error) {
      report(resultText, error.message, 'danger');
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderIntegrations(signal) {
  const platform = currentPlatform;
  view.innerHTML = pageHeading('事件串接', '將事件的專屬 Webhook 網址貼到數位平台。事件發生時，接線站會通知設定的收件者。',
    `<div class="button-row">
      <a href="/connection-guide" class="button button-secondary" target="_blank" rel="noopener">Webhook 串接指南</a>
      ${buttonLink('查看發送紀錄', '#messages', 'secondary')}
    </div>`) +
    '<div id="integration-workspace"><p class="page-loading" role="status">正在載入串接設定…</p></div>';
  const workspace = view.querySelector('#integration-workspace');
  const listPath = 'integrations?webhooks=1';
  let initial, recipients;
  try {
    [initial, { recipients }] = await Promise.all([api(listPath, { signal }), api('recipients', { signal })]);
  } catch (error) {
    if (!signal.aborted) showPageError(workspace, error.message);
    return;
  }
  if (signal.aborted) return;
  const path = 'integrations';
  const recipientOptions = selected => option('', '請選擇收件對象') + recipients.map(recipient =>
    `<option value="${escapeHtml(recipient.id)}"${recipient.id === selected ? ' selected' : ''}>${escapeHtml(recipient.label)}</option>`
  ).join('');
  const fields = (name, recipientId) => `
    <label>觸發事件名稱<input name="name" required maxlength="80" value="${escapeHtml(name)}" placeholder="例如 新增課程報名"></label>
    <label>收件對象<select name="recipientId" required>${recipientOptions(recipientId)}</select></label>`;
  const firstRecipient = recipients.length === 1 ? recipients[0].id : '';
  function webhookSettings(prefix, url) {
    return `
      ${copyField(prefix + '-url', 'Webhook 網址（POST）', url, '複製網址')}
      <p class="muted small">貼到數位平台的 Webhook 欄位並選擇 POST。持有完整網址即可觸發這條通知。</p>`;
  }

  workspace.innerHTML = `
    <section class="panel integration-secret" id="integration-secret" aria-labelledby="integration-secret-title" hidden></section>
    <p class="feedback flash-banner" role="status" id="integration-feedback"></p>
    <div class="workspace-columns">
      <section class="panel" aria-labelledby="integration-list-title">
        <div class="section-heading"><h2 id="integration-list-title" tabindex="-1">已設定的事件</h2>
          <button type="button" class="button button-quiet" id="integration-refresh">重新查詢</button>
        </div>
        <div id="integration-list"></div>
      </section>
      <section class="panel" aria-labelledby="integration-create-title">
        <h2 id="integration-create-title">新增事件串接</h2>
        ${recipients.length ? `<form id="integration-create" class="form-stack">
          ${fields('', firstRecipient)}
          <button type="submit" class="button button-primary">建立 Webhook</button>
        </form>` : platform.botEnabled
          ? emptyState('先配對收件者', '完成 LINE 配對後即可建立 Webhook。', buttonLink('前往配對', '#recipients'))
          : emptyState('先啟用平台的 LINE Bot', '啟用並配對收件者後即可建立 Webhook。', buttonLink('前往 Bot 設定', '#bot'))}
      </section>
    </div>`;

  const list = workspace.querySelector('#integration-list');
  const feedback = workspace.querySelector('#integration-feedback');
  const secret = workspace.querySelector('#integration-secret');
  const testKeys = new Map();
  let items = initial.integrations;
  let busy = false;

  function renderList() {
    if (!items.length) {
      list.innerHTML = emptyState('尚未建立串接', '選好事件名稱與收件者後，就能複製 Webhook 網址。');
      return;
    }
    list.innerHTML = items.map(item => {
      const status = integrationStatus(item);
      const action = (type, label, disabled = false, style = 'quiet') =>
        `<button type="button" class="button button-${style}" data-integration-action="${type}"${disabled ? ' disabled' : ''}>${label}</button>`;
      return `<article class="integration-item" data-integration-id="${escapeHtml(item.id)}">
        <div class="section-heading"><h3 tabindex="-1">${escapeHtml(integrationName(item))}</h3>${chip(...status)}</div>
        ${!item.eventName ? '<p class="muted small">沿用舊名稱，請確認觸發事件。</p>' : ''}
        <div class="integration-meta small">
          <span>收件者 <strong>${escapeHtml(item.recipientLabel)}</strong></span>
        </div>
        <div class="integration-actions">
          ${item.privateWebhookUrl ? `<details class="action-menu integration-webhook">
            <summary>Webhook 設定</summary>
            ${webhookSettings('event-' + item.id, item.privateWebhookUrl)}
          </details>` : ''}
          ${action('test', '發送測試', status[1] !== 'success', 'secondary')}
          <details class="action-menu integration-edit"><summary>管理事件</summary>
            ${recipients.length ? `<form class="form-stack">${fields(integrationName(item), item.recipientId)}
              <button class="button button-secondary" type="submit">儲存串接設定</button>
            </form>` : ''}
            <div class="button-row">
              ${item.enabled ? action('disable', '停用串接') : action('enable', '啟用串接', !item.targetReady || !item.keyTail)}
              ${action('rotate', item.keyTail ? '換發網址' : '產生新網址')}
              ${item.keyTail ? action('revoke', '撤銷 Webhook', false, 'danger-outline') : ''}
            </div>
          </details>
        </div>
      </article>`;
    }).join('');
    bindCopyFields(list);
  }

  function hideSecret() {
    secret.replaceChildren();
    secret.hidden = true;
  }

  function showWebhook({ apiKey, webhookUrl, privateWebhookUrl }) {
    secret.innerHTML = `<div class="section-heading"><h2 id="integration-secret-title" tabindex="-1">Webhook 串接設定</h2>
        <button class="button button-quiet" type="button" data-hide-key>關閉</button></div>
      ${webhookSettings('new-webhook', privateWebhookUrl)}
      <details class="action-menu integration-webhook">
        <summary>標頭驗證（選用）</summary>
        ${copyField('header-webhook-url', '標頭驗證網址（POST）', webhookUrl, '複製網址')}
        ${copyField('integration-key', '串接金鑰（僅顯示一次）', apiKey, '複製金鑰')}
      </details>`;
    secret.querySelector('#integration-key').autocomplete = 'off';
    secret.hidden = false;
    bindCopyFields(secret);
    secret.querySelector('[data-hide-key]').addEventListener('click', () => {
      hideSecret();
      workspace.querySelector('#integration-list-title').focus();
    });
    secret.querySelector('h2').focus();
  }

  async function refreshList() {
    const updated = await api(listPath, { signal });
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
      if (result.privateWebhookUrl) showWebhook(result);
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
      'Webhook 已建立。', () => createForm.reset());
  });
  list.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const id = form.closest('[data-integration-id]').dataset.integrationId;
    change(form.querySelector('button'), `${path}/${id}/edit`, Object.fromEntries(new FormData(form)), '已儲存串接設定。');
  });
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-integration-action]');
    if (!button || busy) return;
    const item = items.find(entry => entry.id === button.closest('[data-integration-id]').dataset.integrationId);
    if (!item) return;
    const action = button.dataset.integrationAction;
    const confirmation = {
      test: ['發送測試通知', `「${item.botName}」將傳送測試通知給「${item.recipientLabel}」。`, '確認發送', 'primary'],
      disable: ['停用事件串接', '等候發送的通知將取消。', '確認停用', 'danger'],
      rotate: [item.keyTail ? '換發網址' : '產生新網址', '換發會讓舊網址與舊金鑰失效。請把新網址貼到數位平台。', '確認換發', 'primary'],
      revoke: ['撤銷 Webhook', '撤銷會讓這個事件的網址與金鑰失效。', '確認撤銷', 'danger']
    };
    if (confirmation[action]) {
      const [title, description, label, style] = confirmation[action];
      if (!await confirmAction(title, description, label, signal, style)) return;
    }
    const success = {
      test: '測試通知已送出處理，請查看發送紀錄並向收件人確認。',
      disable: '串接已停用。', enable: '串接已啟用。',
      rotate: '新網址已產生。', revoke: 'Webhook 已撤銷。'
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
}

async function renderMessages(signal) {
  view.innerHTML = pageHeading('發送與紀錄', '發送文字通知並查看這個平台的傳訊結果。') +
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
    if (!signal.aborted) bindComposer(compose, recipients, signal, loadHistory);
  } catch (error) {
    if (!signal.aborted) showPageError(compose, error.message);
  }
  await historyRequest;
}

function bindComposer(target, recipients, signal, loadHistory) {
  if (!recipients.length) {
    target.innerHTML = currentPlatform.botEnabled
      ? emptyState('先配對收件者', '收件者完成配對後，即可選擇對方發送通知。', buttonLink('前往配對', '#recipients'))
      : emptyState('先啟用平台的 LINE Bot', 'Bot 啟用並配對收件者後即可發送。', buttonLink('前往 Bot 設定', '#bot'));
    return;
  }
  target.innerHTML = `<p class="muted small compose-bot">LINE Bot · ${escapeHtml(currentPlatform.botName)}</p>
  <form id="send-form" class="form-stack">
    <label>收件對象<select name="recipientId" required>${option('', '選擇收件者')}
      ${recipients.map(recipient => option(recipient.id, recipient.label)).join('')}</select></label>
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
  const recipientSelect = form.elements.recipientId;
  const submit = form.querySelector('button');
  let draft;
  let sending = false;

  if (recipients.length === 1) recipientSelect.value = recipients[0].id;
  signal.addEventListener('abort', () => {
    if (dialog.open) dialog.close('cancel');
  }, { once: true });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending || dialog.open) return;
    const recipient = recipients.find(item => item.id === recipientSelect.value);
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
      const response = await api('notification/send', { data: { ...data, requestId: crypto.randomUUID() }, signal });
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
    currentPlatform = undefined;
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
