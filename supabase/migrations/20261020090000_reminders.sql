-- Reminders when a customer's message sits unanswered: first the assigned agent, then supervisors.

alter table public.mvnos
  add column reminders_enabled boolean not null default true,
  add column remind_agent_mins int not null default 10 check (remind_agent_mins between 1 and 1440),
  add column remind_supervisor_mins int not null default 30 check (remind_supervisor_mins between 1 and 1440);

-- Which wait the reminders refer to (the customer message's time) and how far they've escalated.
alter table public.conversations
  add column reminder_wait_since timestamptz,
  add column reminder_level smallint not null default 0;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mvno_id uuid references public.mvnos(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  kind text not null,               -- reminder_agent | reminder_supervisor
  title text not null,
  body text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "own notifications" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "mark own read" on public.notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Every 5 minutes the database calls the app's reminder job (works on any Vercel plan).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.schedule_reminder_job(p_url text, p_secret text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where name = 'jobs_secret';
  perform vault.create_secret(p_secret, 'jobs_secret', 'Bearer token for the app''s scheduled jobs');
  if exists (select 1 from cron.job where jobname = 'tuongee-reminders') then
    perform cron.unschedule('tuongee-reminders');
  end if;
  perform cron.schedule(
    'tuongee-reminders',
    '*/5 * * * *',
    format(
      $job$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jobs_secret')), body := '{}'::jsonb, timeout_milliseconds := 55000)$job$,
      p_url
    )
  );
end;
$$;
revoke all on function public.schedule_reminder_job(text, text) from public, anon, authenticated;
grant execute on function public.schedule_reminder_job(text, text) to service_role;
