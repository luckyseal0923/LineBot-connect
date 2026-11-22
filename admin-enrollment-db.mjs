// Open the restricted connection only after the owner has scanned the QR code.
export function createEnrollmentDb(makeClient) {
 return {async query(...args) {
  const client=makeClient();
  client.on('error',()=>{});
  try {
   await client.connect();
   const role=(await client.query('select current_user as name,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
   if(!role||role.name!=='linebot_enroller'||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls)throw Error('Unsafe enrollment database role');
   return await client.query(...args);
  } finally { await client.end().catch(()=>{}); }
 }};
}
