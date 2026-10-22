-- Each tenant's own logo, shown on emails sent on its behalf (Tuongee's stays on the app itself).
alter table public.mvnos add column logo_url text;

-- Public bucket: email clients must be able to load the image without signing in.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 1048576, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
