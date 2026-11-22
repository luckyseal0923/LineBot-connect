import { lookup } from 'node:dns/promises';
import { createPgRelay } from './pg-relay.mjs';
const {LINEBOT_RELAY_BIND_NAME,LINEBOT_DB_HOST}=process.env;
if(LINEBOT_RELAY_BIND_NAME!=='linebot-pg-relay-private')throw Error('Invalid relay bind');
const bind=await lookup(LINEBOT_RELAY_BIND_NAME,{family:4});
const server=createPgRelay({targetHost:LINEBOT_DB_HOST,maxConnections:8});
server.listen(5432,bind.address,()=>console.log('Database relay ready'));
process.once('SIGTERM',()=>server.close());
