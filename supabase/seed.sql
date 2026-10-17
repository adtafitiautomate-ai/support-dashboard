-- Demo data. All passwords: Password123!
-- MVNO brands are fictional.

-- ---------------------------------------------------------------- MVNOs
insert into public.mvnos (id, slug, name, brand_color, currency, wa_phone_number_id, wa_display_number, bot_name, bot_persona, greeting, sla_first_response_mins) values
  ('11111111-1111-1111-1111-111111111111', 'nova', 'Nova Mobile', '#7C3AED', 'KES', 'SIM-NOVA', '+254 700 100 100', 'Nova',
   'Warm, upbeat and concise. Uses light emoji. Youth-focused brand with cheap data.',
   'Hi 👋 I''m Nova, your Nova Mobile assistant.', 5),
  ('22222222-2222-2222-2222-222222222222', 'zuri', 'Zuri Telecom', '#0EA5E9', 'KES', 'SIM-ZURI', '+254 700 200 200', 'Zuri',
   'Professional and reassuring. Business and family plans. Minimal emoji.',
   'Hello, welcome to Zuri Telecom. I''m Zuri, your virtual assistant.', 3),
  ('33333333-3333-3333-3333-333333333333', 'pulse', 'Pulse Connect', '#F97316', 'KES', 'SIM-PULSE', '+254 700 300 300', 'Pulse',
   'Friendly and plain-spoken. Rural focus, explains steps simply, often in Swahili when the customer writes Swahili.',
   'Hi! I''m Pulse 🧡 Here to help with airtime, bundles and more.', 10);

-- ---------------------------------------------------------------- Users
do $$
declare
  u record;
begin
  for u in
    select * from (values
      ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'admin@demo.test',  'Platform Admin'),
      ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'amina@nova.test',  'Amina Wanjiru'),
      ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'brian@nova.test',  'Brian Otieno'),
      ('aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'chen@zuri.test',   'Chen Mwangi'),
      ('aaaaaaaa-0000-0000-0000-000000000005'::uuid, 'dana@pulse.test',  'Dana Achieng')
    ) as t(id, email, full_name)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
      extensions.crypt('Password123!', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.full_name),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id, u.id::text,
            jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', now(), now(), now());
  end loop;
end $$;

update public.profiles set is_platform_admin = true where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.profiles set status = 'online' where id in ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000004');

insert into public.mvno_members (mvno_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'supervisor'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'agent'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003', 'agent'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000004', 'admin'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000005', 'admin');

-- ---------------------------------------------------------------- Catalog
insert into public.bundles (mvno_id, code, name, price, data_mb, minutes, sms, validity_days, sort)
select m.id, b.code, b.name, b.price * m.mult, b.data_mb, b.minutes, b.sms, b.validity_days, b.sort
from (values
  ('11111111-1111-1111-1111-111111111111'::uuid, 1.0),
  ('22222222-2222-2222-2222-222222222222'::uuid, 1.2),
  ('33333333-3333-3333-3333-333333333333'::uuid, 0.9)
) as m(id, mult)
cross join (values
  ('D1',  'Daily 1GB',        50,   1024,    0,    0,  1, 1),
  ('D3',  'Daily 3GB + 50min', 99,  3072,   50,   20,  1, 2),
  ('W5',  'Weekly 5GB',       250,  5120,    0,    0,  7, 3),
  ('WC',  'Weekly Combo',     300,  3072,  200,  200,  7, 4),
  ('M20', 'Monthly 20GB',     1000, 20480,   0,    0, 30, 5),
  ('MU',  'Monthly Unlimited Calls + 10GB', 1500, 10240, 99999, 1000, 30, 6),
  ('NO',  'Night Owl 10GB (00-06h)', 75, 10240, 0, 0, 1, 7)
) as b(code, name, price, data_mb, minutes, sms, validity_days, sort);

insert into public.outlets (mvno_id, name, kind, address, lat, lng, phone, hours, services)
select m.id, m.prefix || ' ' || o.name, o.kind, o.address, o.lat, o.lng, o.phone, o.hours, o.services::text[]
from (values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'Nova'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'Zuri'),
  ('33333333-3333-3333-3333-333333333333'::uuid, 'Pulse')
) as m(id, prefix)
cross join (values
  ('Store – CBD',          'store', 'Kimathi St, Nairobi CBD',        -1.2841, 36.8233, '+254711000001', 'Mon–Sat 8am–7pm', '{sim_swap,esim,device_repair,recharge}'),
  ('Store – Westlands',    'store', 'Sarit Centre, Westlands',        -1.2614, 36.8027, '+254711000002', 'Daily 9am–8pm',   '{sim_swap,esim,recharge}'),
  ('Agent – Kibera Drive', 'agent', 'Kibera Drive, Olympic stage',    -1.3133, 36.7848, '+254711000003', 'Daily 7am–9pm',   '{recharge,sim_registration}'),
  ('Agent – Eastleigh',    'agent', '1st Ave Eastleigh',              -1.2753, 36.8510, '+254711000004', 'Daily 7am–10pm',  '{recharge,sim_registration}'),
  ('Kiosk – Rongai',       'kiosk', 'Rongai Stage, Magadi Rd',        -1.3963, 36.7442, '+254711000005', 'Mon–Sat 8am–6pm', '{recharge}'),
  ('Store – Thika',        'store', 'Kenyatta Hwy, Thika Town',       -1.0333, 37.0693, '+254711000006', 'Mon–Sat 8am–6pm', '{sim_swap,recharge,device_repair}'),
  ('Agent – Mombasa Old Town', 'agent', 'Digo Rd, Mombasa',           -4.0617, 39.6766, '+254711000007', 'Daily 8am–9pm',   '{recharge,sim_registration}')
) as o(name, kind, address, lat, lng, phone, hours, services);

