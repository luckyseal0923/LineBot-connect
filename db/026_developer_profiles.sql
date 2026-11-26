begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
alter table linebot_private.accounts add column if not exists google_auto_activate boolean not null default false;
create table linebot_private.developer_profiles (
 account_id uuid primary key references linebot_private.accounts(id) on delete cascade,
 full_name text not null check (char_length(btrim(full_name)) between 1 and 100),
 phone text not null check (char_length(btrim(phone)) between 1 and 50),
 hospital text not null check (char_length(btrim(hospital)) between 1 and 150),
 job_title text not null check (char_length(btrim(job_title)) between 1 and 100),
 department text not null check (char_length(btrim(department)) between 1 and 150),
 submitted_at timestamptz not null default now()
);
revoke all on linebot_private.developer_profiles from public, anon, authenticated;
grant select on linebot_private.developer_profiles to linebot_runtime;
grant select on linebot_private.developer_profiles to linebot_reviewer;
create or replace function linebot_private.google_sign_in(
  p_username text,p_subject text,p_email text,p_display_name text,p_hosted_domain text
) returns uuid language plpgsql security definer set search_path = pg_catalog,linebot_private as $$
declare
  account_id uuid;
  trusted boolean := split_part(p_email,'@',2)='w.tmu.edu.tw'
    and coalesce(p_hosted_domain in ('w.tmu.edu.tw','tmu.edu.tw'),false);
begin
  if p_subject is null or p_email is null then
    return null;
  end if;

  insert into linebot_private.accounts as a
    (username,display_name,password_salt,password_hash,status,google_subject,google_email)
    values (p_username,p_display_name,'','','pending',p_subject,p_email)
    on conflict (google_subject) do nothing returning a.id into account_id;

  if found then
    if trusted then
      update linebot_private.accounts set google_auto_activate = true where id = account_id;
    end if;
    return account_id;
  end if;

  update linebot_private.accounts a set google_email=p_email,display_name=p_display_name
    where a.google_subject=p_subject and a.status in ('pending','active')
    returning a.id into account_id;
  return account_id;
end
$$;
revoke all on function linebot_private.google_sign_in(text,text,text,text,text) from public;
grant execute on function linebot_private.google_sign_in(text,text,text,text,text) to linebot_runtime;

create or replace function linebot_private.save_developer_profile(p_account uuid,p_name text,p_phone text,p_hospital text,p_job_title text,p_department text)
returns void language plpgsql security definer set search_path=pg_catalog,linebot_private as $$
begin
 insert into linebot_private.developer_profiles(account_id,full_name,phone,hospital,job_title,department)
 values(p_account,p_name,p_phone,p_hospital,p_job_title,p_department)
 on conflict(account_id) do update set full_name=excluded.full_name,phone=excluded.phone,hospital=excluded.hospital,
 job_title=excluded.job_title,department=excluded.department,submitted_at=now();
 update linebot_private.accounts a set status='active', google_auto_activate=false
 where a.id=p_account and a.status='pending' and a.google_auto_activate;
 if found then
   insert into linebot_private.review_audit(account_id,actor,old_status,new_status,reason)
   values(p_account,'google','pending','active','Google 身分已驗證且已完成開發者資料');
 end if;
end $$;
revoke all on function linebot_private.save_developer_profile(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function linebot_private.save_developer_profile(uuid,text,text,text,text,text) to linebot_runtime;
create or replace function linebot_private.review_account(p_username text,p_status text,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare old_record record;
begin
 if p_status not in ('active','disabled') or length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid review'; end if;
 select id,status into old_record from linebot_private.accounts where username=p_username for update;
 if not found then return false; end if;
 if old_record.status=p_status then return false; end if;
 if p_status='active' and old_record.status='pending' and not exists(select 1 from linebot_private.developer_profiles where account_id=old_record.id) then return false; end if;
 update linebot_private.accounts set status=p_status where id=old_record.id;
 insert into linebot_private.review_audit(account_id,actor,old_status,new_status,reason)
 values(old_record.id,session_user,old_record.status,p_status,btrim(p_reason));
 return true;
end $$;
create or replace view linebot_private.admin_accounts as
 select a.username, a.display_name, a.status, a.created_at,
 (select count(*)::int from linebot_private.bot_credentials b where b.account_id=a.id and b.enabled) as active_bots,
 (select count(*)::int from linebot_private.notifications n where n.account_id=a.id and n.created_at >= now()-interval '30 days') as notifications_30d,
 a.google_email, p.full_name, p.phone, p.hospital, p.job_title, p.department, p.submitted_at as profile_submitted_at
 from linebot_private.accounts a left join linebot_private.developer_profiles p on p.account_id=a.id;
commit;
