-- Prepare one service for each existing Bot; names remain unset until the owner supplies them.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
create table linebot_private.platform_services (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references linebot_private.accounts(id),
 name text check (name is null or char_length(name) between 1 and 80),
 bot_id uuid unique references linebot_private.bot_credentials(id),
 created_at timestamptz not null default now()
);
create function linebot_private.check_platform_bot_owner() returns trigger language plpgsql set search_path = pg_catalog, linebot_private as $$
begin
 if new.bot_id is not null and not exists (select 1 from linebot_private.bot_credentials b where b.id=new.bot_id and b.account_id=new.account_id) then
   raise exception 'Bot must belong to platform owner' using errcode='23514';
 end if;
 return new;
end $$;
create trigger platform_bot_owner before insert or update of account_id,bot_id on linebot_private.platform_services for each row execute function linebot_private.check_platform_bot_owner();
alter table linebot_private.integrations add column event_name text check (event_name is null or char_length(event_name) between 1 and 80);
create index platform_services_account_idx on linebot_private.platform_services(account_id,created_at,id);
insert into linebot_private.platform_services (account_id,bot_id)
 select account_id,id from linebot_private.bot_credentials;
revoke all on linebot_private.platform_services from public,anon,authenticated,linebot_reviewer,linebot_admin_auth,linebot_enroller;
grant select,insert,update on linebot_private.platform_services to linebot_runtime;
commit;
