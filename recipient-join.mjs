import { createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import { recipientHash } from './notifications.mjs';

const validPlatform = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const validLiff = /^\d{5,15}-[A-Za-z0-9]{4,64}$/;
const source = `from linebot_private.platform_services p
  join linebot_private.accounts a on a.id=p.account_id and a.status='active'
  join linebot_private.bot_credentials b on b.id=p.bot_id and b.account_id=p.account_id and b.enabled`;

export function createRecipientJoin({ db, key, recipientVault, tokenVault, publicOrigin, allow, fetchImpl = fetch }) {
  async function lookup(id) {
    if (!validPlatform.test(id || '')) return null;
    const result = await db.query(`select p.name,p.account_id,p.bot_id,b.bot_name,b.encrypted_access_token,
      p.line_setup->>'recipientLiffId' as liff ${source} where p.id=$1`, [id]);
    return result.rows[0];
  }
  function invitation(id, row) {
    return createHmac('sha256', key).update('recipient-invite:v1:' + id + ':' + row.bot_id + ':' + row.liff).digest('base64url');
  }
  async function settings(owner, id, input) {
    let row = await lookup(id);
    if (!row || row.account_id !== owner) return null;
    if (input !== undefined) {
      const liff = typeof input?.liffId === 'string' ? input.liffId.trim() : '';
      if (!validLiff.test(liff)) return { error: '請輸入 LINE Developers 提供的 LIFF ID。' };
      const saved = await db.query(`update linebot_private.platform_services set
        line_setup=jsonb_set(line_setup,'{recipientLiffId}',to_jsonb($3::text))
        where id=$1 and account_id=$2 and bot_id=$4`, [id, owner, liff, row.bot_id]);
      if (!saved.rowCount) return null;
      row.liff = liff;
    }
    const url = row.liff ? 'https://liff.line.me/' + row.liff + '?invite=' + invitation(id,row) : '';
    let basicId = '';
    try {
      const token = tokenVault.open(row.account_id, row.encrypted_access_token);
      const info = await lineJson('https://api.line.me/v2/bot/info', token);
      basicId = info?.basicId || '';
    } catch {
      // The invitation remains usable when LINE cannot supply the public ID.
    }
    return { basicId, endpoint: new URL('/join/' + id, publicOrigin).href, liffId: row.liff || '', url,
      qr: url ? await QRCode.toDataURL(url, { width: 260, margin: 4 }) : '' };
  }
  async function lineJson(url, token) {
    const res = await fetchImpl(url, { headers: token ? {Authorization:'Bearer ' + token} : {}, signal: AbortSignal.timeout(10000) });
    if (!res.ok && ![400,401,403,404].includes(res.status)) throw Error('LINE unavailable');
    return res.ok ? res.json() : null;
  }
  async function handle(req,res,id) {
    const send = (status,body) => {
      res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify(body));
    };
    const row = await lookup(id);
    if (!row?.liff) return send(404,{error:'這個平台尚未開放收件者登記。'});
    if (req.method === 'GET') return send(200,{liffId:row.liff, platform:row.name || row.bot_name, bot:row.bot_name});
    if (req.method !== 'POST' || req.headers.origin !== new URL(publicOrigin).origin) return send(403,{error:'請重新掃描邀請碼。'});
    let size=0;
    const parts=[];
    for await (const part of req) {
      size += part.length;
      if (size>8192) return send(413,{error:'資料過長。'});
      parts.push(part);
    }
    let data;
    try { data=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(400,{error:'資料格式有誤。'}); }
    const label = typeof data?.name === 'string' ? data.name.trim() : '';
    if (data?.invite !== invitation(id,row)) return send(403,{error:'邀請碼已失效，請重新掃碼。'});
    if (!label || label.length>80 || label.includes('\0')) return send(400,{error:'請填寫 1 到 80 個字元的姓名。'});
    const token=data.token;
    if (typeof token !== 'string' || !token || token.length>4096) return send(401,{error:'請重新登入 LINE。'});
    if (!await allow('recipient-join:'+id)) return send(429,{error:'目前登記人數較多，請稍後再試。'});
    const verified=await lineJson('https://api.line.me/oauth2/v2.1/verify?access_token='+encodeURIComponent(token));
    if (verified?.client_id !== row.liff.split('-')[0] || !(verified.expires_in>0)) return send(401,{error:'登入已失效或頻道不符，請重新掃碼。'});
    const [profile,friend]=await Promise.all([lineJson('https://api.line.me/v2/profile',token),lineJson('https://api.line.me/friendship/v1/status',token)]);
    if (!/^U[0-9a-f]{32}$/.test(profile?.userId || '')) return send(403,{error:'無法取得 LINE 身分，請確認登入時允許讀取個人資料。'});
    const botToken=tokenVault.open(row.account_id,row.encrypted_access_token);
    if (!friend?.friendFlag) {
      const info=await lineJson('https://api.line.me/v2/bot/info', botToken);
      return send(409,{error:'請先將此平台的官方帳號加入好友或解除封鎖，再回來按「加入收件名單」。',addFriend:info?.basicId ? 'https://line.me/R/ti/p/'+encodeURIComponent(info.basicId) : ''});
    }
    const actual=await lineJson('https://api.line.me/v2/bot/profile/'+profile.userId,botToken);
    if (actual?.userId!==profile.userId) return send(409,{error:'無法由此 Bot 確認好友身分，請管理者核對 LINE Login 綁定的官方帳號與 Provider。'});
    const hash=recipientHash(key,row.bot_id,profile.userId);
    const result=await db.query(`insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label)
      select p.account_id,p.bot_id,$4,$5::jsonb,$6 ${source}
      where p.id=$1 and p.bot_id=$2 and p.line_setup->>'recipientLiffId'=$3
      on conflict(bot_id,line_hash) do update set label=excluded.label,active=true,encrypted_line_id=excluded.encrypted_line_id,created_at=now()
      where linebot_private.recipients.account_id=excluded.account_id`,[id,row.bot_id,row.liff,hash,JSON.stringify(recipientVault.seal(row.account_id,profile.userId)),label]);
    return result.rowCount ? send(200,{ok:true}) : send(409,{error:'平台設定已更新，請重新掃碼。'});
  }
  return {settings,handle};
}
