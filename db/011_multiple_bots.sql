-- Apply only after backup and review. Preserve the existing webhook of each bot.
begin;
alter table linebot_private.bot_credentials add column id uuid default gen_random_uuid();
alter table linebot_private.bot_credentials add column webhook_key uuid;
update linebot_private.bot_credentials b set webhook_key=a.webhook_key
 from linebot_private.accounts a where a.id=b.account_id;
alter table linebot_private.bot_credentials alter column id set not null;
alter table linebot_private.bot_credentials alter column webhook_key set default gen_random_uuid();
alter table linebot_private.bot_credentials alter column webhook_key set not null;
alter table linebot_private.bot_credentials drop constraint bot_credentials_pkey;
alter table linebot_private.bot_credentials add primary key (id);
alter table linebot_private.bot_credentials add constraint bot_credentials_webhook_key_unique unique (webhook_key);
create index bot_credentials_account_id_idx on linebot_private.bot_credentials(account_id);
commit;
