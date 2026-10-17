-- PaxTel (Hamilton Telecom, Uganda). Demo agent passwords: Password123!
-- Outlet coordinates are approximate: correct them in the outlets table.

-- ---------------------------------------------------------------- MVNO
insert into public.mvnos (
  id, slug, name, brand_color, currency, wallet_name, wallet_ussd, care_line,
  wa_phone_number_id, wa_display_number, bot_name, bot_persona, greeting, sla_first_response_mins, business_hours
) values (
  '11111111-1111-1111-1111-111111111111', 'paxtel', 'PaxTel', '#111827', 'UGX', 'PaxSente', '*185#',
  'Dial 100 from a PaxTel line (toll free, 24/7) or email info@paxtel.com',
  'SIM-PAXTEL', '+256 724 000 100', 'Pax',
  'PaxTel''s brand is warm, community-centred and practical: "Connectivity built around people", tagline "Better with us". Speak simply and kindly, like a helpful neighbour. Customers are across Uganda (Kampala, Masaka, Mbarara, Ntungamo, Kasese, Isingiro, rural areas). Reply in the customer''s language: English, Luganda, Runyankole/Rukiga or Swahili. Use UGX amounts with commas (e.g. UGX 2,000). Light emoji only.',
  'Hi 👋 Welcome to PaxTel, better with us! I''m Pax, your virtual assistant.',
  5,
  '{"tz":"Africa/Kampala","open":"08:00","close":"20:00","days":[0,1,2,3,4,5,6]}'
);

-- ---------------------------------------------------------------- Demo agents
do $$
declare
  u record;
