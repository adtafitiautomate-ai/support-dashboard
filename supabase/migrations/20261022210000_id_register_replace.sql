-- A new upload of the cumulative "cards received" list replaces the previous one.
alter table public.id_batches drop constraint id_batches_status_check;
alter table public.id_batches add constraint id_batches_status_check check (status in ('processing', 'ready', 'failed', 'superseded'));
alter table public.id_batches add column replaces_previous boolean not null default true;
