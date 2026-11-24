const stages = ['輸入配對碼', '確認授權', '驗證發送'];
const deliveryLabels = {
  accepted: 'LINE 已受理，等待收件者確認',
  queued: '接線站已收到，等候發送',
  sending: '正在發送通知',
  failed: '發送失敗，請查看發送紀錄',
  unknown: '結果待確認，請查看發送紀錄',
  cancelled: '這筆通知已取消'
};
const normalize = value => value.replace(/[\s-]/g, '').toUpperCase();

export function mountGuidedConnection({ mount, signal, api, escapeHtml, report, state, platformId, platformName, messagesHref, recipientsHref }) {
  let pairing = null;
  let recipients = state.recipients;
  let recipientId = recipients.length === 1 ? recipients[0].id : '';
  const storageKey = 'source-pairing:' + platformId;
  let code = sessionStorage.getItem(storageKey) || '';
  let busy = false;
  let polling = false;
  let activeStatus = true;

  function steps() {
    const index = pairing?.connection ? 2 : pairing ? 1 : 0;
    return `<ol class="wizard-progress source-progress" aria-label="串接進度">${stages.map((stage, position) =>
      `<li ${position === index ? 'aria-current="step"' : ''} ${position < index ? 'data-completed="true"' : ''}>
        <span aria-hidden="true">${position < index ? '✓' : position + 1}</span>${stage}</li>`).join('')}</ol>`;
  }

  function codeForm() {
    return `<h2 id="guided-title" tabindex="-1">取得原平台的配對碼</h2>
      <p class="muted">在原平台開始接線後，把原平台顯示的配對碼貼到這裡。</p>
      <form class="form-stack" id="guided-code-form">
        <label>配對碼<input name="code" value="${escapeHtml(code)}" autocomplete="off" spellcheck="false"
          autocapitalize="characters" placeholder="例如 A1B2-C3D4-E5F6-7788" maxlength="24" required></label>
        <button class="button button-primary" type="submit">查詢來源</button>
      </form>
      <details class="help-block">
        <summary>第一次接線，請原專案的 AI 準備</summary>
        <p class="muted">把接線指令貼給能修改原專案的 AI，並告訴它要在什麼事件發生後通知。</p>
        <button class="button button-secondary" data-guided-action="copy" type="button">複製給 AI 的接線指令</button>
        <textarea id="guided-instructions" aria-label="給原專案 AI 的接線指令" rows="4" readonly hidden></textarea>
        <p class="small"><a href="/connection-guide" target="_blank" rel="noopener">查看完整接線說明</a></p>
      </details>`;
  }

  function consent() {
    return `<h2 id="guided-title" tabindex="-1">確認來源與收件者</h2>
      <p class="muted">核對來源顯示的配對碼和事件。按允許後，這個來源可以對所選收件者發送 LINE 通知。</p>
      <form class="form-stack" id="guided-consent">
        <label for="guided-recipient">LINE 收件者</label>
        <select id="guided-recipient" required>
          <option value="">選擇已配對的收件者</option>
          ${recipients.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === recipientId ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
        ${recipients.length ? '' : `<p class="muted">先設定 LINE Bot 並完成<a href="${escapeHtml(recipientsHref)}">收件者配對</a>，再回來授權。</p>`}
        <div class="button-row wizard-actions">
          <button class="button button-primary" type="submit" ${recipientId ? '' : 'disabled'}>允許連接</button>
          <button class="button button-quiet" data-guided-action="change" type="button">使用其他配對碼</button>
        </div>
      </form>`;
  }

  function verify() {
    return `<h2 id="guided-title" tabindex="-1">確認發送結果</h2>
      <div class="source-delivery" id="guided-status" role="status"></div>
      <div class="button-row">
        <a class="button button-secondary" href="${escapeHtml(messagesHref)}">查看發送紀錄</a>
        <button class="button button-quiet" data-guided-action="change" type="button">新的一組配對</button>
      </div>`;
  }

  function routeSummary() {
    const selected = pairing.connection?.recipient || recipients.find(item => item.id === recipientId)?.label;
    return `<aside class="panel source-summary" aria-labelledby="guided-summary">
      <h2 id="guided-summary">這次的通知路線</h2>
      <ol class="source-flow">
        <li><span>來源平台</span><strong>${escapeHtml(pairing.name)}</strong></li>
        <li><span>觸發事件</span><strong>${escapeHtml(pairing.event)}</strong></li>
        <li><span>LINE 收件者</span><strong id="guided-summary-recipient">${escapeHtml(selected || '待選擇')}</strong></li>
      </ol>
      <p class="muted small section-gap">配對碼 <code>${escapeHtml(pairing.code.match(/.{4}/g).join('-'))}</code></p>
    </aside>`;
  }

  function showStatus() {
    const target = mount.querySelector('#guided-status');
    if (!target) return;
    const connection = pairing.connection.state;
    const status = pairing.latest?.status;
    const description = connection === 'approved'
      ? '已完成授權。原平台正在領取連接憑證。'
      : connection === 'interrupted'
        ? '連接已停用或金鑰已有更動。請在「事件串接」確認設定。'
        : '來源已連接。請回原平台觸發一筆測試事件，再請收件者確認有收到。';
    const detail = deliveryLabels[status] || '等候原平台觸發事件';
    const markup = `<p class="muted">${description}</p><ul class="section-gap"><li data-complete="${status === 'accepted'}">
      <span>最近一次發送</span><strong>${detail}</strong></li></ul>`;
    if (target.dataset.markup !== markup) {
      target.innerHTML = markup;
      target.dataset.markup = markup;
    }
  }

  function render(focus = false) {
    mount.innerHTML = `${steps()}<p class="feedback flash-banner" id="guided-feedback" role="status"></p>
      <div class="${pairing ? 'source-layout' : 'wizard-panel'}">
        <section class="panel source-step" aria-labelledby="guided-title">
          ${!pairing ? codeForm() : pairing.connection ? verify() : consent()}
        </section>
        ${pairing ? routeSummary() : ''}
      </div>`;
    showStatus();
    if (focus) mount.querySelector('#guided-title')?.focus({ preventScroll: true });
  }

  function feedback(message, tone) {
    report(mount.querySelector('#guided-feedback'), message, tone);
  }

  async function run(path, data) {
    if (busy || signal.aborted) return;
    busy = true;
    const button = mount.querySelector('form [type="submit"]');
    if (button) button.disabled = true;
    feedback('處理中…');
    try {
      const result = await api(path, { data, signal });
      if (signal.aborted) return;
      pairing = result.pairing;
      recipients = result.recipients;
      if (!recipients.some(item => item.id === recipientId)) {
        recipientId = recipients.length === 1 ? recipients[0].id : '';
      }
      activeStatus = true;
      sessionStorage.setItem(storageKey, pairing.code);
      render(true);
    } catch (error) {
      if (!signal.aborted) {
        if (error.status === 404) sessionStorage.removeItem(storageKey);
        feedback(error.message, 'danger');
      }
    } finally {
      busy = false;
      if (button?.isConnected) button.disabled = false;
    }
  }

  mount.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'guided-code-form') {
      code = normalize(new FormData(event.target).get('code'));
      if (!/^[0-9A-F]{16}$/.test(code)) return feedback('請貼上原平台顯示的 16 位配對碼。', 'danger');
      return run('source-setup?code=' + code);
    }
    if (event.target.id === 'guided-consent' && recipientId) {
      return run('source-setup/approve', { code, recipientId });
    }
  });
  mount.addEventListener('change', event => {
    if (event.target.id !== 'guided-recipient') return;
    recipientId = event.target.value;
    mount.querySelector('#guided-consent button[type="submit"]').disabled = !recipientId;
    mount.querySelector('#guided-summary-recipient').textContent = recipients.find(item => item.id === recipientId)?.label || '待選擇';
  });
  mount.addEventListener('click', async event => {
    const action = event.target.closest('[data-guided-action]')?.dataset.guidedAction;
    if (busy) return;
    if (action === 'change') {
      pairing = null;
      code = '';
      sessionStorage.removeItem(storageKey);
      render(true);
    }
    if (action === 'copy') {
      const instructions = `請讀取 ${location.origin}/connection-guide，替目前專案接上「${platformName}」的 LINEBOT 接線站。請先找出我指定的事件在程式中成功完成的位置，再依指南由後端產生配對碼，讓我在接線站確認收件者並授權。來源後端領取並保存串接金鑰，日後只在該事件成功時送通知，重試要沿用同一個事件編號與訊息內容。`;
      try {
        await navigator.clipboard.writeText(instructions);
        if (!signal.aborted) feedback('已複製接線指令。', 'success');
      } catch {
        if (signal.aborted) return;
        const area = mount.querySelector('#guided-instructions');
        area.hidden = false;
        area.value = instructions;
        area.select();
        feedback('請複製畫面上的接線指令。');
      }
    }
  });
  const timer = setInterval(async () => {
    if (!pairing?.connection || !activeStatus || busy || polling || document.hidden) return;
    polling = true;
    const codeToCheck = pairing.code;
    try {
      const next = await api('source-setup?code=' + codeToCheck, { signal });
      if (!signal.aborted && pairing?.code === codeToCheck) {
        pairing = next.pairing;
        showStatus();
      }
    } catch (error) {
      if (!signal.aborted && pairing?.code === codeToCheck && error.status === 404) {
        activeStatus = false;
        sessionStorage.removeItem(storageKey);
        feedback('配對碼已到期。若來源已完成連接，可在「發送紀錄」查看結果。', 'warning');
      }
    } finally {
      polling = false;
    }
  }, 2500);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  render();
  if (/^[0-9A-F]{16}$/.test(code)) run('source-setup?code=' + code);
}
