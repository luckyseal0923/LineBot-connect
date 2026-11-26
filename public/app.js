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

async function api(path, { data, signal } = {}) {
  const scoped = /^(bots|bot(?:\/.*)?|recipients|recipient\/.*|notifications|notification\/.*|integrations(?:\/.*)?|platforms\/line-setup)(?:\?|$)/.test(path);
  if (currentPlatform && scoped) path += (path.includes('?') ? '&' : '?') + 'platform=' + encodeURIComponent(currentPlatform.id);
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
    try {
      const { googleLogin } = await api('status', { signal });
      if (signal.aborted) return;
      if (googleLogin && page !== 'account') page = replacePage('account');
      setLayout('guest', page);
      if (googleLogin) {
        guestLink.hidden = true;
        renderGoogleEntry(params.get('google'));
      } else {
        renderEntry(page);
      }
    } catch (error) {
      if (!signal.aborted) showPageError(view, '暫時無法取得登入設定，請稍後再試。');
    }
  } else if (!user.profileComplete) {
    if (page !== 'account') page = replacePage('account');
    setLayout('pending', page, user);
    renderDeveloperProfile(signal);
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

function renderGoogleEntry(notice) {
  const messages = {
    cancelled: '已取消 Google 登入。你可以再試一次。',
    expired: '登入已逾時，請重新按「使用 Google 登入」。',
    busy: '登入操作過於頻繁，請稍候再試。',
    unavailable: '暫時無法完成 Google 登入，請稍後再試。',
    identity: '請確認 Google 帳號的信箱已完成驗證。',
    disabled: '這個帳號已停用，請聯絡管理員。'
  };
  view.innerHTML = `<div class="entry-layout">
    <div class="entry-intro">${entryIntro()}</div>
    <section class="panel entry-card" aria-labelledby="entry-title">
      <h1 id="entry-title" tabindex="-1">登入接線站</h1>
      <p class="muted">登入後請先填寫開發者資料。經 Google 驗證的萬芳醫院 @w.tmu.edu.tw 帳號完成資料後可啟用，其他帳號由管理員核准。</p>
      <a class="button button-primary button-full spaced" href="/auth/google/start">使用 Google 登入</a>
      ${Object.hasOwn(messages, notice) ? `<p class="feedback spaced" role="status">${messages[notice]}</p>` : ''}
    </section>
  </div>`;
}

function entryIntro() {
  return `<div class="entry-line-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M24 6C12.95 6 4 13.8 4 23.4c0 8.6 7.1 15.8 16.7 17.2.7.1 1.1.6 1 1.3l-.4 2.8c0 .5.5.8.9.5C32.9 39.9 44 32.3 44 23.4 44 13.8 35.05 6 24 6Z" fill="white"/><text x="24" y="27" text-anchor="middle" fill="#06c755" font-family="Arial,sans-serif" font-size="12" font-weight="bold">LINE</text></svg></div>
      <h2>讓你的網站，<br>透過 LINE 發送通知</h2>
      <p>將網站連接到接線站，當報名、申請等事件發生時，就能通知相關人員。</p>
      <div class="entry-flow" aria-label="你的網站透過 LINE 接線站通知收件者的 LINE">
        <span>你的網站</span><span aria-hidden="true">→</span><span>LINE 接線站</span><span aria-hidden="true">→</span><span>收件者的 LINE</span>
      </div>
      <details class="entry-bot-help">
        <summary>什麼是 LINE Bot？</summary>
        <p>LINE Bot 讓你的 LINE 官方帳號能自動收發訊息。設定完成後，你的網站就能透過它發送通知。</p>
      </details>
      <details class="entry-bot-help entry-pricing">
        <summary>LINE 訊息通知收費標準</summary>
        <div class="entry-pricing-content">
          <p class="entry-pricing-notice">本接線站為免費服務，不收取使用費。<br>相關訊息費用由 LINE 官方依您選擇的方案收取。</p>
          <p>透過接線站發送的通知，會使用您自己的 LINE 官方帳號。您可依需要選擇方案：</p>
          <div class="entry-pricing-table-wrap"><table class="entry-pricing-table">
            <caption>LINE 官方帳號方案（新臺幣未稅）</caption>
            <thead><tr><th scope="col">方案</th><th scope="col">每月費用</th><th scope="col">每月包含訊息量</th><th scope="col">超過後</th></tr></thead>
            <tbody>
              <tr><th scope="row">輕用量</th><td>0 元</td><td>200 則</td><td>不可加購，可升級方案</td></tr>
              <tr><th scope="row">中用量</th><td>1,000 元</td><td>3,000 則</td><td>不可加購，可升級方案</td></tr>
              <tr><th scope="row">高用量</th><td>1,400 元</td><td>6,000 則</td><td>可加購訊息，第 1～50,000 則每則 0.2 元，第 50,001 則起每則 0.15 元</td></tr>
            </tbody>
          </table></div>
          <p><strong>訊息怎麼計算？</strong><br>例如，一次通知 5 位收件者，約計入 5 則訊息。使用同一 LINE 官方帳號從其他管道發送的計費訊息，也會共用該帳號的訊息額度。</p>
          <p><strong>請留意：若訊息額度用完，且未升級方案或未設定足夠的加購額度，接線站可能無法發送通知。</strong>建議定期至 LINE 官方帳號管理後台查看用量；使用高用量方案時，也可設定加購訊息上限，避免費用超出預期。</p>
          <p><a href="https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/" target="_blank" rel="noopener noreferrer">查看 LINE 官方最新收費說明</a></p>
        </div>
      </details>`;
}

function renderEntry(page) {
  const signingUp = page === 'register';
  const heading = signingUp ? '申請接線站帳號' : '登入接線站';
  view.innerHTML = `<div class="entry-layout">
    <div class="entry-intro">
      ${signingUp ? entryIntro() : `<h2>讓數位平台的事件<br>變成 LINE 通知</h2>
      <p>每個平台綁定自己的 LINE Bot，分開管理事件、收件者與發送紀錄。</p>
      <div class="entry-flow" aria-label="數位平台透過事件串接通知 LINE 收件者">
        <span>數位平台</span><span aria-hidden="true">→</span><span>事件串接</span><span aria-hidden="true">→</span><span>LINE 收件者</span>
      </div>`}
    </div>
    <section class="panel entry-card" aria-labelledby="entry-title">
      <h1 id="entry-title" tabindex="-1">${heading}</h1>
      <p class="muted">${signingUp ? '帳號核准後，就能自行新增網站接線。' : '登入後可管理網站的 LINE 通知。'}</p>
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

function renderDeveloperProfile(signal) {
  view.innerHTML = `<section class="panel profile-panel">
    <h1 tabindex="-1">填寫開發者資料</h1>
    <p class="muted">請完成以下資料，供接線站帳號管理及必要聯繫使用。資料由接線站管理員查閱。</p>
    <form id="developer-profile" class="form-stack spaced">
      <label>姓名<input name="fullName" autocomplete="name" maxlength="100" required></label>
      <label>電話<input name="phone" type="tel" autocomplete="tel" maxlength="50" required></label>
      <label>服務醫院<input name="hospital" maxlength="150" required></label>
      <label>職稱<input name="jobTitle" autocomplete="organization-title" maxlength="100" required></label>
      <label>單位<input name="department" maxlength="150" required></label>
      <button class="button button-primary" type="submit">儲存並繼續</button>
      <p class="feedback" role="status"></p>
    </form>
  </section>`;
  const form=view.querySelector('#developer-profile');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=form.querySelector('button'); button.disabled=true;
    try {
      await api('developer-profile',{data:Object.fromEntries(new FormData(form)),signal});
      if (!signal.aborted) await render({openPlatformsIfApproved:true});
    } catch(error) { if(!signal.aborted) report(form.querySelector('.feedback'),error.message,'danger'); }
    finally { button.disabled=false; }
  });
}

function renderPending(user) {
  view.innerHTML = `<section class="panel centered-status">
    ${chip('等待審核', 'warning')}
    <h1 tabindex="-1">帳號申請審核中</h1>
    <p>${escapeHtml(user.displayName)}（${escapeHtml(user.username)}），帳號核准後即可新增網站接線並設定通知。</p>
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

function notifiableCount(item) {
  // Older server instances may still return the previous response during deployment.
  return item.notifiableCount ?? (item.enabled && item.keyTail && item.targetReady
    ? item.recipients.filter(person => person.active).length : 0);
}

function integrationStatus(item, count = notifiableCount(item)) {
  if (!item.keyTail) return ['Webhook 已撤銷', 'neutral'];
  if (!item.enabled) return ['已停用', 'neutral'];
  if (!item.recipients.length) return ['收件者待設定', 'warning'];
  if (!count) return ['收件者或 Bot 無法使用', 'warning'];
  return count < item.recipients.length ? ['部分可通知', 'warning'] : ['啟用中', 'success'];
}

function webhookCode(item) {
  return 'WH-' + String(item.webhookNumber).padStart(3, '0');
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
        <p class="muted small">點選事件或 Webhook 代號，即可查看這條路線的收件者。</p></div>${buttonLink('管理串接', '#integrations', 'secondary')}</div>
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
  const liveCount = integrations?.filter(item => notifiableCount(item) > 0).length;
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
  else if (recipients && !recipients.length) nextAction = ['邀請第一位收件者', '到收件對象頁面分享邀請 QR Code。', '#recipients'];
  else if (recipients && integrations && !integrations.length) nextAction = ['建立第一組事件串接', '先建立事件取得 Webhook 網址，再指定收件者。', '#integrations'];
  if (nextAction) {
    const [label, description, destination] = nextAction;
    next.innerHTML = `<section class="next-card" aria-labelledby="next-heading">
      <div><h2 id="next-heading">${label}</h2><p>${description}</p></div>${buttonLink(label, destination)}
    </section>`;
  }

  const map = view.querySelector('#overview-map');
  renderRouteMap(map, integrations, recipients, platform, signal);

  const history = view.querySelector('#overview-history');
  if (historyResult.status === 'fulfilled') renderHistory(history, historyResult.value.notifications, 4);
  else history.innerHTML = '<p class="feedback" data-tone="danger">暫時無法載入紀錄。</p>';
}

function renderRouteMap(target, integrations, recipients, platform, signal) {
  const people = new Map((recipients || []).map(person => [
    person.id, {label:person.label, paired:true, assigned:false}
  ]));
  const routes = (integrations || []).map(item => {
    for (const person of item.recipients) {
      people.set(person.id, {label:person.label,paired:person.active,assigned:true});
    }
    const count = notifiableCount(item);
    const [label, tone] = integrationStatus(item, count);
    return { item, label, tone, count, ready: count > 0 };
  });
  const pending = (label, hash) => `<a class="route-node route-pending" href="${escapeHtml(workspaceLink(hash))}">${label}</a>`;
  const unavailable = label => `<div class="route-node">${label}暫時無法載入</div>`;
  target.innerHTML = `<div class="route-graph">
    <div class="route-canvas" role="group" aria-label="${escapeHtml(platformName(platform))}的通知路線">
      <svg class="route-lines" aria-hidden="true"></svg>
      <div class="route-stages-grid">
      <div class="route-column route-stages">
        <h3><small>外部平台 · 觸發事件</small>${escapeHtml(platformName(platform))}</h3>
        ${!integrations ? unavailable('事件') : !routes.length ? pending('事件串接待設定', '#integrations') : ''}
        ${routes.map(({ item }) => `<button type="button" class="route-node route-source" aria-pressed="false">
          <strong>${escapeHtml(integrationName(item))}</strong>${!item.eventName ? '<small>舊名稱待確認</small>' : ''}
        </button>`).join('')}
      </div>
      <div class="route-column route-stages">
        <h3><small>LINE Bot · Webhook</small>${platform.botId ? escapeHtml(platform.botName || 'LINE Bot') : `<a href="${escapeHtml(workspaceLink('#bot'))}">LINE Bot 待設定</a>`}</h3>
        ${!integrations ? unavailable('Webhook') : !routes.length ? '<div class="route-node route-pending">Webhook 待建立</div>' : ''}
        ${routes.map(({ item, label, tone }) => `<button type="button" class="route-node route-integration" aria-pressed="false">
          <strong>${escapeHtml(webhookCode(item))}</strong>${chip(label, tone)}
        </button>`).join('')}
      </div>
      </div>
      <div class="route-column"><h3><small>通知對象</small>收件者</h3>
        ${[...people.values()].map(person => `<div class="route-node route-person"><strong>${escapeHtml(person.label)}</strong>
          ${!person.paired ? '<small>目前無法接收</small>' : !person.assigned ? '<small>已配對' + (integrations ? ' · 事件待指定' : '') + '</small>' : ''}</div>`).join('')}
        ${!recipients ? unavailable('收件名單') : !people.size ? pending('收件者待設定', '#recipients') : ''}
      </div>
    </div>
    ${routes.some(({ item, count }) => !count || count < item.recipients.length) ? '<p class="route-legend small"><span>可發送</span><span class="unavailable">暫無法發送</span></p>' : ''}
    <p class="route-description" aria-live="polite"></p>
  </div>`;

  const canvas = target.querySelector('.route-canvas');
  canvas.style.setProperty('--stage-rows', String(1 + Math.max(1, routes.length)));
  const svg = canvas.querySelector('.route-lines');
  const sources = [...canvas.querySelectorAll('.route-source')];
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
      line(sources[index], buttons[index], ready, selected === index);
      for (const person of item.recipients) {
        line(buttons[index], personNodes.get(person.id), ready && person.active, selected === index);
      }
    };
    routes.forEach((_, index) => { if (index !== selected) drawRoute(index); });
    if (selected >= 0) drawRoute(selected);
  }

  function selectRoute(index) {
    selected = selected === index ? -1 : index;
    buttons.forEach((item, key) => item.setAttribute('aria-pressed', String(key === selected)));
    const route = routes[selected];
    sources.forEach((node, key) => node.setAttribute('aria-pressed', String(key === selected)));
    for (const [id, node] of personNodes) node.classList.toggle('is-highlighted', Boolean(route?.item.recipients.some(person=>person.id===id)));
    description.textContent = route ? `${integrationName(route.item)} → ${webhookCode(route.item)} → ${route.item.recipientLabel || '收件者待設定'}（可通知 ${route.count}／${route.item.recipients.length} 人）` : '';
    draw();
  }
  for (const nodes of [sources, buttons]) {
    nodes.forEach((node, index) => node.addEventListener('click', () => selectRoute(index)));
  }
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  for (const node of [...sources, ...buttons, ...recipientElements]) observer.observe(node);
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  draw();
}