insert into public.kb_articles (mvno_id, title, body, tags)
select m.id, k.title, replace(k.body, '{brand}', m.name), k.tags::text[]
from public.mvnos m
cross join (values
  ('Data not working / no internet',
   'Ask the customer to: 1) toggle Airplane mode for 10 seconds, 2) confirm mobile data is ON, 3) set APN to "internet" (Settings > Mobile network > Access Point Names), 4) restart the phone. If the balance shows data but it still fails after these steps, escalate to an agent with the device model.',
   '{data,internet,apn}'),
  ('SIM swap / replacement',
   'SIM swaps require the original ID. Visit any {brand} store (not agents or kiosks) with your national ID. A replacement SIM costs KES 50. Your number, balance and bundles are kept. For lost phones we can block the line immediately — hand over to an agent for that.',
   '{sim,swap,lost}'),
  ('eSIM activation',
   'eSIM works on supported phones (iPhone XS and newer, Pixel 3 and newer, Samsung S20 and newer). We can deliver an eSIM QR code by email after an agent verifies identity, or you can visit a store. Delivery of a physical SIM is free in Nairobi within 24h.',
   '{esim}'),
  ('Bundle expiry and rollover',
   'Unused data rolls over once if you renew the same bundle before expiry. Night Owl data only works 00:00–06:00. Bundles bought via WhatsApp activate instantly after payment confirmation.',
   '{bundle,expiry,rollover}'),
  ('Payment failed but money deducted',
   'If mobile money was deducted but the bundle did not arrive within 5 minutes, it is automatically reversed within 24 hours. Collect the payment reference and hand over to an agent if the customer wants it resolved faster.',
   '{payment,refund,recharge}'),
  ('Coverage and network outages',
   'For poor signal, ask for the customer''s location/town. {brand} runs on a partner network with 4G across major towns. Known outages are announced on our socials. Escalate repeated drops in a specific area to an agent so engineering can log a ticket.',
   '{network,coverage,outage}'),
  ('Porting your number to us',
   'Number porting is free. Dial *100# from the old SIM to get a porting code, then request a SIM delivery or visit a store with ID. Porting completes within 24 hours.',
   '{porting,mnp}')
) as k(title, body, tags);

insert into public.canned_responses (mvno_id, shortcut, title, body)
select m.id, c.shortcut, c.title, c.body
from public.mvnos m
cross join (values
  ('hi',      'Greeting',          'Hi {{name}}, thanks for reaching out to {{brand}}. I''m {{agent}} and I''ll help you with this today.'),
  ('apn',     'APN settings',      'Please set your APN to "internet": Settings > Mobile network > Access Point Names > Add. Then restart your phone and let me know if data works.'),
  ('swap',    'SIM swap steps',    'For a SIM swap please visit any of our stores with your original national ID. It takes about 5 minutes and your number and balance stay the same.'),
  ('refund',  'Refund timeline',   'I''ve logged your payment reference. Failed recharges are reversed automatically within 24 hours, and I''ve flagged yours to be checked today.'),
  ('wait',    'Checking',          'Thanks for your patience. I''m checking this for you now, it will take 2–3 minutes.'),
  ('bye',     'Closing',           'Glad I could help, {{name}}! Is there anything else I can do for you today?')
) as c(shortcut, title, body);

