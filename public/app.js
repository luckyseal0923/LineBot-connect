const pages = {
  bot: { title: 'LINE Bot 設定', description: '連接並驗證您管理的 LINE 官方帳號。', steps: ['填入 Channel access token 與 Channel secret', '設定專屬 Webhook 網址並驗證簽章', '確認憑證與 Webhook 均已驗證'] },
  recipients: { title: '收件對象', description: '管理接收通知的 LINE 個人聊天室。', steps: ['建立一次性配對連結或 QR Code', '在 LINE 聊天室送出配對訊息', '確認收件對象並設定名稱'] },
  integrations: { title: '外部串接', description: '讓您的外部系統安全地傳送通知。', steps: ['建立串接並選擇收件對象', '將專屬 API Key 存放於外部系統的伺服器端', '使用共用 API 網址傳送通知'] },
  messages: { title: '傳訊紀錄', description: '查看通知的處理狀態與經過清理的錯誤資訊。', steps: ['依日期、來源、收件對象與狀態篩選', '查看平台傳訊 ID 與 LINE 回應', '追蹤排隊、受理、失敗或取消的通知'] }
};
const view = document.querySelector('#view');
function render() {
  const key = location.hash.slice(1) || 'overview';
  const current = pages[key];
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === (current ? key : 'overview')));
  document.querySelector('#breadcrumb').textContent = current?.title || '總覽';
  if (current) {
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">WORKSPACE</p><h1>${current.title}</h1><p>${current.description}</p></div><span class="state">尚未開放</span></div><section class="panel detail"><div class="detail-icon">✳</div><h2>功能開發中</h2><p>此頁目前展示預計提供的操作流程，尚未連接後端服務。</p><ol>${current.steps.map(step => `<li>${step}</li>`).join('')}</ol><a class="text-link" href="#overview">返回總覽</a></section>`;
    return;
  }
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">OVERVIEW</p><h1>歡迎來到接線站 <span class="wave">✳</span></h1><p>在這裡，將您的系統與 LINE 通知連接起來。</p></div><span class="state"><i></i> 尚未完成設定</span></div>
  <section class="hero"><div class="hero-copy"><span class="hero-tag">開始使用</span><h2>讓重要訊息，<br>準時送到對的人手上。</h2><p>完成簡單設定，即可透過自己的 LINE 官方帳號，接收來自各個系統的通知。</p><a class="hero-link" href="#bot">查看設定步驟 <span>↗</span></a></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-card art-card-one">▦</div><div class="art-card art-card-two">✓</div><div class="art-center">L<span>•</span></div><div class="art-label">CONNECTED</div></div></section>
  <div class="section-heading"><div><p class="eyebrow">GETTING STARTED</p><h2>三個步驟，開始串接</h2><p>依序完成設定，建立您的第一條通知路徑。</p></div><span class="progress">0 / 3 已完成</span></div>
  <section class="steps" aria-label="開始使用步驟"><a href="#bot" class="step"><div class="step-top"><span class="step-icon">◉</span><span class="step-number">01</span></div><h3>設定 LINE Bot</h3><p>填入頻道憑證並驗證 Webhook，連接您的官方帳號。</p><span class="step-link">查看設定 <b>↗</b></span></a><a href="#recipients" class="step"><div class="step-top"><span class="step-icon">♙</span><span class="step-number">02</span></div><h3>綁定收件對象</h3><p>透過 LINE 聊天室配對，指定通知要送給誰。</p><span class="step-link">查看綁定 <b>↗</b></span></a><a href="#integrations" class="step"><div class="step-top"><span class="step-icon">⌘</span><span class="step-number">03</span></div><h3>建立外部串接</h3><p>取得專用 API Key，將您的系統與通知連接。</p><span class="step-link">查看串接 <b>↗</b></span></a></section>
  <section class="activity panel"><div class="activity-head"><div><p class="eyebrow">RECENT ACTIVITY</p><h2>最近傳訊</h2></div><a class="text-link" href="#messages">查看全部紀錄 <span>↗</span></a></div><div class="empty"><div class="empty-icon">≡</div><strong>還沒有傳訊紀錄</strong><p>完成設定並開始發送後，紀錄將顯示於此。</p></div></section>`;
}
window.addEventListener('hashchange', render); render();
