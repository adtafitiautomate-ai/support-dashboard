-- Tickets are only chats that need a person: handed off by the bot or assigned to an agent.
-- Bot-resolved inquiries stay as conversations without a ticket number.
-- Numbers run per MVNO (SalamTel #1, #2...) and are assigned once, never reused.

alter table public.conversations alter column ticket_no drop identity if exists;
alter table public.conversations alter column ticket_no drop not null;
alter table public.mvnos add column ticket_seq bigint not null default 0;

update public.conversations set ticket_no = null;
with numbered as (
  select id, row_number() over (partition by mvno_id order by created_at, id) n
  from public.conversations
  where handoff_at is not null or assignee_id is not null
)
update public.conversations c set ticket_no = numbered.n from numbered where numbered.id = c.id;
update public.mvnos m set ticket_seq = coalesce((select max(ticket_no) from public.conversations c where c.mvno_id = m.id), 0);

create unique index conversations_mvno_ticket_no on public.conversations (mvno_id, ticket_no) where ticket_no is not null;

create or replace function private.assign_ticket_no()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ticket_no is null and (new.handoff_at is not null or new.assignee_id is not null) then
    -- Row lock on the MVNO serialises concurrent handoffs, so numbers never collide.
    update public.mvnos set ticket_seq = ticket_seq + 1 where id = new.mvno_id returning ticket_seq into new.ticket_no;
  end if;
  return new;
end;
$$;

create trigger conversations_assign_ticket_no
  before insert or update of handoff_at, assignee_id on public.conversations
  for each row execute function private.assign_ticket_no();

create or replace function public.dashboard_stats(p_mvno uuid default null, p_since timestamptz default now() - interval '7 days')
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with mine as (
    select m.id from public.mvnos m
    where private.has_role(m.id, array['admin', 'supervisor']::public.member_role[])
      and (p_mvno is null or m.id = p_mvno)
  ),
  conv as (
    select c.* from public.conversations c where c.mvno_id in (select id from mine)
  ),
  recent as (select * from conv where created_at >= p_since)
  select jsonb_build_object(
    'open', (select count(*) from conv where status = 'open'),
    'unassigned', (select count(*) from conv where status = 'open' and assignee_id is null),
    'pending', (select count(*) from conv where status = 'pending'),
    'with_bot', (select count(*) from conv where status = 'bot'),
    'sla_breached', (select count(*) from conv where status = 'open' and first_response_at is null and sla_due_at < now()),
    'conversations', (select count(*) from recent),
    'bot_contained', (select count(*) from recent where handoff_at is null and status in ('resolved', 'bot')),
    'avg_first_response_secs', (select coalesce(avg(extract(epoch from first_response_at - handoff_at)), 0)::int
                                 from recent where first_response_at is not null and handoff_at is not null),
    'tickets', (select count(*) from recent where ticket_no is not null),
    -- Resolution time is measured on tickets only (from handover), not on chats the bot closed.
    'avg_resolution_mins', (select coalesce(avg(extract(epoch from resolved_at - coalesce(handoff_at, created_at)) / 60), 0)::int
                             from recent where resolved_at is not null and ticket_no is not null),
    'csat_avg', (select round(avg(csat_score)::numeric, 2) from recent where csat_score is not null),
    'csat_count', (select count(*) from recent where csat_score is not null),
    'recharge_total', (select coalesce(sum(r.amount), 0) from public.recharges r
                        where r.status = 'success' and r.created_at >= p_since and r.mvno_id in (select id from mine)),
    'recharge_count', (select count(*) from public.recharges r
                        where r.status = 'success' and r.created_at >= p_since and r.mvno_id in (select id from mine)),
    'deliveries_active', (select count(*) from public.deliveries d
                           where d.status in ('requested', 'scheduled', 'out_for_delivery') and d.mvno_id in (select id from mine)),
    'by_category', (select coalesce(jsonb_object_agg(k, n), '{}') from (
                      select coalesce(category, 'uncategorised') k, count(*) n from recent group by 1) x),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'total', t, 'handoffs', h) order by d), '[]') from (
                 select date_trunc('day', created_at)::date d, count(*) t, count(handoff_at) h
                 from recent group by 1) y),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', p.id, 'name', p.full_name, 'status', p.status,
                  'open', (select count(*) from conv where assignee_id = p.id and status in ('open', 'pending')),
                  'resolved', (select count(*) from recent where assignee_id = p.id and status = 'resolved'),
                  'csat', (select round(avg(csat_score)::numeric, 1) from recent where assignee_id = p.id and csat_score is not null)
                ) order by p.full_name), '[]')
               from public.profiles p
               where exists (select 1 from public.mvno_members mm where mm.user_id = p.id and mm.mvno_id in (select id from mine)))
  );
$$;
revoke all on function public.dashboard_stats(uuid, timestamptz) from public, anon;
grant execute on function public.dashboard_stats(uuid, timestamptz) to authenticated;
