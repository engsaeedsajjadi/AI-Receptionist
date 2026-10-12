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
\n\n## Voice accent/tonality A/B test\n\nPiper is not a Gemini voice clone. Persian publisher voices available from the catalog include `fa_IR-ganji-medium`, `fa_IR-ganji_adabi-medium`, `fa_IR-gyro-medium`, `fa_IR-reza_ibrahim-medium` as alternatives to Amir. Download one or more voices into the **same working directory as the Piper HTTP server**, keeping each model's `.onnx` + `.onnx.json` together:\n\n```powershell\ncd "$env:USERPROFILE\\piper-fa-lab"\n.\\.venv\\Scripts\\python.exe -m piper.download_voices fa_IR-ganji-medium fa_IR-ganji_adabi-medium fa_IR-gyro-medium fa_IR-reza_ibrahim-medium\n```\n\nRestart the Piper server from this directory; in the telephone lab select **گوینده فارسی** and try **طبیعی / گرم و روان / آرام و شمرده**. Model availability can be checked at `http://127.0.0.1:5000/voices`. Piper may silently revert to default when requested voice files are absent, so compare the waveform/voice by listening instead of assuming that voice selection succeeded. Prosody controls affect duration/variability, not intrinsic trained pronunciation. Confirm each voice card's license before commercial use.\n
## CPU Faster-Whisper Persian STT (experimental, developer-only)

The default selection remains **Gemini STT**. For an optional A/B test with
Piper, run an additional CPU-only server on port 5001:

```powershell
cd "D:\\Downloads\\AI-Receptionist-arena-final\\AI-Receptionist-github-sync"
py -3.12 -m venv .venv-whisper
.\\.venv-whisper\\Scripts\\python.exe -m pip --isolated install --index-url https://pypi.org/simple flask faster-whisper
.\\.venv-whisper\\Scripts\\python.exe scripts/local-stt/server.py --model tiny --port 5001 --threads 4
```

This separate process downloads its model on the first run. Confirm
`http://127.0.0.1:5001/health` responds with `"ok":true`. In
`/dashboard/telephony-lab` choose **Faster-Whisper روی CPU** under STT.
Keep Piper TTS and the Gemini LLM as before.

The experimental Python server binds only to loopback, accepts bounded mono
PCM16 8/16 kHz WAV, and computes local inference without cloud STT charges.
The Next.js adapter permits only localhost URLs and never automatically falls
back to Gemini on STT failure. CPU speed and Persian accuracy, especially for
`tiny`, are **not guaranteed**. Compare at least three identical spoken prompts
against the configured Gemini STT; measure STT milliseconds and transcription
accuracy. Try `--model base` only after the tiny speed/accuracy benchmark.
Leave `STT_PROVIDER` unchanged for production.
\n\nUse **شنیدن نمونه صدا بدون Gemini** to A/B voice/style choices using a fixed Persian phrase. This local-only preview creates no call and invokes no cloud STT/LLM; it returns one bounded Piper waveform with local synthesis timing. A real customer utterance is still required to benchmark the full pipeline.\n

### Windows PyAV 19 compatibility (October 2026)

Some combinations of older faster-whisper and PyAV 19 fail on `decode_audio` with
`TypeError: open() got an unexpected keyword argument 'metadata_errors'`
(see https://github.com/SYSTRAN/faster-whisper/issues/1589).
The local-STT **telephony-only** sidecar now uses `pcm_audio.py` to parse
strict, bounded mono 8/16-kHz PCM16 WAV and resample via NumPy directly to
Whisper's 16-kHz float32 waveform. It passes the array to
`WhisperModel.transcribe`, bypassing the incompatible PyAV decoding path.
It never accepts arbitrary media file formats. No global library downgrade
or `--force-reinstall` is necessary for the local STT lab.

After pulling this fix, stop the Python Flask server with Ctrl+C and restart
`scripts/local-stt/server.py`. Next.js, Piper and databases require no changes.

Test the decoder without loading the model or sending audio to Gemini:

```powershell
.\.venv-whisper\Scripts\python.exe scripts/local-stt/test_pcm_audio.py
```

The tests cover 8/16-kHz resampling, WAV truncation, invalid input and stereo rejection.
