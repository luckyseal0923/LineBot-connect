-- Add optional LINE account application details to each developer-owned platform.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
alter table linebot_private.platform_services
  add column if not exists line_setup jsonb not null default '{}'::jsonb
  check (jsonb_typeof(line_setup) = 'object');
commit;
