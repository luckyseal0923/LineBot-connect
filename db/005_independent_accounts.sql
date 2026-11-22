-- Independent account design. Isolated tests only until role, backup, and
-- shared-server permissions have been reviewed; never modifies Supabase Auth.
begin;
do $$ begin
  if current_setting('linebot.isolated_test', true) is distinct from 'yes' then
    raise exception 'Blocked: isolated test only; production review is required';
  end if;
end $$;
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
commit;
