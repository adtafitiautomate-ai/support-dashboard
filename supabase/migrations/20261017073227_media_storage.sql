-- Private bucket for WhatsApp media (Meta deletes its copies after ~30 days).
-- No storage policies: only the server (secret key) reads/writes; agents get
-- short-lived signed URLs through /api/media/[id] after an RLS membership check.
insert into storage.buckets (id, name, public, file_size_limit)
values ('wa-media', 'wa-media', false, 104857600) -- 100 MB (WhatsApp's document limit)
on conflict (id) do nothing;
