# Local Pocket-TTS voice (Cilla) in the telephone lab

Experimental, developer lab only. Compares an open Persian Pocket-TTS model
(for example Cilla-Lite / Cilla-Mini, or `mehdi-hf/pocket-tts-farsi`) with
Piper and Gemini in `/dashboard/telephony-lab`. Production is unchanged.

## 1. Before you start

- Read the model's licence on its Hugging Face page. The base Kyutai
  pocket-tts model forbids cloning a voice without the speaker's explicit,
  lawful consent.
- Record a 2-5 s clean WAV (16-bit) of a speaker who has agreed in writing to
  be the receptionist's voice. Never use a caller's or a public figure's voice.

## 2. Install (once, Windows PowerShell, in the repository folder)

```
py -3.12 -m venv .venv-pocket
.\.venv-pocket\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch
.\.venv-pocket\Scripts\python.exe -m pip install pocket-tts numpy
```

Download the model repo's `normalize_fa.py` (if it has one) next to your voice
file. The model itself is downloaded on first start (a VPN may be needed).

## 3. Start the server (keep the window open)

```
.\.venv-pocket\Scripts\python.exe scripts/local-tts/pocket_server.py `
  --config hf://<owner>/<repo>/<config>.yaml `
  --voice D:\voices\approved_voice.wav `
  --normalizer D:\voices\normalize_fa.py
```

`--config` is the model's YAML from its Hugging Face page (for the earlier
model: `hf://mehdi-hf/pocket-tts-farsi/farsi.yaml`). Add `--quantize` for less
memory and faster CPU inference. Check `http://127.0.0.1:5002/health`.

## 4. Use it in the lab

Choose **Cilla / Pocket-TTS** as the reply voice, press the sample button,
then run a live conversation. The server listens on 127.0.0.1 only; the app
sends text and never a voice choice. `POCKET_TTS_URL` changes the port.

## Safeguards

- Long text is split into short chunks (the model was trained on ~4 s
  utterances).
- A chunk that runs to the model's length cap (no end-of-speech, repeating) is
  retried, then split, then trimmed; whole replies are capped at 28 s and the
  app rejects anything over 30 s.
- Known model limits: ezafe is sometimes wrong and Latin-script words are
  skipped. The app converts digits and times to spoken Persian before TTS.
