
// This router is for isolated integration tests only. Production requires a
// distributed rate limiter, dedicated DB role, persistent configuration, and
// durable handling of non-empty LINE events before enabling public access.
export function createIndependentApi({ accounts, bots, allow, lookupBot, publicOrigin }) {
  if (!accounts || !bots || typeof allow !== 'function' || typeof lookupBot !== 'function') throw new Error('Missing API dependencies');
  const origin = new URL(publicOrigin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid origin');
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  const cookie = token => `linebot_sid=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=28800`;
  const getToken = req => /(?:^|;\s*)linebot_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const send = (res,status,body,extra={}) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}); res.end(JSON.stringify(body)); };
  const read = async req => { const parts=[]; let n=0; for await(const chunk of req){n+=chunk.length;if(n>8192) throw Error('too large');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8')); };
  return async function api(req,res) {
    const path=new URL(req.url,origin).pathname;
    if (!path.startsWith('/independent-api/')) return false;
    if (req.method === 'POST' && req.headers.origin !== origin.origin) {send(res,403,{error:'來源不正確'});return true;}
    try {
      if(path==='/independent-api/status' && req.method==='GET') {send(res,200,{enabled:true});return true;}
      if(path==='/independent-api/register' && req.method==='POST') {
        if(!await allow('register')){send(res,429,{error:'申請過於頻繁，請稍後再試。'});return true;}
        const result=await accounts.register(await read(req));
        send(res,result.status==='created'?201:400,{message:result.status==='created'?'帳號已建立，請登入。':'帳號格式有誤或名稱無法使用。'});return true;
      }
      if(path==='/independent-api/login' && req.method==='POST') {
        if(!await allow('login')){send(res,429,{error:'登入過於頻繁，請稍後再試。'});return true;}
        const result=await accounts.login(await read(req));
        if(result.status!=='ok'){send(res,401,{error:'帳號或密碼不正確，或暫時無法登入。'});return true;}
        send(res,200,{message:'登入成功'},{'Set-Cookie':cookie(result.token)});return true;
      }
      if(path==='/independent-api/logout' && req.method==='POST') {
        await accounts.logout(getToken(req));send(res,200,{message:'已登出'},{'Set-Cookie':`linebot_sid=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`});return true;
      }
      if(path==='/independent-api/me' && req.method==='GET') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        send(res,200,{username:user.username,displayName:user.display_name,status:user.status});return true;
      }
      if(path==='/independent-api/bots' && req.method==='GET') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        const items=await bots.list(user.id);
        send(res,200,{bots:items.map(item=>({id:item.id,name:item.botName,enabled:item.enabled,webhookUrl:new URL(`/webhooks/line/${item.webhookKey}`,origin).href}))});return true;
      }
      if(path==='/independent-api/bot' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        if(user.status!=='active'){send(res,403,{error:'申請尚未核准，無法設定 LINE Bot。'});return true;}
        const data=await read(req);
        if(typeof data.channelSecret!=='string'||!data.channelSecret.trim()||Buffer.byteLength(data.channelSecret)>4096){send(res,400,{error:'請輸入 Channel secret'});return true;}
        if(typeof data.accessToken!=='string'||!data.accessToken||Buffer.byteLength(data.accessToken)>4096){send(res,400,{error:'請輸入 Channel access token'});return true;}
        const bot=await lookupBot(data.accessToken);if(!bot){send(res,400,{error:'無法驗證 LINE Bot 憑證。'});return true;}
        try {const saved=await bots.save(user.id,data.channelSecret,data.accessToken,bot);if(!saved){send(res,409,{error:'此 LINE Bot 已綁定其他帳號。'});return true;}}
        catch(error){if(error?.code==='23505'){send(res,409,{error:'此 LINE Bot 已綁定其他帳號。'});return true;}throw error;}
        send(res,200,{message:'LINE Bot 憑證已儲存，請在 LINE Developers 驗證 Webhook。'});return true;
      }
      if(path==='/independent-api/bot/disable' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        const data=await read(req);
        if(typeof data.botId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.botId)){send(res,400,{error:'請選擇要停用的 LINE Bot。'});return true;}
        if(!await bots.disable(user.id,data.botId)){send(res,404,{error:'找不到 LINE Bot。'});return true;}
        send(res,200,{message:'已停用'});return true;
      }
      send(res,404,{error:'找不到功能'});return true;
    } catch {send(res,503,{error:'服務暫時無法使用'});return true;}
  };
}
