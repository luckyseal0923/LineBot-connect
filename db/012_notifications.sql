-- Additive migration for the dedicated LINEBOT schema only.
begin;
create table linebot_private.pairing_codes (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references linebot_private.accounts(id),
 bot_id uuid not null references linebot_private.bot_credentials(id), code_hash text not null unique,
 label text not null check (char_length(label) between 1 and 80),
 expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now()
);
create index pairing_codes_expiry_idx on linebot_private.pairing_codes(expires_at);
create table linebot_private.recipients (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references linebot_private.accounts(id),
 bot_id uuid not null references linebot_private.bot_credentials(id), line_hash text not null,
 encrypted_line_id jsonb not null, label text not null check (char_length(label) between 1 and 80),
 active boolean not null default true, created_at timestamptz not null default now(),
 unique(bot_id,line_hash)
);
create index recipients_account_idx on linebot_private.recipients(account_id,bot_id);
create table linebot_private.notifications (
 id uuid primary key, account_id uuid not null references linebot_private.accounts(id),
 bot_id uuid not null references linebot_private.bot_credentials(id), recipient_id uuid not null references linebot_private.recipients(id),
 status text not null check (status in ('sending','accepted','failed','unknown')),
 line_status integer, created_at timestamptz not null default now(), completed_at timestamptz
);
create index notifications_account_time_idx on linebot_private.notifications(account_id,created_at desc);
revoke all on linebot_private.pairing_codes,linebot_private.recipients,linebot_private.notifications from public,anon,authenticated;
grant select,insert,update,delete on linebot_private.pairing_codes,linebot_private.recipients,linebot_private.notifications to linebot_runtime;
commit;
