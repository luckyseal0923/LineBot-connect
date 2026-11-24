-- Install on the LineBOT schema after 014_line_quota.sql.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table linebot_private.integrations (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references linebot_private.accounts(id),
 recipient_id uuid not null references linebot_private.recipients(id),
 name text not null check (char_length(name) between 1 and 80),
 enabled boolean not null default true,
 key_hash text unique check (key_hash ~ '^[0-9a-f]{64}$'),
 key_tail text check (key_tail ~ '^[A-Za-z0-9_-]{6}$'),
 revision integer not null default 1,
 created_at timestamptz not null default now(),
 check ((key_hash is null) = (key_tail is null)),
 check (not enabled or key_hash is not null)
);
create index integrations_account_idx on linebot_private.integrations(account_id,created_at desc);

alter table linebot_private.notifications
 drop constraint notifications_status_check,
 add constraint notifications_status_check
 check (status in ('queued','sending','accepted','failed','unknown','cancelled')) not valid;

create table linebot_private.integration_jobs (
 notification_id uuid primary key references linebot_private.notifications(id) on delete cascade deferrable initially deferred,
 integration_id uuid not null references linebot_private.integrations(id),
 integration_revision integer not null,
 source_name text not null check (char_length(source_name) between 1 and 80),
 request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
 message_hash text not null check (message_hash ~ '^[0-9a-f]{64}$'),
 encrypted_message jsonb,
 next_attempt_at timestamptz default now(),
 attempts integer not null default 0 check (attempts >= 0),
 error_code text,
 line_message_id text,
 check ((encrypted_message is null) = (next_attempt_at is null)),
 unique (integration_id,request_hash)
);
create index integration_jobs_dispatch_idx on linebot_private.integration_jobs(next_attempt_at,notification_id)
 where next_attempt_at is not null;

revoke all on linebot_private.integrations,linebot_private.integration_jobs
 from public,anon,authenticated,linebot_reviewer,linebot_admin_auth,linebot_enroller;
grant select,insert,update on linebot_private.integrations,linebot_private.integration_jobs to linebot_runtime;

create or replace view linebot_private.admin_notifications as
 select a.username, a.display_name, b.bot_name, r.label as recipient_label,
 n.status, n.line_status, n.created_at, n.completed_at, j.source_name as integration_name
 from linebot_private.notifications n
 join linebot_private.accounts a on a.id=n.account_id
 join linebot_private.bot_credentials b on b.id=n.bot_id and b.account_id=n.account_id
 join linebot_private.recipients r on r.id=n.recipient_id and r.account_id=n.account_id and r.bot_id=n.bot_id
 left join linebot_private.integration_jobs j on j.notification_id=n.id;

commit;
