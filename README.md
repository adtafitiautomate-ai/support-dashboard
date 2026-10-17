# Tuvugane: WhatsApp customer care for MVNOs

A realtime shared inbox and AI + guided-flow chatbot for three MVNOs on WhatsApp.

- **Bot** (per MVNO persona): self-service menu, live balance, bundle and airtime purchase via mobile money, line check, nearest shop/agent from a shared location, SIM/eSIM delivery ordering and tracking, and free-text answers from the knowledge base (Claude). Hands off to a human with an AI summary, sentiment, category and priority.
- **Inbox**: queue / mine / all / bot / resolved views, auto-assignment to the least-loaded online agent, first-response SLA timers, internal notes, `/` saved replies, AI draft reply, quick actions (bundle catalogue, nearest shop, location request), 24h-window detection with template sending, collision detection (who's viewing / typing), CSAT survey on resolve, and keyboard shortcuts (`j`/`k`, `e` resolve, `a` assign to me, `]` profile panel, `Ctrl+K` search).
- **Knowledge**: train the bot from PDFs, text files and web links (AI distills them into articles), hand-written articles, and a "test what the bot knows" search.
- **Insights**: live KPIs (SLA breaches, first response, bot containment, CSAT, WhatsApp top-up revenue) and a per-agent table.
- **Simulator**: chat as a customer with tappable buttons, lists and location sharing. No phone needed.

Stack: Next.js 16 (App Router) · Supabase (Postgres, RLS, Realtime broadcast, Auth) · Claude API · Meta WhatsApp Cloud API.

## Run locally

```bash
npm install
npx supabase start          # needs Docker; applies migrations + seed
npm run dev
```

`.env.local` is already filled with the local Supabase keys. Sign in at `/login` with a demo account (password `Password123!`):

| Account | Access |
|---|---|
| admin@demo.test | Platform admin: all MVNOs |
| sarah@paxtel.test | Supervisor, PaxTel |
| david@paxtel.test | Agent, PaxTel |
| grace@paxtel.test | Agent, PaxTel |

The seed loads PaxTel (Hamilton Telecom, Uganda): published bundles with USSD codes, PaxSente fees and rules, eSIM steps, service centres (Wandegeya, Ben Kiwanuka Street, Masaka) and Mbarara agents. Outlet coordinates are approximate, so correct them in the `outlets` table.

Set `ANTHROPIC_API_KEY` to enable the AI (free-text answers, summaries, drafts, PDF/link training). Without it the bot still runs all guided flows, with a keyword fallback.

## Use the hosted Supabase project

Project `hpcrwtgmhyxksxxyetbs` (eu-west-1, shared pooler).

1. Put the database password in `web/.env.cloud` (`SUPABASE_DB_PASSWORD=...`). Special characters are encoded for you.
2. Push the schema: `npm run db:cloud`. Add `-- --seed` to also load the demo MVNOs, bundles, outlets and demo agents. The demo accounts all share the password `Password123!`, so delete them or change their passwords before real customers use the project.
3. In `.env.local`, fill in the hosted block (URL plus publishable and secret keys from **Project Settings → API Keys**), comment out the local block, and restart `npm run dev`.

## Connect your Meta test number

1. **developers.facebook.com** → your app → **WhatsApp → API Setup**. Copy the **temporary access token** and the **Phone number ID**. Add up to 5 recipient phone numbers there (test numbers can only message verified recipients).
2. In `.env.local` set:
   ```
   WHATSAPP_ACCESS_TOKEN=EAAG...        # temporary tokens expire after 24h; use a System User token for longer
   WHATSAPP_APP_SECRET=...              # App settings → Basic → App secret (enables signature checks)
   WHATSAPP_VERIFY_TOKEN=any-random-string
   ```
   Restart `npm run dev`.
3. Expose your local server over HTTPS, e.g. `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`).
4. Meta → **WhatsApp → Configuration → Webhook**: callback URL `https://<tunnel>/api/whatsapp/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`. Click *Verify and save*, then subscribe to the **messages** field.
5. In Tuvugane, go to **Settings → WhatsApp number**, pick the MVNO (e.g. Nova Mobile), paste the Phone number ID and save. The other MVNOs stay on the simulator.
6. Send "hi" from one of your verified phones to the test number.

To start a conversation from the inbox (**New message**), WhatsApp requires an approved template. Test numbers come with `hello_world` (`en_US`).

## Architecture notes

- **Speed**: the webhook acknowledges Meta immediately and processes the message after the response (`after()`). Messages from the same customer are serialized; different customers run in parallel. The bot makes at most one Claude call per message: tools send the WhatsApp UI themselves, so there's no second round-trip. The system prompt is prompt-cached. Pages prerender as static shells, and data loads client-side over one websocket.
- **Realtime**: Postgres triggers broadcast row changes to a private topic per MVNO (`mvno:<id>`) with `realtime.broadcast_changes`. RLS on `realtime.messages` restricts each topic to that MVNO's members. Presence on the same channel powers "who's viewing" and typing indicators.
- **Tenancy & security**: every table carries `mvno_id` with RLS. Agents read through RLS; anything that sends to WhatsApp or moves money goes through server routes. WhatsApp tokens live in a non-exposed `private` schema.
- **MVNO integrations**: `src/lib/mvno/api.ts` is the adapter boundary (balance, line status, charge + credit). Everything is mocked today; register a real adapter per MVNO slug when their APIs are ready.
- **Knowledge retrieval**: small knowledge bases are embedded whole in the cached prompt. Past ~30k characters the bot retrieves the top matches per message with Postgres full-text search (`search_kb`).
