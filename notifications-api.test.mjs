import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {createIndependentApi} from './independent-api.mjs';

test('notification routes require an approved session and same-origin writes',async()=>{
 const token='a'.repeat(43),id='11111111-1111-4111-8111-111111111111';let calls=[];
 const accounts={me:async value=>value===token?{id,status:'active',profile_complete:true}:null};
 const notifications={list:async owner=>{calls.push(owner);return [];},send:async(owner,body)=>{calls.push(owner);return {status:'accepted'};}};
 const bots={},allow=async()=>true,lookupBot=async()=>null;
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 server.on('request',createIndependentApi({accounts,bots,allow,lookupBot,publicOrigin:origin,notifications}));
 try{
  assert.equal((await fetch(origin+'/independent-api/recipients')).status,401);
  assert.equal((await fetch(origin+'/independent-api/notification/send',{method:'POST',headers:{Origin:'http://evil.invalid',Cookie:`linebot_sid=${token}`,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/independent-api/recipients',{headers:{Cookie:`linebot_sid=${token}`}})).status,200);
  assert.equal((await fetch(origin+'/independent-api/notification/send',{method:'POST',headers:{Origin:origin,Cookie:`linebot_sid=${token}`,'Content-Type':'application/json'},body:'{}'})).status,200);
  assert.deepEqual(calls,[id,id]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
