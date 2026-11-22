export function createAdminRateLimiter({db}){
 if(!db?.query)throw Error('Missing database');
 return async function(scope){
  if(scope!=='admin-login')throw Error('Invalid scope');
  const result=await db.query(`insert into linebot_private.admin_request_limit(scope,window_start,hits) values($1,now(),1)
   on conflict(scope) do update set window_start=case when linebot_private.admin_request_limit.window_start<=now()-interval '1 minute' then now() else linebot_private.admin_request_limit.window_start end,
   hits=case when linebot_private.admin_request_limit.window_start<=now()-interval '1 minute' then 1 else linebot_private.admin_request_limit.hits+1 end returning hits`,[scope]);
  return result.rows[0].hits<=20;
 };
}
