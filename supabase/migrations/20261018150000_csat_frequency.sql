-- Ask each customer for a rating at most once every N days (per tenant), not after every chat.
alter table public.mvnos add column csat_every_days int not null default 14 check (csat_every_days between 0 and 365);
alter table public.contacts add column csat_asked_at timestamptz;