async function renderPlatforms(signal) {
  view.innerHTML = pageHeading('我的網站與 LINE Bot', '每個網站搭配一個 LINE Bot，點選卡片即可管理通知。',
    '<button class="button button-primary" type="button" id="new-platform">新增網站接線</button>') +
    `<p id="platform-feedback" class="feedback flash-banner" role="status"></p>
    <div id="platform-list"><p class="page-loading" role="status">正在載入平台…</p></div>
    <dialog class="action-dialog" id="platform-dialog" aria-labelledby="platform-dialog-title">
      <h2 id="platform-dialog-title">新增網站接線</h2>
      <p class="muted">輸入網站名稱，建立後即可設定對應的 LINE Bot。</p>
      <form id="platform-create" class="form-stack">
        <label>網站名稱<input name="name" maxlength="80" required placeholder="例如 課程報名網站" autofocus></label>
        <p class="feedback" role="status"></p>
        <div class="dialog-actions">
          <button class="button button-secondary" type="button" data-close>取消</button>
          <button class="button button-primary" type="submit">建立接線</button>
        </div>
      </form>
    </dialog>
    <dialog class="action-dialog" id="platform-rename-dialog" aria-labelledby="platform-rename-title">
      <h2 id="platform-rename-title">重新命名平台</h2>
      <form id="platform-rename" class="form-stack">
        <label>平台名稱<input name="name" required maxlength="80" autofocus></label>
        <p class="feedback" role="status"></p>
        <div class="dialog-actions">
          <button class="button button-secondary" type="button">取消</button>
          <button class="button button-primary" type="submit">儲存名稱</button>
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
  const newPlatform = view.querySelector('#new-platform');
  const renameDialog = view.querySelector('#platform-rename-dialog');
  const renameForm = view.querySelector('#platform-rename');
  const renameButton = renameForm.querySelector('[type="submit"]');
  const renameCancel = renameForm.querySelector('[type="button"]');
  const renameFeedback = renameForm.querySelector('.feedback');
  let platforms = [];
  let renamingId;
  let removing = false;

  function platformCard(platform) {
    const connection = !platform.botId ? 'missing' : platform.botEnabled ? 'ready' : 'off';
    const [label, tone] = connection === 'ready' ? ['Bot 已啟用', 'success']
      : connection === 'missing' ? ['尚未連結 Bot', 'warning'] : ['Bot 已停用', 'neutral'];
    return `<article class="panel platform-card" data-platform-id="${escapeHtml(platform.id)}" data-connection="${connection}">
      <div class="section-heading">
        <h2><a class="platform-card-link" href="${escapeHtml(platformLink('overview', platform))}">${escapeHtml(platformName(platform))}</a></h2>
        ${chip(label, tone)}
        <details class="platform-menu" name="platform-management">
          <summary class="button button-quiet" aria-label="${escapeHtml(platformName(platform))}的平台設定" title="平台設定">⋯</summary>
          <div class="event-menu-list">
            <button class="button button-quiet" type="button" data-platform-action="rename">重新命名</button>
            <button class="button button-danger-outline" type="button" data-platform-action="delete">刪除平台</button>
          </div>
        </details>
      </div>
      <p class="muted small">${platform.botId ? 'LINE Bot · ' + escapeHtml(platform.botName) : '連結 LINE Bot 後即可配對收件者。'}</p>
      ${platform.botId ? '' : `<div class="button-row platform-card-actions">${buttonLink('設定 LINE Bot', platformLink('bot', platform), 'quiet')}</div>`}
    </article>`;
  }

  function drawPlatforms(focusId) {
    list.innerHTML = platforms.length
      ? `<div class="platform-grid">${platforms.map(platformCard).join('')}</div>`
      : emptyState('尚未建立網站接線', '點選「新增網站接線」，為你的網站設定 LINE 通知。');
    if (focusId) {
      const card = [...list.querySelectorAll('.platform-card')].find(card => card.dataset.platformId === focusId);
      card?.querySelector('.platform-card-link').focus();
    }
  }

  newPlatform.addEventListener('click', () => {
    form.reset();
    report(createFeedback, '');
    dialog.showModal();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (createButton.disabled) event.preventDefault(); });
  signal.addEventListener('abort', () => {
    if (dialog.open) dialog.close();
    if (renameDialog.open) renameDialog.close();
  }, { once: true });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (createButton.disabled) return;
    createButton.disabled = close.disabled = true;
    report(createFeedback, '正在建立網站接線…');
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

  renameCancel.addEventListener('click', () => renameDialog.close());
  renameDialog.addEventListener('cancel', event => { if (renameButton.disabled) event.preventDefault(); });
  renameForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (renameButton.disabled) return;
    renameButton.disabled = renameCancel.disabled = true;
    const name = renameForm.elements.name.value.trim();
    try {
      await api('platforms/rename', { data: { id: renamingId, name }, signal });
      if (signal.aborted) return;
      platforms.find(platform => platform.id === renamingId).name = name;
      renameDialog.close();
      drawPlatforms(renamingId);
      report(status, '平台名稱已儲存。', 'success');
    } catch (error) {
      if (!signal.aborted) report(renameFeedback, error.message, 'danger');
    } finally {
      renameButton.disabled = renameCancel.disabled = false;
    }
  });
  bindCardMenuDismissal(list, '.platform-menu', signal);
  list.addEventListener('click', async event => {
    const action = event.target.closest('[data-platform-action]');
    if (!action || removing) return;
    const { platformId } = action.closest('[data-platform-id]').dataset;
    const platform = platforms.find(item => item.id === platformId);
    const menu = action.closest('details');
    menu.open = false;
    menu.querySelector('summary').focus();
    if (action.dataset.platformAction === 'rename') {
      renamingId = platformId;
      renameForm.elements.name.value = platform.name || '';
      report(renameFeedback, '');
      renameDialog.showModal();
      return;
    }

    removing = true;
    try {
      const description = `刪除「${platformName(platform)}」後，平台的 Bot 連線和事件 Webhook 會失效，既有發送紀錄會保留。`;
      if (!await confirmAction('刪除平台', description, '確認刪除', signal)) return;
      report(status, '正在刪除平台…');
      await api('platforms/delete', { data: { id: platformId }, signal });
      if (signal.aborted) return;
      platforms = platforms.filter(item => item.id !== platformId);
      drawPlatforms();
      newPlatform.focus();
      report(status, '已刪除「' + platformName(platform) + '」。', 'success');
    } catch (error) {
      if (!signal.aborted) report(status, error.message, 'danger');
    } finally {
      removing = false;
    }
  });
  try {
    ({ platforms } = await api('platforms', { signal }));
    if (!signal.aborted) drawPlatforms();
  }
  catch (error) { if (!signal.aborted) showPageError(list, error.message); }
}

function bindCardMenuDismissal(list, selector, signal) {
  document.addEventListener('click', event => {
    const menu = list.querySelector(selector + '[open]');
    if (menu && !menu.contains(event.target)) menu.open = false;
  }, { signal });
  list.addEventListener('keydown', event => {
    const menu = event.target.closest(selector + '[open]');
    if (menu && event.key === 'Escape') {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
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
    ${['填寫憑證', '驗證 Webhook'].map((label, index) => {
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
        ${buttonLink('完成設定', '#bot')}
      </div>
    </section>`;
  bindWebhookControls(view.querySelector('#webhook-step'), bot, signal);
}

