-- Google Calendar for confirmed appointments, and appointment reminders.

alter table public.mvnos
  add column google_calendar_id text,                    -- e.g. abc123@group.calendar.google.com
  add column appointment_minutes int not null default 30 check (appointment_minutes between 5 and 480),
  add column reminder_template_name text,                -- approved WhatsApp template for reminders outside the 24h window
  add column reminder_template_lang text not null default 'en';

alter table public.appointments
  add column google_event_id text,
  add column reminded_day_at timestamptz,                -- the "tomorrow" reminder
  add column reminded_soon_at timestamptz;               -- the "in 2 hours" reminder

-- The Google service account key stays in the private schema (never sent to browsers).
alter table private.mvno_secrets add column google_service_account jsonb;

create or replace function public.get_google_sa(p_mvno uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select s.google_service_account from private.mvno_secrets s where s.mvno_id = p_mvno;
$$;
revoke all on function public.get_google_sa(uuid) from public, anon, authenticated;
grant execute on function public.get_google_sa(uuid) to service_role;

create or replace function public.set_google_sa(p_mvno uuid, p_sa jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into private.mvno_secrets (mvno_id, google_service_account, updated_at)
  values (p_mvno, p_sa, now())
  on conflict (mvno_id) do update set google_service_account = excluded.google_service_account, updated_at = now();
$$;
revoke all on function public.set_google_sa(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_google_sa(uuid, jsonb) to service_role;
