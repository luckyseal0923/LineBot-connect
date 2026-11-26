import { supportRequest } from './support.mjs';
const lists = {
  accounts: { view: 'admin_accounts', order: 'created_at desc, username' },
  bots: { view: 'admin_bots', order: 'updated_at desc, username, bot_name' },
  notifications: { view: 'admin_notifications', order: 'created_at desc, username, bot_name, recipient_label' }
};
const accountStatuses = ['pending', 'active', 'disabled'];
const notificationStatuses = ['accepted', 'failed', 'unknown', 'sending', 'queued', 'cancelled'];
const accountPattern = /^[a-z0-9_]{3,32}$/;
const pageSize = 50;
const summarySql = `select (select count(*)::int from linebot_private.admin_accounts) as accounts,
  (select count(*)::int from linebot_private.admin_accounts where status='pending') as pending,
  (select count(*)::int from linebot_private.admin_bots where enabled) as active_bots,
  (select count(*)::int from linebot_private.admin_notifications where created_at>=now()-interval '30 days') as notifications_30d,
  (select count(*)::int from linebot_private.admin_notifications
    where created_at>=now()-interval '30 days' and status in ('failed','unknown')) as attention_30d`;
const auditSql = 'select * from linebot_private.admin_review_audit order by reviewed_at desc limit 100';

function validDate(value) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function readFilteredPage(reviewDb, name, params) {
  const { view, order } = lists[name];
  const pageText = params.get('page') || '1';
  if (!/^[1-9]\d{0,3}$/.test(pageText)) return null;
  const page = Number(pageText);
  const username = params.get('username');
  const status = params.get('status');
  const values = [];
  const clauses = [];
  const bind = value => `$${values.push(value)}`;
  if (username) {
    if (!accountPattern.test(username)) return null;
    clauses.push(`username = ${bind(username)}`);
  }

  if (name === 'accounts') {
    const query = params.get('q')?.trim();
    if (query) {
      if (query.length > 100) return null;
      const term = bind(query);
      clauses.push(`(strpos(lower(username), lower(${term})) > 0 or strpos(lower(display_name), lower(${term})) > 0)`);
    }
    if (status) {
      if (!accountStatuses.includes(status)) return null;
      clauses.push(`status = ${bind(status)}`);
    }
  }
  if (name === 'notifications') {
    const botName = params.get('bot');
    const from = params.get('from');
    const to = params.get('to');
    if (botName) {
      if (botName.length > 200) return null;
      clauses.push(`bot_name = ${bind(botName)}`);
    }
    if (status === 'attention') {
      clauses.push("status in ('failed', 'unknown')");
    } else if (status) {
      if (!notificationStatuses.includes(status)) return null;
      clauses.push(`status = ${bind(status)}`);
    }
    if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) return null;
    if (from) clauses.push(`created_at >= ${bind(`${from}T00:00:00+08:00`)}::timestamptz`);
    if (to) clauses.push(`created_at < ((${bind(to)}::date + 1)::timestamp at time zone 'Asia/Taipei')`);
  }

  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const { rows } = await reviewDb.query(`select * from linebot_private.${view} ${where}
    order by ${order} limit ${pageSize + 1} offset ${bind((page - 1) * pageSize)}`, values);
  return { items: rows.slice(0, pageSize), page, hasNext: page < 9999 && rows.length > pageSize };
}

// The dedicated reviewer connection can read the existing management views.
export function createAdminApi({reviewDb,authorize,publicOrigin}) {
 if (!reviewDb?.query || typeof authorize!=='function') throw new Error('Missing review authorization');
 const origin=new URL(publicOrigin);
 const send=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));};
 return async function(req,res) {
  const { pathname: path, searchParams } = new URL(req.url, origin);
  if(!path.startsWith('/admin-api/')) return false;
  if(req.method==='POST' && req.headers.origin!==origin.origin){send(res,403,{error:'來源不正確'});return true;}
  try {
   const admin=await authorize(req);
   if(!admin?.id || (admin.mfaVerified!==true && admin.passwordVerified!==true)){send(res,401,{error:'請先登入管理員帳號。'});return true;}
   if (path==='/admin-api/support' || path==='/admin-api/support/image') {
     await supportRequest({db:reviewDb,req,res,send,url:new URL(req.url,origin)});
     return true;
   }
   if(path==='/admin-api/pending' && req.method==='GET'){
    const pending = " from linebot_private.accounts where status='pending' order by created_at limit 100";
    const columns = 'select username,display_name,status,created_at';
    const result = await reviewDb.query(columns + ',google_email' + pending).catch(error => {
      if (error.code !== '42703') throw error;
      return reviewDb.query(columns + pending);
    });
    send(res,200,{accounts:result.rows});return true;
   }
   const listName = path.slice('/admin-api/'.length);
   if (req.method === 'GET' && Object.hasOwn(lists, listName)) {
    const result = await readFilteredPage(reviewDb, listName, searchParams);
    send(res, result ? 200 : 400, result || { error: '請確認篩選條件與日期範圍。' });
    return true;
   }
   if (req.method === 'GET' && listName === 'summary') {
    const result = await reviewDb.query(summarySql);
    send(res, 200, { summary: result.rows[0] }); return true;
   }
   if (req.method === 'GET' && listName === 'audit') {
    const result = await reviewDb.query(auditSql);
    send(res, 200, { audit: result.rows }); return true;
   }
   if(path==='/admin-api/monitor' && req.method==='GET'){
    const [accounts,bots,notifications,audit,summary]=await Promise.all([
     reviewDb.query('select * from linebot_private.admin_accounts order by created_at desc limit 200'),
     reviewDb.query('select * from linebot_private.admin_bots order by updated_at desc limit 200'),
     reviewDb.query('select * from linebot_private.admin_notifications order by created_at desc limit 200'),
     reviewDb.query(auditSql),
     reviewDb.query(summarySql)
    ]);
    send(res,200,{accounts:accounts.rows,bots:bots.rows,notifications:notifications.rows,audit:audit.rows,summary:summary.rows[0]});return true;
   }
   if(path==='/admin-api/review' && req.method==='POST'){
    let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>8192){send(res,413,{error:'資料過大'});return true;}chunks.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(res,400,{error:'資料格式不正確'});return true;}
    if(typeof data.username!=='string'||!/^[a-z0-9_]{3,32}$/.test(data.username)||!['active','disabled'].includes(data.status)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.trim().length>500){send(res,400,{error:'請確認帳號、決定和原因。'});return true;}
    const result=await reviewDb.query('select linebot_private.review_account($1,$2,$3) as changed',[data.username,data.status,data.reason.trim()]);
    send(res,result.rows[0]?.changed?200:409,{message:result.rows[0]?.changed?'已記錄審核決定。':'沒有變更。請確認申請人已填寫資料，並重新整理帳號狀態。'});return true;
   }
   send(res,404,{error:'找不到功能'});return true;
  }catch{send(res,503,{error:'管理服務暫時無法使用。'});return true;}
 };
}
