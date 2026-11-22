// Run as the prospective restricted role, never as postgres or service_role.
// Reports counts only; does not inspect table contents or change privileges.
export async function checkDatabaseRole(db,expectedRole){
 if(!db?.query||!['linebot_runtime','linebot_reviewer','linebot_admin_auth','linebot_enroller'].includes(expectedRole))throw Error('Invalid preflight configuration');
 const role=(await db.query(`select r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,
   (select count(*)::int from pg_catalog.pg_auth_members m where m.member=r.oid) as memberships
   from pg_catalog.pg_roles r where r.rolname=current_user`)).rows[0];
 if(!role||role.rolname!==expectedRole||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls||Number(role.memberships)!==0)return {safe:false,reason:'unsafe_role'};
 const objects=(await db.query(`select count(*)::int as n from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','p','v','m','f') and n.nspname not in ('linebot_private','pg_catalog','information_schema')
   and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
   and pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
   and pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`)).rows[0].n;
 const functions=(await db.query(`select count(*)::int as n from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where p.prosecdef and n.nspname not in ('linebot_private','pg_catalog','information_schema') and n.nspname not like 'pg_temp_%'
   and pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') and pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')`)).rows[0].n;
 return {safe:Number(objects)===0&&Number(functions)===0,otherObjects:Number(objects),otherSecurityDefinerFunctions:Number(functions)};
}
