-- Scoped migration: no changes to auth.users, shared schema grants, or other applications.
-- Apply only after review and verification in an isolated environment.
begin;
-- Do not apply on a live shared service until app-specific email verification exists.
-- This flag is used exclusively by the isolated local test database.
do $$ begin
  if current_setting('linebot.isolated_test', true) is distinct from 'yes' then
    raise exception 'Blocked: isolated test only; production review is required';
  end if;
end $$;
-- Not exposed through the Data API. Backend access must use a dedicated,
-- least-privilege database role; no shared service-role key is required.
create table public.linebot_email_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  challenge_email text not null,
  token_hash text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  sent_at timestamptz not null default now(),
  verified_email text,
  verified_at timestamptz
);
alter table public.linebot_email_verifications enable row level security;
revoke all on public.linebot_email_verifications from public, anon, authenticated;

create table public.linebot_applications (
  user_id uuid primary key references auth.users(id) on delete restrict,
  webhook_key uuid not null unique default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  purpose text not null check (char_length(btrim(purpose)) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','returned','disabled')),
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.linebot_applications enable row level security;
revoke all on public.linebot_applications from public, anon, authenticated;

-- This function derives identity from the JWT, checks app-specific mailbox proof,
-- and cannot set approval status or submit on behalf of another user.
create function public.linebot_submit_application(p_name text, p_purpose text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users u
    join public.linebot_email_verifications v on v.user_id = u.id
    where u.id = v_user and u.email is not null and v.verified_at is not null
      and v.verified_email = u.email
  ) then
    raise exception 'LineBOT mailbox verification required' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 or p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 2000 then
    raise exception 'invalid application' using errcode = '22023';
  end if;
  insert into public.linebot_applications (user_id, name, purpose)
    values (v_user, btrim(p_name), btrim(p_purpose));
end;
$$;
create function public.linebot_my_application()
returns table (name text, purpose text, status text, review_reason text, webhook_key uuid)
language sql stable security definer set search_path = '' as $$
  select a.name, a.purpose, a.status, a.review_reason, a.webhook_key
  from public.linebot_applications a
  where a.user_id = auth.uid() and not coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
$$;
revoke all on function public.linebot_submit_application(text,text) from public, anon, authenticated;
revoke all on function public.linebot_my_application() from public, anon, authenticated;
grant execute on function public.linebot_submit_application(text,text) to authenticated;
grant execute on function public.linebot_my_application() to authenticated;
commit;
