begin;
set local lock_timeout = '3s';
alter table linebot_private.integrations
  add column webhook_number bigint generated always as identity unique;
commit;