begin
  for u in
    select * from (values
      ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'admin@demo.test',    'Platform Admin'),
      ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'sarah@paxtel.test',  'Sarah Nakato'),
      ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'david@paxtel.test',  'David Okello'),
      ('aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'grace@paxtel.test',  'Grace Atuhaire')
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

insert into public.mvno_members (mvno_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'supervisor'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'agent'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004', 'agent');

-- ---------------------------------------------------------------- Bundles (as published on paxtel.com)
insert into public.bundles (mvno_id, code, name, category, ussd, price, data_mb, minutes, sms, validity_days, sort)
select '11111111-1111-1111-1111-111111111111', b.* from (values
  ('V8',   '8 Minutes',                    'voice', '*100*2*1#',   500,     0,   8, 0,  1, 10),
  ('V12',  '12 Minutes',                   'voice', '*100*2*1#',   700,     0,  12, 0,  1, 11),
  ('V25',  '25 Minutes',                   'voice', '*100*2*1#',   600,     0,  25, 0,  1, 12),
  ('V27',  '27 Minutes',                   'voice', '*100*2*1#',  1500,     0,  27, 0,  1, 13),
  ('V45',  '45 Minutes',                   'voice', '*100*2*1#',  2500,     0,  45, 0,  1, 14),
  ('V60',  '60 Minutes',                   'voice', '*100*2*1#',  1000,     0,  60, 0,  1, 15),
  ('V130', '130 Minutes',                  'voice', '*100*2*1#',  2000,     0, 130, 0,  1, 16),
  ('D100', '100MB Daily',                  'data',  '*100*2*2#',   500,   100,   0, 0,  1, 20),
  ('D300', '300MB Daily',                  'data',  '*100*2*2#',  1500,   300,   0, 0,  1, 21),
  ('D700', '700MB Daily',                  'data',  '*100*2*2#',  2000,   700,   0, 0,  1, 22),
  ('C1',   'Starter: 25 on-net + 170MB',   'combo', '*100*2*3#',  1000,   170,  25, 0,  1, 30),
  ('C2',   '20 all-net mins + 250MB',      'combo', '*100*2*3#',  2000,   250,  20, 0,  1, 31),
  ('C3',   '40 all-net mins + 1GB',        'combo', '*100*2*3#',  4500,  1024,  40, 0,  1, 32),
  ('MEGA', 'Mega Value: 200 mins + 10GB',  'deal',  null,        35000, 10240, 200, 0, 30, 40)
) as b(code, name, category, ussd, price, data_mb, minutes, sms, validity_days, sort);

-- ---------------------------------------------------------------- Service centres & agents
insert into public.outlets (mvno_id, name, kind, address, lat, lng, phone, hours, services) values
  ('11111111-1111-1111-1111-111111111111', 'PaxTel Service Centre – Wandegeya', 'store', 'Wandegeya Traffic Lights, Kampala', 0.3317, 32.5711, '+256 724 000 100', 'Daily 8:00 AM – 8:00 PM', '{sim_swap,esim,paxsente,bundles,device_support}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxTel Service Centre – Kampala CBD', 'store', 'Ben Kiwanuka Street, Kampala', 0.3132, 32.5782, '+256 724 000 100', 'Daily 8:00 AM – 8:00 PM', '{sim_swap,esim,paxsente,bundles}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxTel Service Centre – Masaka', 'store', 'Masaka Town', -0.3410, 31.7360, '+256 724 000 100', 'Daily 8:00 AM – 8:00 PM', '{sim_swap,esim,paxsente,bundles}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxSente Agent – Katete', 'agent', 'Katete, Mbarara', -0.6230, 30.6490, null, 'Daily 8:00 AM – 8:00 PM', '{paxsente,airtime,bundles,sim_registration}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxSente Agent – CBD High Street', 'agent', 'High Street, Mbarara CBD', -0.6072, 30.6545, null, 'Daily 8:00 AM – 8:00 PM', '{paxsente,airtime,bundles,sim_registration}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxSente Agent – Kakoba', 'agent', 'Kakoba, Mbarara', -0.6010, 30.6680, null, 'Daily 8:00 AM – 8:00 PM', '{paxsente,airtime,bundles}'),
  ('11111111-1111-1111-1111-111111111111', 'PaxSente Agent – Ruhengere', 'agent', 'Ruhengere, Mbarara', -0.6140, 30.6300, null, 'Daily 8:00 AM – 8:00 PM', '{paxsente,airtime,bundles}');

-- ---------------------------------------------------------------- Knowledge base
insert into public.kb_articles (mvno_id, title, body, tags)
select '11111111-1111-1111-1111-111111111111', k.title, k.body, k.tags::text[] from (values
  ('About PaxTel',
   'PaxTel ("Better with us") is the mobile, data and money brand of Hamilton Telecom, a licensed telecommunications and digital solutions company in Uganda. Mobile money is provided by PaxSente (Hamilton Mobile Commerce Uganda Ltd). PaxTel offers mobile, data, mobile money and enterprise connectivity across Uganda, built around communities: "Connectivity built around people." Every bundle purchased supports digital ministry and community development. CEO of Hamilton Telecom: Otaremwa Otuhumurize.',
   '{about,company}'),
  ('Contact PaxTel customer care',
   'Customer care: dial 100 from a PaxTel line (toll free, 24/7). WhatsApp: +256 724 000 100. Email: info@paxtel.com. Head office: KT Estates, Plot 96 Prince Charles Drive, Kampala. Service centres: Kampala (Ben Kiwanuka Street), Wandegeya Traffic Lights (Kampala) and Masaka, open daily 8:00 AM to 8:00 PM. Social: Facebook; X @paxtel_mobile; Instagram paxtel_ug; TikTok @paxtel_ug. App: PaxTel app on Google Play (Android).',
   '{contact,support,hours}'),
  ('Voice bundles and how to buy them',
   'Daily voice bundles (valid 1 day), buy on WhatsApp here or dial *100*2*1#: 8 minutes UGX 500; 12 minutes UGX 700; 25 minutes UGX 600; 27 minutes UGX 1,500; 45 minutes UGX 2,500; 60 minutes UGX 1,000; 130 minutes UGX 2,000. If a customer asks whether minutes are on-net (PaxTel to PaxTel) or all-network, say the published list does not specify and offer an agent to confirm.',
   '{voice,minutes,bundles,prices}'),
  ('Data bundles and how to buy them',
   'Daily data bundles (valid 24 hours), buy on WhatsApp here or dial *100*2*2#: 100MB UGX 500; 300MB UGX 1,500; 700MB UGX 2,000. Weekly, monthly and non-expiry data bundles are not currently published: offer an agent if asked.',
   '{data,internet,bundles,prices}'),
  ('Combo bundles and deals',
   'Daily combo bundles, buy here or dial *100*2*3#: Starter Pack 25 on-net minutes + 170MB UGX 1,000; 20 all-net minutes + 250MB UGX 2,000; 40 all-net minutes + 1GB UGX 4,500. Monthly deal: Mega Value UGX 35,000 for 200 all-net minutes and 10GB high-speed data (30 days). SIM card voice bundle: UGX 5,000 for a SIM with 90 minutes. Customers can also buy PaxTel airtime and data at any of 21,000+ Quickteller agent locations.',
   '{combo,deals,mega,quickteller,prices}'),
  ('eSIM: compatibility and activation',
   'eSIM is activated only at PaxTel service centres (not by delivery). Steps: 1) Dial *#06#: if an EID number appears, the phone supports eSIM. 2) Visit a PaxTel service centre with your ORIGINAL National ID. 3) Staff capture biometrics and a photo. 4) A QR code is generated. 5) Scan the QR code to activate. Supported devices: iPhone XS and later, Samsung Galaxy S20 and later, Google Pixel 3 and later, iPad Pro (2018) and later, Apple Watch Series 3 and later. Benefits: compact design, easy carrier switching, better security, remote profile programming.',
   '{esim,activation,devices}'),
  ('SIM registration, activation and replacement',
   'To get a PaxTel line you need your full name, residential address and a valid ID; PaxTel verifies details as required by the Uganda Communications Commission (UCC). Activate a new SIM within 7 days of receiving it. Prepaid and postpaid plans exist. SIM swaps/replacements are done at PaxTel service centres with your original National ID. Lost or stolen SIM or phone: report it immediately by dialling 100 or messaging here so the line can be protected, then hand over to an agent.',
   '{sim,registration,swap,lost,stolen}'),
  ('PaxSente mobile money overview',
   'PaxSente is PaxTel''s mobile money wallet: dial *185# or use the PaxTel app. Send money, pay bills, buy airtime and data, bank transfers, merchant payments, international remittances, quick loans and financial insights. Limits: up to UGX 5,000,000 per transaction and a maximum wallet balance of UGX 20,000,000. Free: deposits, airtime and data purchases, balance checks, PIN resets and registration.',
   '{paxsente,mobile money,wallet,limits}'),
  ('PaxSente deposits and withdrawals',
   'Deposit: visit any PaxSente agent with cash, or transfer from your bank via the PaxTel app or *185#. Withdraw: cash out at any PaxSente agent. Never pay an agent a fee directly: fees are deducted from your wallet automatically. Never share your PIN or let an agent transact for you.',
   '{paxsente,deposit,withdraw,agent,safety}'),
  ('PaxSente fees (UGX)',
   'Published fees per amount band: send fee / withdrawal fee / withdrawal tax.
500–2,500: 100 / 330 / 0
2,501–5,000: 150 / 440 / 13
5,001–15,000: 330 / 880 / 25
15,001–30,000: 550 / 1,320 / 75
30,001–45,000: 800 / 1,760 / 150
45,001–60,000: 1,000 / 2,200 / 225
60,001–125,000: 1,200 / 3,300 / 300
125,001–250,000: 1,500 / 4,400 / 625
250,001–500,000: 1,700 / 7,700 / 1,250
500,001–1,000,000: 1,800 / 12,500 / 2,500
1,000,001–2,000,000: 1,900 / 16,500 / 5,000
2,000,001–4,000,000: 2,000 / 17,600 / 10,000
4,000,001–5,000,000: 2,000 / 18,000 / 20,000
Quote the fee and the tax separately exactly as listed. Do NOT add them into a single total: it is not confirmed whether the tax is included in the withdrawal fee. The exact charge is shown on the *185# confirmation screen before the customer approves.',
   '{paxsente,fees,charges,tax,withdraw,send}'),
  ('PaxSente safety and fraud',
   'Never share your PaxSente PIN with anyone, including people claiming to be PaxTel staff. Never let an agent transact on your behalf. If money was sent to the wrong number, a transaction failed but money was deducted, or you suspect fraud, hand over to an agent immediately with the transaction reference. Agents must report suspicious transactions within 24 hours on +256 724 000 100.',
   '{paxsente,fraud,pin,safety,reversal}'),
  ('Network coverage and speeds',
   'PaxTel runs a 4G LTE network with speeds up to 100 Mbps; 5G is rolling out. Coverage reaches urban and rural areas and is growing. For poor signal, ask the customer for their town/area and hand over repeated problems in a specific area to an agent so it can be logged for the network team.',
   '{network,coverage,4g,5g,signal}'),
  ('Data not working',
   'Ask the customer to: 1) toggle airplane mode for 10 seconds, 2) confirm mobile data is ON, 3) check they have an active data bundle (offer a balance check), 4) restart the phone. If data still fails, hand over to an agent with the phone model.',
   '{data,internet,troubleshooting,apn}'),
  ('Business and internet solutions',
   'PaxTel offers APN, MiFi (mobile WiFi hotspot devices), WiFi, Microwave (point-to-point wireless), Broadband, Fibre and Bulk SMS (custom sender ID, delivery reports, analytics). Prices are not published: collect the customer''s name, company, location and need, then hand over to an agent for a quote.',
   '{business,enterprise,fibre,mifi,bulk sms,broadband}'),
  ('Privacy and your data',
   'PaxTel does not sell subscriber data and follows the Uganda Data Protection and Privacy Act, 2019. Data is used for SIM registration, service delivery, billing, regulatory duties (UCC), fraud prevention and, with consent, promotions. Customers can request access, correction, objection, consent withdrawal and deletion where legally permissible. Data Protection Officer: Paxtel Mobile Limited, KT Estates, Plot 96 Prince Charles Drive, Kampala; +256 724 072 418; kevin.ssonko@hamiltel.com. Some records are kept up to 5 years.',
   '{privacy,data protection,dpo}'),
  ('Becoming a PaxSente agent',
   'Hamilton Mobile Commerce Uganda Ltd appoints PaxSente agents (non-exclusive). Agents keep accurate records, display PaxSente branding, protect customer data, keep a minimum float and carry insurance. Commission is paid on the total value of transactions. Interested? Hand over to an agent to start the application.',
   '{agent,paxsente,business,commission}')
) as k(title, body, tags);

insert into public.canned_responses (mvno_id, shortcut, title, body)
select '11111111-1111-1111-1111-111111111111', c.* from (values
  ('hi',      'Greeting',            'Hi {{name}}, thank you for contacting PaxTel. I''m {{agent}} and I''ll help you with this today.'),
  ('wait',    'Checking',            'Thank you for your patience, {{name}}. I''m checking this for you now, it will take 2–3 minutes.'),
  ('esim',    'eSIM steps',          'To get an eSIM: dial *#06# (an EID number means your phone supports eSIM), then visit a PaxTel service centre with your original National ID. We''ll capture your details and give you a QR code to scan.'),
  ('swap',    'SIM swap',            'For a SIM replacement please visit a PaxTel service centre (Wandegeya, Ben Kiwanuka Street or Masaka) with your original National ID. Your number stays the same.'),
  ('pin',     'PIN safety',          'For your safety, never share your PaxSente PIN with anyone, including PaxTel staff. We will never ask for it.'),
  ('ref',     'Ask for reference',   'Please share the PaxSente transaction ID/reference, the amount and the time of the transaction so I can trace it.'),
  ('bye',     'Closing',             'Glad I could help, {{name}}! Is there anything else I can do for you today? PaxTel, better with us. 🙏')
) as c(shortcut, title, body);

-- ---------------------------------------------------------------- Demo customers & conversations
insert into public.contacts (id, mvno_id, wa_id, name, msisdn, plan, tags, language) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '256724100201', 'Brenda Namutebi',   '256724100201', 'Prepaid', '{vip}', 'en'),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '256724100202', 'Joseph Mugisha',    '256724100202', 'Prepaid', '{}',    'en'),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '256724100203', 'Ivan Ssemwogerere', '256724100203', 'Postpaid', '{business}', 'en'),
  ('cccccccc-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '256724100204', 'Prossy Nabirye',    '256724100204', 'Prepaid', '{}',    'lg');

insert into public.conversations (id, mvno_id, contact_id, status, priority, assignee_id, category, subject, ai_summary, sentiment, handoff_at, sla_due_at, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001',
   'open', 'high', null, 'payment', 'PaxSente: data bundle paid, not received',
   'Paid UGX 2,000 from PaxSente for 700MB Daily 20 min ago; bundle not credited. Ref PS81LM2Q. Needs data urgently.',
   'negative', now() - interval '6 minutes', now() - interval '1 minute', now() - interval '25 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000002',
   'open', 'normal', 'aaaaaaaa-0000-0000-0000-000000000002', 'network', 'No internet in Mbarara',
   'Data not working in Kakoba, Mbarara since morning. Bot walked through troubleshooting without success.',
   'neutral', now() - interval '40 minutes', now() - interval '35 minutes', now() - interval '50 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000003',
   'open', 'normal', null, 'business', 'Fibre quote for office',
   'Business customer wants a fibre/microwave quote for an office in Kampala; needs pricing.', 'positive',
   now() - interval '2 minutes', now() + interval '3 minutes', now() - interval '10 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000004',
   'bot', 'normal', null, 'recharge', null, null, null, null, null, now() - interval '3 minutes');

insert into public.messages (conversation_id, mvno_id, direction, sender_type, type, body, status, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'I bought 700MB with PaxSente but I haven''t received it', 'received', now() - interval '25 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'out', 'bot',     'text', 'Sorry about that 😔 Please share the PaxSente transaction reference so we can trace it.', 'read', now() - interval '24 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'PS81LM2Q. I need the data now please', 'received', now() - interval '8 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Can I talk to someone', 'received', now() - interval '6 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'out', 'system',  'event', 'Handed over to the support team', 'sent', now() - interval '6 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'My internet is not working here in Kakoba', 'received', now() - interval '50 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'out', 'bot',     'text', 'Let''s fix that. Please switch airplane mode on for 10 seconds, then off, and restart your phone.', 'read', now() - interval '49 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Still nothing', 'received', now() - interval '41 minutes'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'out', 'agent',   'text', 'Hi Joseph, I''m Sarah. I''ve logged this with our network team for Kakoba and I''m checking your line now.', 'read', now() - interval '38 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Good morning, we need fibre internet for our office on Kampala Road. Can you send a quote?', 'received', now() - interval '10 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'in',  'contact', 'text', 'Njagala bundle ya data', 'received', now() - interval '3 minutes');

update public.conversations set first_response_at = now() - interval '38 minutes', unread_count = 0
  where id = 'dddddddd-0000-0000-0000-000000000002';

insert into public.recharges (mvno_id, contact_id, msisdn, kind, amount, method, status, created_at)
select '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001', '256724100201', 'bundle', 2000, 'paxsente', s, now() - (i || ' days')::interval
from (values (1, 'success'), (3, 'success'), (0, 'failed')) as v(i, s);

insert into public.deliveries (mvno_id, contact_id, item, status, address, lat, lng, scheduled_for, rider_name, rider_phone) values
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000002', 'sim', 'out_for_delivery', 'Kakoba, Mbarara', -0.6010, 30.6680, now() + interval '40 minutes', 'Moses K.', '+256 772 000 111');
