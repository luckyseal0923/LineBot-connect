const nav = document.querySelector('.equipment-sidebar nav');
const form = document.querySelector('#borrowing-form');
const submit = document.querySelector('#submit-request');
const feedback = document.querySelector('#equipment-feedback');
const list = document.querySelector('#borrow-requests');
const inbox = document.querySelector('#borrow-inbox');
const timestamp = new Intl.DateTimeFormat('zh-Hant-TW', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei'
});
const noticeLabels = {
  accepted: ['LINE 已受理（模擬）', 'success'],
  queued: ['接線站已收到，等待發送', 'neutral'],
  sending: ['接線站正在發送', 'neutral'],
  enqueuing: ['正將通知送往接線站', 'neutral'],
  unconnected: ['核准時尚未連接接線站', 'warning'],
  disconnected: ['連接已斷開，請查看發送紀錄', 'warning'],
  retry: ['通知待重試', 'warning'],
  cancelled: ['通知已取消', 'warning'],
  failed: ['通知發送失敗', 'danger'],
  unknown: ['請查看接線站的發送紀錄', 'warning']
};

let data;
let busy = false;
let fetching = false;
let version = 0;

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
}

function selectPage() {
  const reviewing = location.hash === '#review';
  document.querySelector('#request-page').hidden = reviewing;
  document.querySelector('#review-page').hidden = !reviewing;
  for (const link of nav.querySelectorAll('a')) {
    if ((link.dataset.page === 'review') === reviewing) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function render(next) {
  if (!data) {
    document.querySelector('#equipment-list').innerHTML = next.equipment.map(item => `
      <label>
        <input type="radio" name="itemId" value="${escapeHtml(item.id)}" required>
        <span><span class="muted small">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.name)}</strong><span class="muted small">${escapeHtml(item.location)}</span></span>
      </label>`).join('');
    document.querySelector('#station-link').href = next.hubHref;
    document.querySelector('#station-link').hidden = false;
  }
  data = next;
  submit.disabled = busy;
  const connection = document.querySelector('#connection-state');
  connection.textContent = next.connected ? '已連接接線站' : '尚未連接接線站';
  connection.className = 'chip ' + (next.connected ? 'chip-success' : 'chip-warning');
  const pending = next.loans.filter(loan => !loan.approvedAt).length;
  document.querySelector('#review-count').textContent = pending ? String(pending) : '';
  document.querySelector('#loan-count').textContent = `待審 ${pending} 筆，共 ${next.loans.length} 筆`;
  const rows = next.loans.length ? next.loans.map(loan => {
    const notice = noticeLabels[loan.notice];
    const action = !loan.approvedAt ? ['approve', '核准借用'] : loan.canRetry ? ['retry', '重試送出通知'] : null;
    return `<article class="borrow-card">
      <div class="section-heading">
        <div><p class="muted small">${escapeHtml(loan.number)}</p><h3>${escapeHtml(loan.item.name)}</h3></div>
        <span class="chip ${loan.approvedAt ? 'chip-success' : 'chip-warning'}">${loan.approvedAt ? '已核准' : '待核准'}</span>
      </div>
      <p class="muted small">${escapeHtml(loan.unit)} · ${escapeHtml(timestamp.format(new Date(loan.createdAt)))}</p>
      ${loan.purpose ? `<p class="borrow-note">${escapeHtml(loan.purpose)}</p>` : ''}
      ${notice || action ? `<div class="button-row">
        ${notice ? `<span class="chip chip-${notice[1]}">${notice[0]}</span>` : ''}
        ${action ? `<button class="button button-primary" type="button"
          data-action="${action[0]}" data-loan="${escapeHtml(loan.id)}"
          aria-label="${action[1]} ${escapeHtml(loan.number)}"${busy ? ' disabled' : ''}>${action[1]}</button>` : ''}
      </div>` : ''}
    </article>`;
  }).join('') : '<p class="empty-state equipment-empty">新增一筆借用申請後，會在這裡出現。</p>';
  // Polling changes the list only when results change so keyboard focus stays on existing actions.
  if (list.dataset.previous !== rows) {
    list.innerHTML = rows;
    list.dataset.previous = rows;
  }
  for (const button of list.querySelectorAll('button')) button.disabled = busy;
  const receipts = next.loans.filter(loan => loan.message);
  const messages = receipts.length ? `<ul class="receipt-list">${receipts.map(loan =>
    `<li class="receipt-item"><strong>${escapeHtml(loan.number)} 已收到</strong><p>${escapeHtml(loan.message)}</p></li>`
  ).join('')}</ul>` : `<p class="empty-state equipment-empty">${next.connected
    ? '核准一筆借用單後，通知會顯示在這裡。' : '先設定借用核准的 Webhook，再核准一筆借用單。'}</p>`;
  if (inbox.dataset.previous !== messages) {
    inbox.innerHTML = messages;
    inbox.dataset.previous = messages;
  }
}

function report(message, tone = '') {
  feedback.textContent = message;
  feedback.dataset.tone = tone;
}

async function workspace(path = '/api/borrow', body) {
  const options = body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : {};
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '目前無法更新借用單。');
  return result;
}

async function refresh() {
  if (busy || fetching) return;
  fetching = true;
  const requestVersion = version;
  try {
    const next = await workspace();
    if (!busy && version === requestVersion) {
      if (!data) report('');
      render(next);
    }
  } catch {
    if (!data) report('無法載入測試平台。請重新整理頁面。', 'danger');
  } finally {
    fetching = false;
  }
}

async function mutate(path, body, after) {
  if (busy || !data) return;
  busy = true;
  version++;
  submit.disabled = true;
  for (const button of list.querySelectorAll('button')) button.disabled = true;
  report('正在處理…');
  try {
    const next = await workspace(path, body);
    busy = false;
    render(next);
    after(next);
  } catch (error) {
    report(error.message, 'danger');
    busy = false;
    submit.disabled = false;
    for (const button of list.querySelectorAll('button')) button.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  mutate('/api/borrow', Object.fromEntries(new FormData(form)), next => {
    form.reset();
    report(`已送出借用單 ${next.created}，請在下方核准。`, 'success');
    location.hash = '#review';
  });
});
list.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  mutate('/api/borrow/' + button.dataset.action, { id: button.dataset.loan }, next => {
    const loan = next.loans.find(item => item.id === button.dataset.loan);
    if (loan?.notice === 'unconnected') report('借用單已核准。核准當下尚未連接接線站。', 'warning');
    else if (loan?.canRetry) report('借用單已核准，可重試這筆通知。', 'warning');
    else report('已核准借用單，請查看通知狀態。', 'success');
  });
});
window.addEventListener('hashchange', selectPage);
selectPage();
refresh();
setInterval(refresh, 1200);
