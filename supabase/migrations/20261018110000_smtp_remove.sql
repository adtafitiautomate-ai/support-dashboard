-- Lets a super admin wipe the SMTP settings (host, username, password...) completely.
create or replace function public.clear_smtp_settings()
returns void language sql security definer set search_path = '' as $$
  delete from private.smtp_settings where id = 1;
$$;
revoke all on function public.clear_smtp_settings() from public, anon, authenticated;
grant execute on function public.clear_smtp_settings() to service_role;
