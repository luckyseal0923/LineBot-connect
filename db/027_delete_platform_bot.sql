-- Detach and retire one Bot while keeping the website and its event names.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create function linebot_private.delete_platform_bot(p_account uuid,p_platform uuid,p_bot uuid)
returns boolean language plpgsql security invoker set search_path = pg_catalog,linebot_private as $$
begin
  perform 1 from linebot_private.platform_services p
    where p.id=p_platform and p.account_id=p_account and p.deleted_at is null and p.bot_id=p_bot
    for update;
  if not found then return false; end if;

  -- Existing event URLs remain recorded but events are disabled until reviewed.
  update linebot_private.integrations i
    set platform_id=p_platform, recipient_id=null, extra_recipient_ids='{}', enabled=false, revision=i.revision+1
    where i.account_id=p_account and i.deleted_at is null and
      (i.platform_id=p_platform or (i.platform_id is null and exists (
        select 1 from linebot_private.recipients r
        where r.id=i.recipient_id and r.account_id=p_account and r.bot_id=p_bot
      )));
  update linebot_private.recipients set active=false,encrypted_line_id='{}'::jsonb
    where account_id=p_account and bot_id=p_bot;
  update linebot_private.bot_credentials set enabled=false,bot_user_id=null,
    encrypted_secret='{}'::jsonb,encrypted_access_token='{}'::jsonb,updated_at=now()
    where account_id=p_account and id=p_bot;
  update linebot_private.platform_services set bot_id=null,
    line_setup=line_setup - 'recipientLiffId' - 'loginProfile'
    where id=p_platform and account_id=p_account;
  return true;
end $$;
revoke all on function linebot_private.delete_platform_bot(uuid,uuid,uuid) from public;
grant execute on function linebot_private.delete_platform_bot(uuid,uuid,uuid) to linebot_runtime;
commit;