function lineSetupOptions(choices, selected, placeholder = '') {
  const options = placeholder ? [option('', placeholder)] : [];
  for (const label of choices) {
    options.push(`<option value="${escapeHtml(label)}"${label === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
  }
  if (selected && !choices.includes(selected)) {
    options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（原填寫）</option>`);
  }
  return options.join('');
}

async function renderLineSetup(signal) {
  const endpoint = 'platforms/line-setup';
  view.innerHTML = pageHeading('LINE 開設資料', '先填好這個平台的官方帳號資料，之後可讓 AI 代填 LINE 申請表。',
    buttonLink('返回 Bot 設定', '#bot', 'secondary')) +
    '<section class="panel line-setup-panel" id="line-setup-panel"><p class="page-loading" role="status">正在載入開設資料…</p></section>';
  const panel = view.querySelector('#line-setup-panel');
  let details, catalog;
  try {
    [{ lineSetup: details }, catalog] = await Promise.all([
      api(endpoint, { signal }),
      import('/line-setup-options.js')
    ]);
  } catch (error) {
    if (!signal.aborted) showPageError(panel, error.message);
    return;
  }
  if (signal.aborted) return;
  const { lineSetupRegions, lineSetupIndustries } = catalog;
  const region = details.region || '台灣';
  const profileUrl = new URL(platformLink('bot?setup=profile', currentPlatform), location.href);
  const guideUrl = new URL('/line-bot-setup.md', location.origin);
  const setupPrompt = `請先確認這次對話已啟用 Computer Use（瀏覽器操作），用該工具開啟 ${profileUrl.href}。若無法操作，請先告訴我原因，引導我開啟或授權，等我回覆後再用工具確認。可以操作後，請依照 ${guideUrl.href} 的開設步驟，讀取這個平台已儲存的開設資料。請協助我申請 LINE 官方帳號、啟用 Messaging API、連上這個平台並驗證 Webhook。登入與身分驗證由我操作。請將憑證直接填入接線站，回報驗證結果即可。`;
  panel.innerHTML = `<form id="line-setup-form" class="form-stack">
    <div class="line-setup-fields">
      <label>LINE 機器人名稱
        <input name="accountName" maxlength="80" value="${escapeHtml(details.accountName)}" aria-describedby="line-account-name-help">
        <small class="muted" id="line-account-name-help">好友在 LINE 好友名單和聊天室看到的名稱。</small>
      </label>
      <label>公司或事業者名稱
        <input name="organization" maxlength="120" value="${escapeHtml(details.organization)}">
      </label>
      <label>國家或地區
        <select name="region" required>${lineSetupOptions(lineSetupRegions, region)}</select>
      </label>
      <label>可聯絡的電子郵件
        <input type="email" name="contactEmail" maxlength="254" value="${escapeHtml(details.contactEmail)}" aria-describedby="line-contact-email-help">
        <small class="muted" id="line-contact-email-help">請填你可以收信的信箱。</small>
      </label>
      <label>產業類別
        <select name="industry" aria-describedby="line-industry-help">${lineSetupOptions([...lineSetupIndustries.keys()], details.industry, '請選擇產業類別')}</select>
        <small class="muted" id="line-industry-help">選項依 LINE 台灣開設表單整理。</small>
      </label>
      <label>產業細分類
        <select name="subIndustry"></select>
      </label>
      <label><span>機器人管理單位（Provider）<span class="muted small"> 必填</span></span>
        <input name="providerName" maxlength="100" value="${escapeHtml(details.providerName)}" required aria-describedby="line-provider-help">
        <small class="muted" id="line-provider-help">管理這個機器人的個人或組織。</small>
      </label>
      <label class="line-setup-purpose">使用目的
        <textarea name="purpose" rows="3" maxlength="240">${escapeHtml(details.purpose)}</textarea>
      </label>
    </div>
    <div class="button-row"><button type="submit" class="button button-primary">儲存開設資料</button></div>
    <p class="feedback" role="status"></p>
  </form>
  <section class="ai-setup-handoff" aria-labelledby="ai-handoff-title" ${details.providerName ? '' : 'hidden'}>
    <h2 id="ai-handoff-title">交給 AI 繼續設定</h2>
    <p>把下方指令貼給你的 AI。它會先確認這次對話能操作瀏覽器，需要時會提示你開啟 Computer Use，再協助設定 LINE。</p>
    ${copyField('line-setup-prompt', '給 AI 的指令', setupPrompt, '複製指令')}
  </section>`;
  bindCopyFields(panel);
  const form = panel.querySelector('form');
  const button = form.querySelector('button');
  const feedback = form.querySelector('.feedback');
  const { industry, subIndustry } = form.elements;

  function renderSubIndustries(selected = '') {
    const choices = lineSetupIndustries.get(industry.value) || [];
    const placeholder = industry.value ? '請選擇產業細分類' : '請先選擇產業類別';
    subIndustry.innerHTML = lineSetupOptions(choices, selected, placeholder);
    subIndustry.disabled = !choices.length && !selected;
  }

  renderSubIndustries(details.subIndustry);
  industry.addEventListener('change', () => renderSubIndustries());

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    report(feedback, '正在儲存…');
    try {
      const { lineSetup } = await api(endpoint, { data: Object.fromEntries(new FormData(form)), signal });
      if (signal.aborted) return;
      for (const field of form.querySelectorAll('input, select, textarea')) field.value = lineSetup[field.name] || '';
      panel.querySelector('.ai-setup-handoff').hidden = false;
      report(feedback, '已儲存開設資料。接下來可複製下方指令給 AI。', 'success');
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
    currentPlatform.botId ? buttonLink('LINE 開設資料', '#bot?setup=profile', 'secondary') : '') +
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
    list.innerHTML = `<div class="bot-setup-paths">
      <section class="panel bot-setup-path">
        <h2>手動設置機器人</h2>
        <p>熟悉 LINE 官方帳號、Messaging API 和 Webhook 設定的開發者，可直接從憑證開始。</p>
        <ol><li>自行開設官方帳號並啟用 Messaging API。</li><li>在接線站填入 Channel access token 和 Channel secret。</li><li>將接線站提供的 Webhook 網址填回 LINE 並完成驗證。</li></ol>
        ${buttonLink('開始手動設定', '#bot?setup=1', 'secondary')}
      </section>
      <section class="panel bot-setup-path assisted">
        <h2>AI 協助申請與設定</h2>
        <p>第一次開設 LINE 機器人，可以請支援瀏覽器操作（Computer Use）的 AI 帶你完成。</p>
        <ol><li>先在接線站填寫開設資料。</li><li>將指令貼給 AI，並在 LINE 頁面親自登入。</li><li>AI 依資料協助開辦帳號、連上接線站並驗證 Webhook。</li></ol>
        ${buttonLink('填寫開設資料', '#bot?setup=profile')}
      </section>
    </div>`;
    return;
  }
  const requestedBot = params.get('bot');
  if (bot.enabled && (!requestedBot || requestedBot === bot.id)) {
    if (step === 'webhook') {
      renderWebhookStep(bot, signal);
      return;
    }
    if (step === 'test') {
      goTo(workspaceLink('#recipients'));
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
      <h2 id="bot-actions-title">Bot 管理</h2>
      <p class="muted">管理此平台的 LINE 憑證及啟用狀態。</p>
      <div class="button-row spaced">
        ${buttonLink(bot.enabled ? '更新憑證' : '重新啟用 Bot', '#bot?setup=1', 'secondary')}
        ${bot.enabled ? '<button class="button button-danger-outline" type="button" data-disable-bot>停用 Bot</button>' : ''}
      </div>
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

function showPageError(target, message, retry = () => render()) {
  target.innerHTML = emptyState('暫時無法載入', escapeHtml(message),
    '<button type="button" class="button button-secondary" data-retry>重新查詢</button>');
  target.querySelector('[data-retry]').addEventListener('click', () => retry());
}

async function renderRecipientInvite(panel, signal) {
  let config;
  try { config = await api('recipient/invite',{signal}); }
  catch(error) {
    if (!signal.aborted) showPageError(panel, error.message, () => renderRecipientInvite(panel, signal));
    return;
  }
  if(signal.aborted) return;
  const pageUrl=new URL(platformLink('recipients?setup=login-ai',currentPlatform),location.href);
  const skillUrl=new URL('/line-login-setup.md',location.origin);
  const loginPrompt=`請依照 ${skillUrl.href} 的 LINE Login 開設 Skill，使用 Computer Use 開啟 ${pageUrl.href}。先讀取這個平台已儲存的 AI 開設資料並核對 Bot，再協助設定 LINE Login 與 LIFF、接上本平台的收件者登記頁。登入與身分驗證由我操作。如已有可用邀請 QR Code，請沿用。`;
  function draw() {
    const idBox=panel.closest('#recipients-body').querySelector('#invite-bot-id');
    idBox.innerHTML = config.basicId
      ? copyField('recipient-bot-id','LINE 官方帳號 ID（加入好友用）',config.basicId,'複製 ID')
      : '<p class="muted">目前無法取得 LINE 官方帳號 ID。</p>';
    bindCopyFields(idBox);
    panel.innerHTML = `      ${config.qr ? `<p>請收件者用手機相機掃碼，以 LINE 登入並填寫名字。</p>
      <img class="invite-qr" width="230" height="230" alt="收件者登記 QR Code" src="${escapeHtml(config.qr)}">
      ${copyField('invite-url','收件者登記連結',config.url,'複製登記連結')}` : '<p>先設定 LINE 登入頁，完成後就能分享登記連結或 QR Code。</p>'}
      <details class="help-block"><summary>手動設定 LINE 登入頁</summary>
        <p>熟悉 LINE Developers 的開發者可依下列步驟建立登入頁。</p>
        <ol class="instructions">
          <li>在 <a href="${consoleUrl}" target="_blank" rel="noopener">LINE Developers</a> 選擇此 Bot 所屬的 Provider，建立或開啟 LINE Login 頻道，並在 Basic settings 將 Linked LINE Official Account 設為此 Bot。</li>
          <li>新增 LIFF 網頁，選擇 Full、勾選 profile、啟用加入好友選項，並填入下方的 Endpoint URL。</li>
          <li>將 LINE Login 頻道設為 Published，將 LIFF ID 貼回此處。</li>
        </ol>
        ${copyField('join-endpoint','Endpoint URL',config.endpoint,'複製網址')}
        <form class="form-stack"><label>LIFF ID<input name="liff" value="${escapeHtml(config.liffId)}" required maxlength="80" placeholder="例如 1234567890-AbcdEfgh"></label>
          <button class="button button-secondary">儲存並顯示 QR Code</button><p class="feedback" role="status"></p></form>
      </details>
      <details class="help-block" id="login-assist" ${new URLSearchParams(location.hash.split('?')[1]).get('setup')==='login-ai'?'open':''}>
        <summary>AI 協助設定 LINE 登入頁</summary>
        <p>先確認開設資料，再將指令貼給支援瀏覽器操作的 AI。登入 LINE 時由你接手。</p>
        <form class="form-stack" data-login-profile>
          <div class="line-setup-fields">
          ${[['provider','Bot 所屬管理單位（Provider）',100],['region','服務地區',80],['channel','LINE Login 頻道名稱',20],['app','登入頁名稱（LIFF）',20],['email','聯絡電子郵件',254],['description','收件者登入用途',500]].map(([name,label,max])=>
            `<label>${label}<input name="${name}" type="${name==='email'?'email':'text'}" required maxlength="${max}" value="${escapeHtml(config.loginProfile[name])}"></label>`).join('')}
          </div>
          <button type="submit" class="button button-secondary">儲存 AI 開設資料</button>
          <p class="feedback" role="status"></p>
        </form>
        <div data-login-handoff ${config.profileSaved?'':'hidden'}>
          ${copyField('login-ai-prompt','給 AI 的設定指令',loginPrompt,'複製指令')}
          <a class="text-link" href="/line-login-setup.md" target="_blank" rel="noopener">查看 LINE Login Skill</a>
        </div>
      </details>`;
    bindCopyFields(panel);
    const profileForm=panel.querySelector('[data-login-profile]');
    const handoff=panel.querySelector('[data-login-handoff]');
    profileForm.addEventListener('input',()=>{handoff.hidden=true;});
    profileForm.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=profileForm.querySelector('button');
      if(button.disabled) return;
      button.disabled=true;
      const fields=Object.fromEntries(new FormData(profileForm));
      try {
        const result=await api('recipient/login-profile',{data:fields,signal});
        if(signal.aborted) return;
        config.loginProfile=result.loginProfile;
        config.profileSaved=true;
        const unchanged=Object.entries(fields).every(([name,value])=>profileForm.elements.namedItem(name).value===value);
        handoff.hidden=!unchanged;
        report(profileForm.querySelector('.feedback'),unchanged?'已儲存，可複製指令給 AI。':'已儲存先前內容，請再儲存剛才的修改。','success');
      } catch(error) { if(!signal.aborted) report(profileForm.querySelector('.feedback'),error.message,'danger'); }
      finally {button.disabled=false;}
    });
    const form=panel.querySelector('form');
    form.addEventListener('submit', async event=>{
      event.preventDefault();
      const button=form.querySelector('button');
      if(button.disabled) return;
      button.disabled=true;
      try {
        config=await api('recipient/invite',{data:{liffId:form.elements.liff.value.trim()},signal});
        if(!signal.aborted) draw();
      } catch(error) { if(!signal.aborted) report(form.querySelector('.feedback'),error.message,'danger'); }
      finally { button.disabled=false; }
    });
  }
  draw();
}

