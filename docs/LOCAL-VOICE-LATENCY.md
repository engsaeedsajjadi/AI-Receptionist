# Local voice latency & optional Piper (developer-only lab)

**Scope:** The dashboard telephone lab requires a development server and isolated `ai_receptionist_test` on loopback. This is not PSTN/Twilio and is not a claim of full-duplex low-latency streaming. Neither provider is switched globally by selecting the local lab options.

## Optimizing the existing Gemini voice test

1. Sync branch `enterprise/hardening-2026-10-03` and restart your Next.js dev server.
2. Open `/dashboard/telephony-lab`, select the active test agent and a real microphone, confirm that AI usage may be billed.
3. Enable **پاسخ صوتی کوتاه**. This is a system-prompt style request (one/two sentences when possible), **not a destructive truncation**. It preserves tool execution and mandatory disclaimers.
4. Choose **گفتگوی زنده** or manual talk; compare the displayed **STT**, **Agent + tools**, **TTS**, **storage**, and **total** timings per turn. The playback duration is separate from processing latency.
5. Retain the configured TTS as baseline; avoid declaring performance wins until identical prompts are tested.

## Optional zero-API-cost TTS: Piper on your Windows machine

This replaces **only the voice synthesis step**. Gemini STT and LLM may still consume credits.

Install Piper using official instructions: https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md . The sample voice `fa_IR-amir-medium` is available via the Piper voice downloader; check each voice's model card and license before commercial rollout.

Typical commands (Python installed, isolated virtualenv recommended):

```powershell
py -3.12 -m venv .venv-piper
.\.venv-piper\Scripts\python.exe -m pip install "piper-tts[http]"
.\.venv-piper\Scripts\python.exe -m piper.download_voices fa_IR-amir-medium
.\.venv-piper\Scripts\python.exe -m piper.http_server -m fa_IR-amir-medium --host 127.0.0.1 --port 5000
```

**Piper 1.8 HTTP header note:** The official Flask server can send genuine RIFF/WAV bytes with `Content-Type: text/html; charset=utf-8`. The app deliberately authenticates the WAV by inspecting and strictly validating its binary RIFF/WAVE, PCM16 mono payload, rather than relying on the MIME header. If a user sees `Piper returned a non-WAV response`, sync the adapter fix from the GitHub branch and restart Next.js.

The last command is long-running and must remain open while testing. Test `http://127.0.0.1:5000/info` in a browser; for an API probe, POST JSON `{"text":"سلام، وقت بخیر."}` to `http://127.0.0.1:5000/synthesize` and expect WAV data.

Back in the **dev-only** telephone lab, choose **Piper محلی** under the TTS engine dropdown. The server only connects to localhost, follows no HTTP redirects, accepts only bounded, mono PCM16 WAV, converts Piper 22.05-kHz audio to 24-kHz PCM and reuses the existing G.711 telephony encoding. By default `PIPER_TTS_URL=http://127.0.0.1:5000` and `PIPER_TTS_VOICE=fa_IR-amir-medium`; no new .env variable is required for defaults. Do not copy Gemini API keys into Piper.

**Important:** In Docker or Vercel, `localhost` is the container/server, *not your Windows workstation*. This local-only adapter intentionally does not permit remote hosts. It is a Windows workstation experiment and requires a separate architecture/security review for hosted deployments. Real provider speed/audio tests must run on the user's machine; CI tests validate the conversion and isolation logic, not real synthesizer performance.

Environment alternative: set `TTS_PROVIDER=piper` for a deployment where that Piper HTTP server is actually running on localhost, but the dashboard dropdown is safer for comparing with Gemini without changing .env.

### Acceptance

Record per-turn total, STT, Agent, TTS, reply text/voice duration, and whether barge-in/playback worked. Run at least 3 equivalent short Persian utterances for each TTS engine. Baseline and Piper results are not interchangeable unless STT, LLM, prompts and hardware load are held constant.
