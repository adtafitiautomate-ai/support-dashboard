-- =====================================================================
-- WhatsApp shared inbox for MVNOs
-- Tenancy: every business row carries mvno_id; agents see only MVNOs
-- they are members of (platform admins see all).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.member_role as enum ('admin', 'supervisor', 'agent');
create type public.agent_status as enum ('online', 'away', 'offline');
create type public.conversation_status as enum ('bot', 'open', 'pending', 'resolved');
create type public.conversation_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.message_direction as enum ('in', 'out');
create type public.sender_type as enum ('contact', 'bot', 'agent', 'system');
create type public.message_status as enum ('queued', 'sent', 'delivered', 'read', 'failed', 'received');

-- ---------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------
create table public.mvnos (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  brand_color text not null default '#25D366',
  currency text not null default 'KES',
  wa_phone_number_id text unique,          -- Meta Cloud API phone_number_id
  wa_display_number text,
  bot_name text not null default 'Assistant',
  bot_persona text not null default '',
  greeting text not null default 'Hi! How can we help you today?',
  sla_first_response_mins int not null default 5,
  business_hours jsonb not null default '{"tz":"Africa/Nairobi","open":"08:00","close":"20:00","days":[1,2,3,4,5,6]}',
  created_at timestamptz not null default now()
);

-- Secrets never leave the private schema (not exposed via the Data API).
create table private.mvno_secrets (
  mvno_id uuid primary key references public.mvnos(id) on delete cascade,
  wa_access_token text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  avatar_url text,
  is_platform_admin boolean not null default false,
  status public.agent_status not null default 'offline',
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.mvno_members (
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'agent',
  max_concurrent int not null default 8,
  created_at timestamptz not null default now(),
  primary key (mvno_id, user_id)
);
create index mvno_members_user_idx on public.mvno_members(user_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  wa_id text not null,                      -- WhatsApp id (E.164 without +)
  name text,
  msisdn text,                              -- the MVNO line, defaults to wa_id
  language text not null default 'en',
  tags text[] not null default '{}',
  plan text,
  notes text,
  last_location jsonb,                      -- {lat,lng,at}
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (mvno_id, wa_id)
);

-- ---------------------------------------------------------------------
-- Conversations (each one is also a ticket)
-- ---------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  ticket_no bigint generated always as identity,
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status public.conversation_status not null default 'bot',
  priority public.conversation_priority not null default 'normal',
  assignee_id uuid references public.profiles(id) on delete set null,
  category text,
  subject text,
  ai_summary text,
  sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  bot_state jsonb not null default '{}',
  unread_count int not null default 0,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  last_inbound_at timestamptz,
  handoff_at timestamptz,
  first_response_at timestamptz,
  sla_due_at timestamptz,
  resolved_at timestamptz,
  csat_score int check (csat_score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_inbox_idx on public.conversations(mvno_id, status, last_message_at desc);
create index conversations_assignee_idx on public.conversations(assignee_id, status);
create index conversations_contact_idx on public.conversations(contact_id, created_at desc);
-- At most one active conversation per contact.
create unique index conversations_one_active_idx on public.conversations(contact_id)
  where status <> 'resolved';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  direction public.message_direction not null,
  sender_type public.sender_type not null,
  sender_id uuid references public.profiles(id) on delete set null,
  type text not null default 'text',        -- text|image|audio|video|document|location|interactive|button_reply|list_reply|template|note|event
  body text,
  payload jsonb not null default '{}',
  is_internal boolean not null default false, -- internal notes / system events never go to WhatsApp
  wa_message_id text unique,
  status public.message_status not null default 'queued',
  error text,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);

-- ---------------------------------------------------------------------
-- Knowledge / catalog / operations
-- ---------------------------------------------------------------------
create table public.canned_responses (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  shortcut text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  unique (mvno_id, shortcut)
);

-- Training sources: uploaded documents and web links. Each is distilled into kb_articles.
create table public.kb_sources (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  kind text not null check (kind in ('file', 'url')),
  name text not null,
  url text,
  mime text,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  error text,
  chars int,
  article_count int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_sources_mvno_idx on public.kb_sources(mvno_id, created_at desc);

create table public.kb_articles (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  source_id uuid references public.kb_sources(id) on delete cascade, -- null = written by hand
  title text not null,
  body text not null,
  tags text[] not null default '{}',
  fts tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) stored,
  updated_at timestamptz not null default now()
);
create index kb_articles_mvno_idx on public.kb_articles(mvno_id);
create index kb_articles_source_idx on public.kb_articles(source_id);
create index kb_articles_fts_idx on public.kb_articles using gin (fts);

-- Retrieval for the bot: any-word match ('simple' config also suits Swahili/Sheng), ranked.
create or replace function public.search_kb(p_mvno uuid, p_query text, p_limit int default 8)
returns setof public.kb_articles
language sql stable security invoker set search_path = ''
as $$
  with q as (
    select to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) as tsq
    from unnest(to_tsvector('simple', p_query)) as t(lexeme, positions, weights)
    where length(lexeme) > 2
  )
  select a.* from public.kb_articles a, q
  where a.mvno_id = p_mvno and q.tsq is not null and a.fts @@ q.tsq
  order by ts_rank(a.fts, q.tsq) desc
  limit p_limit;
