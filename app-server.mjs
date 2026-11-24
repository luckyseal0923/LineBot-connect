import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createIndependentApi } from './independent-api.mjs';
import { createWebhookHandler } from './line-webhook.mjs';

export function createLinebotServer({accounts,bots,vault,eventStore,allow,lookupBot,publicOrigin,notifications,checkWebhook}) {
 const api=createIndependentApi({accounts,bots,allow,lookupBot,publicOrigin,notifications,checkWebhook});
 const webhook=createWebhookHandler({findBot:bots.findByWebhook,vault,handleEvents:async(account,events,bot)=>{await eventStore(account,events);if(notifications)await notifications.pair(account,bot,events);}});
 const root=fileURLToPath(new URL('./public/',import.meta.url));
 const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']]]);
 const headers={'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 return createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/health' && ['GET','HEAD'].includes(req.method)){res.writeHead(200,headers);return res.end(req.method==='HEAD'?undefined:'ok');}
  if(path.startsWith('/independent-api/')){try{await api(req,res);}catch{res.writeHead(503,headers);res.end();}return;}
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
