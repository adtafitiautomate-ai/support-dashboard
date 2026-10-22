-- Tenants that aren't mobile networks (e.g. an embassy): own menu, telecom features off,
-- and optionally "sourced answers only" (every answer cites a source page + last-verified date).

alter table public.mvnos
  add column kind text not null default 'telecom' check (kind in ('telecom', 'general')),
  add column menu_items jsonb not null default '[]',      -- [{ id, title, description, action }]
  add column strict_sources boolean not null default false,
  add column emergency_message text;

-- Where an article's facts come from, and when someone last checked them.
alter table public.kb_articles
  add column source_url text,
  add column verified_at date;

-- Articles trained from a web link: the link is their source, verified the day it was read.
update public.kb_articles a
set source_url = s.url, verified_at = coalesce(a.verified_at, s.updated_at::date)
from public.kb_sources s
where a.source_id = s.id and s.kind = 'url' and s.url is not null and a.source_url is null;
