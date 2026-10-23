-- Per-tenant email: each tenant can send from its own mail server and address. A tenant without
-- its own server only uses the system server when shared_email is on (off by default).

create table if not exists private.tenant_smtp (
  mvno_id uuid primary key references public.mvnos(id) on delete cascade,
  host text not null,
  port int not null default 587,
  secure boolean not null default false,
  username text,
  password text,
  from_email text not null,
  from_name text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table private.tenant_smtp enable row level security;

create or replace function public.get_tenant_smtp(p_mvno uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) from private.tenant_smtp s where s.mvno_id = p_mvno;
$$;

-- For the admin page: every tenant's settings without passwords.
create or replace function public.list_tenant_smtp()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s) - 'password' || jsonb_build_object('has_password', s.password is not null)), '[]'::jsonb)
  from private.tenant_smtp s;
$$;

create or replace function public.set_tenant_smtp(p_mvno uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.tenant_smtp (mvno_id, host, port, secure, username, password, from_email, from_name, enabled, updated_at)
  values (
    p_mvno, p ->> 'host', coalesce((p ->> 'port')::int, 587), coalesce((p ->> 'secure')::boolean, false),
    nullif(p ->> 'username', ''), nullif(p ->> 'password', ''), p ->> 'from_email',
    nullif(p ->> 'from_name', ''), coalesce((p ->> 'enabled')::boolean, true), now()
  )
  on conflict (mvno_id) do update set
    host = excluded.host,
    port = excluded.port,
    secure = excluded.secure,
    username = excluded.username,
    -- An omitted password keeps the stored one.
    password = case when p ? 'password' then excluded.password else private.tenant_smtp.password end,
    from_email = excluded.from_email,
    from_name = excluded.from_name,
    enabled = excluded.enabled,
    updated_at = now();
end;
$$;

create or replace function public.clear_tenant_smtp(p_mvno uuid)
returns void language sql security definer set search_path = '' as $$
  delete from private.tenant_smtp where mvno_id = p_mvno;
$$;

revoke all on function public.get_tenant_smtp(uuid) from public, anon, authenticated;
revoke all on function public.list_tenant_smtp() from public, anon, authenticated;
revoke all on function public.set_tenant_smtp(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.clear_tenant_smtp(uuid) from public, anon, authenticated;
grant execute on function public.get_tenant_smtp(uuid) to service_role;
grant execute on function public.list_tenant_smtp() to service_role;
grant execute on function public.set_tenant_smtp(uuid, jsonb) to service_role;
grant execute on function public.clear_tenant_smtp(uuid) to service_role;

alter table public.mvnos add column if not exists shared_email boolean not null default false;
update public.mvnos set shared_email = true where name in ('SalamTel', 'PaxTel', 'AgroTel') and kind = 'telecom';

-- Which tenant an email was sent for (Admin → Email log).
alter table public.email_log add column if not exists mvno_id uuid references public.mvnos(id) on delete set null;
