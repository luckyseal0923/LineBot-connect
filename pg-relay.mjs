import net from 'node:net';
// Forward only PostgreSQL traffic to one configured destination. Run in a
// restricted container attached to a private application network and the
// Supabase stack network; never publish a host port.
export function createPgRelay({targetHost,targetPort=5432,maxConnections=4,idleTimeoutMs=30000,connect=net.createConnection}){
 if(typeof targetHost!=='string'||!/^supabase-db-[a-z0-9]+$/.test(targetHost)||!Number.isInteger(targetPort)||targetPort!==5432||!Number.isInteger(maxConnections)||maxConnections<1||maxConnections>8)throw Error('Invalid relay configuration');
 let active=0;
 return net.createServer(client=>{
  if(active>=maxConnections){client.destroy();return;}
  active++;let cleaned=false;let upstream;
  const finish=()=>{if(cleaned)return;cleaned=true;active--;client.destroy();upstream?.destroy();};
  client.setTimeout(idleTimeoutMs,finish);client.on('error',finish);client.on('close',finish);
  upstream=connect({host:targetHost,port:targetPort});
  upstream.setTimeout(idleTimeoutMs,finish);upstream.on('error',finish);upstream.on('close',finish);
  client.pipe(upstream);upstream.pipe(client);
 });
}
