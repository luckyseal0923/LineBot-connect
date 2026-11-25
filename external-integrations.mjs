import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createLineTextSender } from './line-client.mjs';

export const externalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const integrationKeyPattern = /^lbc_[A-Za-z0-9_-]{43}$/;
export const webhookTokenPattern = /^wh_[A-Za-z0-9_-]{43}$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const retryDelays = [15, 60];
const digest = value => createHash('sha256').update(value).digest('hex');

export async function hasExternalIntegrationSchema(db) {
  const { rows } = await db.query(`select
    to_regclass('linebot_private.integrations') is not null
    and to_regclass('linebot_private.integration_jobs') is not null as available`);
  return rows[0]?.available === true;
}

export function createExternalIntegrations({ db, key, messageVault, recipientVault, tokenVault, allow, fetchImpl = fetch }) {
  const sendText = createLineTextSender({ fetchImpl });
  // Regenerate a send-only URL from the current key hash so rotation invalidates both credentials.
  const tokenFor = (id, keyHash) => 'wh_' + createHmac('sha256', key)
    .update(`integration-webhook:v1:${id}:${keyHash}`).digest('base64url');
  const eligibleRecipients = `from linebot_private.recipients r
    join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id
    join linebot_private.accounts a on a.id=r.account_id
    where r.id=$2 and r.account_id=$1 and r.active and b.enabled and a.status='active'`;

  const eventBotJoins = `left join linebot_private.platform_services p on p.id=i.platform_id and p.account_id=i.account_id
      left join linebot_private.recipients original on original.id=i.recipient_id and original.account_id=i.account_id
      left join linebot_private.bot_credentials b on b.id=(case when i.platform_id is null then original.bot_id else p.bot_id end) and b.account_id=i.account_id`;
  const assigned = 'array_remove(array_prepend(i.recipient_id,i.extra_recipient_ids),null)';

  async function list(accountId, botId = null, includeWebhook = false, platformId = null) {
    const { rows } = await db.query(`select i.id,i.name,i.enabled,i.key_tail as "keyTail",case when $3 then i.key_hash end as "keyHash",
      i.recipient_id as "recipientId",b.id as "botId",b.bot_name as "botName",i.event_name as "eventName",
      targets.people as recipients,targets.ready as "targetReady",i.created_at as "createdAt"
      from linebot_private.integrations i ${eventBotJoins}
      cross join lateral (select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'label',r.label,'active',r.active)
        order by r.label,r.id),'[]') as people,coalesce(bool_or(r.active and b.enabled),false) as ready
        from linebot_private.recipients r where r.account_id=i.account_id and r.bot_id=b.id and r.id=any(${assigned})) targets
      where i.deleted_at is null and i.account_id=$1 and ($2::uuid is null or i.platform_id=$4::uuid or (b.id=$2 and (i.platform_id is null or $4 is null)))
      order by i.created_at desc,i.id`,[accountId,botId,includeWebhook,platformId]);
    return rows.map(({keyHash,...item}) => ({
      ...item, recipientLabel:item.recipients.map(person=>person.label).join('、'),
      ...(keyHash && {webhookToken:tokenFor(item.id,keyHash)})
    }));
  }

  async function create(accountId, input, botId = null, platformId = null) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const recipientId = input?.recipientId;
    if (!name || name.length>80 || (recipientId ? !externalIdPattern.test(recipientId) : !platformId)) return {error:'invalid'};
    const id = randomUUID();
    const apiKey = 'lbc_' + randomBytes(32).toString('base64url');
    const keyHash = digest(apiKey);
    // Existing clients may still provide a single recipient when creating an event.
    const source = recipientId
      ? `select $1::uuid,r.id,$3::uuid ${eligibleRecipients} and ($4::uuid is null or b.id=$4)`
      : `select p.account_id,null::uuid,p.id from linebot_private.platform_services p
         where p.id=$3 and p.account_id=$1 and $2::uuid is null and $4::uuid is not null`;
    const {rows}=await db.query(`with target(account_id,recipient_id,platform_id) as (${source})
      insert into linebot_private.integrations(id,account_id,recipient_id,platform_id,name,event_name,key_hash,key_tail)
      select $5,account_id,recipient_id,platform_id,$6,$6,$7,$8 from target returning id`,
      [accountId,recipientId || null,platformId,botId,id,name,keyHash,apiKey.slice(-6)]);
    return rows.length ? { id, apiKey, webhookToken: tokenFor(id, keyHash) } : { error: 'target_unavailable' };
  }

  async function edit(accountId, id, input) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const raw = input?.recipientIds ?? (input?.recipientId ? [input.recipientId] : null);
    if (!name || name.length>80 || !Array.isArray(raw) || raw.some(id=>typeof id!=='string' || !externalIdPattern.test(id))) return {error:'invalid'};
    const ids=[...new Set(raw.map(id=>id.toLowerCase()))].sort();
    const result=await db.query(`with context as (
      select i.id,b.id as bot_id,coalesce(p.id,legacy.id) as platform_id
      from linebot_private.integrations i ${eventBotJoins}
      left join linebot_private.platform_services legacy on legacy.bot_id=b.id and legacy.account_id=i.account_id
      where i.id=$2 and i.account_id=$1 and i.deleted_at is null for update of i
    ) update linebot_private.integrations i set name=$3,event_name=$3,platform_id=c.platform_id,
      recipient_id=($4::uuid[])[1],extra_recipient_ids=($4::uuid[])[2:],
      revision=i.revision + case when ${assigned}=$4 then 0 else 1 end
      from context c where i.id=c.id and (c.platform_id is not null or cardinality($4::uuid[])>0)
      and cardinality($4::uuid[])=(select count(*) from linebot_private.recipients r
        where r.account_id=$1 and r.bot_id=c.bot_id and r.id=any($4) and (r.active or r.id=any(${assigned})))
      returning i.id`,[accountId,id,name,ids]);
    return result.rowCount ? { id } : { error: 'unavailable' };
  }

  async function manage(accountId, id, action) {
    if (action === 'rotate') {
      const apiKey = 'lbc_' + randomBytes(32).toString('base64url');
      const keyHash = digest(apiKey);
      const { rows } = await db.query(`update linebot_private.integrations set key_hash=$3,key_tail=$4,revision=revision+1
        where deleted_at is null and id=$1 and account_id=$2 returning id`, [id, accountId, keyHash, apiKey.slice(-6)]);
      const webhookId = rows[0]?.id;
      return webhookId ? { id: webhookId, apiKey, webhookToken: tokenFor(webhookId, keyHash) } : { error: 'unavailable' };
    }
    if (action === 'revoke') {
      const result = await db.query(`update linebot_private.integrations
        set enabled=false,key_hash=null,key_tail=null,revision=revision+1
        where deleted_at is null and id=$1 and account_id=$2 returning id`, [id, accountId]);
      return result.rowCount ? { id } : { error: 'unavailable' };
    }
    const enabled = action === 'enable';
    const result = await db.query(`update linebot_private.integrations i
      set enabled=$3,revision=i.revision + case when i.enabled<>$3 then 1 else 0 end
      where i.deleted_at is null and i.id=$1 and i.account_id=$2 and (not $3::boolean or (
        i.key_hash is not null and exists (select 1 from linebot_private.recipients r
          join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id
          where r.id=any(${assigned}) and r.account_id=i.account_id and r.active and b.enabled)))
      returning i.id`, [id, accountId, enabled]);
    return result.rowCount ? { id } : { error: 'unavailable' };
  }

  async function remove(accountId, id, botId, platformId = null) {
    const result = await db.query(`update linebot_private.integrations i
      set deleted_at=now(), enabled=false, key_hash=null, key_tail=null, revision=i.revision+1
      where i.id=$1 and i.account_id=$2 and i.deleted_at is null and
        (i.platform_id=$4::uuid or ((i.platform_id is null or $4 is null) and exists(select 1 from linebot_private.recipients r
          where r.id=i.recipient_id and r.account_id=i.account_id and r.bot_id=$3)))
      returning i.id`, [id, accountId, botId, platformId]);
    return result.rowCount ? { id } : { error: 'unavailable' };
  }

  async function authenticate(apiKey) {
    if (!integrationKeyPattern.test(apiKey || '')) return null;
    const keyHash = digest(apiKey);
    const { rows } = await db.query(`select i.id,i.account_id as "accountId",i.enabled,a.status
      from linebot_private.integrations i join linebot_private.accounts a on a.id=i.account_id
      where i.key_hash=$1`, [keyHash]);
    return rows[0] ? { ...rows[0], keyHash } : null;
  }

  async function authenticateWebhook(id, token) {
    if (!externalIdPattern.test(id) || !webhookTokenPattern.test(token)) return null;
    const { rows } = await db.query(`select i.id,i.account_id as "accountId",i.enabled,i.key_hash as "keyHash",a.status,
      coalesce(i.event_name,i.name) as "eventName"
      from linebot_private.integrations i join linebot_private.accounts a on a.id=i.account_id
      where i.id=$1 and i.key_hash is not null`, [id]);
    const access = rows[0];
    if (!access || !timingSafeEqual(Buffer.from(token), Buffer.from(tokenFor(access.id, access.keyHash)))) return null;
    return access;
  }

  async function readSubmission(access, { requestHash = null, messageId = null }) {
    const { rows } = await db.query(`select n.id as "messageId",n.status,n.line_status as "lineStatus",
      n.created_at as "createdAt",n.completed_at as "completedAt",j.line_message_id as "lineMessageId",
      j.error_code as "errorCode",j.message_hash as "messageHash",
      (select jsonb_agg(jsonb_build_object('messageId',n2.id,'status',n2.status) order by n2.id)
       from linebot_private.integration_jobs j2 join linebot_private.notifications n2 on n2.id=j2.notification_id
       where j2.batch_id=j.notification_id and j2.integration_id=j.integration_id having count(*)>1) as deliveries
      from linebot_private.integration_jobs j
      join linebot_private.notifications n on n.id=j.notification_id
      join linebot_private.integrations i on i.id=j.integration_id and i.account_id=n.account_id
      join linebot_private.accounts a on a.id=i.account_id
      where i.id=$1 and i.account_id=$2 and i.key_hash=$3 and a.status='active'
        and (n.id=$4::uuid or j.request_hash=$5)`,
    [access.id, access.accountId, access.keyHash, messageId, requestHash]);
    return rows[0];
  }

  function submissionResult(row) {
    const { messageHash, deliveries, ...result } = row;
    if (!deliveries) return result;
    const states=deliveries.map(delivery=>delivery.status);
    const status=states.every(state=>state===states[0]) ? states[0]
      : states.some(state=>state==='sending' || state==='queued') ? 'sending' : 'partial';
    return {messageId:result.messageId,createdAt:result.createdAt,status,deliveries};
  }

  async function enqueue(access, eventKey, message) {
    if (access.status !== 'active' || !access.enabled) return { error: 'disabled' };
    if (typeof eventKey !== 'string' || !idempotencyPattern.test(eventKey) ||
        typeof message !== 'string' || !message.trim() || message.length > 2000) return { error: 'invalid' };

    const requestHash = digest(eventKey);
    const messageHash = createHmac('sha256', key).update(`integration-message:v1:${access.id}:${message}`).digest('hex');
    const replay = async () => {
      const row = await readSubmission(access, { requestHash });
      if (!row) return null;
      return row.messageHash === messageHash ? submissionResult(row) : { error: 'event_conflict' };
    };
    const existing = await replay();
    if (existing) return existing;
    if (!await allow('external-submit') || !await allow(`external-account:${access.accountId}`) ||
        !await allow(`external-integration:${access.id}`)) return { error: 'rate_limited' };

    const encryptedMessage = JSON.stringify(messageVault.seal(access.accountId, message));
    // Reserve the external event key once before inserting any sibling deliveries.
    const rootId=randomUUID();
    const {rows}=await db.query(`with event as (
        select i.* from linebot_private.integrations i join linebot_private.accounts a on a.id=i.account_id
        where i.id=$1 and i.account_id=$2 and i.key_hash=$3 and i.enabled and a.status='active' for share of i
      ), targets as (
        select i.id,i.revision,i.name,i.account_id,r.id as recipient_id,r.bot_id
        from event i ${eventBotJoins} join linebot_private.recipients r
          on r.id=any(${assigned}) and r.account_id=i.account_id and r.bot_id=b.id
        where r.active and b.enabled
      ), deliveries as materialized (
        select t.*,case when row_number() over(order by recipient_id)=1 then $4::uuid else gen_random_uuid() end as delivery_id
        from targets t
      ), reserved as (
        insert into linebot_private.integration_jobs
          (notification_id,integration_id,integration_revision,source_name,request_hash,message_hash,encrypted_message,batch_id)
        select delivery_id,id,revision,name,$5,$6,$7::jsonb,$4 from deliveries where delivery_id=$4
        on conflict(integration_id,request_hash) do nothing returning notification_id
      ), siblings as (
        insert into linebot_private.integration_jobs
          (notification_id,integration_id,integration_revision,source_name,request_hash,message_hash,encrypted_message,batch_id)
        select delivery_id,id,revision,name,encode(sha256(convert_to('/delivery/' || delivery_id::text,'UTF8')),'hex'),$6,$7::jsonb,$4
        from deliveries cross join reserved where delivery_id<>$4 returning notification_id
      )
      insert into linebot_private.notifications(id,account_id,bot_id,recipient_id,status)
      select delivery_id,account_id,bot_id,recipient_id,'queued' from deliveries
      where delivery_id in (select notification_id from reserved union all select notification_id from siblings)
      returning id as "messageId",status,created_at as "createdAt"`,
      [access.id,access.accountId,access.keyHash,rootId,requestHash,messageHash,encryptedMessage]);
    if (!rows.length) return await replay() || {error:'target_unavailable'};
    const receipt=rows.find(row=>row.messageId===rootId);
    return rows.length===1 ? receipt : {...receipt,deliveries:rows};

  }

  async function status(access, messageId) {
    const row = await readSubmission(access, { messageId });
    return row ? submissionResult(row) : null;
  }

  async function testSend(accountId, id, eventKey) {
    const { rows } = await db.query(`select i.id,i.account_id as "accountId",i.enabled,i.key_hash as "keyHash",a.status
      from linebot_private.integrations i join linebot_private.accounts a on a.id=i.account_id
      where i.id=$1 and i.account_id=$2 and i.key_hash is not null`, [id, accountId]);
    if (!rows[0]) return { error: 'unavailable' };
    return enqueue(rows[0], eventKey, '這是一則來自 LINEBOT 接線站的外部串接測試通知。');
  }

  async function finish(job, { status, lineStatus = null, lineMessageId = null, errorCode = null, delay = null }) {
    await db.query(`with saved as (
        update linebot_private.integration_jobs set
          next_attempt_at=case when $3::int is null then null else now()+$3 * interval '1 second' end,
          encrypted_message=case when $3::int is null then null else encrypted_message end,
          error_code=$4,line_message_id=$5
        where notification_id=$1 and attempts=$2 and next_attempt_at is not null returning notification_id
      )
      update linebot_private.notifications n set status=$6,line_status=$7,
        completed_at=case when $3::int is null then now() else null end
      from saved where n.id=saved.notification_id`,
    [job.notification_id, job.attempts, delay, errorCode, lineMessageId, status, lineStatus]);
  }

  async function runNext() {
    // A lease allows another worker to recover after a crash without changing the LINE retry key.
    const { rows } = await db.query(`with due as (
        select notification_id from linebot_private.integration_jobs where next_attempt_at<=now()
        order by next_attempt_at,notification_id limit 1 for update skip locked
      ), claimed as (
        update linebot_private.integration_jobs j set attempts=j.attempts+1,next_attempt_at=now()+interval '45 seconds'
        from due where j.notification_id=due.notification_id returning j.*
      ), started as (
        update linebot_private.notifications n set status='sending'
        from claimed where n.id=claimed.notification_id returning n.*
      )
      select j.notification_id,j.attempts,j.encrypted_message,n.account_id,r.encrypted_line_id,b.encrypted_access_token,
        (n.created_at<now()-interval '15 minutes') as expired,
        (i.enabled and i.revision=j.integration_revision and n.recipient_id=any(${assigned})
          and a.status='active' and r.active and b.enabled
          and r.created_at<=n.created_at and b.updated_at<=n.created_at) as permitted
      from claimed j
      join started n on n.id=j.notification_id
      join linebot_private.integrations i on i.id=j.integration_id and i.account_id=n.account_id
      join linebot_private.accounts a on a.id=n.account_id
      join linebot_private.recipients r on r.id=n.recipient_id and r.account_id=n.account_id and r.bot_id=n.bot_id
      join linebot_private.bot_credentials b on b.id=n.bot_id and b.account_id=n.account_id`);
    const job = rows[0];
    if (!job) return false;

    if (job.attempts > retryDelays.length + 1 || job.expired || !job.permitted) {
      const errorCode = job.expired ? 'expired' : !job.permitted ? 'target_unavailable' : 'line_outcome_unknown';
      await finish(job, { status: job.attempts > 1 ? 'unknown' : 'cancelled', errorCode });
      return true;
    }

    let payload;
    try {
      payload = {
        requestId: job.notification_id,
        message: messageVault.open(job.account_id, job.encrypted_message),
        to: recipientVault.open(job.account_id, job.encrypted_line_id),
        token: tokenVault.open(job.account_id, job.encrypted_access_token)
      };
    } catch {
      await finish(job, { status: job.attempts > 1 ? 'unknown' : 'failed', errorCode: 'credential_unreadable' });
      return true;
    }

    const result = await sendText(payload);
    if (result.status === 'unknown') {
      const delay = retryDelays[job.attempts - 1];
      await finish(job, { ...result, status: delay ? 'queued' : 'unknown', errorCode: 'line_outcome_unknown', delay });
    } else {
      const errorCode = result.status === 'failed' ? 'line_rejected' : null;
      await finish(job, { ...result, errorCode });
    }
    return true;
  }

  return { list, create, edit, manage, remove, authenticate, authenticateWebhook, enqueue, status, testSend, runNext };
}
