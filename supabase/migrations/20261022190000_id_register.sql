-- National ID register (e.g. an embassy's "cards received" PDFs), lookups and a notify-me list.

create table public.id_batches (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  label text not null,                 -- e.g. "Batch 5"
  batch_date date,                     -- when the cards arrived (from the PDF or entered by staff)
  source_name text,                    -- uploaded file name (cited in answers)
  file_path text,                      -- private storage path of the PDF
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  error text,
  row_count int not null default 0,
  notified_count int not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index id_batches_mvno on public.id_batches (mvno_id, created_at desc);

create table public.id_register (
  id bigint generated always as identity primary key,
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  batch_id uuid not null references public.id_batches(id) on delete cascade,
  full_name text not null,
  name_key text not null,              -- lowercase name words, sorted (order-insensitive matching)
  extra jsonb not null default '{}',   -- any other columns in the PDF (serial no., district…)
  created_at timestamptz not null default now()
);
create index id_register_lookup on public.id_register (mvno_id, name_key);

-- "Tell me when my card arrives"
create table public.id_watch (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  full_name text not null,
  name_key text not null,
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'needs_template')),
  matched_batch_id uuid references public.id_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (mvno_id, contact_id, name_key)
);
create index id_watch_waiting on public.id_watch (mvno_id, status);

alter table public.id_batches enable row level security;
alter table public.id_register enable row level security;
alter table public.id_watch enable row level security;
create policy "members read batches" on public.id_batches for select to authenticated using (private.is_member(mvno_id));
create policy "members read watch" on public.id_watch for select to authenticated using (private.is_member(mvno_id));
-- id_register rows are read through the server only (lookups never expose other names).

-- Template used to tell people their card has arrived, outside the 24h window.
alter table public.mvnos add column id_ready_template_name text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('registers', 'registers', false, 26214400, array['application/pdf', 'text/csv'])
on conflict (id) do nothing;
