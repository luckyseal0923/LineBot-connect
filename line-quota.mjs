// Query at most one active bot per run, always using LINE's fixed HTTPS endpoint.
export function createLineQuotaPoller({db,tokenVault,fetchImpl=fetch}){
 if(!db?.query||!tokenVault?.open)throw Error('Missing LINE quota dependencies');
 let busy=false;
 return async function poll(){
  if(busy)return;busy=true;
  try{
   const result=await db.query(`select b.id,b.account_id,b.encrypted_access_token from linebot_private.bot_credentials b
    join linebot_private.accounts a on a.id=b.account_id
    left join linebot_private.bot_monthly_usage u on u.bot_id=b.id
    where b.enabled and a.status='active' and (u.checked_at is null or u.checked_at<now()-interval '30 minutes')
    order by u.checked_at nulls first,b.id limit 1`);
   if(!result.rowCount)return;
   const bot=result.rows[0];let usage=null,status='unavailable';
   try{
    const token=tokenVault.open(bot.account_id,bot.encrypted_access_token);
    const response=await fetchImpl('https://api.line.me/v2/bot/message/quota/consumption',{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(response.ok){const body=await response.json();if(Number.isSafeInteger(body.totalUsage)&&body.totalUsage>=0){usage=body.totalUsage;status='ok';}}
   }catch{}
   await db.query(`insert into linebot_private.bot_monthly_usage(bot_id,total_usage,checked_at,status)
    values($1,$2,now(),$3) on conflict(bot_id) do update set total_usage=excluded.total_usage,checked_at=excluded.checked_at,status=excluded.status`,[bot.id,usage,status]);
  }finally{busy=false;}
 };
}
