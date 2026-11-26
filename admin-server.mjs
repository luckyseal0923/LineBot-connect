import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAdminApi } from './admin-api.mjs';
import { createAdminSessionApi } from './admin-session-api.mjs';
export function createAdminServer({authDb,reviewDb,vault,mfa,allow,publicOrigin}){
 const session=createAdminSessionApi({mfa,allow,publicOrigin});
 const api=createAdminApi({reviewDb,authorize:session.authorize,publicOrigin});
 const paths=new Map([['/',['admin.html','text/html']],['/support.js',['support.js','text/javascript']],['/admin.js',['admin.js','text/javascript']],['/styles.css',['styles.css','text/css']]]);
 const headers={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 return createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/admin-session/')){await session.handle(req,res);return;}
  if(path.startsWith('/admin-api/')){await api(req,res);return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});return res.end();}
  const item=paths.get(path);if(!item){res.writeHead(404,headers);return res.end();}
  try{const body=await readFile(new URL('./public/'+item[0],import.meta.url));res.writeHead(200,{...headers,'Content-Type':item[1]+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(500,headers);res.end();}
 });
}