-- ---------------------------------------------------------------- Demo customers
insert into public.contacts (id, mvno_id, wa_id, name, msisdn, plan, tags) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '254712345001', 'Grace Njeri',  '254712345001', 'Prepaid', '{vip}'),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '254712345002', 'Kevin Mutua',  '254712345002', 'Prepaid', '{}'),
  ('cccccccc-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', '254712345003', 'Faith Kamau',  '254712345003', 'Business Postpaid', '{business}'),
  ('cccccccc-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', '254712345004', 'Joseph Kiprop','254712345004', 'Prepaid', '{}'),
  ('cccccccc-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '254712345005', 'Mercy Atieno', '254712345005', 'Prepaid', '{}');

insert into public.conversations (id, mvno_id, contact_id, status, priority, assignee_id, category, subject, ai_summary, sentiment, handoff_at, sla_due_at, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001',
   'open', 'high', null, 'payment', 'Paid for bundle, not received',
   'Customer paid KES 250 for Weekly 5GB via mobile money 20 min ago; bundle not credited. Ref QX81LM2. Frustrated, VIP.',
   'negative', now() - interval '6 minutes', now() - interval '1 minute', now() - interval '25 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000002',
   'open', 'normal', 'aaaaaaaa-0000-0000-0000-000000000002', 'network', 'No internet after SIM swap',
   'Data not working since SIM swap yesterday. Bot walked through APN steps without success.',
   'neutral', now() - interval '40 minutes', now() - interval '35 minutes', now() - interval '50 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'cccccccc-0000-0000-0000-000000000003',
   'open', 'normal', null, 'delivery', 'eSIM for new company phones',
   'Business customer wants 5 eSIMs for staff; needs invoice.', 'positive', now() - interval '2 minutes', now() + interval '1 minute', now() - interval '10 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'cccccccc-0000-0000-0000-000000000004',
   'bot', 'normal', null, 'recharge', null, null, null, null, null, now() - interval '3 minutes');

insert into public.messages (conversation_id, mvno_id, direction, sender_type, type, body, status, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Hi I bought weekly 5GB and I haven''t received it', 'received', now() - interval '25 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'out', 'bot',     'text', 'Sorry about that 😔 Failed purchases are reversed automatically within 24h. Can you share the payment reference?', 'read', now() - interval '24 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'QX81LM2. I need the data now, I have a meeting', 'received', now() - interval '8 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Talk to a person please', 'received', now() - interval '6 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'out', 'system',  'event', 'Handed over to the support team', 'sent', now() - interval '6 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'My internet is not working since I swapped my SIM', 'received', now() - interval '50 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'out', 'bot',     'text', 'Let''s fix that. Please set your APN to "internet" and restart your phone.', 'read', now() - interval '49 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Still nothing', 'received', now() - interval '41 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'out', 'agent',   'text', 'Hi Kevin, I''m Amina. I can see the new SIM is provisioned — I''m re-pushing data settings now.', 'read', now() - interval '38 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'in',  'contact', 'text', 'Good morning, we need 5 eSIMs for new staff phones. Can you invoice the company?', 'received', now() - interval '10 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'in',  'contact', 'text', 'Nataka bundle ya wiki', 'received', now() - interval '3 minutes');

update public.conversations set first_response_at = now() - interval '38 minutes', unread_count = 0
  where id = 'dddddddd-0000-0000-0000-000000000002';

insert into public.recharges (mvno_id, contact_id, msisdn, kind, amount, status, created_at)
select '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001', '254712345001', 'bundle', 250, s, now() - (i || ' days')::interval
from (values (1, 'success'), (3, 'success'), (0, 'failed')) as v(i, s);

insert into public.deliveries (mvno_id, contact_id, item, status, address, lat, lng, scheduled_for, rider_name, rider_phone) values
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000005', 'sim', 'out_for_delivery', 'Kilimani, Argwings Kodhek Rd', -1.2921, 36.7856, now() + interval '40 minutes', 'Peter K.', '+254722000111'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-0000-0000-0000-000000000003', 'esim', 'requested', 'Upper Hill, Nairobi', -1.2995, 36.8155, null, null, null);
