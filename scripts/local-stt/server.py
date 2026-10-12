"""
CPU-only, localhost-only Persian STT test server for the developer telephony lab.

Install in its own Python venv:
    python -m pip install flask faster-whisper
    python scripts/local-stt/server.py --model tiny --port 5001

The first boot downloads the public Whisper model. This is an experimental
benchmark sidecar, NOT an authenticated production speech API.
"""
import argparse
import io
import threading
import time
import wave

from flask import Flask, jsonify, request
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 800_000

model = None
model_name = "tiny"
inference_lock = threading.Lock()


@app.get("/health")
def health():
    return jsonify({"ok": model is not None, "model": model_name, "compute": "int8", "device": "cpu"})


@app.post("/transcribe")
def transcribe():
    if request.mimetype != "audio/wav":
        return jsonify({"error": "WAV required"}), 415
    raw = request.get_data(cache=False)
    if len(raw) < 44 or len(raw) > 800_000:
        return jsonify({"error": "Invalid WAV size"}), 400
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            if (wav.getnchannels() != 1 or wav.getsampwidth() != 2
                    or wav.getframerate() not in (8000, 16000)
                    or wav.getcomptype() != "NONE"):
                return jsonify({"error": "Expected mono 8/16-kHz PCM16"}), 400
            duration = wav.getnframes() / wav.getframerate()
            if not 0.7 <= duration <= 20.0:
                return jsonify({"error": "Audio must be 0.7..20 s"}), 400

        # PyAV decoder resamples real 8-kHz G.711-normalized WAV to 16 kHz,
        # the Whisper model's expected input sample rate.
        samples = decode_audio(io.BytesIO(raw), sampling_rate=16000)
        start = time.perf_counter()
        with inference_lock:
            segments, _ = model.transcribe(
                samples,
                language="fa",
                beam_size=1,
                best_of=1,
                temperature=0,
                vad_filter=False,  # browser VAD already segmented this utterance
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        elapsed = round(time.perf_counter() - start, 3)
        return jsonify({
            "text": text[:4000],
            "language": "fa",
            "durationSeconds": duration,
            "model": model_name,
            "inferenceSeconds": elapsed,
        })
    except Exception:
        # Do not echo private audio/transcription or provider stack traces.
        app.logger.exception("Local STT failed")
        return jsonify({"error": "Local STT inference failed"}), 500


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["tiny", "base"], default="tiny")
    parser.add_argument("--port", type=int, default=5001)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or not 1 <= args.threads <= 8:
        parser.error("port must be >=1024 and threads between 1 and 8")
    model_name = args.model
    model = WhisperModel(
        args.model, device="cpu", compute_type="int8",
        cpu_threads=args.threads, num_workers=1,
    )
    print(f"Faster-Whisper {model_name} ready on 127.0.0.1:{args.port}")
    app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False, threaded=True)
