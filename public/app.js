const pages = {
  bot: { title: 'LINE Bot 設定', description: '連接並驗證您管理的 LINE 官方帳號。', steps: ['填入 Channel access token 與 Channel secret', '設定專屬 Webhook 網址並驗證簽章', '確認憑證與 Webhook 均已驗證'] },
  recipients: { title: '收件對象', description: '管理接收通知的 LINE 個人聊天室。', steps: ['建立一次性配對連結或 QR Code', '在 LINE 聊天室送出配對訊息', '確認收件對象並設定名稱'] },
  integrations: { title: '外部串接', description: '讓您的外部系統安全地傳送通知。', steps: ['建立串接並選擇收件對象', '將專屬 API Key 存放於外部系統的伺服器端', '使用共用 API 網址傳送通知'] },
  messages: { title: '傳訊紀錄', description: '查看通知的處理狀態與經過清理的錯誤資訊。', steps: ['依日期、來源、收件對象與狀態篩選', '查看平台傳訊 ID 與 LINE 回應', '追蹤排隊、受理、失敗或取消的通知'] }
};
const view = document.querySelector('#view');
function render() {
  const key = location.hash.slice(1) || 'overview';
  if (key === 'account') { renderAccount(); return; }
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

async function renderAccount() {
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === 'account'));
  document.querySelector('#breadcrumb').textContent = '帳號申請與登入';
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">ACCOUNT</p><h1>帳號申請與登入</h1><p>建立接線站專用帳號，設定自己的 LINE Bot。</p></div></div><section class="panel account-panel"><p id="account-message" role="status">正在確認服務狀態…</p><div id="account-content"></div></section>`;
  const content=document.querySelector('#account-content'), message=document.querySelector('#account-message');
  const call=async (path,data)=>{const response=await fetch('/independent-api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});let result={};try{result=await response.json();}catch{};return {response,result};};
  const status=await call('status').catch(()=>null);
  if(!content.isConnected)return;
  if(!status?.response.ok || !status.result.enabled){message.textContent='帳號功能尚未開放。';return;}
  document.querySelector('.preview-badge').textContent='接線站 · 測試版';
  document.querySelector('.notice p').textContent='帳號與 LINE Webhook 功能開放測試；通知發送及其他功能仍在開發中。';
  const me=await call('me');if(!content.isConnected)return;
  if(me.response.ok){
    message.textContent='已登入：'+me.result.displayName+'（'+me.result.username+'）'+(me.result.status==='pending'?'，申請尚待審核。':'');
    content.innerHTML=`<h2>我的 LINE Bot</h2><p>每個 Bot 都有自己的 Webhook 網址。此版本尚未提供通知發送。</p><div id="bot-list"></div><h2>新增或更新 LINE Bot</h2><p>帳號核准後，輸入 Bot 的 Channel secret 和 access token；系統驗證後會建立專屬網址。</p><form id="bot-form"><label>Channel access token<input name="accessToken" type="password" autocomplete="off" required maxlength="4096"></label><label>Channel secret<input name="channelSecret" type="password" autocomplete="off" required maxlength="512"></label><button type="submit">儲存 LINE Bot 設定</button></form><p id="bot-message" role="status"></p><form id="logout-form"><button type="submit">登出</button></form>`;
    const loadBots=async()=>{
      const r=await call('bots').catch(()=>null),list=content.querySelector('#bot-list');
      if(!list?.isConnected)return;list.replaceChildren();
      if(!r?.response.ok){list.textContent='無法載入 LINE Bot，請稍後再試。';return;}
      if(!r.result.bots.length){list.textContent='目前還沒有 LINE Bot。';return;}
      for(const bot of r.result.bots){
        const section=document.createElement('section'),title=document.createElement('h3'),label=document.createElement('label'),url=document.createElement('input'),state=document.createElement('p');
        title.textContent=bot.name;label.textContent='Webhook 網址';url.value=bot.webhookUrl;url.readOnly=true;label.append(url);state.textContent=bot.enabled?'已啟用':'已停用';section.append(title,label,state);
        if(bot.enabled){const button=document.createElement('button');button.type='button';button.textContent='停用此 Bot';button.addEventListener('click',async()=>{button.disabled=true;const result=await call('bot/disable',{botId:bot.id}).catch(()=>null);content.querySelector('#bot-message').textContent=result?.result.message||result?.result.error||'暫時無法停用。';if(result?.response.ok)await loadBots();else button.disabled=false;});section.append(button);}
        list.append(section);
      }
    };
    await loadBots();
    content.querySelector('#bot-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const r=await call('bot',{channelSecret:new FormData(form).get('channelSecret'),accessToken:new FormData(form).get('accessToken')}).catch(()=>null);content.querySelector('#bot-message').textContent=r?.result.message||r?.result.error||'暫時無法儲存。';if(r?.response.ok){form.reset();await loadBots();}});
    content.querySelector('#logout-form').addEventListener('submit',async e=>{e.preventDefault();await call('logout',{});renderAccount();});
  } else {
    message.textContent='這是接線站獨立帳號，暫無 Email 驗證或自助找回密碼，請妥善保管密碼。';
    content.innerHTML=`<h2>申請帳號</h2><form id="register-form"><label>帳號（3–32 字元，小寫英文字母、數字或底線）<input name="username" required pattern="[a-z0-9_]{3,32}" autocomplete="username"></label><label>顯示名稱<input name="displayName" required maxlength="100" autocomplete="name"></label><label>密碼（至少 8 個字元）<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><button type="submit">建立帳號</button></form><h2>登入</h2><form id="login-form"><label>帳號<input name="username" required autocomplete="username"></label><label>密碼<input name="password" type="password" required autocomplete="current-password"></label><button type="submit">登入</button></form><p id="form-message" role="status"></p>`;
    for(const [id,path] of [['register-form','register'],['login-form','login']])content.querySelector('#'+id).addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));const r=await call(path,data).catch(()=>null);content.querySelector('#form-message').textContent=r?.result.message||r?.result.error||'暫時無法完成，請稍後再試。';if(r?.response.ok){form.reset();if(path==='login')renderAccount();}});
  }
}
window.addEventListener('hashchange', render); render();
