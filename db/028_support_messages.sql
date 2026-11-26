begin;
set local lock_timeout = '4s';
create table linebot_private.support_messages (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references linebot_private.accounts(id),
 platform_id uuid not null,
 platform_name text not null,
 subject text not null check (char_length(subject) between 1 and 120),
 body text not null check (char_length(body) between 1 and 4000),
 mail_state text not null default 'queued' check (mail_state in ('queued','sending','accepted','failed')),
 mail_attempts integer not null default 0,
 next_attempt timestamptz not null default now(),
 image_type text,
 image_bytes bytea,
 created_at timestamptz not null default now(),
 check ((image_type is null and image_bytes is null) or
        (image_type is not null and image_type in ('image/jpeg','image/png') and image_bytes is not null and octet_length(image_bytes) between 1 and 2097152))
);
create index support_messages_owner_idx on linebot_private.support_messages(account_id,platform_id,created_at desc,id desc);
create index support_messages_inbox_idx on linebot_private.support_messages(created_at desc,id desc);
revoke all on linebot_private.support_messages from public, anon, authenticated, linebot_runtime, linebot_reviewer;
grant select,insert on linebot_private.support_messages to linebot_runtime;
grant update(mail_state,mail_attempts,next_attempt) on linebot_private.support_messages to linebot_runtime;
grant select on linebot_private.support_messages to linebot_reviewer;
create view linebot_private.support_inbox as
 select s.id,s.subject,s.body,s.created_at,s.platform_name,s.image_type,s.mail_state,a.display_name,a.google_email
 from linebot_private.support_messages s join linebot_private.accounts a on a.id=s.account_id;
revoke all on linebot_private.support_inbox from public,anon,authenticated;
grant select on linebot_private.support_inbox to linebot_reviewer;
create table linebot_private.support_mail_config (
 singleton boolean primary key default true check (singleton),
 encrypted jsonb not null
);
revoke all on linebot_private.support_mail_config from public,anon,authenticated,linebot_runtime,linebot_reviewer,linebot_admin_auth,linebot_enroller;
grant select on linebot_private.support_mail_config to linebot_runtime;
commit;
