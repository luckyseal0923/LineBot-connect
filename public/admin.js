const status=document.querySelector('#status'),list=document.querySelector('#applications');
const login=document.querySelector('#login-form'),logout=document.querySelector('#logout-form');
async function load(){
 list.replaceChildren();status.textContent='正在載入…';
 let response;try{response=await fetch('/admin-api/pending');}catch{status.textContent='管理服務無法連線。';return;}
 if(response.status===401){login.hidden=false;logout.hidden=true;status.textContent='請輸入管理員帳號與密碼。';return;}
 if(!response.ok){status.textContent='無法載入申請。';return;}
 login.hidden=true;logout.hidden=false;
 const data=await response.json();status.textContent=data.accounts.length?'請選擇申請並輸入審核原因。':'目前沒有待審申請。';
 for(const account of data.accounts){
  const box=document.createElement('section');box.className='review-row';
  const title=document.createElement('h2');title.textContent=account.display_name+'（'+account.username+'）';
  const time=document.createElement('p');time.textContent='申請時間：'+new Date(account.created_at).toLocaleString('zh-TW');
  const form=document.createElement('form');const label=document.createElement('label');label.textContent='審核原因';const reason=document.createElement('input');reason.required=true;reason.maxLength=500;label.append(reason);
  const approve=document.createElement('button');approve.type='submit';approve.textContent='核准';
  form.append(label,approve);box.append(title,time,form);list.append(box);
  form.addEventListener('submit',async e=>{e.preventDefault();approve.disabled=true;try{const result=await fetch('/admin-api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:account.username,status:'active',reason:reason.value})});const body=await result.json();status.textContent=body.message||body.error||'無法完成審核。';if(result.ok)await load();}catch{status.textContent='管理服務無法連線。';}finally{approve.disabled=false;}});
 }
}
login.addEventListener('submit',async e=>{e.preventDefault();const button=login.querySelector('button');button.disabled=true;try{const result=await fetch('/admin-session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(login)))});const body=await result.json();status.textContent=body.message||body.error||'登入失敗。';login.reset();if(result.ok)await load();}catch{status.textContent='無法連線。';}finally{button.disabled=false;}});
logout.addEventListener('submit',async e=>{e.preventDefault();await fetch('/admin-session/logout',{method:'POST'});await load();});
load();
