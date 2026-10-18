# Tuongee: data protection record

Prepared for the Data Protection Officer of each MVNO using Tuongee, against the **Uganda Data Protection and Privacy Act, 2019 (DPPA)** and its 2021 Regulations. Review and sign off before go-live; keep a copy with your register of processing activities.

## 1. What the system processes

| Data | Source | Purpose |
|---|---|---|
| WhatsApp number, profile name | Customer messages us on WhatsApp | Identify the customer, reply to them |
| Message text, button choices, shared location | Customer | Answer questions, route to agents, find nearest outlet |
| Photos, voice notes, videos, documents | Customer | Resolve the request (e.g. proof of payment) |
| Transaction IDs given by the customer | Customer | Finance verification of failed transactions |
| Agent names, logins, actions | Staff | Access control, accountability (audit log) |

No balances, payments or national ID numbers are collected by the bot. Billing data is only shown when a real billing integration is connected.

## 2. Where it is stored (cross-border transfer)

| Component | Provider | Location |
|---|---|---|
| Database, files (Supabase) | Supabase Inc. | **EU, Ireland (eu-west-1)** |
| Application servers (Vercel) | Vercel Inc. | **EU, Dublin (dub1)** |
| WhatsApp delivery | Meta Platforms | Meta data centres |
| AI assistant (Claude) | Anthropic PBC | United States (message content of bot conversations is sent for processing; not used for model training under API terms) |

Storing personal data outside Uganda requires that the destination offers adequate protection (DPPA s.19). **Action for the DPO:** record this transfer, confirm adequacy (EU GDPR jurisdiction; contractual safeguards with Supabase, Vercel, Meta and Anthropic), and register with the Personal Data Protection Office (PDPO) as required.

## 3. Security measures in place

- Row-level security on every table: staff only see their own MVNO's data.
- Roles: agent, supervisor, admin, super admin; agents cannot export reports or view analytics.
- Accounts are invite-only (public sign-up blocked at the database).
- WhatsApp webhooks verified by Meta signature; rejected if the secret is missing.
- Customer media stored privately; agents get 5-minute signed links.
- WhatsApp tokens stored server-side only.
- Browser security headers (CSP, frame blocking, HSTS).
- Rate limits on AI actions, exports and admin actions.
- Audit log of admin actions, report exports, customer erasures and retention clean-ups (Admin → Activity).

## 4. Retention

Each MVNO sets **"Keep chats (days)"** in Admin (default **730 days / 2 years**). A daily job deletes resolved or inactive conversations older than that, with their messages and media, and removes customer profiles with no remaining conversations. Top-up records are kept for finance/legal obligations.

## 5. Customer rights

| Right (DPPA) | How it is handled |
|---|---|
| To be informed (s.13) | A privacy notice is sent once to every new customer (editable per MVNO in Admin). Customers can type **"privacy"** at any time to see it. |
| Access / correction (s.24, s.16) | Agents can view and correct customer details in the inbox; a full export is available via Reports. |
| Erasure (s.16) | Customer taps **"Delete my data"** (or asks an agent) → a high-priority ticket is created → after verifying identity, a supervisor/admin uses **Erase customer data** (Inbox → customer → History). Chats, messages, media and profile are deleted; the action is logged with a masked number. |
| Objection / withdraw consent | Handled by an agent on request; the customer can stop messaging at any time. |

## 6. Breach response

Report suspected breaches to the DPO immediately. The PDPO must be notified without delay (Regulation 33). Use Admin → Activity and Supabase logs to establish scope.

## 7. Open items for the DPO

1. Confirm the privacy notice wording and the retention period per MVNO.
2. Document the cross-border transfer (section 2) and PDPO registration.
3. Decide whether top-up records need their own retention period.
4. Sign data processing agreements with the providers listed in section 2.
