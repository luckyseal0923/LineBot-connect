import { supportRequest } from './support.mjs';

import { eventWebhookPath } from './external-api.mjs';

export function developerSessionCookie(origin, token = '') {
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  return `linebot_sid=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${token ? 28800 : 0}`;
}

// This router is for isolated integration tests only. Production requires a
// distributed rate limiter, dedicated DB role, persistent configuration, and
// durable handling of non-empty LINE events before enabling public access.
export function createIndependentApi({ accounts, bots, allow, lookupBot, publicOrigin, notifications, checkWebhook, integrations, platforms, recipientJoin, supportDb, googleLogin = false }) {
  if (!accounts || !bots || typeof allow !== 'function' || typeof lookupBot !== 'function') throw new Error('Missing API dependencies');
  const origin = new URL(publicOrigin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid origin');
  const getToken = req => /(?:^|;\s*)linebot_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const botIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const webhookUrl = key => new URL(`/webhooks/line/${key}`, origin).href;
  const publicBot = bot => ({ id: bot.id, name: bot.botName, enabled: bot.enabled, webhookUrl: webhookUrl(bot.webhookKey) });
  const lineSetupPath = '/independent-api/platforms/line-setup';
  const platformDeletePath = '/independent-api/platforms/delete';
  const withEventWebhook = ({ webhookToken, ...item }) => ({
    ...item,
    webhookUrl: new URL(eventWebhookPath(item.id), origin).href,
    ...(webhookToken && { privateWebhookUrl: new URL(eventWebhookPath(item.id, webhookToken), origin).href })
  });
  const send = (res,status,body,extra={}) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}); res.end(JSON.stringify(body)); };
  const read = async req => { const parts=[]; let n=0; for await(const chunk of req){n+=chunk.length;if(n>8192) throw Error('too large');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8')); };
  return async function api(req,res) {
    const requestUrl=new URL(req.url,origin);
    const path=requestUrl.pathname;
    const requestedPlatform=requestUrl.searchParams.get('platform');
    async function platformBot(user) {
      if (!requestedPlatform) return null;
      if (!platforms || !botIdPattern.test(requestedPlatform)) throw Error('invalid platform');
      const platform=(await platforms.list(user.id)).find(item => item.id===requestedPlatform);
      if (!platform) throw Error('invalid platform');
      return platform.botId || '00000000-0000-0000-0000-000000000000';
    }
    if (!path.startsWith('/independent-api/')) return false;
    if (req.method === 'POST' && req.headers.origin !== origin.origin) {send(res,403,{error:'來源不正確'});return true;}
    try {
      if(path==='/independent-api/status' && req.method==='GET') {send(res,200,googleLogin?{enabled:true,googleLogin:true}:{enabled:true});return true;}
      if (googleLogin && ['/independent-api/register', '/independent-api/login'].includes(path)) {
        send(res, 410, { error: '請使用 Google 登入接線站。' });
        return true;
      }
      if(path==='/independent-api/register' && req.method==='POST') {
        if(!await allow('register')){send(res,429,{error:'申請過於頻繁，請稍後再試。'});return true;}
        const result=await accounts.register(await read(req));
        send(res,result.status==='created'?201:400,{message:result.status==='created'?'帳號已建立，請登入。':'帳號格式有誤或名稱無法使用。'});return true;
      }
      if(path==='/independent-api/login' && req.method==='POST') {
        if(!await allow('login')){send(res,429,{error:'登入過於頻繁，請稍後再試。'});return true;}
        const result=await accounts.login(await read(req));
        if(result.status!=='ok'){send(res,401,{error:'帳號或密碼不正確，或暫時無法登入。'});return true;}
        send(res,200,{message:'登入成功'},{'Set-Cookie':developerSessionCookie(origin,result.token)});return true;
      }
      if(path==='/independent-api/logout' && req.method==='POST') {
        await accounts.logout(getToken(req));send(res,200,{message:'已登出'},{'Set-Cookie':developerSessionCookie(origin)});return true;
      }
      if(path==='/independent-api/me' && req.method==='GET') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        send(res,200,{username:user.username,displayName:user.display_name,status:user.status,profileComplete:user.profile_complete});return true;
      }
      if (path === '/independent-api/developer-profile' && req.method === 'POST') {
        const user = await accounts.me(getToken(req));
        if (!user) { send(res,401,{error:'請先登入。'}); return true; }
        if (!await allow(`developer-profile:${user.id}`)) { send(res,429,{error:'操作過於頻繁，請稍後再試。'}); return true; }
        const saved = await accounts.saveProfile(user.id,await read(req));
        send(res,saved?200:400,saved?{message:'資料已儲存。'}:{error:'請確認五項資料均已填寫，且沒有超過字數限制。'}); return true;
      }
      const gatedUser = await accounts.me(getToken(req));
      if (gatedUser && !gatedUser.profile_complete) {
        send(res,403,{error:'請先完成開發者資料。'}); return true;
      }
      if (path==='/independent-api/support' || path==='/independent-api/support/image') {
        if (!gatedUser || gatedUser.status!=='active') {send(res,gatedUser?403:401,{error:'請以已啟用的開發者帳號登入。'});return true;}
        if (!supportDb) {send(res,503,{error:'此環境尚未啟用技術支援。'});return true;}
        await supportRequest({db:supportDb,req,res,send,url:requestUrl,user:gatedUser,allow});
        return true;
      }
      if(path==='/independent-api/platforms' || path==='/independent-api/platforms/rename' || path===lineSetupPath || path===platformDeletePath) {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入。'});return true;}
        if(user.status!=='active'){send(res,403,{error:'帳號尚未核准。'});return true;}
        if(!platforms){send(res,503,{error:'數位平台功能尚未開放。'});return true;}
        if(req.method==='GET' && path==='/independent-api/platforms'){send(res,200,{platforms:await platforms.list(user.id)});return true;}
        const lineSetupRequest = path === lineSetupPath;
        if (lineSetupRequest && !botIdPattern.test(requestedPlatform || '')) {
          send(res, 400, { error: '請先選擇要設定的數位平台。' });
          return true;
        }
        if (lineSetupRequest && req.method === 'GET') {
          const result = await platforms.getLineSetup(user.id, requestedPlatform);
          if (result.error) send(res, 404, { error: '找不到可操作的數位平台。' });
          else send(res, 200, result);
          return true;
        }
        if(req.method!=='POST'){send(res,405,{error:'請使用指定的方法。'});return true;}
        if(!await allow('platform-manage') || !await allow(`platform-manage:${user.id}`)){send(res,429,{error:'操作過於頻繁，請稍後再試。'});return true;}
        const data=await read(req);
        if (path === platformDeletePath) {
          const result = await platforms.remove(user.id, data?.id);
          if (result.error === 'invalid') send(res, 400, { error: '請選擇要刪除的平台。' });
          else if (result.error) send(res, 404, { error: '找不到可刪除的平台。' });
          else send(res, 200, result);
          return true;
        }
        if (lineSetupRequest) {
          const result = await platforms.saveLineSetup(user.id, requestedPlatform, data);
          if (result.error === 'provider_required') send(res, 400, { error: '請填寫機器人管理單位（Provider）。' });
          else if (result.error === 'invalid') send(res, 400, { error: '請確認開設資料的格式與字數。' });
          else if (result.error) send(res, 404, { error: '找不到可操作的數位平台。' });
          else send(res, 200, result);
          return true;
        }
        const result=path.endsWith('/rename')?await platforms.rename(user.id,data.id,data.name):await platforms.create(user.id,data.name);
        if(result.error){const messages={invalid:'請確認平台名稱及 Bot。',unavailable:'找不到可操作的平台或 Bot，或此平台已有 Bot。',bot_in_use:'此 Bot 已屬於其他平台。'};send(res,result.error==='invalid'?400:409,{error:messages[result.error]});}
        else send(res,200,result);
        return true;
      }
      if(path==='/independent-api/bots' && req.method==='GET') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        const items=await bots.list(user.id,await platformBot(user));
        send(res,200,{bots:items.map(publicBot)});return true;
      }
      if(path==='/independent-api/bot' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        if(user.status!=='active'){send(res,403,{error:'申請尚未核准，無法設定 LINE Bot。'});return true;}
        const data=await read(req);
        if(typeof data.channelSecret!=='string'||!data.channelSecret.trim()||Buffer.byteLength(data.channelSecret)>4096){send(res,400,{error:'請輸入 Channel secret'});return true;}
        if(typeof data.accessToken!=='string'||!data.accessToken||Buffer.byteLength(data.accessToken)>4096){send(res,400,{error:'請輸入 Channel access token'});return true;}
        const bot=await lookupBot(data.accessToken);if(!bot){send(res,400,{error:'無法驗證 LINE Bot 憑證。'});return true;}
        const scopedBot=await platformBot(user);
        if(scopedBot) {
          const existing=await bots.findByIdentity(user.id,bot.userId);
          const unassigned=scopedBot==='00000000-0000-0000-0000-000000000000';
          if((!unassigned && existing?.id!==scopedBot) || (unassigned && existing && (await platforms.list(user.id)).some(p=>p.botId===existing.id))) {
            send(res,409,{error:'此 Bot 已屬於其他平台，請使用此平台的 Bot。'});return true;
          }
        }
        let saved;
        const linkedBot = scopedBot === '00000000-0000-0000-0000-000000000000' ? null : scopedBot;
        try { saved = await bots.save(user.id, data.channelSecret, data.accessToken, bot, linkedBot); }
        catch (error) { if (error?.code !== '23505') throw error; }
        if (!saved) { send(res, 409, { error: '此 LINE Bot 已綁定其他帳號。' }); return true; }
        if (requestedPlatform && scopedBot==='00000000-0000-0000-0000-000000000000') {
          const attached=await platforms.attach(user.id,requestedPlatform,saved.id);
          if(attached.error){send(res,409,{error:'Bot 已儲存，但無法連結平台；請至我的數位平台確認設定。'});return true;}
        }
        send(res, 200, { message: 'LINE Bot 憑證已儲存，請在 LINE Developers 驗證 Webhook。', bot: publicBot(saved) });
        return true;
      }
      if (path === '/independent-api/bot/webhook-check' && req.method === 'POST' && checkWebhook) {
        const user = await accounts.me(getToken(req));
        if (!user) { send(res, 401, { error: '請先登入。' }); return true; }
        if (user.status !== 'active') { send(res, 403, { error: '帳號尚未核准。' }); return true; }
        const { botId } = await read(req);
        const scopedBot=await platformBot(user); if(scopedBot && botId!==scopedBot){send(res,403,{error:'Bot 不屬於此平台。'});return true;}
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
      if(path==='/independent-api/bot/delete' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入。'});return true;}
        if(user.status!=='active'){send(res,403,{error:'帳號尚未核准。'});return true;}
        if(!await allow('platform-manage') || !await allow(`platform-manage:${user.id}`)){send(res,429,{error:'操作過於頻繁，請稍後再試。'});return true;}
        const data=await read(req);
        if(!platforms || !botIdPattern.test(requestedPlatform || '') || !botIdPattern.test(data?.botId || '') || data.confirmation!=='刪除 LINE Bot') {
          send(res,400,{error:'請確認平台、Bot 與確認文字。'});return true;
        }
        const result=await platforms.removeBot(user.id,requestedPlatform,data.botId);
        send(res,result.ok?200:404,result.ok?{message:'已刪除 LINE Bot，請重新設定。'}:{error:'找不到此平台的 LINE Bot，請重新整理。'});return true;
      }
      if(path==='/independent-api/bot/disable' && req.method==='POST') {
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        const data=await read(req);
        const scopedBot=await platformBot(user); if(scopedBot && data.botId!==scopedBot){send(res,403,{error:'Bot 不屬於此平台。'});return true;}
        if(typeof data.botId!=='string'||!botIdPattern.test(data.botId)){send(res,400,{error:'請選擇要停用的 LINE Bot。'});return true;}
        if(!await bots.disable(user.id,data.botId)){send(res,404,{error:'找不到 LINE Bot。'});return true;}
        send(res,200,{message:'已停用'});return true;
      }
      const integrationAction = /^\/independent-api\/integrations\/([0-9a-f-]{36})\/(edit|enable|disable|rotate|revoke|test|delete)$/i.exec(path);
      if (path === '/independent-api/integrations' || (integrationAction && botIdPattern.test(integrationAction[1]))) {
        const user = await accounts.me(getToken(req));
        if (!user) { send(res, 401, { error: '請先登入。' }); return true; }
        if (user.status !== 'active') { send(res, 403, { error: '帳號尚未核准。' }); return true; }
        if (!integrations) { send(res, 503, { error: '外部串接尚未開放。' }); return true; }
        if (req.method === 'GET' && !integrationAction) {
          const scopedBot = await platformBot(user);
          const includeWebhook = Boolean(scopedBot) && requestUrl.searchParams.get('webhooks') === '1';
          const items = await integrations.list(user.id, scopedBot, includeWebhook, requestedPlatform);
          send(res, 200, { integrations: items.map(withEventWebhook), endpoint: new URL('/api/v1/send', origin).href });
          return true;
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: '請使用指定的 HTTP 方法。' }, { Allow: integrationAction ? 'POST' : 'GET, POST' });
          return true;
        }
        if (!await allow('integration-manage') || !await allow(`integration-manage:${user.id}`)) {
          send(res, 429, { error: '操作過於頻繁，請稍候再試。' }); return true;
        }

        const scopedBot=await platformBot(user);
        let result;
        const action = integrationAction?.[2].toLowerCase();
        const id = integrationAction?.[1];
        if (!action) {
          const input=await read(req);
          if(scopedBot && input.recipientId && !(await notifications.list(user.id,scopedBot)).some(r=>r.id===input.recipientId)){send(res,403,{error:'收件對象不屬於此平台。'});return true;}
          result = await integrations.create(user.id, input, scopedBot, requestedPlatform);
        }
        else if (action === 'delete') {
          if (!scopedBot) { send(res,400,{error:'請先選擇事件所屬的平台。'});return true; }
          result = await integrations.remove(user.id, id, scopedBot, requestedPlatform);
        }
        else if (scopedBot && !(await integrations.list(user.id,scopedBot,false,requestedPlatform)).some(item=>item.id===id)) {send(res,404,{error:'找不到此平台的串接。'});return true;}
        else if (action === 'edit') result = await integrations.edit(user.id, id, await read(req));
        else if (action === 'test') result = await integrations.testSend(user.id, id, (await read(req))?.eventKey);
        else result = await integrations.manage(user.id, id, action);

        const failures = {
          invalid: [400, '請確認名稱、收件對象或測試資料。'],
          unavailable: [404, '找不到可操作的串接，請確認事件狀態與收件對象。'],
          disabled: [403, '請先啟用串接。'],
          target_unavailable: [422, '請選擇自己的啟用中 Bot 與已配對收件人。'],
          event_conflict: [409, '此測試編號已有其他通知。'],
          rate_limited: [429, '發送過於頻繁，請稍候再試。']
        };
        if (result.error) {
          const [status, error] = failures[result.error];
          send(res, status, { error });
        } else {
          const payload = result.webhookToken ? withEventWebhook(result) : result;
          const urlOnly = result.webhookToken && requestUrl.searchParams.get('webhooks') === '1';
          send(res, action ? 200 : 201, urlOnly ? { id: result.id, privateWebhookUrl: payload.privateWebhookUrl } : payload);
        }
        return true;
      }
      if(path.startsWith('/independent-api/notification') || path.startsWith('/independent-api/recipient')) {
        if(!notifications){send(res,503,{error:'通知功能尚未開放。'});return true;}
        const user=await accounts.me(getToken(req));if(!user){send(res,401,{error:'請先登入'});return true;}
        if(user.status!=='active'){send(res,403,{error:'帳號尚未核准。'});return true;}
        if(path==='/independent-api/recipients'&&req.method==='GET'){send(res,200,{recipients:await notifications.list(user.id,await platformBot(user),requestedPlatform && requestUrl.searchParams.get("details")==="1")});return true;}
        if(path==='/independent-api/notifications'&&req.method==='GET'){send(res,200,{notifications:await notifications.history(user.id,await platformBot(user))});return true;}
        if (path === '/independent-api/recipient/pair-status' && req.method === 'GET') {
          const invitationId = requestUrl.searchParams.get('invitation');
          if (!botIdPattern.test(requestedPlatform || '') || !botIdPattern.test(invitationId || '')) {
            send(res, 400, { error: '請選擇平台及有效的配對邀請。' });
            return true;
          }
          if (!notifications.registration) {
            send(res, 503, { error: '目前無法查詢配對進度。' });
            return true;
          }
          const result = await notifications.registration.status(user.id, requestedPlatform, invitationId);
          send(res, result ? 200 : 404, result || { error: '找不到這筆邀請，請在目前平台重新產生配對碼。' });
          return true;
        }
        if(path==='/independent-api/recipient/edit' && req.method==='POST'){
          const bot=await platformBot(user);
          if(!bot){send(res,400,{error:'請先選擇要編輯的平台。'});return true;}
          const data=await read(req);
          const result=await notifications.editRecipient(user.id,bot,data.recipientId,data);
          send(res,result?(result.error?400:200):404,result||{error:'找不到此平台的收件者。'});return true;
        }
        if(path==='/independent-api/recipient/login-profile' && req.method==='POST'){
          if(!recipientJoin){send(res,503,{error:'此環境尚未提供 LINE 登入設定。'});return true;}
          const result=await recipientJoin.saveLoginProfile(user.id,requestedPlatform,await read(req));
          send(res,result?(result.error?400:200):404,result||{error:'找不到可操作的平台。'});
          return true;
        }
        if(path==='/independent-api/recipient/invite' && ['POST','GET'].includes(req.method)){
          if(!recipientJoin){send(res,503,{error:'此環境尚未提供 QR Code 登記。'});return true;}
          const config=await recipientJoin.settings(user.id,requestedPlatform,req.method==='POST'?await read(req):undefined);
          send(res,config?(config.error?400:200):404,config||{error:'請先啟用此平台的 LINE Bot。'});
          return true;
        }
        if(path==='/independent-api/recipient/pair'&&req.method==='POST'){
          if(!await allow('pairing')||!await allow(`pairing:${user.id}`)){send(res,429,{error:'操作過於頻繁，請稍後再試。'});return true;}
          const data=await read(req), scopedBot=await platformBot(user);
          if(scopedBot && data.botId!==scopedBot){send(res,403,{error:'Bot 不屬於此平台。'});return true;}
          const result=await notifications.createPairing(user.id,data.botId,data.label,data);
          send(res,result?200:400,result||{error:'無法產生配對碼，請確認此平台的 Bot 已啟用。'});return true;
        }
        if(path==='/independent-api/recipient/disable'&&req.method==='POST'){
          const data=await read(req), scopedBot=await platformBot(user);
          if(scopedBot && !(await notifications.list(user.id,scopedBot)).some(r=>r.id===data.recipientId)){send(res,404,{error:'找不到此平台的收件對象。'});return true;}
          const ok=await notifications.disable(user.id,data.recipientId);send(res,ok?200:404,ok?{message:'已移除收件對象。'}:{error:'找不到收件對象。'});return true;
        }
        if(path==='/independent-api/notification/send'&&req.method==='POST'){
          if(!await allow('notify')||!await allow(`notify:${user.id}`)){send(res,429,{error:'發送過於頻繁，請稍後再試。'});return true;}
          const data=await read(req),scopedBot=await platformBot(user);
          if(scopedBot && !(await notifications.list(user.id,scopedBot)).some(r=>r.id===data.recipientId)){send(res,403,{error:'收件對象不屬於此平台。'});return true;}
          const result=await notifications.send(user.id,data);send(res,result.error?400:200,result.error?{error:'訊息或收件對象不正確。'}:result);return true;
        }
      }
      send(res,404,{error:'找不到功能'});return true;
    } catch {send(res,503,{error:'服務暫時無法使用'});return true;}
  };
}
