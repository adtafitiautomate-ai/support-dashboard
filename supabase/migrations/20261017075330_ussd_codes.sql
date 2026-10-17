-- Self-service USSD codes per MVNO, used in bot replies.
alter table public.mvnos add column if not exists ussd_codes jsonb not null default '{}';
grant update (ussd_codes) on public.mvnos to authenticated;

update public.mvnos
set ussd_codes = '{"self_service":"*100#","balance":"*131#","promos":"*150#"}'
where slug = 'paxtel';

-- PaxTel knowledge the bot must follow.
insert into public.kb_articles (mvno_id, title, body, tags)
select m.id, k.title, k.body, k.tags::text[]
from public.mvnos m
cross join (values
  ('USSD codes: balance, airtime, bundles, promos, my number',
   'Check your balance: dial *131#. Buy airtime or bundles, or find out your own phone number: dial *100#. Promo bundles: dial *150# to see current promotions. PaxSente mobile money: dial *185#.',
   '{ussd,balance,airtime,bundles,promo,my number,codes}'),
  ('Promo bundles',
   'PaxTel promo bundles change from time to time: dial *150# to see and buy the current promotions. Regular bundles are also available here on WhatsApp or via *100#.',
   '{promo,promotion,offers,bundles}'),
  ('Failed transaction or money deducted',
   'If a top-up, bundle purchase or PaxSente transaction failed or money was deducted without value, ask the customer for the transaction ID (from the SMS or PaxSente statement), then hand over to the team. Finance verifies whether the transaction succeeded and resolves it. Never promise a refund before finance confirms.',
   '{failed,transaction,refund,deducted,reversal,paxsente}'),
  ('Lost, stolen or damaged SIM: replacement',
   'For a SIM replacement, a lost or stolen SIM or phone: visit the nearest PaxTel service centre with your original National ID. Your number is kept. Service centres: Wandegeya Traffic Lights and Ben Kiwanuka Street (Kampala), and Masaka, open daily 8:00 AM to 8:00 PM. Agents cannot do SIM replacements.',
   '{sim,replacement,lost,stolen,swap,service centre}'),
  ('PaxSente and top-up agents',
   'PaxSente agents do airtime and bundle top-ups, PaxSente deposits and withdrawals. Share your location here on WhatsApp and we will send the nearest agents. For SIM replacement, eSIM and device support, visit a service centre instead.',
   '{agent,paxsente,top up,deposit,withdraw,location}')
) as k(title, body, tags)
where m.slug = 'paxtel';

-- Replace the older lost/stolen guidance that pointed to an agent handover.
update public.kb_articles
set body = 'To get a PaxTel line you need your full name, residential address and a valid ID; PaxTel verifies details as required by the Uganda Communications Commission (UCC). Activate a new SIM within 7 days of receiving it. Prepaid and postpaid plans exist. SIM swaps, replacements and lost or stolen SIMs are handled at PaxTel service centres: bring your original National ID.'
where title = 'SIM registration, activation and replacement';
