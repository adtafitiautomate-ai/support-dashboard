-- One row per Claude API call, for the super admin's AI usage view.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  mvno_id uuid references public.mvnos(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  kind text not null,               -- bot_reply | triage | draft | summary | knowledge
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0
);
create index ai_usage_created on public.ai_usage (created_at);
alter table public.ai_usage enable row level security; -- no policies: server (service role) only

-- Totals per day × MVNO × kind for a period (super admin API only).
create or replace function public.ai_usage_summary(p_from timestamptz, p_to timestamptz)
returns table (day date, mvno_id uuid, kind text, model text, calls bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint)
language sql stable security definer set search_path = '' as $$
  select (u.created_at at time zone 'Africa/Kampala')::date, u.mvno_id, u.kind, u.model, count(*),
         sum(u.input_tokens), sum(u.output_tokens), sum(u.cache_read_tokens), sum(u.cache_write_tokens)
  from public.ai_usage u
  where u.created_at >= p_from and u.created_at < p_to
  group by 1, 2, 3, 4
  order by 1;
$$;
revoke all on function public.ai_usage_summary(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_usage_summary(timestamptz, timestamptz) to service_role;
