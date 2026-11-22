-- Local isolated test only; do not apply to shared services without review.
begin;
do $$ begin
 if current_setting('linebot.isolated_test',true) is distinct from 'yes' then
  raise exception 'Blocked: isolated test only';
 end if;
end $$;
create table linebot_private.review_audit (
 id uuid primary key default gen_random_uuid(), account_id uuid not null references linebot_private.accounts(id),
 actor text not null, old_status text not null, new_status text not null, reason text not null,
 reviewed_at timestamptz not null default now()
);
revoke all on linebot_private.review_audit from public, anon, authenticated, linebot_runtime;
create function linebot_private.review_account(p_username text,p_status text,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare old_record record;
begin
 if p_status not in ('active','disabled') or length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid review'; end if;
 select id,status into old_record from linebot_private.accounts where username=p_username for update;
 if not found then return false; end if;
 if old_record.status=p_status then return false; end if;
 update linebot_private.accounts set status=p_status where id=old_record.id;
 insert into linebot_private.review_audit(account_id,actor,old_status,new_status,reason)
 values(old_record.id,session_user,old_record.status,p_status,btrim(p_reason));
 return true;
end $$;
revoke all on function linebot_private.review_account(text,text,text) from public,anon,authenticated,linebot_runtime;
grant usage on schema linebot_private to linebot_reviewer;
grant select (username,display_name,status,created_at) on linebot_private.accounts to linebot_reviewer;
grant execute on function linebot_private.review_account(text,text,text) to linebot_reviewer;
create index linebot_event_age on linebot_private.webhook_events(received_at);
create function linebot_private.store_events(p_account uuid,p_events jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare event_item jsonb; needed int; existing_count int;
begin
 if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events)>100 then raise exception 'invalid events'; end if;
 perform 1 from linebot_private.accounts where id=p_account and status='active' for update;
 if not found then raise exception 'account inactive'; end if;
 for event_item in select value from jsonb_array_elements(p_events) loop
  if length(event_item->>'event_id') not between 1 and 100 or jsonb_typeof(event_item->'payload') <> 'object' or octet_length((event_item->'payload')::text)>50000 then raise exception 'invalid event'; end if;
 end loop;
 delete from linebot_private.webhook_events where account_id=p_account and received_at < now() - interval '7 days';
 select count(*) into existing_count from linebot_private.webhook_events where account_id=p_account;
 select count(distinct e.value->>'event_id') into needed from jsonb_array_elements(p_events) e
 where not exists(select 1 from linebot_private.webhook_events w where w.account_id=p_account and w.event_id=e.value->>'event_id');
 if existing_count+needed>1000 then raise exception 'event quota reached'; end if;
 insert into linebot_private.webhook_events(account_id,event_id,payload)
 select p_account,e.value->>'event_id',e.value->'payload' from jsonb_array_elements(p_events) e
 on conflict(account_id,event_id) do nothing;
end $$;
create function linebot_private.purge_expired_events() returns integer language plpgsql security definer set search_path='' as $$
declare deleted int;
begin
 delete from linebot_private.webhook_events where (account_id,event_id) in
 (select account_id,event_id from linebot_private.webhook_events where received_at < now()-interval '7 days' order by received_at limit 500);
 get diagnostics deleted = row_count; return deleted;
end $$;
revoke all on function linebot_private.store_events(uuid,jsonb),linebot_private.purge_expired_events() from public,anon,authenticated;
revoke insert on linebot_private.webhook_events from linebot_runtime;
grant execute on function linebot_private.store_events(uuid,jsonb),linebot_private.purge_expired_events() to linebot_runtime;
commit;
