"""Loopback HTTP server for Persian Pocket-TTS models (Cilla, pocket-tts-farsi).

Speaks the same contract as the app's Piper adapter so the telephone lab can
compare voices:  POST /synthesize {"text": "..."} -> 16-bit mono WAV,
GET /health -> {"ok": true, ...}.

    python scripts/local-tts/pocket_server.py \
        --config hf://<owner>/<repo>/<config>.yaml \
        --voice D:/voices/approved_voice.wav \
        --normalizer D:/models/normalize_fa.py

* --config is the model's pocket-tts YAML (an hf:// path, URL or local file).
* --voice is a short (2-5 s) clean recording of a speaker who has CONSENTED to
  being used as the assistant's voice. Never use someone's voice without it.
* --normalizer (optional) is the model repo's own Persian text normalizer.

Binds to 127.0.0.1 only. The chunking and runaway guard below are adapted from
mehdi-hf/pocket-tts-farsi `farsi_tts.py` (MIT License): the model was trained on
~4 s utterances, so long text is split into short chunks, and a chunk that hits
the model's length cap (it never emitted end-of-speech and is repeating) is
retried once and then split in half instead of being played.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import logging
import math
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

import numpy as np

log = logging.getLogger("pocket_server")

MAX_TEXT_CHARS = 600
MAX_BODY_BYTES = 8_192
MAX_OUTPUT_SECONDS = 28.0  # the app refuses WAVs longer than 30 s
MAX_TOKENS_PER_CHUNK = 18
MIN_TOKENS_PER_CHUNK = 8
CAP_RATIO = 0.97
MAX_SPLIT_DEPTH = 2
PAUSE_SEC = 0.15
VOICE_PROMPT_MAX_SEC = 5.0

HARD_BREAK = re.compile(r"(?<=[.!؟?])\s+")
SOFT_BREAK = re.compile(r"(?<=[،؛:,])\s+")


def split_text(text: str, count_tokens: Callable[[str], int], max_tokens: int = MAX_TOKENS_PER_CHUNK) -> list[str]:
    """Chunks of at most max_tokens, breaking at sentence, then clause marks, then words."""
    text = " ".join(text.split())
    if not text:
        return []

    def fits(s: str) -> bool:
        return count_tokens(s) <= max_tokens

    def split_by(pattern: re.Pattern[str], piece: str) -> list[str]:
        parts = [p.strip() for p in pattern.split(piece) if p.strip()]
        return parts if len(parts) > 1 else []

    def recurse(piece: str) -> list[str]:
        if fits(piece):
            return [piece]
        for pattern in (HARD_BREAK, SOFT_BREAK):
            parts = split_by(pattern, piece)
            if parts:
                return [c for p in parts for c in recurse(p)]
        out: list[str] = []
        cur = ""
        for word in piece.split():
            trial = f"{cur} {word}".strip()
            if cur and not fits(trial):
                out.append(cur)
                cur = word
            else:
                cur = trial
        if cur:
            out.append(cur)
        return out

    merged: list[str] = []
    for chunk in recurse(text):
        if merged and fits(f"{merged[-1]} {chunk}"):
            merged[-1] = f"{merged[-1]} {chunk}"
        else:
            merged.append(chunk)
    return merged


def generate_chunk(
    synth: Callable[[str], np.ndarray],
    cap_seconds: Callable[[str], float],
    text: str,
    sample_rate: int,
    retries: int = 1,
    depth: int = 0,
) -> np.ndarray:
    """One chunk, never returning a runaway (cap-length, repeating) generation if it can avoid it."""
    cap = cap_seconds(text)
    shortest: np.ndarray | None = None
    for _ in range(retries + 1):
        audio = np.asarray(synth(text), dtype=np.float32).reshape(-1)
        if len(audio) / sample_rate <= CAP_RATIO * cap:
            return audio
        if shortest is None or len(audio) < len(shortest):
            shortest = audio
    words = text.split()
    if depth >= MAX_SPLIT_DEPTH or len(words) < 4:
        # Still runaway: trim to the expected length rather than play a loop.
        log.warning("chunk kept hitting the length cap; trimming: %s", text)
        limit = int(CAP_RATIO * cap * sample_rate)
        return (shortest if shortest is not None else np.zeros(1, dtype=np.float32))[:limit]
    half = len(words) // 2
    seam = np.zeros(int(0.05 * sample_rate), dtype=np.float32)
    left = generate_chunk(synth, cap_seconds, " ".join(words[:half]), sample_rate, retries, depth + 1)
    right = generate_chunk(synth, cap_seconds, " ".join(words[half:]), sample_rate, retries, depth + 1)
    return np.concatenate([left, seam, right])


def to_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Synthesizer:
    """Wraps a loaded pocket-tts model; one generation at a time (CPU-bound, stateful)."""

    def __init__(self, model, state, normalize: Callable[[str], str]):
        self.model = model
        self.state = state
        self.normalize = normalize
        self.sample_rate = int(model.sample_rate)
        self.lock = threading.Lock()
        # Works for both sentencepiece and HF-tokenizers models.
        conditioner = model.flow_lm.conditioner
        self.count_tokens = lambda s: int(conditioner.prepare(s).shape[-1])

    def _cap_seconds(self, text: str) -> float:
        tokens = self.model.flow_lm.conditioner.prepare(text).shape[-1]
        tps = getattr(self.model, "_TOKENS_PER_SECOND_ESTIMATE", 3.0)
        pad = getattr(self.model, "_GEN_SECONDS_PADDING", 2.0)
        frame_rate = self.model.config.mimi.frame_rate
        return math.ceil((tokens / tps + pad) * frame_rate) / frame_rate

    def _synth(self, text: str) -> np.ndarray:
        audio = self.model.generate_audio(self.state, text, frames_after_eos=0)
        return np.asarray(audio, dtype=np.float32).reshape(-1)

    def synthesize(self, text: str) -> bytes:
        text = self.normalize(text)
        chunks = split_text(text, self.count_tokens)
        if not chunks:
            raise ValueError("empty text")
        pause = np.zeros(int(PAUSE_SEC * self.sample_rate), dtype=np.float32)
        pieces: list[np.ndarray] = []
        with self.lock:
            for i, chunk in enumerate(chunks):
                if i:
                    pieces.append(pause)
                pieces.append(generate_chunk(self._synth, self._cap_seconds, chunk, self.sample_rate))
        audio = np.concatenate(pieces)
        limit = int(MAX_OUTPUT_SECONDS * self.sample_rate)
        if len(audio) > limit:
            log.warning("output trimmed from %.1fs to %.1fs", len(audio) / self.sample_rate, MAX_OUTPUT_SECONDS)
            audio = audio[:limit]
        return to_wav(audio, self.sample_rate)


def make_handler(synth: Synthesizer, info: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "pocket-tts-lab"

        def log_message(self, fmt, *args):  # quieter; never logs request text
            log.info("%s %s", self.command, self.path)

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                self._json(200, {"ok": True, **info})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/synthesize":
                return self._json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                return self._json(413, {"error": "body must be 1..8192 bytes"})
            try:
                payload = json.loads(self.rfile.read(length))
                text = payload.get("text") if isinstance(payload, dict) else None
            except (ValueError, UnicodeDecodeError):
                text = None
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
                return self._json(400, {"error": f"text must be 1..{MAX_TEXT_CHARS} characters"})
            started = time.perf_counter()
            try:
                wav = synth.synthesize(text)
            except Exception:  # noqa: BLE001
                log.exception("synthesis failed")
                return self._json(500, {"error": "synthesis failed"})
            log.info("synthesized %d chars in %.2fs", len(text), time.perf_counter() - started)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)

    return Handler


def load_normalizer(path: str | None) -> Callable[[str], str]:
    if not path:
        log.warning("no --normalizer given; Persian text is passed to the model as-is")
        return lambda s: " ".join(s.replace("ي", "ی").replace("ك", "ک").split())
    spec = importlib.util.spec_from_file_location("model_normalize_fa", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load normalizer from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.normalize


def trimmed_voice(path: str) -> str:
    """The model was trained on <=5 s voice prompts; longer ones are less stable."""
    import tempfile

    with wave.open(path, "rb") as w:
        rate, frames, channels, width = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        keep = int(VOICE_PROMPT_MAX_SEC * rate)
        if frames <= keep:
            return path
        data = w.readframes(keep)
    out = Path(tempfile.mkdtemp()) / "voice_prompt.wav"
    with wave.open(str(out), "wb") as o:
        o.setnchannels(channels)
        o.setsampwidth(width)
        o.setframerate(rate)
        o.writeframes(data)
    log.info("voice prompt trimmed to %.1fs", VOICE_PROMPT_MAX_SEC)
    return str(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, help="pocket-tts model YAML: hf://owner/repo/file.yaml, URL or path")
    parser.add_argument("--voice", required=True, help="2-5 s 16-bit WAV of a consenting speaker")
    parser.add_argument("--normalizer", default=None, help="the model repo's normalize_fa.py (recommended)")
    parser.add_argument("--port", type=int, default=5002)
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--eos-threshold", type=float, default=-2.0)
    parser.add_argument("--quantize", action="store_true", help="int8 quantization: less memory, faster on x86")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    from pocket_tts import TTSModel

    log.info("loading model %s (first run downloads it)...", args.config)
    model = TTSModel.load_model(
        config=args.config, temp=args.temperature, eos_threshold=args.eos_threshold, quantize=args.quantize,
    )
    state = model.get_state_for_audio_prompt(trimmed_voice(args.voice))
    synth = Synthesizer(model, state, load_normalizer(args.normalizer))
    warm = time.perf_counter()
    synth.synthesize("سلام، وقت شما بخیر.")
    log.info("warm-up done in %.2fs; sample rate %d Hz", time.perf_counter() - warm, synth.sample_rate)

    info = {"config": args.config, "sampleRate": synth.sample_rate}
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(synth, info))
    log.info("listening on http://127.0.0.1:%d (POST /synthesize, GET /health)", args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
