import pg from 'pg';
import { startSupportMail } from './support-mail.mjs';
import { createRecipientJoin } from './recipient-join.mjs';
import { checkDatabaseRole } from './db-role-preflight.mjs';
import { createAccounts } from './accounts.mjs';
import { createCredentialVault } from './line-webhook.mjs';
import { createBotStore } from './bot-store.mjs';
import { createEventStore } from './event-store.mjs';
import { createRequestLimiter } from './request-limiter.mjs';
import { createLineBotLookup, createLineWebhookCheck } from './line-client.mjs';
import { createLinebotServer } from './app-server.mjs';
import { createVerifiedDatabaseConfig,requireEncryptedDatabaseConnection } from './db-tls-config.mjs';
import { createNotifications } from './notifications.mjs';
import { createLineQuotaPoller } from './line-quota.mjs';
import { createExternalIntegrations, hasExternalIntegrationSchema } from './external-integrations.mjs';
import { createPlatformServices } from './platform-services.mjs';
import { createGoogleSignIn } from './google-signin.mjs';

const { LINEBOT_DATABASE_URL, LINEBOT_ENCRYPTION_KEY, PUBLIC_ORIGIN }=process.env;
if(!LINEBOT_DATABASE_URL || !/^[A-Za-z0-9+/]{43}=$/.test(LINEBOT_ENCRYPTION_KEY || '') || !PUBLIC_ORIGIN) throw Error('LineBOT configuration is incomplete');
const key=Buffer.from(LINEBOT_ENCRYPTION_KEY,'base64');
const db=new pg.Pool(createVerifiedDatabaseConfig(LINEBOT_DATABASE_URL,process.env.LINEBOT_DB_CA_CERT_BASE64,{max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,statement_timeout:5000,application_name:'linebot_connection'}));
db.on('error',()=>console.error('Idle database connection closed'));
await requireEncryptedDatabaseConnection(db);
const identity=await db.query(`select current_user as name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname=current_user`);
const role=identity.rows[0];
if(!role || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) throw Error('Unsafe database role');
if(!(await checkDatabaseRole(db,'linebot_runtime')).safe) throw Error('Database role failed isolation checks');
const accounts=createAccounts({db});
startSupportMail(db,key);
const platforms=createPlatformServices({db});
const vault=createCredentialVault(key);
const events=createEventStore({db,vault:createCredentialVault(key,{context:'line-event',maxBytes:32000})});
const tokenVault=createCredentialVault(key,{context:'channel-access-token'});
const recipientVault=createCredentialVault(key,{context:'line-recipient'});
const bots=createBotStore({db,vault,tokenVault});
const allow=createRequestLimiter({db});
const integrationReady=await hasExternalIntegrationSchema(db);
const integrations=integrationReady ? createExternalIntegrations({
 db,key,recipientVault,tokenVault,allow,messageVault:createCredentialVault(key,{context:'integration-message',maxBytes:8000})
}) : undefined;
const notifications=createNotifications({db,key,recipientVault,tokenVault,allow,publicOrigin:PUBLIC_ORIGIN,includeIntegrations:integrationReady});
const pollLineQuota=createLineQuotaPoller({db,tokenVault});
const recipientJoin=createRecipientJoin({db,key,recipientVault,tokenVault,publicOrigin:PUBLIC_ORIGIN,allow});
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const googleSignIn = GOOGLE_CLIENT_ID || GOOGLE_CLIENT_SECRET ? createGoogleSignIn({
  accounts, key, allow, publicOrigin:PUBLIC_ORIGIN, clientId:GOOGLE_CLIENT_ID, clientSecret:GOOGLE_CLIENT_SECRET
}) : undefined;
const server=createLinebotServer({adminOrigin:process.env.ADMIN_PUBLIC_ORIGIN || 'https://linebot-admin.wfhai.org',supportDb:db,recipientJoin,accounts,bots,vault,eventStore:events,allow,lookupBot:createLineBotLookup(),publicOrigin:PUBLIC_ORIGIN,notifications,checkWebhook:createLineWebhookCheck(),integrations,platforms,googleSignIn});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('LineBOT service ready'));
const cleanup=setInterval(()=>db.query('select linebot_private.purge_expired_events()').catch(()=>console.error('Event cleanup failed')),60*60*1000);
cleanup.unref();
const notificationCleanup=setInterval(async()=>{try{
 await db.query("delete from linebot_private.pairing_codes where id in (select id from linebot_private.pairing_codes where expires_at<now()-interval '1 day' limit 500)");
 await db.query("delete from linebot_private.notifications where id in (select id from linebot_private.notifications where created_at<now()-interval '30 days' limit 500)");
 await db.query(`delete from linebot_private.request_limits
  where split_part(scope,':',1) in ('notify','pairing','pair-user','pair-bot','recipient-join','external-integration','external-account','integration-manage','platform-manage')
  and window_start<now()-interval '1 day'`);
 }catch{console.error('Notification cleanup failed');}},60*60*1000);
notificationCleanup.unref();
const quotaTimer=setInterval(()=>pollLineQuota().catch(()=>console.error('LINE usage refresh failed')),30*1000);
quotaTimer.unref();
let stopping=false;
let dispatch;
const integrationTimer=integrations && setInterval(()=>{
 if(dispatch) return;
 dispatch=(async()=>{
  for (let remaining=5; remaining>0 && !stopping; remaining--) {
   if (!await integrations.runNext()) break;
  }
 })().catch(()=>console.error('Integration delivery failed')).finally(()=>{dispatch=undefined;});
},3000);
integrationTimer?.unref();
const shutdown=()=>{
 stopping=true;
 clearInterval(cleanup);clearInterval(notificationCleanup);clearInterval(quotaTimer);clearInterval(integrationTimer);
 server.close(async()=>{await dispatch;await db.end();});
};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
