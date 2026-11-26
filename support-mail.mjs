import nodemailer from 'nodemailer';
import { createCredentialVault } from './line-webhook.mjs';

const recipient = 'chin.wei.chang0923@gmail.com';
export const configId = '00000000-0000-4000-8000-000000000028';
export const smtpVault = key => createCredentialVault(key, {context:'support-smtp', maxBytes:8192});

export function smtpTransport({host, port, user, pass}) {
  const secure = Number(port) === 465;
  return nodemailer.createTransport({
    host, port:Number(port), secure, requireTLS:!secure, auth:{user, pass},
    connectionTimeout:10000, greetingTimeout:10000, socketTimeout:30000,
    disableFileAccess:true, disableUrlAccess:true
  });
}

export async function deliverSupportMail(db, transport, from) {
  const {rows:[message]} = await db.query(`with due as (
    select id from linebot_private.support_messages where mail_state in ('queued','sending')
    and next_attempt <= now() order by next_attempt,id for update skip locked limit 1
  ) update linebot_private.support_messages s set mail_state='sending',mail_attempts=mail_attempts+1,
    next_attempt=now()+interval '5 minutes' from due where s.id=due.id
    returning s.id,s.account_id,s.platform_name,s.subject,s.body,s.image_type,s.image_bytes,s.mail_attempts`);
  if (!message) return false;
  let state;
  try {
    const {rows:[sender]} = await db.query('select display_name,google_email from linebot_private.accounts where id=$1',[message.account_id]);
    const result = await transport.sendMail({
      from:{name:'LineBOT 接線站',address:from}, to:recipient,
      replyTo:sender?.google_email ? {name:sender.display_name,address:sender.google_email} : undefined,
      messageId:'<support-'+message.id+'@linebot-next.wfhai.org>',
      subject:'[接線站求助] '+message.subject.replace(/[\r\n]+/g,' '),
      text:['網站　'+message.platform_name,'開發者　'+(sender?.display_name || '未提供'),
        '回覆信箱　'+(sender?.google_email || '未提供'),'',message.body].join('\n'),
      attachments:message.image_type ? [{filename:message.image_type==='image/png'?'附件.png':'附件.jpg',
        content:message.image_bytes,contentType:message.image_type}] : []
    });
    if (!result.accepted?.includes(recipient)) throw Error('Recipient was not accepted');
    state='accepted';
  } catch {
    state=message.mail_attempts>=5 ? 'failed' : 'queued';
  }
  await db.query(`update linebot_private.support_messages set mail_state=$1,
    next_attempt=now()+interval '1 minute' * mail_attempts where id=$2 and mail_attempts=$3 and mail_state='sending'`,
    [state,message.id,message.mail_attempts]);
  return true;
}

export function startSupportMail(db,key) {
  const vault=smtpVault(key);
  let busy=false;
  const timer=setInterval(async()=>{
    if (busy) return;
    busy=true;
    try {
      const {rows:[row]}=await db.query(`select encrypted from linebot_private.support_mail_config where singleton
        and exists (select 1 from linebot_private.support_messages where mail_state in ('queued','sending') and next_attempt<=now())`);
      if (row) {
        const config=JSON.parse(vault.open(configId,row.encrypted));
        await deliverSupportMail(db,smtpTransport(config),config.from);
      }
    } catch { console.error('Support mail queue unavailable'); }
    finally { busy=false; }
  },5000);
  timer.unref();
  return timer;
}
