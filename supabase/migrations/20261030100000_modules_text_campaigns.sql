-- Per-tenant modules: which staff pages, panels and reports a tenant has.
-- null = the defaults for the tenant's kind (what every tenant had before), so nothing changes until an admin edits it.
alter table public.mvnos add column if not exists modules text[];

-- Campaigns can be a plain-text message (only reaches people who wrote in the last 24 hours) as well as a template,
-- and remember who they were for (e.g. "ID has arrived") so sending can update the waiting list.
alter table public.campaigns
  add column if not exists kind text not null default 'template' check (kind in ('template', 'text')),
  add column if not exists body text,
  add column if not exists audience jsonb;
alter table public.campaigns
  alter column template_name drop not null,
  alter column template_language drop not null,
  alter column template drop not null;
