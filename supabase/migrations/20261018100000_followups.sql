-- Why a ticket is waiting for follow-up: 'after_hours' or 'no_agents' (null when an agent was online).
alter table public.conversations add column followup_reason text check (followup_reason in ('after_hours', 'no_agents'));
create index conversations_queue on public.conversations (mvno_id, handoff_at) where status = 'open' and assignee_id is null;
