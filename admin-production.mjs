import pg from 'pg';
import { createGoogleOAuth } from './google-oauth.mjs';
import { adminSessionCookie } from './admin-session-api.mjs';
import { checkDatabaseRole } from './db-role-preflight.mjs';
import { createCredentialVault } from './line-webhook.mjs';
import { createAdminPassword } from './admin-password.mjs';
import { createAdminRateLimiter } from './admin-rate-limit.mjs';
import { createAdminServer } from './admin-server.mjs';
import { createVerifiedDatabaseConfig,requireEncryptedDatabaseConnection } from './db-tls-config.mjs';
const {LINEBOT_ADMIN_AUTH_DATABASE_URL,LINEBOT_REVIEW_DATABASE_URL,LINEBOT_ADMIN_ENCRYPTION_KEY,ADMIN_PUBLIC_ORIGIN}=process.env;
if(!LINEBOT_ADMIN_AUTH_DATABASE_URL||!LINEBOT_REVIEW_DATABASE_URL||!/^[A-Za-z0-9+/]{43}=$/.test(LINEBOT_ADMIN_ENCRYPTION_KEY||'')||!ADMIN_PUBLIC_ORIGIN)throw Error('Administrator configuration is incomplete');
const authDb=new pg.Pool(createVerifiedDatabaseConfig(LINEBOT_ADMIN_AUTH_DATABASE_URL,process.env.LINEBOT_DB_CA_CERT_BASE64,{max:2,connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'linebot_admin_auth'}));
const reviewDb=new pg.Pool(createVerifiedDatabaseConfig(LINEBOT_REVIEW_DATABASE_URL,process.env.LINEBOT_DB_CA_CERT_BASE64,{max:2,connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'linebot_review'}));
for(const db of [authDb,reviewDb]) db.on('error',()=>console.error('Idle administrator database connection closed'));
for(const db of [authDb,reviewDb]) await requireEncryptedDatabaseConnection(db);
async function roleOf(db){return (await db.query('select current_user as name,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname=current_user')).rows[0];}
const authRole=await roleOf(authDb),reviewRole=await roleOf(reviewDb);
for(const role of [authRole,reviewRole])if(!role||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls)throw Error('Unsafe administrator database role');
if(authRole.name===reviewRole.name)throw Error('Administrator roles must be separate');
if(!(await checkDatabaseRole(authDb,'linebot_admin_auth')).safe || !(await checkDatabaseRole(reviewDb,'linebot_reviewer')).safe)throw Error('Administrator database roles failed isolation checks');
const vault=createCredentialVault(Buffer.from(LINEBOT_ADMIN_ENCRYPTION_KEY,'base64'),{context:'admin-totp'});
const mfa=createAdminPassword({db:authDb});
const allow=createAdminRateLimiter({db:authDb});
const googleSignIn=process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? createGoogleOAuth({
  admin:true, login:mfa.loginWithGoogle, sessionCookie:adminSessionCookie, successPath:'/#overview', errorPath:'/#overview?google=',
  key:Buffer.from(LINEBOT_ADMIN_ENCRYPTION_KEY,'base64'), allow, publicOrigin:ADMIN_PUBLIC_ORIGIN,
  redirectOrigin:process.env.PUBLIC_ORIGIN || 'https://linebot-next.wfhai.org',
  clientId:process.env.GOOGLE_CLIENT_ID, clientSecret:process.env.GOOGLE_CLIENT_SECRET
}) : null;
const server=createAdminServer({authDb,reviewDb,vault,mfa,allow,publicOrigin:ADMIN_PUBLIC_ORIGIN,googleSignIn});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Admin service ready'));
const cleanup=setInterval(()=>authDb.query('select linebot_private.purge_admin_login_audit()').catch(()=>console.error('Admin login audit cleanup failed')),60*60*1000);
cleanup.unref();
const stop=()=>{clearInterval(cleanup);server.close(()=>Promise.all([authDb.end(),reviewDb.end()]));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
