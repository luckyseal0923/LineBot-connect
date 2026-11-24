import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createLineTextSender } from './line-client.mjs';

export const externalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const integrationKeyPattern = /^lbc_[A-Za-z0-9_-]{43}$/;
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
  const eligibleRecipients = `from linebot_private.recipients r
    join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id
    join linebot_private.accounts a on a.id=r.account_id
    where r.id=$2 and r.account_id=$1 and r.active and b.enabled and a.status='active'`;

  async function list(accountId, botId = null) {
    const { rows } = await db.query(`select i.id, i.name, i.enabled, i.key_tail as "keyTail",
      i.recipient_id as "recipientId", b.id as "botId", b.bot_name as "botName", i.event_name as "eventName", r.label as "recipientLabel",
      (r.active and b.enabled) as "targetReady", i.created_at as "createdAt"
      from linebot_private.integrations i
      join linebot_private.recipients r on r.id=i.recipient_id and r.account_id=i.account_id
      join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id
      where i.account_id=$1 and ($2::uuid is null or b.id=$2::uuid) order by i.created_at desc, i.id`, [accountId,botId]);
    return rows;
  }

  async function create(accountId, input, botId = null) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || !externalIdPattern.test(input?.recipientId || '')) return { error: 'invalid' };

    const id = randomUUID();
    const apiKey = 'lbc_' + randomBytes(32).toString('base64url');
    const { rows } = await db.query(`insert into linebot_private.integrations(id,account_id,recipient_id,name,key_hash,key_tail,event_name)
      select $6,r.account_id,r.id,$3,$4,$5,$3 ${eligibleRecipients} and ($7::uuid is null or b.id=$7::uuid)
      on conflict(id) do nothing returning id`,
    [accountId, input.recipientId, name, digest(apiKey), apiKey.slice(-6), id, botId]);
    return rows.length ? { id: rows[0].id, apiKey } : { error: 'target_unavailable' };
  }

  async function edit(accountId, id, input) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || !externalIdPattern.test(input?.recipientId || '')) return { error: 'invalid' };

    const result = await db.query(`update linebot_private.integrations i set name=$3,event_name=$3,recipient_id=$2,
      revision=i.revision + case when i.recipient_id<>$2 then 1 else 0 end
      where i.account_id=$1 and i.id=$4 and exists (select 1 ${eligibleRecipients} and r.bot_id=(select prior.bot_id from linebot_private.recipients prior where prior.id=i.recipient_id and prior.account_id=i.account_id)) returning i.id`,
    [accountId, input.recipientId, name, id]);
    return result.rowCount ? { id } : { error: 'unavailable' };
  }

  async function manage(accountId, id, action) {
    if (action === 'rotate') {
      const apiKey = 'lbc_' + randomBytes(32).toString('base64url');
      const result = await db.query(`update linebot_private.integrations set key_hash=$3,key_tail=$4,revision=revision+1
        where id=$1 and account_id=$2 returning id`, [id, accountId, digest(apiKey), apiKey.slice(-6)]);
      return result.rowCount ? { id, apiKey } : { error: 'unavailable' };
    }
    if (action === 'revoke') {
      const result = await db.query(`update linebot_private.integrations
        set enabled=false,key_hash=null,key_tail=null,revision=revision+1
        where id=$1 and account_id=$2 returning id`, [id, accountId]);
      return result.rowCount ? { id } : { error: 'unavailable' };
    }
    const enabled = action === 'enable';
    const result = await db.query(`update linebot_private.integrations i
      set enabled=$3,revision=i.revision + case when i.enabled<>$3 then 1 else 0 end
      where i.id=$1 and i.account_id=$2 and (not $3::boolean or (
        i.key_hash is not null and exists (select 1 from linebot_private.recipients r
          join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=r.account_id
          where r.id=i.recipient_id and r.account_id=i.account_id and r.active and b.enabled)))
      returning i.id`, [id, accountId, enabled]);
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

  async function readSubmission(access, { requestHash = null, messageId = null }) {
    const { rows } = await db.query(`select n.id as "messageId",n.status,n.line_status as "lineStatus",
      n.created_at as "createdAt",n.completed_at as "completedAt",j.line_message_id as "lineMessageId",
      j.error_code as "errorCode",j.message_hash as "messageHash"
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
    const { messageHash, ...result } = row;
    return result;
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
    // The unique job insert reserves the event key, and both records commit in one statement.
    const { rows } = await db.query(`with target as (
        select i.id,i.revision,i.name,i.account_id,r.id as recipient_id,r.bot_id
        from linebot_private.integrations i
        join linebot_private.recipients r on r.id=i.recipient_id and r.account_id=i.account_id
        join linebot_private.bot_credentials b on b.id=r.bot_id and b.account_id=i.account_id
        join linebot_private.accounts a on a.id=i.account_id
        where i.id=$1 and i.account_id=$2 and i.key_hash=$3 and i.enabled and r.active and b.enabled and a.status='active'
        for share of i
      ), reserved as (
        insert into linebot_private.integration_jobs
          (notification_id,integration_id,integration_revision,source_name,request_hash,message_hash,encrypted_message)
        select $4,id,revision,name,$5,$6,$7::jsonb from target
        on conflict(integration_id,request_hash) do nothing returning notification_id
      )
      insert into linebot_private.notifications(id,account_id,bot_id,recipient_id,status)
      select reserved.notification_id,target.account_id,target.bot_id,target.recipient_id,'queued' from reserved cross join target
      returning id as "messageId",status,created_at as "createdAt"`,
    [access.id, access.accountId, access.keyHash, randomUUID(), requestHash, messageHash, encryptedMessage]);
    return rows[0] || await replay() || { error: 'target_unavailable' };
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
        (i.enabled and i.revision=j.integration_revision and i.recipient_id=n.recipient_id
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

  return { list, create, edit, manage, authenticate, enqueue, status, testSend, runNext };
}
