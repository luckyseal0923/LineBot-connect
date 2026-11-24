const steps = ['選擇來源', '確認連接', '測試通知'];

function stageFor(connection) {
  if (connection?.state === 'connected') return 2;
  return connection ? 1 : 0;
}

export function mountSourceWizard({ mount, state, signal, api, escapeHtml, report, messagesHref, overviewHref, recipientsHref, confirmDisconnect }) {
  const { source } = state;
  let stage = stageFor(state.connection);
  let selectedRecipient = state.connection?.recipientId || (state.recipients.length === 1 ? state.recipients[0].id : '');
  let busy = false;
  let refreshing = false;
  let changeVersion = 0;

  function renderProgress() {
    return `<ol class="wizard-progress source-progress" aria-label="串接進度">${steps.map((label, index) =>
      `<li ${index === stage ? 'aria-current="step"' : ''} ${index < stage ? 'data-completed="true"' : ''}>
        <span aria-hidden="true">${index < stage ? '✓' : index + 1}</span>${label}</li>`
    ).join('')}</ol>`;
  }

  function renderRoute() {
    const recipient = state.connection?.recipient || state.recipients.find(item => item.id === selectedRecipient)?.label;
    const names = [source.name, source.event, recipient || '待選擇收件者'];
    const labels = ['來源平台', '觸發事件', 'LINE 收件者'];
    return `<aside class="panel source-summary" aria-labelledby="source-summary-title">
      <h2 id="source-summary-title">這次的通知路線</h2>
      <ol class="source-flow">${names.map((name, index) =>
        `<li><span>${labels[index]}</span><strong ${index === 2 ? 'data-summary-recipient' : ''}>${escapeHtml(name)}</strong></li>`
      ).join('')}</ol>
    </aside>`;
  }

  function renderSource() {
    return `<h2 id="source-step-heading" tabindex="-1">選擇來源平台</h2>
      <p class="muted">從這個平台發生的事件開始設定。</p>
      <div class="source-provider">
        <span class="brand-mark" aria-hidden="true">借</span>
        <div><strong>${escapeHtml(source.name)}</strong><p class="small">借用核准後發出 LINE 通知</p></div>
        <span class="chip chip-warning">試辦來源</span>
      </div>
      <div class="button-row"><button class="button button-primary" data-source-action="select" type="button">選擇此來源</button></div>`;
  }

  function renderConsent() {
    const connection = state.connection;
    if (connection?.state === 'interrupted') {
      return `<h2 id="source-step-heading" tabindex="-1">此連接需要重新設定</h2>
        <p class="muted">請確認 LINE Bot 和收件者目前可用，再斷開並重新連接。</p>
        <div class="button-row"><button class="button button-danger-outline" data-source-action="disconnect" type="button">斷開連接</button></div>`;
    }
    const pending = connection?.state === 'pending';
    const options = state.recipients.map(item =>
      `<option value="${escapeHtml(item.id)}"${item.id === selectedRecipient ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
    return `<h2 id="source-step-heading" tabindex="-1">確認事件與收件者</h2>
      <p class="muted">允許教具借用平台在「${escapeHtml(source.event)}」時，透過接線站通知下方選定的人。</p>
      ${pending ? '<p class="flash-banner" data-tone="warning">授權已建立，正在等來源平台確認。可以重試這次連接。</p>' : ''}
      <form class="form-stack" id="source-consent">
        <label for="source-recipient">LINE 收件者</label>
        <select id="source-recipient" required ${pending ? 'disabled' : ''}>
          <option value="">選擇已配對的收件者</option>${options}
        </select>
        ${state.recipients.length ? '' : `<p class="muted">請先在<a href="${escapeHtml(recipientsHref)}">收件對象</a>完成配對。</p>`}
        <div class="button-row wizard-actions">
          <button class="button button-primary" type="submit" ${selectedRecipient ? '' : 'disabled'}>${pending ? '重試連接' : '允許連接'}</button>
          ${pending
            ? '<button class="button button-quiet" data-source-action="disconnect" type="button">斷開連接</button>'
            : '<button class="button button-quiet" data-source-action="back" type="button">上一步</button>'}
        </div>
      </form>`;
  }

  function renderTest() {
    return `<div class="section-heading"><h2 id="source-step-heading" tabindex="-1">用一筆測試借用單確認</h2>
        <span class="chip chip-success" id="source-test-badge">已完成授權</span></div>
      <p class="muted" id="source-test-instructions">到教具借用平台核准測試單後，可在這裡查看接線進度。</p>
      <div id="source-delivery" class="source-delivery" role="status"></div>
      <div class="button-row">
        <a class="button button-primary" id="source-finish" href="${escapeHtml(overviewHref)}" hidden>完成，回平台總覽</a>
        <a class="button button-primary" id="source-test-link" href="${escapeHtml(source.href)}">前往原平台核准測試單</a>
        <a class="button button-secondary" href="${escapeHtml(messagesHref)}">查看發送紀錄</a>
      </div>
      <div class="source-management">
        <button class="button button-quiet" data-source-action="disconnect" type="button">斷開連接</button>
      </div>`;
  }

  function displayReceipt() {
    const target = mount.querySelector('#source-delivery');
    if (!target) return;
    const status = state.latest?.status || '';
    if (target.dataset.status === status) return;
    target.dataset.status = status;
    const accepted = status === 'accepted';
    const interrupted = ['failed', 'cancelled', 'unknown'].includes(status);
    mount.querySelector('#source-test-badge').textContent = accepted ? '測試成功' : '已完成授權';
    mount.querySelector('#source-test-instructions').textContent = accepted
      ? '測試借用單已觸發通知，可以回平台總覽查看這條路線。'
      : '到教具借用平台核准測試單後，可在這裡查看接線進度。';
    mount.querySelector('#source-finish').hidden = !accepted;
    const testLink = mount.querySelector('#source-test-link');
    testLink.textContent = accepted ? '回原平台查看測試單' : '前往原平台核准測試單';
    testLink.classList.toggle('button-primary', !accepted);
    testLink.classList.toggle('button-secondary', accepted);
    const parts = [
      ['原平台送出事件', status ? '已觸發' : '等候核准測試單', Boolean(status)],
      ['接線站收到通知', status ? '已收到' : '等候事件', Boolean(status)],
      ['LINE 受理', accepted ? '已受理（模擬）' : interrupted ? '請查看發送紀錄' : '等候發送', accepted]
    ];
    target.innerHTML = `<ul>${parts.map(([label, detail, done]) =>
      `<li data-complete="${done}"><span>${label}</span><strong>${detail}</strong></li>`).join('')}</ul>`;
  }

  function render(focus = false) {
    mount.innerHTML = `${renderProgress()}<p class="feedback flash-banner" id="source-feedback" role="status"></p>
      <div class="source-layout">
        <section class="panel source-step" aria-labelledby="source-step-heading">
          ${stage === 0 ? renderSource() : stage === 1 ? renderConsent() : renderTest()}
        </section>
        ${renderRoute()}
      </div>`;
    displayReceipt();
    if (focus) mount.querySelector('#source-step-heading')?.focus({ preventScroll: true });
  }

  function updateState(next) {
    state = next;
    selectedRecipient = next.connection?.recipientId || selectedRecipient;
    const nextStage = stageFor(next.connection);
    if (nextStage !== stage || stage !== 2) {
      stage = nextStage;
      render(true);
    } else {
      displayReceipt();
    }
  }

  async function save(path, data) {
    if (busy || signal.aborted) return;
    busy = true;
    changeVersion++;
    const button = mount.querySelector(path.endsWith('/disconnect') ? '[data-source-action="disconnect"]' : '[type="submit"]');
    if (button) button.disabled = true;
    report(mount.querySelector('#source-feedback'), '正在處理…');
    try {
      const next = await api(path, { data, signal });
      if (!signal.aborted) updateState(next);
    } catch (error) {
      if (signal.aborted) return;
      try { updateState(await api('source-setup', { signal })); }
      catch { /* Keep the current step available to retry. */ }
      if (!signal.aborted) report(mount.querySelector('#source-feedback'), error.message, 'danger');
    } finally {
      busy = false;
      if (button?.isConnected) button.disabled = false;
    }
  }

  mount.addEventListener('change', event => {
    if (event.target.id !== 'source-recipient') return;
    selectedRecipient = event.target.value;
    mount.querySelector('[type="submit"]').disabled = !selectedRecipient;
    const recipient = state.recipients.find(item => item.id === selectedRecipient);
    mount.querySelector('[data-summary-recipient]').textContent = recipient?.label || '待選擇收件者';
  });
  mount.addEventListener('submit', event => {
    if (event.target.id !== 'source-consent') return;
    event.preventDefault();
    if (selectedRecipient) save('source-setup', { recipientId: selectedRecipient });
  });
  mount.addEventListener('click', async event => {
    const action = event.target.closest('[data-source-action]')?.dataset.sourceAction;
    if (busy) return;
    if (action === 'select' || action === 'back') {
      stage = action === 'select' ? 1 : 0;
      render(true);
    }
    if (action === 'disconnect' && await confirmDisconnect()) save('source-setup/disconnect', {});
  });
  const refreshTimer = setInterval(async () => {
    if (stage !== 2 || busy || refreshing) return;
    refreshing = true;
    const version = changeVersion;
    try {
      const next = await api('source-setup', { signal });
      if (!signal.aborted && !busy && version === changeVersion) updateState(next);
    } catch { /* A later refresh can recover. */ }
    finally { refreshing = false; }
  }, 1500);
  signal.addEventListener('abort', () => clearInterval(refreshTimer), { once: true });
  render();
}
