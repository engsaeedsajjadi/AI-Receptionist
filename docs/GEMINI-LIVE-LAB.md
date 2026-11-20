# Gemini Live in the telephone lab (experimental)

The telephone lab (`/dashboard/telephony-lab`, development only) has a third
conversation mode: **«گفتگوی هم‌زمان با Gemini Live»**. One Gemini Live model
hears the caller, decides and speaks, so there is no speech-to-text → LLM →
text-to-speech chain and the model itself handles turn-taking and interruptions.
Google documents Persian (`fa`) as supported by the Gemini 3.x Live models.

## Requirements

- The existing `COMPATIBLE_LLM_API_KEY` (Gemini API key). Nothing else.
- The browser must reach `generativelanguage.googleapis.com` (from Iran: VPN on).
- Optional `.env.local` settings:

```
GEMINI_LIVE_MODEL=gemini-3.8-live   # default
GEMINI_LIVE_VOICE=                  # e.g. Kore, Puck; empty = model default
```

## How it works

1. `POST /api/v1/agents/:id/live-session` (lab guard: development + local
   `ai_receptionist_test` database only) builds the agent's own guardrailed
   prompt and allow-listed tools — the same ones a chained turn uses — and
   mints a **single-use ephemeral token** (30 min, new session within 60 s)
   locked to that model and configuration. The API key never reaches the browser.
2. The browser streams 16-kHz microphone PCM to Gemini Live and plays the
   24-kHz reply. With «شبیه‌سازی کیفیت خط تلفن» both directions go through
   8-kHz G.711 μ-law first, so you hear what a caller would.
3. Every function call (book, create lead, check availability …) comes back to
   `POST /api/v1/agents/:id/live-session/tool`, which checks the session belongs
   to this tenant, user and agent, caps a session at 40 tool calls, and runs the
   audited tool registry with server-side tenant context. Tools are declared
   `BLOCKING`, so the model waits for a real result before saying a booking exists.

## Limits

- Lab only: not wired to the SIP/telephony gateway yet; that is the next step
  if the Persian quality and latency are good enough.
- Gemini Live usage is billed by Google per audio token and is **not** yet
  recorded in the app's usage/quota tables.
- One connection lasts about 10 minutes (Gemini limit); start a new call after that.
- The grounding gate of chained turns (claim-vs-evidence check) does not apply
  to live speech; knowledge answers rely on the prompt and `search_knowledge`.
- Use headphones: speaker echo can make the model interrupt itself.

## Hotels and other languages

- Agent settings → «زبان‌هایی که منشی جواب می‌دهد»: e.g. `en, ar, fa`. The first
  is the greeting language; the receptionist then answers in whatever language
  the caller speaks, and speech recognition is hinted with all of them. For Gulf
  hotels set the agent language to English and list `en, ar, fa`.
- `request_reservation` records a room-reservation **request** (guest, phone
  with country code, check-in/out, guests, room type, notes) as a lead for the
  front desk. It never confirms a booking: the app holds no room inventory.
- Foreign phone numbers (`+971…`, `00968…`) are stored in E.164; Iranian
  numbers keep their national form.
- Hotel FAQs (check-in time, parking, airport transfer …) go into the
  knowledge base, answered through `search_knowledge`.
