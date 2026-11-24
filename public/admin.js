const status=document.querySelector('#status'),list=document.querySelector('#applications');
const login=document.querySelector('#login-form'),logout=document.querySelector('#logout-form'),dashboard=document.querySelector('#dashboard');
const time=value=>value?new Date(value).toLocaleString('zh-TW'):'—';
const accountStatus={pending:'待審核',active:'已啟用',disabled:'已停用'};
const notificationStatus={accepted:'LINE 已受理',failed:'發送失敗',unknown:'結果未確認',sending:'處理中'};
function table(target,headers,rows){
 target.replaceChildren();if(!rows.length){target.textContent='目前沒有資料。';return;}
 const wrap=document.createElement('div'),table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');wrap.className='table-scroll';
 for(const text of headers){const th=document.createElement('th');th.textContent=text;tr.append(th);}head.append(tr);table.append(head);
 const body=document.createElement('tbody');for(const cells of rows){const row=document.createElement('tr');for(const value of cells){const td=document.createElement('td');if(value instanceof Node)td.append(value);else td.textContent=value??'—';row.append(td);}body.append(row);}table.append(body);wrap.append(table);target.append(wrap);
}
async function review(username,next,reason){
 const result=await fetch('/admin-api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,status:next,reason})});
 const body=await result.json();if(!result.ok)throw new Error(body.error||body.message||'無法完成操作。');return body.message;
}
function action(username,next,label){
 const form=document.createElement('form');form.className='admin-action';
 const input=document.createElement('input');input.name='reason';input.placeholder='請輸入原因';input.setAttribute('aria-label',`${label} ${username} 的原因`);input.maxLength=500;input.required=true;
 const button=document.createElement('button');button.textContent=label;form.append(input,button);
 form.addEventListener('submit',async e=>{e.preventDefault();if(!confirm(`確定${label}帳號 ${username}？`))return;button.disabled=true;try{const message=await review(username,next,input.value);await load();status.textContent=message;}catch(error){status.textContent=error.message||'管理服務無法連線。';button.disabled=false;}});return form;
}
async function load(){
 list.replaceChildren();status.textContent='正在載入…';
 let response;try{response=await fetch('/admin-api/pending');}catch{status.textContent='管理服務無法連線。';return;}
 if(response.status===401){login.hidden=false;logout.hidden=true;dashboard.hidden=true;status.textContent='請輸入管理員帳號與密碼。';return;}
 if(!response.ok){status.textContent='無法載入申請。';return;}
 login.hidden=true;logout.hidden=false;dashboard.hidden=false;
 const data=await response.json();status.textContent='已登入管理後台。';
 table(list,['申請者','申請時間','操作'],data.accounts.map(a=>[`${a.display_name}（${a.username}）`,time(a.created_at),action(a.username,'active','核准')]));
 let monitor;try{monitor=await fetch('/admin-api/monitor');}catch{status.textContent='監看資料無法連線，帳號審核仍可使用。';return;}
 if(!monitor.ok){status.textContent='監看資料暫時無法載入，帳號審核仍可使用。';return;}
 const m=await monitor.json();
 const summary=document.querySelector('#summary');summary.replaceChildren();for(const [label,key] of [['使用者','accounts'],['待審申請','pending'],['啟用中 Bot','active_bots'],['近 30 天通知','notifications_30d'],['失敗或未確認','attention_30d']]){const card=document.createElement('div'),caption=document.createElement('span'),number=document.createElement('strong');caption.textContent=label;number.textContent=String(m.summary[key]);card.append(caption,number);summary.append(card);}
 table(document.querySelector('#users'),['使用者','狀態','建立時間','啟用 Bot','近 30 天通知','操作'],m.accounts.map(a=>[`${a.display_name}（${a.username}）`,accountStatus[a.status]||a.status,time(a.created_at),String(a.active_bots),String(a.notifications_30d),a.status==='pending'?'請在待審申請處核准':action(a.username,a.status==='active'?'disabled':'active',a.status==='active'?'停用':'重新啟用')]));
 table(document.querySelector('#bots'),['使用者','Bot 名稱','狀態','最後更新','近 30 天通知'],m.bots.map(b=>[`${b.display_name}（${b.username}）`,b.bot_name,b.enabled?'已啟用':'已停用',time(b.updated_at),String(b.notifications_30d)]));
 table(document.querySelector('#notifications'),['時間','使用者','Bot','收件對象名稱','狀態','LINE 狀態碼'],m.notifications.map(n=>[time(n.created_at),`${n.display_name}（${n.username}）`,n.bot_name,n.recipient_label,notificationStatus[n.status]||'結果未確認',n.line_status==null?'—':String(n.line_status)]));
 table(document.querySelector('#audit'),['時間','帳號','變更','原因','資料庫角色'],m.audit.map(a=>[time(a.reviewed_at),a.username,`${accountStatus[a.old_status]||a.old_status} → ${accountStatus[a.new_status]||a.new_status}`,a.reason,a.actor]));
}
login.addEventListener('submit',async e=>{e.preventDefault();const button=login.querySelector('button');button.disabled=true;try{const result=await fetch('/admin-session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(login)))});const body=await result.json();status.textContent=body.message||body.error||'登入失敗。';login.reset();if(result.ok)await load();}catch{status.textContent='無法連線。';}finally{button.disabled=false;}});
logout.addEventListener('submit',async e=>{e.preventDefault();await fetch('/admin-session/logout',{method:'POST'});await load();});
load();
