-- Validity is not always published: null = not stated (never shown), 0 = no expiry.
alter table public.bundles alter column validity_days drop not null;
alter table public.bundles alter column validity_days drop default;
