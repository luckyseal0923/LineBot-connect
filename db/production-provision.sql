-- Creates only the LINEBOT schema and four inactive NOLOGIN roles.
-- No shared authentication, schema grants or existing data are changed.
-- Run atomically on the selected database after reviewing the target.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $$ begin
 if current_database() <> 'postgres' then raise exception 'Unexpected database'; end if;
 if to_regnamespace('linebot_private') is not null then raise exception 'Schema already exists'; end if;
 if exists(select 1 from pg_roles where rolname in ('linebot_runtime','linebot_reviewer','linebot_admin_auth','linebot_enroller')) then raise exception 'Role already exists'; end if;
end $$;
create role linebot_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role linebot_reviewer nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role linebot_admin_auth nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role linebot_enroller nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- 005_independent_accounts.sql
create schema linebot_private;
revoke all on schema linebot_private from public, anon, authenticated;
create table linebot_private.accounts (
 id uuid primary key default gen_random_uuid(),
 username text not null unique check (username ~ '^[a-z0-9_]{3,32}$'),
 display_name text not null check (char_length(display_name) between 1 and 100),
 password_salt text not null,
 password_hash text not null,
 webhook_key uuid not null unique default gen_random_uuid(),
 status text not null default 'pending' check (status in ('pending','active','disabled')),
 failed_attempts integer not null default 0,
 locked_until timestamptz,
 created_at timestamptz not null default now()
);
create table linebot_private.sessions (
 token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
 account_id uuid not null references linebot_private.accounts(id) on delete cascade,
 expires_at timestamptz not null
);
create index linebot_sessions_account on linebot_private.sessions(account_id);
create table linebot_private.bot_credentials (
 account_id uuid primary key references linebot_private.accounts(id) on delete cascade,
 bot_user_id text not null unique check (bot_user_id ~ '^U[0-9a-f]{32}$'),
 bot_name text not null check (char_length(bot_name) between 1 and 200),
 encrypted_secret jsonb not null,
 encrypted_access_token jsonb not null,
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table linebot_private.webhook_events (
 account_id uuid not null references linebot_private.accounts(id) on delete cascade,
 event_id text not null check (char_length(event_id) between 1 and 100),
 payload jsonb not null,
 received_at timestamptz not null default now(),
 primary key (account_id, event_id)
);
create table linebot_private.request_limits (
 scope text primary key,
 window_start timestamptz not null,
 hits integer not null check (hits >= 0)
);
revoke all on all tables in schema linebot_private from public, anon, authenticated;

-- 006_runtime_grants.sql
grant usage on schema linebot_private to linebot_runtime;
grant select on linebot_private.accounts to linebot_runtime;
grant insert (username,display_name,password_salt,password_hash) on linebot_private.accounts to linebot_runtime;
grant update (failed_attempts,locked_until) on linebot_private.accounts to linebot_runtime;
grant select,insert,delete on linebot_private.sessions to linebot_runtime;
grant select,insert,update on linebot_private.bot_credentials to linebot_runtime;
grant select,insert on linebot_private.webhook_events to linebot_runtime;
grant select,insert,update on linebot_private.request_limits to linebot_runtime;

-- 007_review_retention.sql
create table linebot_private.review_audit (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references linebot_private.accounts(id),
 actor text not null, old_status text not null, new_status text not null, reason text not null,
 reviewed_at timestamptz not null default now()
);
revoke all on linebot_private.review_audit from public, anon, authenticated, linebot_runtime;
create function linebot_private.review_account(p_username text,p_status text,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare old_record record;
begin
 if p_status not in ('active','disabled') or length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid review'; end if;
 select id,status into old_record from linebot_private.accounts where username=p_username for update;
 if not found then return false; end if;
 if old_record.status=p_status then return false; end if;
 update linebot_private.accounts set status=p_status where id=old_record.id;
 insert into linebot_private.review_audit(account_id,actor,old_status,new_status,reason)
 values(old_record.id,session_user,old_record.status,p_status,btrim(p_reason));
 return true;
end $$;
revoke all on function linebot_private.review_account(text,text,text) from public,anon,authenticated,linebot_runtime;
grant usage on schema linebot_private to linebot_reviewer;
grant select (username,display_name,status,created_at) on linebot_private.accounts to linebot_reviewer;
grant execute on function linebot_private.review_account(text,text,text) to linebot_reviewer;
create index linebot_event_age on linebot_private.webhook_events(received_at);
create function linebot_private.store_events(p_account uuid,p_events jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare event_item jsonb; needed int; existing_count int;
begin
 if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events)>100 then raise exception 'invalid events'; end if;
 perform 1 from linebot_private.accounts where id=p_account and status='active' for update;
 if not found then raise exception 'account inactive'; end if;
 for event_item in select value from jsonb_array_elements(p_events) loop
  if length(event_item->>'event_id') not between 1 and 100 or jsonb_typeof(event_item->'payload') <> 'object' or octet_length((event_item->'payload')::text)>50000 then raise exception 'invalid event'; end if;
 end loop;
 delete from linebot_private.webhook_events where account_id=p_account and received_at < now() - interval '7 days';
 select count(*) into existing_count from linebot_private.webhook_events where account_id=p_account;
 select count(distinct e.value->>'event_id') into needed from jsonb_array_elements(p_events) e
 where not exists(select 1 from linebot_private.webhook_events w where w.account_id=p_account and w.event_id=e.value->>'event_id');
 if existing_count+needed>1000 then raise exception 'event quota reached'; end if;
 insert into linebot_private.webhook_events(account_id,event_id,payload)
 select p_account,e.value->>'event_id',e.value->'payload' from jsonb_array_elements(p_events) e
 on conflict(account_id,event_id) do nothing;
end $$;
create function linebot_private.purge_expired_events() returns integer language plpgsql security definer set search_path='' as $$
declare deleted int;
begin
 delete from linebot_private.webhook_events where (account_id,event_id) in
 (select account_id,event_id from linebot_private.webhook_events where received_at < now()-interval '7 days' order by received_at limit 500);
 get diagnostics deleted = row_count; return deleted;
end $$;
revoke all on function linebot_private.store_events(uuid,jsonb),linebot_private.purge_expired_events() from public,anon,authenticated;
revoke insert on linebot_private.webhook_events from linebot_runtime;
grant execute on function linebot_private.store_events(uuid,jsonb),linebot_private.purge_expired_events() to linebot_runtime;

-- 008_admin_mfa.sql
create table linebot_private.admin_auth (
 id uuid primary key default gen_random_uuid(),
 username text unique not null check(username ~ '^[a-z0-9_]{3,32}$'),
 password_salt text not null, password_hash text not null,
 encrypted_totp jsonb not null, last_totp_step bigint not null default -1,
 enabled boolean not null default false,
 failed_attempts integer not null default 0, locked_until timestamptz
);
create table linebot_private.admin_sessions (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 admin_id uuid not null references linebot_private.admin_auth(id) on delete cascade,
 expires_at timestamptz not null
);
create table linebot_private.admin_request_limit (scope text primary key, window_start timestamptz not null, hits integer not null);
revoke all on linebot_private.admin_request_limit from public,anon,authenticated,linebot_runtime,linebot_reviewer;
grant select,insert,update on linebot_private.admin_request_limit to linebot_admin_auth;
revoke all on linebot_private.admin_auth,linebot_private.admin_sessions from public,anon,authenticated,linebot_runtime,linebot_reviewer;
grant usage on schema linebot_private to linebot_admin_auth;
grant select on linebot_private.admin_auth to linebot_admin_auth;
grant update (last_totp_step,failed_attempts,locked_until) on linebot_private.admin_auth to linebot_admin_auth;
grant select,insert,delete on linebot_private.admin_sessions to linebot_admin_auth;

-- 009_admin_enrollment.sql
create function linebot_private.enroll_initial_admin(p_id uuid,p_username text,p_salt text,p_hash text,p_totp jsonb,p_step bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(741232503);
 if exists(select 1 from linebot_private.admin_auth) then raise exception 'administrator already exists'; end if;
 if p_username !~ '^[a-z0-9_]{3,32}$' or p_salt !~ '^[0-9a-f]{32}$' or p_hash !~ '^[0-9a-f]{128}$' or p_step<0 or jsonb_typeof(p_totp)<>'object' then raise exception 'invalid enrollment'; end if;
 insert into linebot_private.admin_auth(id,username,password_salt,password_hash,encrypted_totp,last_totp_step,enabled)
 values(p_id,p_username,p_salt,p_hash,p_totp,p_step,true);
end $$;
revoke all on function linebot_private.enroll_initial_admin(uuid,text,text,text,jsonb,bigint) from public,anon,authenticated,linebot_runtime,linebot_reviewer,linebot_admin_auth;
grant usage on schema linebot_private to linebot_enroller;
grant execute on function linebot_private.enroll_initial_admin(uuid,text,text,text,jsonb,bigint) to linebot_enroller;

-- Fail the whole transaction if privileges extend to unrelated tables or
-- security-definer functions, including grants inherited from PUBLIC.
do $$ declare r text; outsiders int; privileged_functions int;
begin
 foreach r in array array['linebot_runtime','linebot_reviewer','linebot_admin_auth','linebot_enroller'] loop
  select count(*) into outsiders from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','p','v','m','f') and n.nspname not in ('linebot_private','pg_catalog','information_schema')
    and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
    and has_schema_privilege(r,n.oid,'USAGE') and has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  select count(*) into privileged_functions from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where p.prosecdef and n.nspname not in ('linebot_private','pg_catalog','information_schema') and n.nspname not like 'pg_temp_%'
    and has_schema_privilege(r,n.oid,'USAGE') and has_function_privilege(r,p.oid,'EXECUTE');
  if outsiders<>0 or privileged_functions<>0 then raise exception 'Role % has unrelated effective privileges: tables %, functions %',r,outsiders,privileged_functions; end if;
 end loop;
 if has_column_privilege('linebot_runtime','linebot_private.accounts','status','UPDATE') then raise exception 'Runtime can approve'; end if;
 if has_function_privilege('linebot_runtime','linebot_private.review_account(text,text,text)','EXECUTE') then raise exception 'Runtime can review'; end if;
 if has_table_privilege('linebot_reviewer','linebot_private.admin_auth','SELECT') then raise exception 'Reviewer can read MFA data'; end if;
end $$;
commit;
select 'LINEBOT_ROLE_SETUP_COMPLETE' as result;
