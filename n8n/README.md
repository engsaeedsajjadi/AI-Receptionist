# n8n Workflows — AI-Receptionist

Five workflows. The **application remains the source of truth**; n8n only
reacts to events (notifications, CRM sync, follow-ups).

| File | Webhook path | Purpose |
|---|---|---|
| `new-lead.json` | `/webhook/ai-receptionist/new-lead` | Notify sales chat on new leads |
| `call-completed.json` | `/webhook/ai-receptionist/call-completed` | Post call summary to ops chat |
| `appointment.json` | `/webhook/ai-receptionist/appointment` | Notify on create/reschedule/cancel |
| `human-handoff.json` | `/webhook/ai-receptionist/human-handoff` | Urgent routing for transfers/failures |
| `notification.json` | `/webhook/ai-receptionist/notification` | Generic fan-out template (telegram/sms/email) |

Every workflow follows the same linear topology:

```text
Webhook (headerAuth) → Prepare Dispatch → Dispatch via App → Respond
```

- **Webhook** — validates `x-automation-token` via a native n8n Header Auth
  credential (value = the app's `N8N_WEBHOOK_SECRET`). No HMAC code: n8n
  cannot see the raw request bytes, so in-workflow HMAC checks are
  unverifiable and are deliberately not used.
- **Prepare Dispatch** — validates the event payload and builds the
  dispatch body (channel, recipient, Persian message), forwarding the
  app-issued `idempotencyKey` unchanged.
- **Dispatch via App** — `POST {APP_BASE_URL}/api/v1/automation/dispatch`
  with `Authorization: Bearer {N8N_API_KEY}`. The app dedups on
  `(businessId, idempotencyKey)` in Postgres (`automation_dispatches`)
  and performs the actual provider send, so emit retries and n8n replays
  collapse to a single notification.
- **Respond** — returns `{ ok, duplicate, delivered }` to the app.

Critical dedup state lives **only** in the app database — never in n8n
static data (it is per-worker memory, lost on restart, and unsafe for
exactly-once side effects).

## Import

1. Open n8n → **Workflows** → **⋯ → Import from File**, select a JSON file.
2. Create a **Header Auth** credential named `AI Receptionist Automation Token`:
   - Name: `x-automation-token`
   - Value: the app's `N8N_WEBHOOK_SECRET`
   - Select it in each workflow's Webhook node (the import references the
     credential by name; values are never stored in these JSON files).
3. Set environment variables in n8n (**Settings → Variables** or container env):
   - `APP_BASE_URL` — public base URL of the app (e.g. `https://app.example.com`)
   - `N8N_API_KEY` — must match the app's `N8N_API_KEY` (dispatch auth)
   - `TELEGRAM_OPS_CHAT_ID`, `TELEGRAM_SALES_CHAT_ID`, `TELEGRAM_URGENT_CHAT_ID`
4. **Activate** each workflow (toggle in the editor).
5. In the app, set `N8N_ENABLED=true`, `N8N_URL=http://<n8n-host>:5678`,
   `N8N_WEBHOOK_SECRET=<shared token>`, `N8N_API_KEY=<dispatch key>`.

Provider secrets (`TELEGRAM_BOT_TOKEN`, SMTP credentials, SMS keys) stay
**app-side only** — workflows never call providers directly.

## Delivery semantics

The app emits each event with one stable idempotency key and retries
network errors / 429 / 5xx with exponential backoff (`N8N_MAX_RETRIES`,
default 2). Delivery is at-least-once; the dispatch endpoint's
`ON CONFLICT DO NOTHING` dedup makes redelivery safe.

## Notes

- Webhook nodes use `responseMode: responseNode`; every workflow ends with
  a **Respond** node so the app gets an acknowledgement.
- The `notification` workflow is a generic template: its payload must carry
  `businessId`, `title`, `message` and `recipient` (no app emitter uses it
  today — wire a caller before activating it for production).
- `tests/unit/n8n-workflows.test.ts` pins this topology (headerAuth,
  dispatch routing, linear chain, no static-data/HMAC/provider secrets).
