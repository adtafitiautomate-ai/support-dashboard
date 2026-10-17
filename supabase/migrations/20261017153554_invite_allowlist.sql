-- Invite-only accounts, take 2. GoTrue inserts auth.users before applying app_metadata,
-- so a metadata marker can't distinguish admin-created users. Instead the server puts the
-- email on a short-lived invite list right before calling the admin API; anything else
-- (e.g. public sign-up with the publishable key) is rejected.
create table if not exists private.invites (
  email text primary key,
  expires_at timestamptz not null
);
alter table private.invites enable row level security;

create or replace function public.allow_signup(p_email text)
returns void language sql security definer set search_path = '' as $$
  insert into private.invites (email, expires_at) values (lower(p_email), now() + interval '10 minutes')
  on conflict (email) do update set expires_at = excluded.expires_at;
$$;
revoke all on function public.allow_signup(text) from public, anon, authenticated;
grant execute on function public.allow_signup(text) to service_role;

create or replace function private.block_public_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.invites where expires_at < now();
  delete from private.invites where email = lower(new.email);
  if not found then
    raise exception 'Sign-ups are disabled. Ask your administrator for an account.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
