-- Small server-side cache shared by all app instances (e.g. vtiger dropdown lists).
create table public.app_cache (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_cache enable row level security; -- server only
