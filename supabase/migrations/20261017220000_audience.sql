-- Campaign audience: customers whose WhatsApp number falls in the MVNO's own number ranges.
-- Prefixes are stored in international form without "+" (e.g. 2567243 for 07243...).
alter table public.mvnos add column number_prefixes text[] not null default '{}';
alter table public.mvnos add constraint mvnos_number_prefixes_digits
  check (array_to_string(number_prefixes, '') ~ '^[0-9]*$');

-- Customers who replied STOP are never included in campaigns.
alter table public.contacts add column opted_out_at timestamptz;

create index contacts_mvno_wa_id_pattern on public.contacts (mvno_id, wa_id text_pattern_ops);

update public.mvnos set number_prefixes = '{2567243,25672406}' where slug = 'salamtel';
