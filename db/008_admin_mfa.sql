begin;
do $$ begin
 if current_setting('linebot.isolated_test',true) is distinct from 'yes' then
  raise exception 'Blocked: isolated test only';
 end if;
end $$;
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
commit;
