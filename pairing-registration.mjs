import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { createLineBotLookup } from './line-client.mjs';
import { readRecipientDetails, recipientName } from './recipient-details.mjs';

const ticketPattern = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const inactive = '這個連結已使用或已失效。如尚未完成登記，請向邀請人索取新配對碼。';
const activeBot = `join linebot_private.accounts a on a.id=b.account_id and a.status='active'
  join linebot_private.platform_services p on p.bot_id=b.id and p.account_id=b.account_id`;

function pairingMessage(code) {
  return `這是我的配對碼：${code}。請直接送出，不用修改。`;
}

export function readPairingCode(text) {
  if (typeof text !== 'string') return null;
  const message = text.trim();
  const code = message.match(/[0-9]{6}/)?.[0];
  return code && (message === code || message === pairingMessage(code)) ? code : null;
}

export function createPairingRegistration({db, key, allow, publicOrigin, recipientVault, tokenVault, fetchImpl}) {
  const origin = new URL(publicOrigin).origin;
  const mac = value => createHmac('sha256', key).update(value).digest('base64url');
  const codeHash = (bot,code) => mac('pair-code:v1:'+bot+':'+code);
  const lookupBot = createLineBotLookup({fetchImpl});
  async function issue(account,bot) {
    const {rows:[target]} = await db.query(`select b.bot_user_id,b.encrypted_access_token
      from linebot_private.bot_credentials b ${activeBot}
      where b.account_id=$1 and b.id=$2 and b.enabled`,[account,bot]);
    if (!target) return null;
    const info = await lookupBot(tokenVault.open(account,target.encrypted_access_token));
    for (let attempt=0; attempt<5; attempt++) {
      const code=String(randomInt(1000000)).padStart(6,'0');
      const result=await db.query(`insert into linebot_private.pairing_codes(account_id,bot_id,code_hash,expires_at)
        select b.account_id,b.id,$3,now()+interval '10 minutes' from linebot_private.bot_credentials b ${activeBot}
        where b.id=$2 and b.account_id=$1 and b.enabled on conflict(code_hash) do nothing returning expires_at`,
        [account,bot,codeHash(bot,code)]);
      if (result.rows.length) {
        const invitation = {message:code,expiresMinutes:10,expiresAt:result.rows[0].expires_at};
        if (info?.basicId && info.userId === target.bot_user_id) {
          const chatUrl = `https://line.me/R/oaMessage/${encodeURIComponent(info.basicId)}/?${encodeURIComponent(pairingMessage(code))}`;
          invitation.chatQr = await QRCode.toDataURL(chatUrl,{width:260,margin:4});
          invitation.chatUrl = chatUrl;
        }
        return invitation;
      }
    }
    return null;
  }

  async function claim(account,bot,user,lineHash,code,replyToken) {
    if (!replyToken || !await allow('pair-user:'+lineHash) || !await allow('pair-bot:'+bot)) return;
    const args=[account,bot,codeHash(bot,code),lineHash,JSON.stringify(recipientVault.seal(account,user))];
    // The same sender can ask for the link again if LINE lost the first reply.
    const {rows}=await db.query(`with claimed as (
      update linebot_private.pairing_codes c set consumed_at=coalesce(c.consumed_at,now()),
        claimed_line_hash=$4,claimed_line_id=$5::jsonb
      from linebot_private.bot_credentials b ${activeBot}
      where c.account_id=$1 and c.bot_id=$2 and b.id=c.bot_id and b.account_id=c.account_id and b.enabled
        and c.code_hash=$3 and c.label is null and c.completed_at is null and
        ((c.consumed_at is null and c.expires_at>now()) or
         (c.claimed_line_hash=$4 and c.consumed_at>now()-interval '30 minutes'))
      returning c.id,b.encrypted_access_token)
      select * from claimed`,args);
    const row=rows[0];
    let message, encryptedToken;
    if (row) {
      const link=origin+'/pair-register#'+row.id+'.'+mac('pair-form:v1:'+row.id);
      encryptedToken=row.encrypted_access_token;
      message={type:'template',altText:'配對成功，請開啟訊息並填寫收件資料。',template:{
        type:'buttons',text:'配對成功！請在 30 分鐘內填寫收件資料，送出後就會加入名單。此連結限本人使用。',
        actions:[{type:'uri',label:'填寫資料',uri:link}]
      }};
    } else {
      const current=await db.query(`select b.encrypted_access_token from linebot_private.bot_credentials b ${activeBot}
        where b.account_id=$1 and b.id=$2 and b.enabled`,[account,bot]);
      if (!current.rows.length) return;
      encryptedToken=current.rows[0].encrypted_access_token;
      message={type:'text',text:'配對碼無效、已過期或已使用。請核對數字，或向邀請人索取新配對碼。'};
    }
    const token=tokenVault.open(account,encryptedToken);
    const res=await fetchImpl('https://api.line.me/v2/bot/message/reply',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({replyToken,messages:[message]}),redirect:'error',signal:AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      const error=await res.json().catch(()=>({}));
      // LINE also returns this after a successful reply whose response was lost.
      if (res.status===400 && error?.message==='Invalid reply token') return;
      throw Error('LINE reply unavailable');
    }
    if (res.body) await res.body.cancel();
  }

  async function handle(req,res) {
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if (req.method!=='POST' || req.headers.origin!==origin) return send(403,{error:'請由 LINE 訊息開啟表單。'});
    const parts=[];
    let size=0;
    for await (const part of req) {
      size+=part.length;
      if (size>8192) return send(413,{error:'資料過長。'});
      parts.push(part);
    }
    let data;
    try { data=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(400,{error:'資料格式有誤。'}); }
    const match=ticketPattern.exec(data?.ticket || '');
    if (!match || !timingSafeEqual(Buffer.from(match[2]),Buffer.from(mac('pair-form:v1:'+match[1])))) return send(403,{error:inactive});
    const scope=`from linebot_private.pairing_codes c join linebot_private.bot_credentials b
      on c.bot_id=b.id and c.account_id=b.account_id ${activeBot}
      where c.id=$1 and c.claimed_line_id is not null and c.completed_at is null and b.enabled
      and c.consumed_at>now()-interval '30 minutes'`;
    if (data.action==='open') {
      const {rows}=await db.query(`select coalesce(p.name,b.bot_name) as platform ${scope}`,[match[1]]);
      return rows.length ? send(200,rows[0]) : send(410,{error:inactive});
    }
    const label=recipientName(data.name),details=readRecipientDetails(data);
    if (data.action!=='submit' || !label || !details) return send(400,{error:'請確認姓名、欄位長度及電子郵件格式。'});
    const saved=await db.query(`with pending as (
      select c.id,c.account_id,c.bot_id,c.claimed_line_hash,c.claimed_line_id ${scope} for update of c
    ), finished as (
      update linebot_private.pairing_codes c set completed_at=now(),claimed_line_id=null
      from pending r where c.id=r.id returning r.*
    ) insert into linebot_private.recipients(account_id,bot_id,line_hash,encrypted_line_id,label,details)
      select account_id,bot_id,claimed_line_hash,claimed_line_id,$2,$3::jsonb from finished
      on conflict(bot_id,line_hash) do update set encrypted_line_id=excluded.encrypted_line_id,
        active=true,created_at=now(),label=excluded.label,details=linebot_private.recipients.details || excluded.details
      returning id`,[match[1],label,JSON.stringify(details)]);
    return saved.rows.length ? send(200,{ok:true}) : send(410,{error:inactive});
  }
  return {issue,claim,handle};
}