$$;

create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  code text not null,
  name text not null,
  price numeric(12,2) not null,
  data_mb int not null default 0,
  minutes int not null default 0,
  sms int not null default 0,
  validity_days int not null default 1,
  active boolean not null default true,
  sort int not null default 0,
  unique (mvno_id, code)
);

create table public.outlets (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  name text not null,
  kind text not null default 'agent' check (kind in ('store', 'agent', 'kiosk')),
  address text not null,
  lat double precision not null,
  lng double precision not null,
  phone text,
  hours text,
  services text[] not null default '{}'
);
create index outlets_mvno_idx on public.outlets(mvno_id);

create table public.recharges (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  msisdn text not null,
  kind text not null check (kind in ('airtime', 'bundle')),
  bundle_id uuid references public.bundles(id) on delete set null,
  amount numeric(12,2) not null,
  method text not null default 'mobile_money',
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  reference text not null default upper(substr(md5(random()::text), 1, 10)),
  created_at timestamptz not null default now()
);
create index recharges_mvno_idx on public.recharges(mvno_id, created_at desc);
create index recharges_contact_idx on public.recharges(contact_id, created_at desc);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  mvno_id uuid not null references public.mvnos(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  item text not null check (item in ('sim', 'esim', 'device', 'router')),
  status text not null default 'requested'
    check (status in ('requested', 'scheduled', 'out_for_delivery', 'delivered', 'failed', 'cancelled')),
  address text,
  lat double precision,
  lng double precision,
  scheduled_for timestamptz,
  tracking_code text not null default 'TRK' || upper(substr(md5(random()::text), 1, 7)),
  rider_name text,
  rider_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deliveries_contact_idx on public.deliveries(contact_id, created_at desc);
create index deliveries_mvno_idx on public.deliveries(mvno_id, status);

-- ---------------------------------------------------------------------
-- Authorization helpers (private schema: not callable via the Data API)
-- ---------------------------------------------------------------------
create or replace function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

create or replace function private.is_member(p_mvno uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_platform_admin()
      or exists (
        select 1 from public.mvno_members m
        where m.mvno_id = p_mvno and m.user_id = (select auth.uid())
      );
$$;

create or replace function private.has_role(p_mvno uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_platform_admin()
      or exists (
        select 1 from public.mvno_members m
        where m.mvno_id = p_mvno and m.user_id = (select auth.uid()) and m.role = any(p_roles)
      );
$$;

revoke all on function private.is_platform_admin() from public;
revoke all on function private.is_member(uuid) from public;
revoke all on function private.has_role(uuid, public.member_role[]) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger conversations_touch before update on public.conversations
  for each row execute function private.touch_updated_at();
create trigger deliveries_touch before update on public.deliveries
  for each row execute function private.touch_updated_at();

-- Keep the conversation list row current whenever a message lands.
create or replace function private.on_message_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations c set
    last_message_at = new.created_at,
    last_message_preview = case
      when new.type = 'event' then c.last_message_preview
      when new.is_internal then c.last_message_preview
      else left(coalesce(new.body, '[' || new.type || ']'), 140)
    end,
    last_inbound_at = case when new.direction = 'in' then new.created_at else c.last_inbound_at end,
    unread_count = case when new.direction = 'in' then c.unread_count + 1 else c.unread_count end,
    first_response_at = case
      when new.sender_type = 'agent' and not new.is_internal and c.first_response_at is null
        and c.handoff_at is not null then new.created_at
      else c.first_response_at
    end
  where c.id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_after_insert after insert on public.messages
  for each row execute function private.on_message_insert();

-- Auto-create a profile for every new auth user.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------
-- Realtime: broadcast row changes to a private per-MVNO topic.
-- Clients subscribe to `mvno:<uuid>`; realtime.messages RLS gates access.
-- ---------------------------------------------------------------------
create or replace function private.broadcast_mvno_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_mvno uuid := coalesce(new.mvno_id, old.mvno_id);
begin
  perform realtime.broadcast_changes(
    'mvno:' || v_mvno::text,
    tg_table_name || ':' || tg_op,   -- event, e.g. "messages:INSERT"
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create trigger messages_broadcast after insert or update on public.messages
  for each row execute function private.broadcast_mvno_change();
create trigger conversations_broadcast after insert or update on public.conversations
  for each row execute function private.broadcast_mvno_change();
create trigger contacts_broadcast after update on public.contacts
  for each row execute function private.broadcast_mvno_change();
create trigger recharges_broadcast after insert or update on public.recharges
  for each row execute function private.broadcast_mvno_change();
create trigger deliveries_broadcast after insert or update on public.deliveries
  for each row execute function private.broadcast_mvno_change();
create trigger kb_sources_broadcast after insert or update on public.kb_sources
  for each row execute function private.broadcast_mvno_change();
create trigger kb_sources_touch before update on public.kb_sources
  for each row execute function private.touch_updated_at();

-- Members can receive DB broadcasts and exchange presence/typing on their MVNO topics.
create policy "mvno members read topic" on realtime.messages
  for select to authenticated
  using (
    split_part((select realtime.topic()), ':', 1) = 'mvno'
    and private.is_member(nullif(split_part((select realtime.topic()), ':', 2), '')::uuid)
  );

create policy "mvno members write topic" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and split_part((select realtime.topic()), ':', 1) = 'mvno'
    and private.is_member(nullif(split_part((select realtime.topic()), ':', 2), '')::uuid)
  );

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.mvnos enable row level security;
alter table public.profiles enable row level security;
alter table public.mvno_members enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.canned_responses enable row level security;
alter table public.kb_articles enable row level security;
alter table public.kb_sources enable row level security;
alter table public.bundles enable row level security;
alter table public.outlets enable row level security;
alter table public.recharges enable row level security;
alter table public.deliveries enable row level security;
alter table private.mvno_secrets enable row level security; -- no policies: service role only

-- mvnos
create policy "members read mvno" on public.mvnos for select to authenticated
  using (private.is_member(id));
create policy "admins update mvno" on public.mvnos for update to authenticated
  using (private.has_role(id, array['admin']::public.member_role[]))
  with check (private.has_role(id, array['admin']::public.member_role[]));

-- profiles: colleagues (shared MVNO) are visible; you edit only yourself.
create policy "read self and colleagues" on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.is_platform_admin()
    or exists (
      select 1 from public.mvno_members mine
      join public.mvno_members theirs on theirs.mvno_id = mine.mvno_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id
    )
  );
create policy "update self" on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- memberships
create policy "members read memberships" on public.mvno_members for select to authenticated
  using (private.is_member(mvno_id));
create policy "admins manage memberships" on public.mvno_members for all to authenticated
  using (private.has_role(mvno_id, array['admin']::public.member_role[]))
  with check (private.has_role(mvno_id, array['admin']::public.member_role[]));

-- tenant-scoped tables: members read; members write operational data.
create policy "members read" on public.contacts for select to authenticated using (private.is_member(mvno_id));
create policy "members update" on public.contacts for update to authenticated
  using (private.is_member(mvno_id)) with check (private.is_member(mvno_id));

create policy "members read" on public.conversations for select to authenticated using (private.is_member(mvno_id));
create policy "members update" on public.conversations for update to authenticated
  using (private.is_member(mvno_id)) with check (private.is_member(mvno_id));

create policy "members read" on public.messages for select to authenticated using (private.is_member(mvno_id));

create policy "members read" on public.canned_responses for select to authenticated using (private.is_member(mvno_id));
create policy "supervisors manage" on public.canned_responses for all to authenticated
  using (private.has_role(mvno_id, array['admin','supervisor']::public.member_role[]))
  with check (private.has_role(mvno_id, array['admin','supervisor']::public.member_role[]));

create policy "members read" on public.kb_articles for select to authenticated using (private.is_member(mvno_id));
create policy "supervisors manage" on public.kb_articles for all to authenticated
  using (private.has_role(mvno_id, array['admin','supervisor']::public.member_role[]))
  with check (private.has_role(mvno_id, array['admin','supervisor']::public.member_role[]));

create policy "members read" on public.kb_sources for select to authenticated using (private.is_member(mvno_id));
create policy "supervisors delete" on public.kb_sources for delete to authenticated
  using (private.has_role(mvno_id, array['admin','supervisor']::public.member_role[]));

create policy "members read" on public.bundles for select to authenticated using (private.is_member(mvno_id));
create policy "admins manage" on public.bundles for all to authenticated
  using (private.has_role(mvno_id, array['admin']::public.member_role[]))
  with check (private.has_role(mvno_id, array['admin']::public.member_role[]));

create policy "members read" on public.outlets for select to authenticated using (private.is_member(mvno_id));
create policy "admins manage" on public.outlets for all to authenticated
  using (private.has_role(mvno_id, array['admin']::public.member_role[]))
  with check (private.has_role(mvno_id, array['admin']::public.member_role[]));

create policy "members read" on public.recharges for select to authenticated using (private.is_member(mvno_id));

create policy "members read" on public.deliveries for select to authenticated using (private.is_member(mvno_id));
create policy "members update" on public.deliveries for update to authenticated
  using (private.is_member(mvno_id)) with check (private.is_member(mvno_id));

-- ---------------------------------------------------------------------
-- Data API grants (new tables are not auto-exposed). Writes that touch
-- WhatsApp go through server routes using the secret key.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant update (name, brand_color, bot_name, bot_persona, greeting, sla_first_response_mins, business_hours)
  on public.mvnos to authenticated;
grant update (full_name, avatar_url, status, last_seen_at) on public.profiles to authenticated;
grant insert, update, delete on public.mvno_members to authenticated;
grant update (name, tags, plan, notes, language) on public.contacts to authenticated;
grant update (priority, category, subject, unread_count) on public.conversations to authenticated;
grant insert, update, delete on public.canned_responses, public.kb_articles, public.bundles, public.outlets
  to authenticated;
grant delete on public.kb_sources to authenticated; -- inserts go through the ingest route
grant execute on function public.search_kb(uuid, text, int) to authenticated, service_role;
grant update (status, scheduled_for, rider_name, rider_phone, address) on public.deliveries to authenticated;
revoke all on all tables in schema public from anon;

grant all on all tables in schema public to service_role;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;

-- Server-only accessor for per-MVNO WhatsApp tokens.
create or replace function public.get_mvno_wa_token(p_mvno uuid)
returns text language sql stable security definer set search_path = '' as $$
  select s.wa_access_token from private.mvno_secrets s where s.mvno_id = p_mvno;
$$;
revoke all on function public.get_mvno_wa_token(uuid) from public, anon, authenticated;
grant execute on function public.get_mvno_wa_token(uuid) to service_role;

create or replace function public.set_mvno_wa_token(p_mvno uuid, p_token text)
returns void language sql security definer set search_path = '' as $$
  insert into private.mvno_secrets (mvno_id, wa_access_token, updated_at)
  values (p_mvno, p_token, now())
  on conflict (mvno_id) do update set wa_access_token = excluded.wa_access_token, updated_at = now();
$$;
revoke all on function public.set_mvno_wa_token(uuid, text) from public, anon, authenticated;
grant execute on function public.set_mvno_wa_token(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- Analytics (security invoker: RLS scopes it to the caller's MVNOs)
-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats(p_mvno uuid default null, p_since timestamptz default now() - interval '7 days')
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with conv as (
    select * from public.conversations c
    where (p_mvno is null or c.mvno_id = p_mvno)
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
    'avg_resolution_mins', (select coalesce(avg(extract(epoch from resolved_at - created_at) / 60), 0)::int
                             from recent where resolved_at is not null),
    'csat_avg', (select round(avg(csat_score)::numeric, 2) from recent where csat_score is not null),
    'csat_count', (select count(*) from recent where csat_score is not null),
    'recharge_total', (select coalesce(sum(r.amount), 0) from public.recharges r
                        where r.status = 'success' and r.created_at >= p_since
                          and (p_mvno is null or r.mvno_id = p_mvno)),
    'recharge_count', (select count(*) from public.recharges r
                        where r.status = 'success' and r.created_at >= p_since
                          and (p_mvno is null or r.mvno_id = p_mvno)),
    'deliveries_active', (select count(*) from public.deliveries d
                           where d.status in ('requested', 'scheduled', 'out_for_delivery')
                             and (p_mvno is null or d.mvno_id = p_mvno)),
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
               where exists (select 1 from public.mvno_members m where m.user_id = p.id
                               and (p_mvno is null or m.mvno_id = p_mvno)))
  );
$$;
revoke all on function public.dashboard_stats(uuid, timestamptz) from public, anon;
grant execute on function public.dashboard_stats(uuid, timestamptz) to authenticated;
