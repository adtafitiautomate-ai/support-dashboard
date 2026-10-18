-- Ticket escalation by email to a concerned party (e.g. Finance, Network, Billing).
-- escalation_contacts: [{ "id": "...", "name": "Finance", "emails": ["recon@..."] }], managed by MVNO admins.
alter table public.mvnos add column escalation_contacts jsonb not null default '[]';

alter table public.conversations add column escalated_at timestamptz;
alter table public.conversations add column escalated_to text;
