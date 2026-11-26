begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table linebot_private.accounts
  add column if not exists google_subject text unique check (char_length(google_subject) between 1 and 255),
  add column if not exists google_email text check (char_length(google_email) between 1 and 254);

-- Only the app's verified Google callback can use this account provisioning entry point.
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
    values (p_username,p_display_name,'','',case when trusted then 'active' else 'pending' end,p_subject,p_email)
    on conflict (google_subject) do nothing returning a.id into account_id;

  if found then
    if trusted then
      insert into linebot_private.review_audit(account_id,actor,old_status,new_status,reason)
        values (account_id,'google','pending','active','已驗證的萬芳醫院 Google 帳號');
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

grant select (google_email) on linebot_private.accounts to linebot_reviewer;
create or replace view linebot_private.admin_accounts as
 select a.username, a.display_name, a.status, a.created_at,
 (select count(*)::int from linebot_private.bot_credentials b where b.account_id=a.id and b.enabled) as active_bots,
 (select count(*)::int from linebot_private.notifications n where n.account_id=a.id and n.created_at >= now()-interval '30 days') as notifications_30d,
 a.google_email
 from linebot_private.accounts a;
commit;
