-- =====================================================================
-- Security hardening: invite-only accounts, rate limits, audit log,
-- data retention and privacy notice.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (4) Invite-only: block public sign-ups at the database.
-- Accounts created through the Tuvugane admin API carry app_metadata
-- {"invited": true}. Public sign-up can only set user_metadata, so it
-- can never pass this check.
-- ---------------------------------------------------------------------
create or replace function private.block_public_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.raw_app_meta_data ->> 'invited', 'false') <> 'true' then
    raise exception 'Sign-ups are disabled. Ask your administrator for an account.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists block_public_signup on auth.users;
create trigger block_public_signup before insert on auth.users
  for each row execute function private.block_public_signup();

-- Mark every existing account as invited.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"invited": true}'::jsonb
where coalesce(raw_app_meta_data ->> 'invited', 'false') <> 'true';

-- ---------------------------------------------------------------------
-- (10) Rate limits: fixed windows shared by every server instance.
-- ---------------------------------------------------------------------
create table if not exists private.rate_counters (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
alter table private.rate_counters enable row level security;

/** Counts one hit; returns true while within the limit. */
create or replace function public.rate_limit_hit(p_key text, p_limit int, p_window_secs int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  v_hits int;
begin
  insert into private.rate_counters (key, window_start, hits) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = private.rate_counters.hits + 1
  returning hits into v_hits;
  -- Opportunistic cleanup of old windows.
  if random() < 0.01 then
    delete from private.rate_counters where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end;
$$;
revoke all on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- ---------------------------------------------------------------------
-- (12) Audit log of administrative actions.
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text,
  mvno_id uuid references public.mvnos(id) on delete set null,
  action text not null,
  target text,
  details jsonb not null default '{}'
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_mvno_idx on public.audit_log (mvno_id, at desc);
alter table public.audit_log enable row level security;

-- Super admins see everything; MVNO admins see their MVNO's entries. Writes: server only.
create policy "admins read audit" on public.audit_log for select to authenticated
  using (private.is_platform_admin() or (mvno_id is not null and private.has_role(mvno_id, array['admin']::public.member_role[])));
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;

-- ---------------------------------------------------------------------
-- (13) Data retention and privacy notice per MVNO.
-- ---------------------------------------------------------------------
alter table public.mvnos add column if not exists retention_days int not null default 730
  check (retention_days between 30 and 3650);
alter table public.mvnos add column if not exists privacy_notice text;
alter table public.contacts add column if not exists privacy_notice_sent_at timestamptz;
grant update (retention_days, privacy_notice) on public.mvnos to authenticated;

update public.mvnos set privacy_notice =
  'We use your messages only to help you with your request, as required by the Uganda Data Protection and Privacy Act, 2019. We keep chats for up to 2 years. Reply "privacy" to learn more or ask us to delete your data.'
where privacy_notice is null;
