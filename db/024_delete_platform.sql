begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table linebot_private.platform_services add column if not exists deleted_at timestamptz;

-- A retired Bot keeps its internal ID for delivery history and releases its LINE identity.
alter table linebot_private.bot_credentials
  alter column bot_user_id drop not null;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
     where conrelid='linebot_private.bot_credentials'::regclass and conname='bot_identity_required_when_enabled') then
    alter table linebot_private.bot_credentials add constraint bot_identity_required_when_enabled
      check (bot_user_id is not null or not enabled);
  end if;
end
$$;

create or replace function linebot_private.delete_platform(p_account uuid,p_id uuid)
returns uuid language plpgsql security invoker set search_path = pg_catalog,linebot_private as $$
declare
  retired_bot uuid;
begin
  update linebot_private.platform_services p set deleted_at=now(), line_setup='{}'::jsonb
    where p.id=p_id and p.account_id=p_account and p.deleted_at is null
    returning p.bot_id into retired_bot;
  if not found then
    return (select p.id from linebot_private.platform_services p
      where p.id=p_id and p.account_id=p_account and p.deleted_at is not null);
  end if;

  update linebot_private.bot_credentials b
    set enabled=false, bot_user_id=null, encrypted_secret='{}'::jsonb,
      encrypted_access_token='{}'::jsonb, updated_at=now()
    where b.id=retired_bot and b.account_id=p_account;

  -- Retire both platform-based events and earlier events scoped through the Bot.
  update linebot_private.integrations i
    set deleted_at=now(), enabled=false, key_hash=null, key_tail=null, revision=i.revision+1
    where i.account_id=p_account and i.deleted_at is null and (
      i.platform_id=p_id or (i.platform_id is null and exists (
        select 1 from linebot_private.recipients r
        where r.id=i.recipient_id and r.account_id=p_account and r.bot_id=retired_bot
      ))
    );
  return p_id;
end
$$;
revoke all on function linebot_private.delete_platform(uuid,uuid) from public;
grant execute on function linebot_private.delete_platform(uuid,uuid) to linebot_runtime;
commit;
