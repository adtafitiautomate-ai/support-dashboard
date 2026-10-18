-- Product renamed to Tuongee. (The internal login domain tuvugane.local is unchanged on purpose.)
alter table private.smtp_settings alter column from_name set default 'Tuongee';
update private.smtp_settings set from_name = 'Tuongee' where from_name = 'Tuvugane';

create or replace function public.set_smtp_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.smtp_settings (id, host, port, secure, username, password, from_email, from_name, enabled, updated_at)
  values (
    1, p ->> 'host', coalesce((p ->> 'port')::int, 587), coalesce((p ->> 'secure')::boolean, false),
    nullif(p ->> 'username', ''), nullif(p ->> 'password', ''), p ->> 'from_email',
    coalesce(nullif(p ->> 'from_name', ''), 'Tuongee'), coalesce((p ->> 'enabled')::boolean, true), now()
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
