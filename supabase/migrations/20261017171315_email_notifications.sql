-- =====================================================================
-- Email notifications: platform SMTP settings (password kept in the
-- private schema) and per-MVNO recipient lists.
-- =====================================================================

create table if not exists private.smtp_settings (
  id int primary key default 1 check (id = 1), -- single row
  host text not null,
  port int not null default 587,
  secure boolean not null default false,        -- true = implicit TLS (465); false = STARTTLS (587)
  username text,
  password text,
  from_email text not null,
  from_name text not null default 'Tuvugane',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table private.smtp_settings enable row level security;

-- Server-only accessors (service role). The password never reaches the browser.
create or replace function public.get_smtp_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) from private.smtp_settings s where s.id = 1;
$$;

create or replace function public.set_smtp_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.smtp_settings (id, host, port, secure, username, password, from_email, from_name, enabled, updated_at)
  values (
    1, p ->> 'host', coalesce((p ->> 'port')::int, 587), coalesce((p ->> 'secure')::boolean, false),
    nullif(p ->> 'username', ''), nullif(p ->> 'password', ''), p ->> 'from_email',
    coalesce(nullif(p ->> 'from_name', ''), 'Tuvugane'), coalesce((p ->> 'enabled')::boolean, true), now()
  )
  on conflict (id) do update set
    host = excluded.host,
    port = excluded.port,
    secure = excluded.secure,
    username = excluded.username,
    -- An omitted password keeps the stored one.
    password = case when p ? 'password' then excluded.password else private.smtp_settings.password end,
    from_email = excluded.from_email,
    from_name = excluded.from_name,
    enabled = excluded.enabled,
    updated_at = now();
end;
$$;

revoke all on function public.get_smtp_settings() from public, anon, authenticated;
revoke all on function public.set_smtp_settings(jsonb) from public, anon, authenticated;
grant execute on function public.get_smtp_settings() to service_role;
grant execute on function public.set_smtp_settings(jsonb) to service_role;

-- Who gets emailed, per MVNO.
alter table public.mvnos add column if not exists finance_emails text[] not null default '{}'; -- failed transactions
alter table public.mvnos add column if not exists alert_emails text[] not null default '{}';   -- chats waiting with no agent online, deletion requests
grant update (finance_emails, alert_emails) on public.mvnos to authenticated;

-- SalamTel's mobile money brand.
update public.mvnos set wallet_name = 'SalamPesa' where slug = 'salamtel' and wallet_name = 'mobile money';
