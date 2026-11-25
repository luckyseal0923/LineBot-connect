import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createIndependentApi } from './independent-api.mjs';
import { createWebhookHandler } from './line-webhook.mjs';
import { createExternalApi } from './external-api.mjs';

export function createLinebotServer({accounts,bots,vault,eventStore,allow,lookupBot,publicOrigin,notifications,checkWebhook,integrations,platforms,recipientJoin}) {
 const api=createIndependentApi({accounts,bots,allow,lookupBot,publicOrigin,notifications,checkWebhook,integrations,platforms,recipientJoin});
 const externalApi=createExternalApi({integrations,allow});
 const webhook=createWebhookHandler({findBot:bots.findByWebhook,vault,handleEvents:async(account,events,bot)=>{await eventStore(account,events);if(notifications)await notifications.pair(account,bot,events);}});
 const root=fileURLToPath(new URL('./public/',import.meta.url));
 const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']]]);
 for (const [path,type] of [['/recipient-join.js','text/javascript'],['/recipient-join.css','text/css']]) files.set(path,[path.slice(1),type+'; charset=utf-8']);
 files.set('/pair-register',['pair-register.html','text/html; charset=utf-8']);
 files.set('/pair-register.js',['pair-register.js','text/javascript; charset=utf-8']);
 files.set('/connection-guide',['connection-guide.html','text/html; charset=utf-8']);
 files.set('/line-setup-options.js',['line-setup-options.js','text/javascript; charset=utf-8']);
 files.set('/line-login-setup.md', ['line-login-setup.md', 'text/plain; charset=utf-8']);
 files.set('/line-bot-setup.md', ['line-bot-setup.md', 'text/plain; charset=utf-8']);
 const headers={'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 return createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if (path==='/pair-registration' && notifications?.registration) {
    try { return await notifications.registration.handle(req,res); }
    catch { res.writeHead(503,{...headers,'Content-Type':'application/json'});return res.end(JSON.stringify({error:'暫時無法登記，請再試一次。'})); }
  }
  const registration = /^\/(join|recipient-registration)\/([a-f0-9-]{36})\/?$/.exec(path);
  if(registration && recipientJoin) {
   if(registration[1]==='recipient-registration') {
    try { return await recipientJoin.handle(req,res,registration[2]); }
    catch { res.writeHead(503,{...headers,'Content-Type':'application/json'});return res.end(JSON.stringify({error:'暫時無法連線，請稍後重試。'})); }
   }
   if(req.method!=='GET'){res.writeHead(405,headers);return res.end();}
   const pageHeaders={...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net https://*.line-apps.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
   try { const page=await readFile(join(root,'recipient-join.html'));res.writeHead(200,pageHeaders);return res.end(page); }
   catch { res.writeHead(503,headers);return res.end(); }
  }
  if(path==='/health' && ['GET','HEAD'].includes(req.method)){res.writeHead(200,headers);return res.end(req.method==='HEAD'?undefined:'ok');}
  if(path.startsWith('/independent-api/')){try{await api(req,res);}catch{res.writeHead(503,headers);res.end();}return;}
  if(path.startsWith('/api/v1/'))return externalApi(req,res,path);
  const match=/^\/webhooks\/line\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
  if(match){
   if(req.method!=='POST'){res.writeHead(405,{...headers,Allow:'POST'});return res.end();}
   let size=0;const chunks=[];
   try{for await(const chunk of req){size+=chunk.length;if(size>1048576){res.writeHead(413,headers);return res.end();}chunks.push(chunk);}
    const result=await webhook({webhookKey:match[1],rawBody:Buffer.concat(chunks),signature:req.headers['x-line-signature']});res.writeHead(result.status,headers);return res.end();
   }catch{res.writeHead(503,headers);return res.end();}
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{...headers,Allow:'GET, HEAD'});return res.end();}
  const file=files.get(path);if(!file){res.writeHead(404,headers);return res.end();}
  try{const body=await readFile(join(root,file[0]));res.writeHead(200,{...headers,'Content-Type':file[1]});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500,headers);res.end();}
 });
}
