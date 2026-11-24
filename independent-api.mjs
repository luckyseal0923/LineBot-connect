
// This router is for isolated integration tests only. Production requires a
// distributed rate limiter, dedicated DB role, persistent configuration, and
// durable handling of non-empty LINE events before enabling public access.
export function createIndependentApi({ accounts, bots, allow, lookupBot, publicOrigin, notifications, checkWebhook, integrations }) {
  if (!accounts || !bots || typeof allow !== 'function' || typeof lookupBot !== 'function') throw new Error('Missing API dependencies');
  const origin = new URL(publicOrigin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid origin');
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  const cookie = token => `linebot_sid=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=28800`;
  const getToken = req => /(?:^|;\s*)linebot_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const botIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const webhookUrl = key => new URL(`/webhooks/line/${key}`, origin).href;
  const publicBot = bot => ({ id: bot.id, name: bot.botName, enabled: bot.enabled, webhookUrl: webhookUrl(bot.webhookKey) });
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
        send(res,200,{bots:items.map(publicBot)});return true;
      }
      if(path==='/independent-api/bot' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        if(user.status!=='active'){send(res,403,{error:'申請尚未核准，無法設定 LINE Bot。'});return true;}
        const data=await read(req);
        if(typeof data.channelSecret!=='string'||!data.channelSecret.trim()||Buffer.byteLength(data.channelSecret)>4096){send(res,400,{error:'請輸入 Channel secret'});return true;}
        if(typeof data.accessToken!=='string'||!data.accessToken||Buffer.byteLength(data.accessToken)>4096){send(res,400,{error:'請輸入 Channel access token'});return true;}
        const bot=await lookupBot(data.accessToken);if(!bot){send(res,400,{error:'無法驗證 LINE Bot 憑證。'});return true;}
        let saved;
        try { saved = await bots.save(user.id, data.channelSecret, data.accessToken, bot); }
        catch (error) { if (error?.code !== '23505') throw error; }
        if (!saved) { send(res, 409, { error: '此 LINE Bot 已綁定其他帳號。' }); return true; }
        send(res, 200, { message: 'LINE Bot 憑證已儲存，請在 LINE Developers 驗證 Webhook。', bot: publicBot(saved) });
        return true;
      }
      if (path === '/independent-api/bot/webhook-check' && req.method === 'POST' && checkWebhook) {
        const user = await accounts.me(getToken(req));
        if (!user) { send(res, 401, { error: '請先登入。' }); return true; }
        if (user.status !== 'active') { send(res, 403, { error: '帳號尚未核准。' }); return true; }
        const { botId } = await read(req);
        if (typeof botId !== 'string' || !botIdPattern.test(botId)) {
          send(res, 400, { error: '請選擇啟用中的 LINE Bot。' }); return true;
        }
        const bot = await bots.webhookCheckCredentials(user.id, botId);
        if (!bot) { send(res, 404, { error: '找不到可檢查的 LINE Bot。請確認 Bot 已啟用並儲存憑證。' }); return true; }
        if (!await allow('webhook-check') || !await allow(`webhook-check:${botId.toLowerCase()}`)) {
          send(res, 429, { error: '檢查過於頻繁，請稍後再試。' }); return true;
        }
        const status = await checkWebhook(bot.accessToken, webhookUrl(bot.webhookKey));
        send(res, 200, { status, checkedAt: new Date().toISOString() });
        return true;
      }
      if(path==='/independent-api/bot/disable' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        const data=await read(req);
        if(typeof data.botId!=='string'||!botIdPattern.test(data.botId)){send(res,400,{error:'請選擇要停用的 LINE Bot。'});return true;}
        if(!await bots.disable(user.id,data.botId)){send(res,404,{error:'找不到 LINE Bot。'});return true;}
        send(res,200,{message:'已停用'});return true;
      }
      const integrationAction = /^\/independent-api\/integrations\/([0-9a-f-]{36})\/(edit|enable|disable|rotate|revoke|test)$/i.exec(path);
      if (path === '/independent-api/integrations' || (integrationAction && botIdPattern.test(integrationAction[1]))) {
        const user = await accounts.me(getToken(req));
        if (!user) { send(res, 401, { error: '請先登入。' }); return true; }
        if (user.status !== 'active') { send(res, 403, { error: '帳號尚未核准。' }); return true; }
        if (!integrations) { send(res, 503, { error: '外部串接尚未開放。' }); return true; }
        if (req.method === 'GET' && !integrationAction) {
          send(res, 200, { integrations: await integrations.list(user.id), endpoint: new URL('/api/v1/send', origin).href });
          return true;
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: '請使用指定的 HTTP 方法。' }, { Allow: integrationAction ? 'POST' : 'GET, POST' });
          return true;
        }
        if (!await allow('integration-manage') || !await allow(`integration-manage:${user.id}`)) {
          send(res, 429, { error: '操作過於頻繁，請稍候再試。' }); return true;
        }

        let result;
        const action = integrationAction?.[2].toLowerCase();
        const id = integrationAction?.[1];
        if (!action) result = await integrations.create(user.id, await read(req));
        else if (action === 'edit') result = await integrations.edit(user.id, id, await read(req));
        else if (action === 'test') result = await integrations.testSend(user.id, id, (await read(req))?.eventKey);
        else result = await integrations.manage(user.id, id, action);

        const failures = {
          invalid: [400, '請確認名稱、收件對象或測試資料。'],
          unavailable: [404, '找不到可操作的串接，請確認金鑰與收件對象。'],
          disabled: [403, '請先啟用串接。'],
          target_unavailable: [422, '請選擇自己的啟用中 Bot 與已配對收件人。'],
          event_conflict: [409, '此測試編號已有其他通知。'],
          rate_limited: [429, '發送過於頻繁，請稍候再試。']
        };
        if (result.error) {
          const [status, error] = failures[result.error];
          send(res, status, { error });
        } else send(res, action ? 200 : 201, result);
        return true;
      }
      if(path.startsWith('/independent-api/notification') || path.startsWith('/independent-api/recipient')) {
        if(!notifications){send(res,503,{error:'通知功能尚未開放。'});return true;}
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        if(user.status!=='active'){send(res,403,{error:'帳號尚未核准。'});return true;}
        if(path==='/independent-api/recipients'&&req.method==='GET'){send(res,200,{recipients:await notifications.list(user.id)});return true;}
        if(path==='/independent-api/notifications'&&req.method==='GET'){send(res,200,{notifications:await notifications.history(user.id)});return true;}
        if(path==='/independent-api/recipient/pair'&&req.method==='POST'){
          if(!await allow('pairing')||!await allow(`pairing:${user.id}`)){send(res,429,{error:'操作過於頻繁，請稍後再試。'});return true;}
          const data=await read(req),result=await notifications.createPairing(user.id,data.botId,data.label);
          send(res,result?200:400,result||{error:'請選擇自己的啟用中 Bot 並填寫名稱。'});return true;
        }
        if(path==='/independent-api/recipient/disable'&&req.method==='POST'){
          const data=await read(req),ok=await notifications.disable(user.id,data.recipientId);send(res,ok?200:404,ok?{message:'已移除收件對象。'}:{error:'找不到收件對象。'});return true;
        }
        if(path==='/independent-api/notification/send'&&req.method==='POST'){
          if(!await allow('notify')||!await allow(`notify:${user.id}`)){send(res,429,{error:'發送過於頻繁，請稍後再試。'});return true;}
          const result=await notifications.send(user.id,await read(req));send(res,result.error?400:200,result.error?{error:'訊息或收件對象不正確。'}:result);return true;
        }
      }
      send(res,404,{error:'找不到功能'});return true;
    } catch {send(res,503,{error:'服務暫時無法使用'});return true;}
  };
}
