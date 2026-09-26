# n8n Workflows — AI-Receptionist

Five functional workflows. The **application remains the source of truth**;
n8n only reacts to events (notifications, CRM sync, follow-ups).

| File | Webhook path | Purpose |
|---|---|---|
| `new-lead.json` | `/webhook/ai-receptionist/new-lead` | Notify sales chat on new leads |
| `call-completed.json` | `/webhook/ai-receptionist/call-completed` | Post call summary to ops chat |
| `appointment.json` | `/webhook/ai-receptionist/appointment` | Notify on create/reschedule/cancel |
| `human-handoff.json` | `/webhook/ai-receptionist/human-handoff` | Urgent routing for transfers/failures |
| `notification.json` | `/webhook/ai-receptionist/notification` | Generic fan-out (telegram/sms/email) |

Each workflow follows:

```text
Webhook → Verify Signature (HMAC) → Deduplicate (idempotency key)
→ Route/Format → External delivery → Respond
```

## Import

1. Open n8n → **Workflows** → **⋯ → Import from File**, select a JSON file.
2. Set environment variables in n8n (**Settings → Variables** or container env):
   - `N8N_WEBHOOK_SECRET` — must match the app's `N8N_WEBHOOK_SECRET`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT_ID`, `TELEGRAM_SALES_CHAT_ID`, `TELEGRAM_URGENT_CHAT_ID`
   - `SMS_WEBHOOK_URL`, `SMS_API_KEY` (only for the `notification` SMS branch)
   - Configure SMTP credentials on the **Send Email** node (notification workflow)
3. **Activate** each workflow (toggle in the editor).
4. In the app, set `N8N_ENABLED=true` and `N8N_URL=http://<n8n-host>:5678`.

## Notes

- Webhook nodes use `responseMode: responseNode`; every workflow ends with
  a **Respond** node so the app gets an acknowledgement.
- Signature verification uses the raw JSON body and the shared secret —
  requests with missing/invalid signatures fail the execution.
- Deduplication state lives in workflow static data (24h window).
