-- Deploy only after an isolated test and review. This affects linebot_private only.
begin;
create table linebot_private.admin_login_audit (
 id bigint generated always as identity primary key,
 admin_id uuid references linebot_private.admin_auth(id) on delete set null,
 outcome text not null check (outcome in ('success','denied')),
 created_at timestamptz not null default now()
);
revoke all on linebot_private.admin_login_audit from public, anon, authenticated, linebot_runtime, linebot_reviewer;
grant insert (admin_id,outcome) on linebot_private.admin_login_audit to linebot_admin_auth;
create function linebot_private.purge_admin_login_audit() returns void
language sql security definer set search_path='' as $$
 delete from linebot_private.admin_login_audit where created_at < now() - interval '90 days';
$$;
revoke all on function linebot_private.purge_admin_login_audit() from public, anon, authenticated, linebot_runtime, linebot_reviewer;
grant execute on function linebot_private.purge_admin_login_audit() to linebot_admin_auth;
commit;
