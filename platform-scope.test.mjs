import {test} from 'node:test';import {strict as assert} from 'node:assert';import {createServer} from 'node:http';import {createIndependentApi} from './independent-api.mjs';
test('a scoped bot setup cannot alter a bot attached to another platform',async()=>{
 const platformA='11111111-1111-4111-8111-111111111111', platformB='22222222-2222-4222-8222-222222222222';
 const botA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',botB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';let saved=0;
 const platforms={list:async()=>[{id:platformA,botId:botA},{id:platformB,botId:botB}]};
 const bots={findByIdentity:async(_account,id)=>({id:id==='lineA'?botA:botB}),save:async()=>{saved++;return {id:botA,botName:'A',webhookKey:'fake',enabled:true}}};
 const api=createIndependentApi({accounts:{me:async()=>({id:'account',status:'active',profile_complete:true})},bots,platforms,allow:async()=>true,lookupBot:async token=>({userId:token}),publicOrigin:'http://127.0.0.1:39187'});
 const server=createServer((req,res)=>api(req,res));await new Promise(resolve=>server.listen(39187,'127.0.0.1',resolve));
 try{const send=(platform,token)=>fetch(`http://127.0.0.1:39187/independent-api/bot?platform=${platform}`,{method:'POST',headers:{Origin:'http://127.0.0.1:39187','Content-Type':'application/json'},body:JSON.stringify({channelSecret:'secret',accessToken:token})});
 assert.equal((await send(platformA,'lineB')).status,409);assert.equal(saved,0);
 assert.equal((await send(platformA,'lineA')).status,200);assert.equal(saved,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
