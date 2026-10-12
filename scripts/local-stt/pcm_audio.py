"""Decode the constrained PCM16 WAV used by the local telephony lab.

Bypass PyAV entirely: faster-whisper's older decode_audio can fail with PyAV 19's
removed metadata_errors keyword. Whisper accepts 16-kHz float32 numpy arrays.
"""

import io
import wave

import numpy as np


def decode_telephony_wav(raw: bytes) -> tuple[np.ndarray, float]:
    """Return 16-kHz float32 mono samples and duration for 8/16-kHz PCM16 WAV.

    The caller bounds the request size. Validate the WAVE header and duration
    here as defense in depth; never reinterpret other formats as raw samples.
    """
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            if (wav.getnchannels() != 1 or wav.getsampwidth() != 2
                    or wav.getframerate() not in (8000, 16000)
                    or wav.getcomptype() != "NONE"):
                raise ValueError("Expected mono 8/16-kHz PCM16 WAV")
            rate = wav.getframerate()
            count = wav.getnframes()
            duration = count / rate
            if not 0.7 <= duration <= 20.0:
                raise ValueError("Audio must be 0.7..20 seconds")
            pcm = wav.readframes(count)
    except (wave.Error, EOFError, OSError) as exc:
        raise ValueError("Invalid PCM WAV") from exc

    if len(pcm) != count * 2:
        raise ValueError("Truncated PCM WAV")
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if rate == 8000:
        # Linear interpolation is deterministic and avoids a PyAV/FFmpeg
        # version dependency for the restricted 8-kHz telephony input.
        old = np.arange(samples.size, dtype=np.float64)
        new = np.arange(samples.size * 2, dtype=np.float64) * 0.5
        samples = np.interp(new, old, samples).astype(np.float32)
    return samples, duration
