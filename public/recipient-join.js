const statusText = document.querySelector('#status');
const form = document.querySelector('form');
const friend = document.querySelector('#friend');
const endpoint = '/recipient-registration/' + location.pathname.split('/')[2];
async function start() {
  try {
    const response = await fetch(endpoint);
    const config = await response.json();
    if (!response.ok) throw new Error(config.error);
    document.querySelector('#platform').textContent = config.platform;
    if (!window.liff) throw new Error('LINE 登入服務未載入，請重新掃碼。');
    await liff.init({liffId:config.liffId});
    if (!liff.isLoggedIn()) {
      liff.login({redirectUri:location.href});
      return;
    }
    const invite = new URL(location.href).searchParams.get('invite');
    if (!invite) throw new Error('請使用管理者提供的邀請 QR Code 或完整邀請連結。');
    statusText.textContent = '你將透過「' + config.bot + '」接收通知。請填寫管理者能辨識的名字。';
    form.hidden = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button=form.querySelector('button');
      if (button.disabled) return;
      button.disabled=true;
      friend.hidden=true;
      statusText.textContent='正在加入…';
      try {
        const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite,token:liff.getAccessToken(),...Object.fromEntries(new FormData(form))})});
        const body=await res.json();
        if (!res.ok) {
          if (body.addFriend) { friend.href=body.addFriend; friend.hidden=false; }
          throw new Error(body.error);
        }
        form.hidden=true;
        statusText.textContent='已加入「'+config.platform+'」的收件名單，可以關閉此頁。';
      } catch (error) { statusText.textContent=error.message || '暫時無法登記，請再試一次。'; }
      finally { button.disabled=false; }
    });
  } catch(error) { statusText.textContent=error.message || '無法開啟 LINE 登入，請重新掃碼。'; }
}
start();
