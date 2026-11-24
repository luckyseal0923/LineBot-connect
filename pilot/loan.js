const feedback = document.querySelector('#loan-feedback');
const approve = document.querySelector('#loan-approve');
const newLoan = document.querySelector('#loan-new');
const back = document.querySelector('#hub-link');
const requestStatus = document.querySelector('#loan-state');
const inbox = document.querySelector('#loan-inbox');
const number = document.querySelector('#loan-number');

let current;
let pending = false;
let refreshing = false;
let changeVersion = 0;

function render(loan) {
  current = loan;
  number.textContent = loan.number;
  requestStatus.textContent = loan.approved ? '已核准' : '待核准';
  requestStatus.className = 'chip ' + (loan.approved ? 'chip-success' : 'chip-warning');
  back.href = loan.hubHref;
  back.hidden = false;
  approve.textContent = loan.approved ? '重試送出通知' : '核准借用';
  approve.hidden = Boolean(loan.status);
  approve.disabled = pending || !loan.connected;
  newLoan.disabled = pending;

  const title = document.createElement('strong');
  const message = document.createElement('p');
  if (loan.status === 'accepted' && loan.message) {
    title.textContent = '已收到測試通知';
    message.className = 'loan-message';
    message.textContent = loan.message;
  } else if (['failed', 'cancelled', 'unknown'].includes(loan.status)) {
    title.textContent = '請查看接線站的發送紀錄';
    message.textContent = '接線站已收到事件，發送結果需要確認。';
  } else if (loan.status) {
    title.textContent = '接線站已收到事件';
    message.textContent = '正在等待模擬 LINE 受理。';
  } else {
    title.textContent = loan.connected ? '等待核准借用' : '等待 Webhook 設定';
    message.textContent = loan.connected ? '核准後，這裡會顯示測試通知。' : '請設定借用核准的 Webhook。';
  }
  if (inbox.textContent !== title.textContent + message.textContent) {
    inbox.replaceChildren(title, message);
  }
}

async function getLoan() {
  if (pending || refreshing) return;
  refreshing = true;
  const version = changeVersion;
  try {
    const response = await fetch('/api/loan');
    if (!response.ok) throw new Error();
    const payload = await response.json();
    if (!pending && version === changeVersion) {
      if (!current) feedback.textContent = '';
      render(payload);
    }
  } catch {
    if (!current) feedback.textContent = '暫時無法載入借用單，請重新整理頁面。';
  } finally {
    refreshing = false;
  }
}

async function update(path) {
  if (!current || pending) return;
  pending = true;
  changeVersion++;
  approve.disabled = true;
  newLoan.disabled = true;
  feedback.textContent = '';
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: current.id })
    });
    const payload = await response.json();
    if (payload.id) current = payload;
    if (!response.ok) throw new Error(payload.error);
  } catch (error) {
    feedback.textContent = error.message || '暫時無法更新借用單。';
    feedback.dataset.tone = 'danger';
  } finally {
    pending = false;
    render(current);
  }
}

approve.addEventListener('click', () => update('/api/approve'));
newLoan.addEventListener('click', () => update('/api/new-loan'));
getLoan();
setInterval(getLoan, 1200);
