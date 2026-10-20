-- Every email Tuongee tries to send: who, subject, result. Bodies are never stored
-- (welcome / reset emails contain passwords).
create table public.email_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  recipients text[] not null,
  subject text not null,
  status text not null check (status in ('sent', 'failed', 'not_sent')),
  error text
);
create index email_log_created on public.email_log (created_at desc);
alter table public.email_log enable row level security; -- server only (super admin API)
