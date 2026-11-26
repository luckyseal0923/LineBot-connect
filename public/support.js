const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatTime = new Intl.DateTimeFormat('zh-TW',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Taipei'});

export async function renderSupport({view, signal, platform, request}) {
  const admin = !platform;
  const base = admin ? '/admin-api/support' : '/independent-api/support';
  const query = platform ? new URLSearchParams({platform:platform.id}) : new URLSearchParams();
  view.innerHTML = `<div class="page-heading"><div><h1 tabindex="-1">${admin?'開發者求助訊息':'技術支援'}</h1></div></div>` +
    (admin ? '' : `<section class="panel"><h2>寫給技術支援</h2><p>技術聯絡人　張智維 · <a href="tel:0932542812">0932-542-812</a></p><p>送出後，管理後台會保存這封訊息與附件，並寄至 chin.wei.chang0923@gmail.com。</p>
      <form class="form-stack spaced"><label>主旨<input name="subject" required maxlength="120"></label>
      <label>問題描述<textarea name="body" required maxlength="4000" rows="5"></textarea></label>
      <label>附上圖片（選填）<input type="file" name="image" accept="image/png,image/jpeg"></label>
      <p class="muted small">可附一張 PNG 或 JPG，最大 2 MB。上傳前請遮住個資、Bot 憑證與完整 Webhook 網址。</p>
      <div><button type="submit" class="button button-primary">送出求助</button></div>
      <p role="status" class="feedback"></p></form></section>`) +
    `<section class="panel section-gap"><div class="section-heading"><h2>${admin?'收件匣':'此網站的求助紀錄'}</h2><button type="button" class="button button-quiet" data-refresh>重新整理</button></div>
    <div data-history aria-live="polite"></div><div class="button-row spaced" data-pager></div></section>`;
  const history=view.querySelector('[data-history]');
  const pager=view.querySelector('[data-pager]');
  let page=0, sequence=0;
  async function loadPage(next) {
    const call=++sequence;
    const params=new URLSearchParams(query);
    params.set('offset',String(next*20));
    try {
      const {messages,more}=await request('support?'+params,{signal});
      if (signal.aborted || sequence!==call) return;
      page=next;
      history.innerHTML=messages.length ? messages.map(m=>{
        const imageParams=new URLSearchParams(query);
        imageParams.set('id',m.id);
        const imageUrl=escapeText(base+'/image?'+imageParams);
        return `<details class="help-block"><summary>${escapeText(m.subject)} · ${formatTime.format(new Date(m.created_at))}</summary>
          ${admin?`<p>${escapeText(m.display_name)} · ${escapeText(m.google_email)} · ${escapeText(m.platform_name)}</p>`:''}
          <p class="muted small">郵件狀態 · ${({queued:'待寄送',sending:'寄送中',accepted:'寄信服務已受理',failed:'寄送失敗'})[m.mail_state] || '待確認'}</p>
          <p class="support-message-body">${escapeText(m.body)}</p>
          ${m.image_type?`<a href="${imageUrl}" target="_blank" rel="noopener"><img class="support-image" loading="lazy" src="${imageUrl}" alt="查看求助附件原圖"></a>`:''}</details>`;
      }).join('') : '<p class="muted">目前沒有求助訊息。</p>';
      pager.replaceChildren();
      for (const [label,index,show] of [['上一頁',page-1,page>0],['下一頁',page+1,more]]) {
        if (!show) continue;
        const button=document.createElement('button');
        button.className='button button-secondary';
        button.textContent=label;
        button.onclick=()=>loadPage(index);
        pager.append(button);
      }
    } catch (error) { if(!signal.aborted && sequence===call) history.textContent=error.message; }
  }
  view.querySelector('[data-refresh]').onclick=()=>loadPage(page);
  const form=view.querySelector('form');
  if (form) {
    let id=crypto.randomUUID();
    form.oninput=()=>{id=crypto.randomUUID();};
    form.onsubmit=async event=>{
      event.preventDefault();
      const button=form.querySelector('button'), feedback=form.querySelector('[role=status]');
      if(button.disabled) return;
      const input=new FormData(form), file=input.get('image');
      const message={id,subject:input.get('subject'),body:input.get('body')};
      for (const control of form.elements) control.disabled=true;
      feedback.textContent='正在送出…';
      try {
        if (file?.size) {
          if(file.size>2097152 || !['image/png','image/jpeg'].includes(file.type)) throw Error('請選擇 2 MB 以內的 PNG 或 JPG。');
          const data=await new Promise((resolve,reject)=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(reader.result.split(',')[1]);
            reader.onerror=()=>reject(Error('無法讀取圖片，請重新選擇。'));
            reader.readAsDataURL(file);
          });
          message.image={type:file.type,data};
        }
        await request('support?'+query,{data:message,signal});
        if(signal.aborted) return;
        form.reset();
        id=crypto.randomUUID();
        feedback.textContent='已送達技術支援後台，郵件進度可在紀錄中查看。';
        await loadPage(0);
      } catch(error) { if(!signal.aborted) feedback.textContent=error.message; }
      finally { for(const control of form.elements) control.disabled=false; }
    };
  }
  await loadPage(0);
}
