export function createBotStore({ db, vault, tokenVault }) {
  if (!db?.query || !vault?.seal || !vault?.open || !tokenVault?.seal) throw new Error('Missing bot storage dependencies');
  return {
    async save(accountId, channelSecret, accessToken, bot, linkedBotId = null) {
      const encrypted = vault.seal(accountId, channelSecret);
      const encryptedToken = tokenVault.seal(accountId, accessToken);
      const values = [accountId,bot.userId,bot.displayName,JSON.stringify(encrypted),JSON.stringify(encryptedToken)];
      const statement = linkedBotId
        ? `update linebot_private.bot_credentials b set bot_name=$3,encrypted_secret=$4::jsonb,
          encrypted_access_token=$5::jsonb,enabled=true,updated_at=now()
          where b.id=$6 and b.account_id=$1 and b.bot_user_id=$2
          and exists (select 1 from linebot_private.accounts a where a.id=$1 and a.status='active')`
        : `insert into linebot_private.bot_credentials as b (account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled)
          select id,$2,$3,$4::jsonb,$5::jsonb,true from linebot_private.accounts where id=$1 and status='active'
          on conflict (bot_user_id) do update set bot_name=excluded.bot_name,encrypted_secret=excluded.encrypted_secret,
          encrypted_access_token=excluded.encrypted_access_token,enabled=true,updated_at=now()
          where b.account_id=excluded.account_id`;
      const { rows } = await db.query(statement + ' returning b.id,b.bot_name as "botName",b.webhook_key as "webhookKey",b.enabled',
        linkedBotId ? [...values, linkedBotId] : values);
      return rows[0] || null;
    },
    async list(accountId, botId = null) {
      const result=await db.query(`select id,bot_name as "botName",webhook_key as "webhookKey",enabled from linebot_private.bot_credentials where account_id=$1 and bot_user_id is not null and ($2::uuid is null or id=$2::uuid) order by bot_name,id`,[accountId,botId]);
      return result.rows;
    },
    async findByIdentity(accountId, botUserId) {
      const {rows}=await db.query('select id from linebot_private.bot_credentials where account_id=$1 and bot_user_id=$2',[accountId,botUserId]);
      return rows[0] || null;
    },
    async disable(accountId, botId) {
      const result=await db.query('update linebot_private.bot_credentials set enabled=false,updated_at=now() where account_id=$1 and id=$2 returning id', [accountId,botId]);
      return result.rows.length===1;
    },
    async webhookCheckCredentials(accountId, botId) {
      const { rows } = await db.query(`select b.webhook_key, b.encrypted_access_token
        from linebot_private.bot_credentials b join linebot_private.accounts a on a.id=b.account_id
        where b.account_id=$1 and b.id=$2 and b.enabled and a.status='active'`, [accountId, botId]);
      const bot = rows[0];
      if (!bot || !bot.encrypted_access_token) return null;
      return { webhookKey: bot.webhook_key, accessToken: tokenVault.open(accountId, bot.encrypted_access_token) };
    },
    async findByWebhook(webhookKey) {
      const result = await db.query(`select b.id, a.id as "userId", b.encrypted_secret as "encryptedSecret", b.enabled, b.bot_user_id as "botUserId"
        from linebot_private.accounts a join linebot_private.bot_credentials b on b.account_id=a.id
        where b.webhook_key=$1 and a.status='active' and b.enabled=true`, [webhookKey]);
      return result.rows[0] || null;
    }
  };
}
