-- Supabase PostgreSQL foundation. Apply through a privileged migration role.
-- Authentication identities are managed by Supabase Auth; application writes
-- and administrator actions must be performed by a trusted backend.
create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.account_status as enum ('pending', 'approved', 'returned', 'disabled');
create table public.accounts (
  id uuid primary key references auth.users(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 100),
  email text not null,
  purpose text not null check (char_length(trim(purpose)) between 1 and 2000),
  status public.account_status not null default 'pending',
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- This table is never exposed to ordinary clients. MFA and role checks must
-- both be enforced by the backend before every administrator action.
create table private.administrators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table private.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  target_account_id uuid references public.accounts(id) on delete set null,
  action text not null,
  result text not null,
  reason text,
  sanitized_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
-- Users may only read their own application. No client-side insert/update or
-- administrator policy is granted: trusted endpoints must enforce all writes.
create policy accounts_read_own on public.accounts for select to authenticated using ((select auth.uid()) = id);
revoke all on public.accounts from anon, authenticated;
grant select on public.accounts to authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
