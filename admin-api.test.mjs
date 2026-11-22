import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAdminApi } from './admin-api.mjs';

test('review API rejects missing MFA and cross-origin requests, records approved decision',async()=>{
 const db=new PGlite();let server;
 try{
  await db.exec("create role anon;create role authenticated;create role linebot_runtime;create role linebot_reviewer;set linebot.isolated_test='yes';");
  for(const name of ['005_independent_accounts.sql','006_runtime_grants.sql','007_review_retention.sql'])await db.exec(await readFile(new URL('./db/'+name,import.meta.url),'utf8'));
  await db.exec("insert into linebot_private.accounts(username,display_name,password_salt,password_hash) values('tester','Test','salt','hash')");
  await db.exec('set role linebot_reviewer');
  let auth=null;const origin='http://127.0.0.1:39182';const handler=createAdminApi({reviewDb:db,publicOrigin:origin,authorize:async()=>auth});
  server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(39182,'127.0.0.1',resolve));
  assert.equal((await fetch(origin+'/admin-api/pending')).status,401);
  auth={id:'admin',mfaVerified:false};assert.equal((await fetch(origin+'/admin-api/pending')).status,401);
  auth={id:'admin',mfaVerified:true};assert.equal((await (await fetch(origin+'/admin-api/pending')).json()).accounts.length,1);
  const post=source=>fetch(origin+'/admin-api/review',{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify({username:'tester',status:'active',reason:'approved'})});
  assert.equal((await post('https://other.example')).status,403);
  assert.equal((await post(origin)).status,200);
  assert.equal((await (await fetch(origin+'/admin-api/pending')).json()).accounts.length,0);
  await db.exec('reset role');assert.equal((await db.query('select count(*)::int as n from linebot_private.review_audit')).rows[0].n,1);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
