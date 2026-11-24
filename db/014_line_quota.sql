-- LINEBOT-only cache of approximate official monthly message consumption.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
create table linebot_private.bot_monthly_usage (
 bot_id uuid primary key references linebot_private.bot_credentials(id) on delete cascade,
 total_usage bigint check (total_usage >= 0),
 checked_at timestamptz not null,
 status text not null check (status in ('ok','unavailable')),
 check ((status='ok' and total_usage is not null) or (status='unavailable' and total_usage is null))
);
revoke all on linebot_private.bot_monthly_usage from public,anon,authenticated,linebot_reviewer,linebot_admin_auth;
grant select,insert,update on linebot_private.bot_monthly_usage to linebot_runtime;
create or replace view linebot_private.admin_bots as
 select a.username, a.display_name, b.bot_name, b.enabled, b.updated_at,
 (select count(*)::int from linebot_private.notifications n where n.bot_id=b.id and n.created_at >= now()-interval '30 days') as notifications_30d,
 u.total_usage, u.checked_at as usage_checked_at, u.status as usage_status
 from linebot_private.bot_credentials b join linebot_private.accounts a on a.id=b.account_id
 left join linebot_private.bot_monthly_usage u on u.bot_id=b.id;
commit;
