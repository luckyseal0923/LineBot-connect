// Requires an independently authenticated MFA administrator session and a
// separate restricted reviewer database connection; disabled unless injected.
export function createAdminApi({reviewDb,authorize,publicOrigin}) {
 if (!reviewDb?.query || typeof authorize!=='function') throw new Error('Missing review authorization');
 const origin=new URL(publicOrigin);
 const send=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));};
 return async function(req,res) {
  const path=new URL(req.url,origin).pathname;
  if(!path.startsWith('/admin-api/')) return false;
  if(req.method==='POST' && req.headers.origin!==origin.origin){send(res,403,{error:'來源不正確'});return true;}
  try {
   const admin=await authorize(req);
   if(!admin?.id || (admin.mfaVerified!==true && admin.passwordVerified!==true)){send(res,401,{error:'請先登入管理員帳號。'});return true;}
   if(path==='/admin-api/pending' && req.method==='GET'){
    const result=await reviewDb.query("select username,display_name,status,created_at from linebot_private.accounts where status='pending' order by created_at limit 100");
    send(res,200,{accounts:result.rows});return true;
   }
   if(path==='/admin-api/monitor' && req.method==='GET'){
    const [accounts,bots,notifications,audit,summary]=await Promise.all([
     reviewDb.query('select * from linebot_private.admin_accounts order by created_at desc limit 200'),
     reviewDb.query('select * from linebot_private.admin_bots order by updated_at desc limit 200'),
     reviewDb.query('select * from linebot_private.admin_notifications order by created_at desc limit 200'),
     reviewDb.query('select * from linebot_private.admin_review_audit order by reviewed_at desc limit 100'),
     reviewDb.query(`select (select count(*)::int from linebot_private.admin_accounts) as accounts,
      (select count(*)::int from linebot_private.admin_accounts where status='pending') as pending,
      (select count(*)::int from linebot_private.admin_bots where enabled) as active_bots,
      (select count(*)::int from linebot_private.admin_notifications where created_at>=now()-interval '30 days') as notifications_30d,
      (select count(*)::int from linebot_private.admin_notifications where created_at>=now()-interval '30 days' and status in ('failed','unknown')) as attention_30d`)
    ]);
    send(res,200,{accounts:accounts.rows,bots:bots.rows,notifications:notifications.rows,audit:audit.rows,summary:summary.rows[0]});return true;
   }
   if(path==='/admin-api/review' && req.method==='POST'){
    let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>8192){send(res,413,{error:'資料過大'});return true;}chunks.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(res,400,{error:'資料格式不正確'});return true;}
    if(typeof data.username!=='string'||!/^[a-z0-9_]{3,32}$/.test(data.username)||!['active','disabled'].includes(data.status)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.trim().length>500){send(res,400,{error:'請確認帳號、決定和原因。'});return true;}
    const result=await reviewDb.query('select linebot_private.review_account($1,$2,$3) as changed',[data.username,data.status,data.reason.trim()]);
    send(res,result.rows[0]?.changed?200:409,{message:result.rows[0]?.changed?'已記錄審核決定。':'沒有變更，請重新整理。'});return true;
   }
   send(res,404,{error:'找不到功能'});return true;
  }catch{send(res,503,{error:'管理服務暫時無法使用。'});return true;}
 };
}