const recipientColumns = [
  ['label', '收件者姓名', 80],
  ['employeeNumber', '員編', 40],
  ['jobTitle', '職稱', 80],
  ['unit', '服務單位', 120],
  ['email', '可聯絡的電子郵件', 254]
];

function recipientFields() {
  return recipientColumns.map(([key, title, max]) => `<label>${title}${key === 'label' ? '（必填）' : ''}
    <input name="${key}" maxlength="${max}" type="${key === 'email' ? 'email' : 'text'}" ${key === 'label' ? 'required' : ''}></label>`).join('');
}

const pairingStates = {
  waiting: ['等待送出配對碼', 'neutral', '配對碼有效至'],
  claimed: ['已配對，等待填表', 'warning', '填表期限'],
  completed: ['已加入收件名單', 'success'],
  code_expired: ['配對碼已過期', 'warning'],
  form_expired: ['填表時間已到期', 'warning'],
  cancelled: ['邀請已取消', 'warning'],
  paused: ['Bot 已停用，邀請暫停', 'warning']
};

function trackPairing(preview, invitation, signal, onComplete) {
  const share = preview.querySelector('[data-pair-share]');
  const status = preview.querySelector('#pair-progress');
  const expiryNote = preview.querySelector('#pair-expiry');
  const feedback = preview.querySelector('#pair-check-feedback');
  const button = preview.querySelector('#check-pairing');
  const invitations = preview.closest('#recipient-invitations');
  let state = 'waiting';
  const initialExpiry = Date.parse(invitation.expiresAt);
  let expiry = Number.isFinite(initialExpiry) ? initialExpiry : Date.now() + invitation.expiresMinutes * 60_000;
  let clock, poll;

  function drawStatus() {
    const [label, tone] = pairingStates[state];
    status.innerHTML = `<strong>邀請進度</strong> ${chip(label, tone)}`;
  }

  function updateExpiry() {
    const deadlineLabel = pairingStates[state][2];
    const seconds = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
    share.hidden = state !== 'waiting' || !seconds;
    expiryNote.hidden = !deadlineLabel;
    if (deadlineLabel) {
      const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      expiryNote.textContent = `${deadlineLabel} ${dateTime(expiry)}（${seconds ? '剩 ' + remaining : '已到期'}）`;
    }
  }

  function stopTimers() {
    clearInterval(clock);
    clearInterval(poll);
  }

  async function check() {
    if (button.disabled || signal.aborted) return;
    button.disabled = true;
    try {
      const next = await api('recipient/pair-status?invitation=' + encodeURIComponent(invitation.invitationId), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      });
      if (signal.aborted) return;
      report(feedback, '');
      expiry = Date.parse(next.expiresAt);
      if (state !== next.status) {
        state = next.status;
        drawStatus();
      }
      updateExpiry();
      if (state !== 'paused' && !pairingStates[state][2]) {
        stopTimers();
        button.hidden = true;
        if (state === 'completed') onComplete();
      }
    } catch (error) {
      if (!signal.aborted) {
        report(feedback, error.name === 'TimeoutError' ? '查詢逾時，請稍後再試。' : error.message, 'warning');
        if ([401, 403, 404].includes(error.status)) clearInterval(poll);
      }
    } finally {
      button.disabled = false;
    }
  }

  drawStatus();
  updateExpiry();
  clock = setInterval(updateExpiry, 1000);
  if (invitation.invitationId) {
    button.addEventListener('click', check);
    poll = setInterval(() => {
      if (!document.hidden && !invitations.hidden) check();
    }, 5000);
  } else {
    button.hidden = true;
    report(feedback, '這組邀請無法查詢進度。你仍可重新查詢收件名單。');
  }
  signal.addEventListener('abort', stopTimers, { once: true });
}

