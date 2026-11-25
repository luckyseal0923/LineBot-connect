begin;
set local lock_timeout = '3s';
alter table linebot_private.recipients add column if not exists details jsonb not null default '{}'::jsonb;
alter table linebot_private.pairing_codes add column if not exists details jsonb not null default '{}'::jsonb;
commit;
