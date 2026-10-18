-- WhatsApp template campaigns to a tenant's saved audience.

-- Needed to list the tenant's approved message templates.
alter table public.mvnos add column wa_waba_id text;
update public.mvnos set wa_waba_id = '488254287705157' where slug = 'paxtel';
update public.mvnos set wa_waba_id = '1854277321966538' where slug = 'salamtel';

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  name text not null,
  template_name text not null,
  template_language text not null,
  template_category text,
  template jsonb not null,          -- parsed template snapshot (what was sent)
  variables jsonb not null default '{}',
  header_media jsonb,               -- { path, mime, kind } for image/video/document headers
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'sending' check (status in ('sending', 'done', 'cancelled')),
  processing_until timestamptz,     -- worker lock
  finished_at timestamptz
);
create index campaigns_mvno on public.campaigns (mvno_id, created_at desc);

create table public.campaign_recipients (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  wa_id text not null,
  name text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  wa_message_id text unique,
  error text,
  updated_at timestamptz not null default now()
);
create index campaign_recipients_queue on public.campaign_recipients (campaign_id, status);

-- Server-only (API checks tenant roles); no client policies.
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

-- Per-campaign delivery counts.
create or replace function public.campaign_stats(p_mvno uuid)
returns table (campaign_id uuid, total bigint, queued bigint, sent bigint, delivered bigint, read bigint, failed bigint, skipped bigint)
language sql stable security definer set search_path = '' as $$
  select r.campaign_id, count(*),
    count(*) filter (where r.status = 'queued'),
    count(*) filter (where r.status = 'sent'),
    count(*) filter (where r.status = 'delivered'),
    count(*) filter (where r.status = 'read'),
    count(*) filter (where r.status = 'failed'),
    count(*) filter (where r.status = 'skipped')
  from public.campaign_recipients r
  join public.campaigns c on c.id = r.campaign_id
  where c.mvno_id = p_mvno
  group by r.campaign_id;
$$;
revoke all on function public.campaign_stats(uuid) from public, anon, authenticated;
grant execute on function public.campaign_stats(uuid) to service_role;
