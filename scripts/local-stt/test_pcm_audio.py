"""Regression tests for PyAV-independent, CPU local-STT audio decoding."""

import io
import unittest
import wave

import numpy as np

from pcm_audio import decode_telephony_wav


def make_wav(rate=8000, seconds=1, channels=1):
    count = rate * seconds
    mono = (np.sin(np.arange(count) * 2 * np.pi * 440 / rate) * 11000).astype("<i2")
    pcm = mono.tobytes() if channels == 1 else np.repeat(mono[:, None], 2, axis=1).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return out.getvalue()


class TelephonyAudioTest(unittest.TestCase):
    def test_8k_pcm_is_upsampled_to_float32_16k(self):
        samples, duration = decode_telephony_wav(make_wav())
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.size, 16000)
        self.assertAlmostEqual(duration, 1)
        self.assertTrue(np.max(np.abs(samples)) <= 1)
        self.assertTrue(np.max(np.abs(samples)) > 0.1)

    def test_16k_pcm_passes_without_resampling(self):
        samples, duration = decode_telephony_wav(make_wav(rate=16000))
        self.assertEqual(samples.size, 16000)
        self.assertAlmostEqual(duration, 1)

    def test_rejects_truncated_and_non_wav_data(self):
        for payload in (b"random", make_wav()[:100]):
            with self.assertRaises(ValueError):
                decode_telephony_wav(payload)

    def test_rejects_stereo_and_short_audio(self):
        for payload in (make_wav(channels=2), make_wav()[:44]):
            with self.assertRaises(ValueError):
                decode_telephony_wav(payload)


if __name__ == "__main__":
    unittest.main()
