export function createBotStore({ db, vault, tokenVault }) {
  if (!db?.query || !vault?.seal || !vault?.open || !tokenVault?.seal) throw new Error('Missing bot storage dependencies');
  return {
    async save(accountId, channelSecret, accessToken, bot) {
      const encrypted = vault.seal(accountId, channelSecret);
      const encryptedToken = tokenVault.seal(accountId, accessToken);
      const result=await db.query(`insert into linebot_private.bot_credentials (account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled)
        select id,$2,$3,$4::jsonb,$5::jsonb,true from linebot_private.accounts where id=$1 and status='active'
        on conflict (bot_user_id) do update set bot_name=excluded.bot_name,encrypted_secret=excluded.encrypted_secret,
        encrypted_access_token=excluded.encrypted_access_token,enabled=true,updated_at=now()
        where linebot_private.bot_credentials.account_id=excluded.account_id returning account_id`,
        [accountId,bot.userId,bot.displayName,JSON.stringify(encrypted),JSON.stringify(encryptedToken)]);
      return result.rows.length===1;
    },
    async list(accountId) {
      const result=await db.query(`select id,bot_name as "botName",webhook_key as "webhookKey",enabled from linebot_private.bot_credentials where account_id=$1 order by bot_name,id`,[accountId]);
      return result.rows;
    },
    async disable(accountId, botId) {
      const result=await db.query('update linebot_private.bot_credentials set enabled=false,updated_at=now() where account_id=$1 and id=$2 returning id', [accountId,botId]);
      return result.rows.length===1;
    },
    async findByWebhook(webhookKey) {
      const result = await db.query(`select a.id as "userId", b.encrypted_secret as "encryptedSecret", b.enabled, b.bot_user_id as "botUserId"
        from linebot_private.accounts a join linebot_private.bot_credentials b on b.account_id=a.id
        where b.webhook_key=$1 and a.status='active' and b.enabled=true`, [webhookKey]);
      return result.rows[0] || null;
    }
  };
}
