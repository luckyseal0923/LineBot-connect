begin;
set local lock_timeout = '3s';
alter table linebot_private.integrations add column if not exists deleted_at timestamptz;
commit;