async function renderRecipients(signal) {
  const platform = currentPlatform;
  const inviteAction = platform.botEnabled ? '<button class="button button-primary" type="button" id="open-recipient-invite" aria-controls="recipient-invitations" aria-expanded="false" disabled>邀請收件者</button>' : '';
  view.innerHTML = pageHeading('收件對象', '管理這個平台的 LINE 收件者。', inviteAction) +
    '<div id="recipients-body"><p class="page-loading" role="status">正在載入收件對象…</p></div>';
  const body = view.querySelector('#recipients-body');
  if (!platform.botEnabled) {
    body.innerHTML = `<section class="panel">${emptyState('先啟用平台的 LINE Bot',
      'Bot 啟用後，就能設定掃碼邀請收件者。', buttonLink('前往 Bot 設定', '#bot'))}</section>`;
    return;
  }
  let recipients;
  try {
    ({ recipients } = await api('recipients?details=1', { signal }));
  } catch (error) {
    if (!signal.aborted) showPageError(body, error.message);
    return;
  }
  if (signal.aborted) return;
  body.innerHTML = `
    <section class="panel" aria-labelledby="paired-title">
      <div class="section-heading"><h2 id="paired-title">收件名單</h2>
        <button id="refresh-recipients" class="button button-quiet" type="button">重新查詢</button>
      </div>
      <p id="recipient-feedback" class="feedback" role="status"></p>
      <div id="recipients-list"></div>
      <dialog class="action-dialog" id="edit-recipient" aria-labelledby="edit-recipient-title">
        <h2 id="edit-recipient-title">編輯收件資料</h2>
        <form class="form-stack">${recipientFields()}
          <p class="feedback" role="status"></p>
          <div class="dialog-actions"><button class="button button-secondary" type="button">取消</button>
          <button class="button button-primary" type="submit">儲存</button></div>
        </form>
      </dialog>
    </section>
    <section class="section-gap" id="recipient-invitations" aria-labelledby="invite-title" hidden>
      <div class="section-heading">
        <h2 id="invite-title" tabindex="-1">邀請收件者</h2>
        <button class="button button-quiet" type="button" id="close-recipient-invite">收起邀請</button>
      </div>
      <div id="invite-bot-id"></div>
      <div class="bot-setup-paths spaced">
        <section class="panel">
          <h3>邀請一位</h3>
          <p class="muted">請對方加入「${escapeHtml(platform.botName)}」為好友，開啟一對一聊天室並送出一次性配對碼，再點「填寫資料」。</p>
          <form id="pair-form" class="form-stack">
            <button class="button button-primary" type="submit">產生配對 QR Code</button>
            <p id="pair-result" class="feedback" role="status"></p>
          </form>
          <div id="pair-preview" class="detail-block" hidden></div>
        </section>
        <section class="panel">
          <h3>邀請多人自行登記</h3>
          <p class="muted">分享同一個登記入口，讓收件者登入 LINE 並填寫資料。</p>
          <div id="recipient-invite" class="spaced"><p class="muted" role="status">載入邀請設定中…</p></div>
        </section>
      </div>
    </section>`;

  const invitations = body.querySelector('#recipient-invitations');
  const inviteButton = view.querySelector('#open-recipient-invite');
  const closeInvites = body.querySelector('#close-recipient-invite');
  const inviteTitle = body.querySelector('#invite-title');
  let inviteSettingsLoaded = false;
  function setInvitationsOpen(open) {
    invitations.hidden = !open;
    inviteButton.setAttribute('aria-expanded', String(open));
    if (open && !inviteSettingsLoaded) {
      inviteSettingsLoaded = true;
      renderRecipientInvite(body.querySelector('#recipient-invite'), signal);
    }
  }
  inviteButton.disabled = false;
  inviteButton.addEventListener('click', () => {
    setInvitationsOpen(true);
    inviteTitle.focus();
  });
  closeInvites.addEventListener('click', () => {
    setInvitationsOpen(false);
    inviteButton.focus();
  });
  setInvitationsOpen(!recipients.length || route().params.get('setup') === 'login-ai');
  const form = body.querySelector('#pair-form');
  const list = body.querySelector('#recipients-list');
  const refresh = body.querySelector('#refresh-recipients');
  const feedback = body.querySelector('#recipient-feedback');
  const preview = body.querySelector('#pair-preview');
  let pairingController;

  const dialog = body.querySelector('#edit-recipient');
  const editForm = dialog.querySelector('form');
  const editStatus = editForm.querySelector('.feedback');
  const save = editForm.querySelector('[type="submit"]');
  const cancel = editForm.querySelector('[type="button"]');
  let editingId;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (save.disabled) event.preventDefault(); });
  signal.addEventListener('abort', () => { if (dialog.open) dialog.close(); }, {once:true});
  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = cancel.disabled = true;
    try {
      await api('recipient/edit', {data:{recipientId:editingId, ...Object.fromEntries(new FormData(editForm))}, signal});
      if (signal.aborted) return;
      dialog.close();
      await loadList('已儲存收件資料。');
    } catch (error) {
      if (!signal.aborted) report(editStatus, error.message, 'danger');
    } finally {
      save.disabled = cancel.disabled = false;
    }
  });

  function drawList(items) {
    if (!items.length) {
      list.innerHTML = emptyState('尚無收件對象', '收件者填完登記資料後，就會出現在這裡。');
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table class="data-table" aria-label="平台收件名單">
      <thead><tr>${recipientColumns.map(([,title]) => `<th scope="col">${title}</th>`).join('')}<th scope="col">操作</th></tr></thead>
      <tbody>${items.map((recipient, index) => `<tr>
        <th scope="row">${escapeHtml(recipient.label)}</th>
        ${recipientColumns.slice(1).map(([key]) => `<td>${escapeHtml(recipient.details?.[key] || '—')}</td>`).join('')}
        <td><div class="button-row">
          <button class="button button-secondary" type="button" data-edit="${index}">編輯</button>
          <button class="button button-secondary" type="button" data-test="${index}">傳送測試</button>
          <button class="button button-danger-outline" type="button" data-remove="${index}">移除</button>
        </div></td></tr>`).join('')}</tbody>
      </table></div><div class="button-row spaced">${buttonLink('前往發送通知', '#messages', 'secondary')}</div>`;
    for (const button of list.querySelectorAll('[data-edit]')) {
      button.addEventListener('click', () => {
        const recipient = items[Number(button.dataset.edit)];
        editingId = recipient.id;
        for (const [key] of recipientColumns) {
          editForm.elements.namedItem(key).value = key === 'label' ? recipient.label : recipient.details?.[key] || '';
        }
        report(editStatus, '');
        dialog.showModal();
      });
    }
    for (const button of list.querySelectorAll('[data-test]')) {
      const recipient = items[Number(button.dataset.test)];
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          if (!await confirmAction('傳送測試通知', `用「${platform.botName}」傳送測試通知給「${recipient.label}」？`, '傳送', signal, 'primary')) return;
          const {status} = await api('notification/send', {data:{recipientId:recipient.id, message:'這是「'+platformName(platform)+'」的收件測試通知。',requestId:crypto.randomUUID()},signal});
          report(feedback, status==='accepted' ? 'LINE 已受理，請向對方確認是否收到。' : status==='failed' ? 'LINE 發送失敗。' : '結果未確認，請查看發送紀錄。');
        } catch(error) { if(!signal.aborted) report(feedback,error.message,'danger'); }
        finally { button.disabled=false; }
      });
    }
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

  let listRequest = 0;
  async function loadList(message = '已更新收件對象。') {
    const request = ++listRequest;
    refresh.disabled = true;
    report(feedback, '正在更新收件名單…');
    try {
      const data = await api('recipients?details=1', { signal });
      if (signal.aborted || request !== listRequest) return;
      drawList(data.recipients);
      report(feedback, message, 'success');
    } catch (error) {
      if (!signal.aborted && request === listRequest) report(feedback, error.message, 'danger');
    } finally {
      if (request === listRequest) refresh.disabled = false;
    }
  }

  drawList(recipients);
  refresh.addEventListener('click', () => loadList());
  signal.addEventListener('abort', () => pairingController?.abort(), { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button');
    if (submit.disabled) return;
    const resultText = body.querySelector('#pair-result');
    submit.disabled = true;
    report(resultText, '正在產生配對碼…');
    try {
      const result = await api('recipient/pair', { data: { botId: platform.botId, selfRegistration: true }, signal });
      if (signal.aborted || !form.isConnected) return;
      pairingController?.abort();
      pairingController = new AbortController();
      preview.hidden = false;
      preview.innerHTML = `<h3 tabindex="-1">一次性配對邀請</h3>
        <div data-pair-share>
          ${result.chatQr ? `<img class="invite-qr" width="230" height="230" alt="開啟 ${escapeHtml(platform.botName)} 聊天室並帶入配對碼的 QR Code" src="${escapeHtml(result.chatQr)}">
            ${result.chatUrl ? copyField('pair-chat-link', '配對連結', result.chatUrl, '複製配對連結') : ''}
            <p>請收件者掃碼或點開配對連結，在「${escapeHtml(platform.botName)}」聊天室直接按「送出」，再點 Bot 回覆的「填寫資料」。</p>`
            : '<p class="muted small">暫時無法取得聊天室 QR Code，請複製下方配對碼，在 Bot 的一對一聊天室送出。</p>'}
          <p class="muted small">每組限一人配對，也可以手動輸入以下數字。</p>
          ${copyField('pair-code', '6 位數配對碼', result.message, '複製配對碼')}
        </div>
        <p id="pair-progress" class="pair-progress" role="status"></p>
        <p id="pair-expiry" class="expiry-note"></p>
        <p id="pair-check-feedback" class="feedback" role="status"></p>
        <button class="button button-secondary" type="button" id="check-pairing">更新邀請進度</button>`;
      bindCopyFields(preview);
      trackPairing(preview, result, pairingController.signal, () => loadList('邀請已完成，收件名單已更新。'));
      preview.querySelector('h3').focus();
      report(resultText, '配對碼已產生。', 'success');
    } catch (error) {
      if (!signal.aborted) report(resultText, error.message, 'danger');
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderIntegrations(signal) {
  view.innerHTML = `<header class="page-heading">
    <div>
      <div class="button-row">
        <h1>事件串接</h1>
        <button type="button" class="button button-primary" id="new-event" aria-controls="integration-create" aria-expanded="false" disabled>＋ 新增事件</button>
      </div>
      <p>建立事件、指定收件者，再將專屬 Webhook 網址貼到數位平台。</p>
    </div>
  </header>
  <div id="integration-workspace"><p class="page-loading" role="status">正在載入串接設定…</p></div>`;
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
  const nameField = name => `<label>觸發事件名稱<input name="name" required maxlength="80"
    value="${escapeHtml(name)}" placeholder="例如 新增課程報名"></label>`;
  function recipientFields(item) {
    const checked=new Set(item.recipients.map(person=>person.id));
    const options=new Map([...recipients,...item.recipients].map(person=>[person.id,person]));
    return `<fieldset class="event-recipients"><legend>收件對象（可複選）</legend>
      ${[...options.values()].map(person=>`<label><input type="checkbox" name="recipientIds"
        value="${escapeHtml(person.id)}"${checked.has(person.id) ? ' checked' : ''}>
        ${escapeHtml(person.label)}${person.active===false ? '（已停用）' : ''}</label>`).join('') ||
        buttonLink('邀請收件者', '#recipients', 'secondary')}</fieldset>`;
  }
  workspace.innerHTML = `
    <form id="integration-create" class="panel form-stack event-editor" hidden>
      ${nameField('')}
      <div class="button-row"><button class="button button-primary" type="submit">建立事件</button>
        <button class="button button-quiet" type="button" data-cancel>取消</button></div>
    </form>
    <p class="feedback flash-banner" role="status" id="integration-feedback"></p>
    <div class="section-heading"><span class="muted small" id="event-count"></span>
      <button class="button button-quiet" id="integration-refresh">重新查詢</button></div>
    <section id="integration-list" aria-label="已設定的事件"></section>`;

  const list = workspace.querySelector('#integration-list');
  const feedback = workspace.querySelector('#integration-feedback');
  bindCardMenuDismissal(list, '.event-menu', signal);
  const createForm = workspace.querySelector('#integration-create');
  const newEvent = view.querySelector('#new-event');
  function toggleCreate(open) {
    createForm.hidden = !open;
    newEvent.setAttribute('aria-expanded', String(open));
    if (open) createForm.elements.name.focus();
    else newEvent.focus();
  }
  newEvent.disabled = false;
  newEvent.addEventListener('click', () => toggleCreate(createForm.hidden));
  createForm.querySelector('[data-cancel]').addEventListener('click', () => toggleCreate(false));
  const testKeys = new Map();
  let openEventId;
  let items = initial.integrations;
  let busy = false;

  function renderList() {
    workspace.querySelector('#event-count').textContent = `共 ${items.length} 個事件`;
    if (!items.length) {
      list.innerHTML = emptyState('尚未建立事件', '點選頁首的「＋ 新增事件」，輸入事件名稱即可開始。');
      return;
    }
    list.innerHTML = items.map(item => {
      const count = notifiableCount(item);
      const status = integrationStatus(item, count);
      const action = (type, label, disabled = false, style = 'quiet') =>
        `<button type="button" class="button button-${style}" data-integration-action="${type}"${disabled ? ' disabled' : ''}>${label}</button>`;
      const assigned = item.recipients.length > 0;
      const ready = count > 0;
      const copy = item.privateWebhookUrl ? action('copy', '複製 Webhook 網址', false, ready ? 'primary' : 'secondary') : '';
      const recipientButton = `<button type="button" class="button button-${assigned ? 'secondary' : 'primary'}"
        data-integration-action="recipients" aria-controls="people-${item.id}" aria-expanded="${item.id === openEventId}">${assigned ? '編輯' : '設定'}收件者</button>`;
      return `<article class="panel integration-item" data-integration-id="${escapeHtml(item.id)}">
        <div class="section-heading">
          <h2 tabindex="-1">${escapeHtml(integrationName(item))}</h2>
          <div class="button-row">${chip(...status)}
            <details class="event-menu" name="event-management"><summary class="button button-quiet" aria-label="管理事件" title="管理事件">⋯</summary>
              <div class="event-menu-list">
                ${action('rename', '重新命名')}
                ${item.enabled ? action('disable', '停用事件') : action('enable', '啟用事件', !item.targetReady || !item.keyTail)}
                ${action('rotate', item.keyTail ? '換發網址' : '產生新網址')}
                ${item.keyTail ? action('revoke', '撤銷 Webhook') : ''}
                ${action('delete', '刪除事件', false, 'danger-outline')}
              </div>
            </details>
          </div>
        </div>
        ${!item.eventName ? '<p class="muted small">沿用舊名稱，可在管理事件中重新命名。</p>' : ''}
        <div class="event-card-body">
          <dl class="event-meta"><dt>Webhook 代號</dt><dd>${escapeHtml(webhookCode(item))}</dd>
            <dt>收件者</dt><dd><strong>可通知 ${count}／${item.recipients.length} 人</strong>${assigned
              ? ` <span class="muted small">· ${escapeHtml(item.recipientLabel)}</span>` : ''}</dd></dl>
          <div class="button-row">${assigned ? copy + recipientButton : recipientButton + copy}
            ${assigned ? action('test','發送測試', !ready, 'quiet') : ''}</div>
        </div>
        <form id="people-${item.id}" data-editor="recipients" class="form-stack event-editor"${item.id === openEventId ? '' : ' hidden'}>
          ${recipientFields(item)}<button class="button button-primary" type="submit">儲存收件者</button>
        </form>
        <form data-editor="rename" class="form-stack event-editor" hidden>${nameField(integrationName(item))}
          <div class="button-row"><button class="button button-secondary" type="submit">儲存名稱</button>${action('cancelRename', '取消')}</div>
        </form>
      </article>`;
    }).join('');
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
      const result = await api(route + '?webhooks=1', { data, signal });
      if (signal.aborted) return;
      after?.(result);
      report(feedback, success, 'success');
      try { await refreshList(); }
      catch { if (!signal.aborted) { list.replaceChildren(); report(feedback, `${success} 請重新查詢清單。`, 'warning'); } }
    } catch (error) {
      if (!signal.aborted) report(feedback, error.message, 'danger');
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  createForm.addEventListener('submit', event => {
    event.preventDefault();
    change(createForm.querySelector('button'), path, Object.fromEntries(new FormData(createForm)),
      '事件已建立。請勾選收件者並儲存。', result => {
        createForm.reset();
        toggleCreate(false);
        openEventId = result.id;
      });
  });
  list.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const id = form.closest('[data-integration-id]').dataset.integrationId;
    const data = new FormData(form);
    const renaming = form.dataset.editor === 'rename';
    const payload = renaming ? {name: data.get('name')} : {recipientIds: data.getAll('recipientIds')};
    change(form.querySelector('[type="submit"]'), `${path}/${id}/edit`, payload,
      renaming ? '已更新事件名稱。' : '已儲存收件者。', () => { openEventId = null; });
  });
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-integration-action]');
    if (!button || busy) return;
    const card = button.closest('[data-integration-id]');
    const item = items.find(entry => entry.id === card.dataset.integrationId);
    if (!item) return;
    const action = button.dataset.integrationAction;
    const menu = card.querySelector('.event-menu');
    menu.open = false;
    const renameForm = card.querySelector('[data-editor="rename"]');
    if (action === 'rename' || action === 'cancelRename') {
      renameForm.hidden = action === 'cancelRename';
      if (renameForm.hidden) { renameForm.reset(); menu.querySelector('summary').focus(); }
      else { renameForm.elements.name.focus(); renameForm.elements.name.select(); }
      return;
    }
    if (action === 'recipients') {
      const form = card.querySelector('[data-editor="recipients"]');
      form.hidden = !form.hidden;
      button.setAttribute('aria-expanded', String(!form.hidden));
      return;
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(item.privateWebhookUrl);
        button.textContent = '已複製';
        report(feedback, '已複製 Webhook 網址。貼到數位平台後，發送方式選 POST。', 'success');
        setTimeout(() => { button.textContent = '複製 Webhook 網址'; }, 1800);
      } catch {
        let input = card.querySelector('[data-manual-copy]');
        if (!input) {
          input = document.createElement('input');
          input.dataset.manualCopy = '';
          input.readOnly = true;
          input.setAttribute('aria-label', '手動複製 Webhook 網址');
          card.append(input);
        }
        input.value = item.privateWebhookUrl;
        input.focus();
        input.select();
        report(feedback, '已選取 Webhook 網址，請按 Ctrl+C 或使用複製指令。');
      }
      return;
    }
    const activeLabels = item.recipients.filter(person => person.active).map(person => person.label).join('、');
    const confirmation = {
      test: ['發送測試通知', `「${item.botName}」將傳送測試通知給「${activeLabels}」。`, '確認發送', 'primary'],
      disable: ['停用事件串接', '等候發送的通知將取消。', '確認停用', 'danger'],
      rotate: [item.keyTail ? '換發網址' : '產生新網址', '換發後，原有串接將失效。請把新網址貼到數位平台。', '確認換發', 'primary'],
      delete: ['刪除事件', `確定刪除「${integrationName(item)}」（收件者：${item.recipientLabel || '待設定'}）？刪除後無法復原，原有串接也會失效。既有發送紀錄會保留。`, '確認刪除', 'danger'],
      revoke: ['撤銷 Webhook', '撤銷後，數位平台將無法透過原有串接觸發這個事件。', '確認撤銷', 'danger']
    };
    if (confirmation[action]) {
      const [title, description, label, style] = confirmation[action];
      if (!await confirmAction(title, description, label, signal, style)) return;
    }
    const success = {
      test: '測試通知已送出處理，請查看發送紀錄並向收件人確認。',
      disable: '串接已停用。', enable: '串接已啟用。',
      rotate: '新網址已產生。', revoke: 'Webhook 已撤銷。', delete: '已刪除所選事件。'
    };
    if (action === 'test' && !testKeys.has(item.id)) testKeys.set(item.id, 'test-' + crypto.randomUUID());
    const after = () => {
      if (action === 'test' || action === 'delete') testKeys.delete(item.id);
      if (action === 'delete') {
        items = items.filter(entry => entry.id !== item.id);
        renderList();
      }
    };
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
