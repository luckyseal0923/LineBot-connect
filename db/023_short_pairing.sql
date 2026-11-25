begin;
set local lock_timeout = '3s';
alter table linebot_private.pairing_codes
  alter column label drop not null,
  add column claimed_line_hash text,
  add column claimed_line_id jsonb,
  add column completed_at timestamptz;
commit;
