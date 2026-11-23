import { createHash, createHmac, randomBytes } from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=s=>createHash('sha256').update(s).digest('hex');

// The only permitted target is a user who redeemed a one-time code in this bot's signed webhook.
export function createNotifications({db,recipientVault,tokenVault,key,fetchImpl=fetch}) {
 if(!db?.query||!recipientVault?.open||!tokenVault?.open||!Buffer.isBuffer(key)||key.length!==32)throw Error('Missing notification dependencies');
 const lineHash=(bot,id)=>createHmac('sha256',key).update(`recipient:v1:${bot}:${id}`).digest('hex');
 async function pair(account,bot,events){
  if(!uuid.test(bot||''))return;
  for(const event of events){
   const user=event?.source?.userId;
   if(event?.type==='unfollow' && event.source?.type==='user' && /^U[0-9a-f]{32}$/.test(user||'') && Number.isFinite(event.timestamp)){
    await db.query("update linebot_private.recipients set active=false,encrypted_line_id='{}'::jsonb where account_id=$1 and bot_id=$2 and line_hash=$3 and created_at<=to_timestamp($4::double precision/1000)",[account,bot,lineHash(bot,user),event.timestamp]);continue;
   }
   const code=event?.type==='message'&&event.source?.type==='user'&&event.message?.type==='text'&&/^綁定 ([0-9a-f]{32})$/.exec(event.message.text||'');
   if(!code||!/^U[0-9a-f]{32}$/.test(user||''))continue;
   const encrypted=JSON.stringify(recipientVault.seal(account,user));
   await db.query(`with claimed as (update linebot_private.pairing_codes set consumed_at=now()
      where account_id=$1 and bot_id=$2 and code_hash=$3 and consumed_at is null and expires_at>now() returning label)
     insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label)
     select $1,$2,$4,$5::jsonb,label from claimed
     on conflict(bot_id,line_hash) do update set encrypted_line_id=excluded.encrypted_line_id,label=excluded.label,active=true,created_at=now()
     where linebot_private.recipients.account_id=excluded.account_id`,[account,bot,digest(code[1]),lineHash(bot,user),encrypted]);
  }
 }
 async function createPairing(account,bot,label){
  if(!uuid.test(bot||'')||typeof label!=='string'||!label.trim()||label.trim().length>80)return null;
  const code=randomBytes(16).toString('hex');
  const result=await db.query(`insert into linebot_private.pairing_codes(account_id,bot_id,code_hash,label,expires_at)
   select $1,id,$3,$4,now()+interval '10 minutes' from linebot_private.bot_credentials where id=$2 and account_id=$1 and enabled=true returning id`,[account,bot,digest(code),label.trim()]);
  return result.rowCount?{message:`綁定 ${code}`,expiresMinutes:10}:null;
 }
 async function list(account){return (await db.query(`select r.id,r.bot_id as "botId",r.label,b.bot_name as "botName" from linebot_private.recipients r join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id where r.account_id=$1 and r.active and b.enabled order by r.created_at desc limit 200`,[account])).rows;}
 async function disable(account,id){if(!uuid.test(id||''))return false;return (await db.query("update linebot_private.recipients set active=false,encrypted_line_id='{}'::jsonb where id=$1 and account_id=$2 and active returning id",[id,account])).rowCount===1;}
 async function history(account){return (await db.query(`select n.id,n.status,n.line_status as "lineStatus",n.created_at as "createdAt",b.bot_name as "botName",r.label from linebot_private.notifications n join linebot_private.bot_credentials b on b.id=n.bot_id join linebot_private.recipients r on r.id=n.recipient_id where n.account_id=$1 order by n.created_at desc limit 100`,[account])).rows;}
 async function send(account,{recipientId,message,requestId}){
  if(!uuid.test(recipientId||'')||!uuid.test(requestId||'')||typeof message!=='string'||!message.trim()||message.length>2000)return {error:'invalid'};
  const r=await db.query(`select r.bot_id,r.encrypted_line_id,b.encrypted_access_token from linebot_private.recipients r join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id join linebot_private.accounts a on a.id=r.account_id where r.id=$1 and r.account_id=$2 and r.active and b.enabled and a.status='active'`,[recipientId,account]);
  if(r.rowCount!==1)return {error:'recipient'};
  const row=r.rows[0];
  const inserted=await db.query(`insert into linebot_private.notifications(id,account_id,bot_id,recipient_id,status) values($1,$2,$3,$4,'sending') on conflict(id) do nothing returning id`,[requestId,account,row.bot_id,recipientId]);
  if(!inserted.rowCount){const old=await db.query('select status from linebot_private.notifications where id=$1 and account_id=$2',[requestId,account]);return old.rowCount?{status:old.rows[0].status}:{error:'invalid'};}
  let status='unknown',code=null;
  try {
   const to=recipientVault.open(account,row.encrypted_line_id),token=tokenVault.open(account,row.encrypted_access_token);
   const response=await fetchImpl('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':requestId},body:JSON.stringify({to,messages:[{type:'text',text:message}]}),redirect:'error',signal:AbortSignal.timeout(10000)});
   code=response.status;status=response.ok||(code===409&&response.headers.get('x-line-accepted-request-id'))?'accepted':code>=400&&code<500?'failed':'unknown';
  }catch{status='unknown';}
  await db.query('update linebot_private.notifications set status=$1,line_status=$2,completed_at=now() where id=$3 and account_id=$4',[status,code,requestId,account]);
  return {status};
 }
 return {pair,createPairing,list,disable,history,send};
}
