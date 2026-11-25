const ticket=location.hash.slice(1);
const statusText=document.querySelector('#status');
const form=document.querySelector('form');
const button=form.querySelector('button');

async function registration(action, fields={}) {
  const response=await fetch('/pair-registration',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket,action,...fields})});
  const data=await response.json();
  if (!response.ok) throw new Error(data.error || '暫時無法連線，請再試一次。');
  return data;
}

async function start() {
  const {platform}=await registration('open');
  document.querySelector('#platform').textContent=platform;
  statusText.textContent='已完成 LINE 配對。請填寫姓名，其餘欄位可選填。';
  form.hidden=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (button.disabled) return;
    button.disabled=true;
    try {
      await registration('submit',Object.fromEntries(new FormData(form)));
      form.hidden=true;
      history.replaceState(null,'',location.pathname);
      statusText.textContent='已加入「'+platform+'」的收件名單，可以關閉此頁。';
    } catch (error) { statusText.textContent=error.message; }
    finally {button.disabled=false;}
  });
}
start().catch(error=>{statusText.textContent=error.message;});
