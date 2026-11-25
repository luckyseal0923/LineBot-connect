begin;
set local lock_timeout='3s';
alter table linebot_private.integrations alter column recipient_id drop not null,
  add column platform_id uuid references linebot_private.platform_services(id),
  add column extra_recipient_ids uuid[] not null default '{}',
  add constraint integration_owner_context check (platform_id is not null or recipient_id is not null);
update linebot_private.integrations i set platform_id=p.id
from linebot_private.recipients r join linebot_private.platform_services p on p.account_id=r.account_id and p.bot_id=r.bot_id
where r.id=i.recipient_id and i.account_id=r.account_id;
alter table linebot_private.integration_jobs add column batch_id uuid;
create index integration_jobs_batch_idx on linebot_private.integration_jobs(batch_id) where batch_id is not null;
commit;
