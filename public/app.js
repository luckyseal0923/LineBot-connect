const pages = {
  bot: { title: 'LINE Bot 設定', description: '連接並驗證您管理的 LINE 官方帳號。', steps: ['填入 Channel access token 與 Channel secret', '設定專屬 Webhook 網址並驗證簽章', '確認憑證與 Webhook 均已驗證'] },
  recipients: { title: '收件對象', description: '管理接收通知的 LINE 個人聊天室。', steps: ['建立一次性配對連結或 QR Code', '在 LINE 聊天室送出配對訊息', '確認收件對象並設定名稱'] },
  integrations: { title: '外部串接', description: '讓您的外部系統安全地傳送通知。', steps: ['建立串接並選擇收件對象', '將專屬 API Key 存放於外部系統的伺服器端', '使用共用 API 網址傳送通知'] },
  messages: { title: '傳訊紀錄', description: '查看通知的處理狀態與經過清理的錯誤資訊。', steps: ['依日期、來源、收件對象與狀態篩選', '查看平台傳訊 ID 與 LINE 回應', '追蹤排隊、受理、失敗或取消的通知'] }
};
const view = document.querySelector('#view');
let renderVersion=0;
async function render() {
  const version=++renderVersion;
  const key = location.hash.slice(1) || 'overview';
  document.documentElement.dataset.auth='checking';
  view.innerHTML='<section class="panel account-panel"><p role="status">正在確認登入狀態…</p></section>';
  let session;try{session=await notificationCall('me');}catch{session=null;}
  if(version!==renderVersion)return;
  const state=session?.response.ok?(session.result.status==='active'?'active':'pending'):session?.response.status===401?'guest':'error';
  document.documentElement.dataset.auth=state;
  document.querySelector('.workspace strong').textContent=state==='active'?'我的工作空間':state==='pending'?'等待帳號審核':'歡迎來到接線站';
  document.querySelector('.workspace small').textContent=state==='active'?session.result.displayName:state==='pending'?'申請審核中':state==='error'?'連線狀態無法確認':'請先登入或申請帳號';
  if(state!=='active'&&key!=='account'){location.hash='account';return;}
  if(state==='error'){document.querySelector('#breadcrumb').textContent='帳號申請與登入';view.innerHTML='<section class="panel account-panel"><p role="status">暫時無法確認登入狀態，請檢查網路後重新整理。</p></section>';return;}
  if (key === 'account' || key === 'bot') { renderAccount(key); return; }
  if (key === 'recipients' || key === 'messages') { renderNotifications(key); return; }
  const current = pages[key];
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === (current ? key : 'overview')));
  document.querySelector('#breadcrumb').textContent = current?.title || '總覽';
  if (current) {
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">WORKSPACE</p><h1>${current.title}</h1><p>${current.description}</p></div><span class="state">尚未開放</span></div><section class="panel detail"><div class="detail-icon">✳</div><h2>功能開發中</h2><p>此頁目前展示預計提供的操作流程，尚未連接後端服務。</p><ol>${current.steps.map(step => `<li>${step}</li>`).join('')}</ol><a class="text-link" href="#overview">返回總覽</a></section>`;
    return;
  }
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">OVERVIEW</p><h1>歡迎來到接線站 <span class="wave">✳</span></h1><p>透過自己的 LINE Bot 傳送文字通知。</p></div><span class="state"><i></i> 測試版</span></div>
  <section class="hero"><div class="hero-copy"><span class="hero-tag">開始使用</span><h2>讓重要訊息，<br>準時送到對的人手上。</h2><p>完成設定後，即可透過自己的 LINE 官方帳號傳送文字通知。</p><a class="hero-link" href="#bot">查看設定步驟 <span>↗</span></a></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-card art-card-one">▦</div><div class="art-card art-card-two">✓</div><div class="art-center">L<span>•</span></div><div class="art-label">CONNECTED</div></div></section>
  <div class="section-heading"><div><p class="eyebrow">GETTING STARTED</p><h2>開始使用</h2><p>先申請帳號並等待管理員核准，再依序完成以下步驟。</p></div></div>
  <section class="steps" aria-label="開始使用步驟"><a href="#bot" class="step"><div class="step-top"><span class="step-icon">◉</span><span class="step-number">01</span></div><h3>設定 LINE Bot</h3><p>輸入自己 Bot 的憑證，再將專屬 Webhook 網址設定到 LINE Developers 並驗證。</p><span class="step-link">查看設定 <b>↗</b></span></a><a href="#recipients" class="step"><div class="step-top"><span class="step-icon">♙</span><span class="step-number">02</span></div><h3>配對收件對象</h3><p>請收件者將一次性配對文字傳給 Bot。</p><span class="step-link">查看配對 <b>↗</b></span></a><a href="#messages" class="step"><div class="step-top"><span class="step-icon">≡</span><span class="step-number">03</span></div><h3>發送測試通知</h3><p>選擇配對對象，傳送文字並確認對方收到。</p><span class="step-link">前往發送 <b>↗</b></span></a></section>
  <section class="activity panel"><div class="activity-head"><div><p class="eyebrow">NOTIFICATIONS</p><h2>發送紀錄</h2><p>可在發送通知頁查看最近紀錄；外部系統串接仍在開發中。</p></div><a class="text-link" href="#messages">查看紀錄 <span>↗</span></a></div></section>`;
}

async function notificationCall(path,data){
 const response=await fetch('/independent-api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 let result={};try{result=await response.json();}catch{}return {response,result};
}
async function renderNotifications(page){
 document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.dataset.page===page));
 document.querySelector('#breadcrumb').textContent=page==='recipients'?'收件對象':'發送通知';
 view.innerHTML=`<div class="page-heading"><div><p class="eyebrow">NOTIFICATIONS</p><h1>${page==='recipients'?'收件對象':'發送通知'}</h1><p>${page==='recipients'?'讓收件者在 LINE 主動完成配對。':'使用自己的 Bot 發送文字訊息。'}</p></div></div><section class="panel account-panel"><p id="notify-status" role="status">正在載入…</p><div id="notify-content"></div></section>`;
 const content=view.querySelector('#notify-content'),status=view.querySelector('#notify-status');
 const me=await notificationCall('me').catch(()=>null);if(!content.isConnected)return;
 if(!me?.response.ok||me.result.status!=='active'){status.textContent='請先登入已核准的帳號。';return;}
 const [bots,recipients]=await Promise.all([notificationCall('bots'),notificationCall('recipients')]).catch(()=>[]);
 if(!content.isConnected)return;if(!bots?.response.ok||!recipients?.response.ok){status.textContent='暫時無法載入資料，請稍後再試。';return;}
 status.textContent='';
 if(page==='recipients'){
  content.innerHTML=`<h2>新增收件對象</h2><p>選擇 Bot 並輸入名稱，將產生的配對文字交給收件者；請收件者加該 Bot 為好友後，在一對一聊天室傳送文字。配對碼 10 分鐘內有效，僅能使用一次。</p><form id="pair-form"><label>LINE Bot<select name="botId" required></select></label><label>收件對象名稱<input name="label" required maxlength="80"></label><button>產生配對文字</button></form><p id="pair-result" role="status"></p><label id="pair-label" hidden>配對文字<input id="pair-code" readonly></label><h2>已配對收件對象</h2><div id="recipients-list"></div><p><a class="text-link" href="#messages">前往發送通知</a></p>`;
  const select=content.querySelector('select');for(const bot of bots.result.bots.filter(x=>x.enabled)){const option=document.createElement('option');option.value=bot.id;option.textContent=bot.name;select.append(option);}
  if(!select.options.length){const option=document.createElement('option');option.value='';option.textContent='請先設定 LINE Bot';select.append(option);}
  const list=content.querySelector('#recipients-list');if(!recipients.result.recipients.length)list.textContent='尚無收件對象。';
  for(const recipient of recipients.result.recipients){const row=document.createElement('p'),name=document.createElement('span'),button=document.createElement('button');name.textContent=`${recipient.label}（${recipient.botName}） `;button.type='button';button.textContent='移除';button.addEventListener('click',async()=>{if(!confirm('確定移除此收件對象？'))return;button.disabled=true;const r=await notificationCall('recipient/disable',{recipientId:recipient.id}).catch(()=>null);if(r?.response.ok)renderNotifications(page);else{status.textContent='移除失敗，請稍後再試。';button.disabled=false;}});row.append(name,button);list.append(row);}
  content.querySelector('#pair-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;const r=await notificationCall('recipient/pair',Object.fromEntries(new FormData(form))).catch(()=>null);button.disabled=false;content.querySelector('#pair-result').textContent=r?.response.ok?'請將下方文字交給收件者，傳送後重新整理此頁。':r?.result.error||'暫時無法建立配對。';if(r?.response.ok){content.querySelector('#pair-label').hidden=false;content.querySelector('#pair-code').value=r.result.message;}});
 }else{
  content.innerHTML=`<h2>發送文字訊息</h2><p>請先確認收件對象及內容。LINE 受理後不代表對方一定已收到；逾時時請先確認收件狀況，避免重複發送。發送紀錄保存 30 天，不保存訊息內容。</p><form id="send-form"><label>收件對象<select name="recipientId" required></select></label><label>訊息內容<textarea name="message" required maxlength="2000" rows="5"></textarea></label><button>發送訊息</button></form><p id="send-result" role="status"></p><h2>最近發送紀錄</h2><div id="notification-list"></div>`;
  const select=content.querySelector('select');for(const r of recipients.result.recipients){const option=document.createElement('option');option.value=r.id;option.textContent=`${r.label}（${r.botName}）`;select.append(option);}
  if(!select.options.length){const option=document.createElement('option');option.value='';option.textContent='請先配對收件對象';select.append(option);}
  const records=await notificationCall('notifications').catch(()=>null);if(!content.isConnected)return;const list=content.querySelector('#notification-list');
  const labels={accepted:'LINE 已受理',failed:'發送失敗',unknown:'結果未確認',sending:'處理中，結果未確認'};
  if(!records?.response.ok)list.textContent='無法載入紀錄。';else if(!records.result.notifications.length)list.textContent='尚無發送紀錄。';else for(const item of records.result.notifications){const p=document.createElement('p');p.textContent=`${new Date(item.createdAt).toLocaleString('zh-TW')} · ${item.botName} → ${item.label} · ${labels[item.status]||'結果未確認'}`;list.append(p);}
  content.querySelector('#send-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,data=Object.fromEntries(new FormData(form));if(!confirm(`確定發送給 ${select.selectedOptions[0].textContent}？`))return;const button=form.querySelector('button');button.disabled=true;data.requestId=crypto.randomUUID();const r=await notificationCall('notification/send',data).catch(()=>null);const result=content.querySelector('#send-result');result.textContent=r?.response.ok?(labels[r.result.status]||'結果未確認')+'；請至 LINE 確認。':(!r||r.response.status>=500?'結果未確認，請先至 LINE 確認後再重新發送。':r.result.error||'發送失敗。');if(r?.result.status==='accepted')form.reset();button.disabled=false;});
 }
}

async function renderAccount(section = 'account') {
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === section));
  document.querySelector('#breadcrumb').textContent = section === 'bot' ? 'LINE Bot 設定' : '帳號申請與登入';
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">ACCOUNT</p><h1>${section === 'bot' ? 'LINE Bot 設定' : '帳號申請與登入'}</h1><p>建立接線站專用帳號，設定自己的 LINE Bot。</p></div></div><section class="panel account-panel"><p id="account-message" role="status">正在確認服務狀態…</p><div id="account-content"></div></section>`;
  const content=document.querySelector('#account-content'), message=document.querySelector('#account-message');
  const call=async (path,data)=>{const response=await fetch('/independent-api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});let result={};try{result=await response.json();}catch{};return {response,result};};
  const status=await call('status').catch(()=>null);
  if(!content.isConnected)return;
  if(!status?.response.ok || !status.result.enabled){message.textContent='帳號功能尚未開放。';return;}
  document.querySelector('.preview-badge').textContent='接線站 · 測試版';
  document.querySelector('.notice p').textContent='帳號、LINE Bot 與個人文字通知開放使用；外部串接仍在開發中。';
  const me=await call('me').catch(()=>null);if(!content.isConnected)return;
  if(!me || (!me.response.ok && me.response.status!==401)){message.textContent='暫時無法確認登入狀態，請檢查網路後重新整理。';return;}
  if(me.response.ok){
    message.textContent='已登入：'+me.result.displayName+'（'+me.result.username+'）'+(me.result.status==='pending'?'，申請尚待審核。':'');
    if(me.result.status==='pending'){
      content.innerHTML='<div class="pending-account"><h2>帳號申請審核中</h2><p>你的帳號已建立，請聯絡平台管理員審核。核准後重新整理頁面，即可使用 LINE Bot 與通知功能。</p><form id="logout-form"><button type="submit">登出</button></form></div>';
      content.querySelector('#logout-form').addEventListener('submit',async e=>{e.preventDefault();await call('logout',{});render();});
      return;
    }
    content.innerHTML=`<div class="setup-intro"><h2>開始串接你的 LINE Bot</h2><p>一個帳號可以管理多個 Bot；每個 Bot 都有自己的 Webhook 網址。請先準備你有管理權限的 LINE 官方帳號。</p></div><div class="setup-steps"><section class="setup-step"><span class="setup-number">1</span><div><h3>在 LINE 取得兩項憑證</h3><p>前往 <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer">LINE Developers Console ↗</a>，開啟你的 Messaging API channel。從「Basic settings」找到 Channel secret，從「Messaging API」找到或發行 Channel access token。</p><p>若還沒有 Messaging API channel，請先在 LINE 官方帳號管理後台啟用 Messaging API。憑證只填在下方，請勿貼到聊天或公開頁面。</p></div></section><section class="setup-step"><span class="setup-number">2</span><div><h3>儲存 Bot 憑證</h3><p>核准帳號後，填入同一個 Bot 的兩項憑證。儲存成功後，專屬網址會出現在下方「我的 LINE Bot」。重複此步驟可新增其他 Bot。</p><form id="bot-form"><label>Channel access token<input name="accessToken" type="password" autocomplete="off" required maxlength="4096"></label><label>Channel secret<input name="channelSecret" type="password" autocomplete="off" required maxlength="512"></label><button type="submit">儲存 LINE Bot 設定</button></form><p id="bot-message" role="status"></p></div></section><section class="setup-step"><span class="setup-number">3</span><div><h3>設定並驗證 Webhook</h3><p>複製下方 Bot 的網址，貼到 LINE Developers 的「Messaging API → Webhook URL」，儲存後開啟 Use webhook，並按 Verify。Bot「已啟用」只表示接線站設定已啟用，不代表 LINE 驗證已通過。</p><h4>我的 LINE Bot</h4><div id="bot-list"></div></div></section><section class="setup-step"><span class="setup-number">4</span><div><h3>配對並測試通知</h3><p>前往「收件對象」選擇 Bot，建立配對文字，請收件者加 Bot 為好友並在一對一聊天室傳送。再到「傳訊紀錄」發送測試文字，請對方確認收到。</p><a class="text-link" href="#recipients">前往配對收件對象 ↗</a></div></section></div><form id="logout-form"><button type="submit">登出</button></form>`;
    const loadBots=async()=>{
      const r=await call('bots').catch(()=>null),list=content.querySelector('#bot-list');
      if(!list?.isConnected)return;list.replaceChildren();
      if(!r?.response.ok){list.textContent='無法載入 LINE Bot，請稍後再試。';return;}
      if(!r.result.bots.length){list.textContent='目前還沒有 LINE Bot。';return;}
      for(const bot of r.result.bots){
        const section=document.createElement('section'),title=document.createElement('h3'),label=document.createElement('label'),url=document.createElement('input'),state=document.createElement('p');
        section.className='bot-card';title.textContent=bot.name;label.textContent='Webhook 網址';url.value=bot.webhookUrl;url.readOnly=true;label.append(url);state.textContent=bot.enabled?'接線站已啟用，請至 LINE Developers 驗證':'已停用';section.append(title,label,state);
        const copy=document.createElement('button'),copyStatus=document.createElement('p');copyStatus.setAttribute('role','status');copy.type='button';copy.textContent='複製 Webhook 網址';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(url.value);copyStatus.textContent='已複製 Webhook 網址。';}catch{url.select();copyStatus.textContent='請手動複製選取的 Webhook 網址。';}});section.append(copy,copyStatus);
        if(bot.enabled){const button=document.createElement('button');button.type='button';button.textContent='停用此 Bot';button.addEventListener('click',async()=>{button.disabled=true;const result=await call('bot/disable',{botId:bot.id}).catch(()=>null);content.querySelector('#bot-message').textContent=result?.result.message||result?.result.error||'暫時無法停用。';if(result?.response.ok)await loadBots();else button.disabled=false;});section.append(button);}
        list.append(section);
      }
    };
    await loadBots();
    content.querySelector('#bot-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const r=await call('bot',{channelSecret:new FormData(form).get('channelSecret'),accessToken:new FormData(form).get('accessToken')}).catch(()=>null);content.querySelector('#bot-message').textContent=r?.result.message||r?.result.error||'暫時無法儲存。';if(r?.response.ok){form.reset();await loadBots();}});
    content.querySelector('#logout-form').addEventListener('submit',async e=>{e.preventDefault();await call('logout',{});location.hash='account';render();});
  } else {
    message.textContent='這是接線站獨立帳號，暫無 Email 驗證或自助找回密碼，請妥善保管密碼。';
    content.innerHTML=`<div class="auth-layout"><section class="auth-card auth-login" aria-labelledby="login-title"><div class="auth-card-head"><span class="auth-icon" aria-hidden="true">↗</span><span class="auth-kicker">WELCOME BACK</span><h2 id="login-title">登入接線站</h2><p>已有帳號嗎？登入後管理你的 LINE Bot 與通知。</p></div><form id="login-form"><label>帳號<input name="username" placeholder="輸入帳號" required autocomplete="username"></label><label>密碼<input name="password" type="password" placeholder="輸入密碼" required autocomplete="current-password"></label><button type="submit">登入 <span aria-hidden="true">→</span></button><p class="auth-feedback" id="login-message" role="status" aria-live="polite"></p></form><p class="auth-footnote">登入後即可查看帳號審核狀態。</p></section><section class="auth-card auth-register" aria-labelledby="register-title"><div class="auth-card-head"><span class="auth-icon" aria-hidden="true">＋</span><span class="auth-kicker">GET STARTED</span><h2 id="register-title">申請新帳號</h2><p>建立你的專屬工作空間，開始串接自己的 LINE Bot。</p></div><form id="register-form"><label>帳號<input name="username" placeholder="例如 linebot_user" required pattern="[a-z0-9_]{3,32}" autocomplete="username" aria-describedby="username-hint"><small id="username-hint">3–32 字元，限小寫英文字母、數字及底線</small></label><label>顯示名稱<input name="displayName" placeholder="你的名稱或團隊名稱" required maxlength="100" autocomplete="name"></label><label>密碼<input name="password" type="password" placeholder="設定至少 8 個字元" minlength="8" maxlength="128" autocomplete="new-password" required></label><button type="submit">送出帳號申請 <span aria-hidden="true">→</span></button><p class="auth-feedback" id="register-message" role="status" aria-live="polite"></p></form><p class="auth-footnote">送出後請聯絡平台管理員審核；核准後即可設定 Bot。</p></section></div>`;
    for(const [id,path] of [['register-form','register'],['login-form','login']])content.querySelector('#'+id).addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button'),feedback=content.querySelector('#'+path+'-message');button.disabled=true;feedback.textContent='處理中…';const data=Object.fromEntries(new FormData(form));const r=await call(path,data).catch(()=>null);feedback.textContent=r?.result.message||r?.result.error||'暫時無法完成，請稍後再試。';button.disabled=false;if(r?.response.ok){form.reset();if(path==='login')render();}});
  }
}
window.addEventListener('hashchange', render); render();
