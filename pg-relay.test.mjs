import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import net from 'node:net';
import { once } from 'node:events';
import { createPgRelay } from './pg-relay.mjs';
test('database relay rejects arbitrary destinations and excessive connection settings',()=>{
 assert.throws(()=>createPgRelay({targetHost:'google.com'}));
 assert.throws(()=>createPgRelay({targetHost:'supabase-db-abc',targetPort:443}));
 assert.throws(()=>createPgRelay({targetHost:'supabase-db-abc',maxConnections:100}));
});
test('relay forwards only to its configured destination and enforces connection cap',async()=>{
 const target=net.createServer(socket=>socket.on('data',data=>socket.write(data)));
 await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
 let calls=0;const relay=createPgRelay({targetHost:'supabase-db-abc',maxConnections:1,connect:opts=>{calls++;assert.equal(opts.host,'supabase-db-abc');assert.equal(opts.port,5432);return net.createConnection({host:'127.0.0.1',port:target.address().port});}});
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
 const first=net.createConnection({host:'127.0.0.1',port:relay.address().port});
 try{
  await once(first,'connect');first.write('synthetic');assert.equal((await once(first,'data'))[0].toString(),'synthetic');
  const second=net.createConnection({host:'127.0.0.1',port:relay.address().port});second.on('error',()=>{});await once(second,'close');assert.equal(calls,1);
 } finally {first.destroy();await new Promise(resolve=>relay.close(resolve));await new Promise(resolve=>target.close(resolve));}
});
