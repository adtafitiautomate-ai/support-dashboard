-- Appointment requests collected by the bot (general-business tenants), confirmed by staff.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  service text not null,
  preferred text,                 -- what the customer asked for, in their words
  full_name text,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'completed', 'no_show', 'cancelled')),
  scheduled_at timestamptz,       -- set when confirmed
  office text,                    -- where (from Locations)
  staff_note text,                -- sent to the customer with the confirmation
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index appointments_mvno on public.appointments (mvno_id, status, created_at desc);
alter table public.appointments enable row level security;
create policy "members read appointments" on public.appointments for select to authenticated using (private.is_member(mvno_id));
