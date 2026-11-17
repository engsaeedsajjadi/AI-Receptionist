"""Model-free tests for the Pocket-TTS lab server: python -m unittest scripts/local-tts/test_pocket_server.py"""
import io
import json
import sys
import threading
import unittest
import wave
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pocket_server as ps  # noqa: E402

RATE = 24_000


def words(s):
    return len(s.split())


class SplitTextTest(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(ps.split_text("نوبت شما ثبت شد.", words, 18), ["نوبت شما ثبت شد."])

    def test_long_text_splits_at_sentence_then_clause_then_words(self):
        text = "فردا ساعت ۱۱ آزاد است. لطفاً نام و شماره تماس خود را بفرمایید، تا نوبت را ثبت کنم."
        chunks = ps.split_text(text, words, 6)
        self.assertTrue(all(words(c) <= 6 for c in chunks), chunks)
        self.assertEqual(" ".join(chunks), " ".join(text.split()))

    def test_empty(self):
        self.assertEqual(ps.split_text("   ", words, 18), [])


class RunawayGuardTest(unittest.TestCase):
    def test_healthy_generation_is_returned_once(self):
        calls = []
        def synth(t):
            calls.append(t)
            return np.zeros(RATE)  # 1 s, cap 3 s
        out = ps.generate_chunk(synth, lambda t: 3.0, "یک دو سه", RATE)
        self.assertEqual(len(out), RATE)
        self.assertEqual(len(calls), 1)

    def test_runaway_is_retried_then_split(self):
        calls = []
        def synth(t):
            calls.append(t)
            # The full sentence always runs to the cap; halves are healthy.
            return np.zeros(int(3.0 * RATE)) if len(t.split()) > 4 else np.zeros(RATE)
        out = ps.generate_chunk(synth, lambda t: 3.0, "یک دو سه چهار پنج شش هفت هشت", RATE)
        self.assertEqual(calls[0], calls[1])  # retried once
        self.assertEqual(len(calls), 4)       # then two healthy halves
        self.assertLess(len(out) / RATE, 3.0)

    def test_stuck_short_text_is_trimmed_not_played_in_full(self):
        out = ps.generate_chunk(lambda t: np.ones(10 * RATE), lambda t: 2.0, "بله", RATE)
        self.assertLessEqual(len(out), int(ps.CAP_RATIO * 2.0 * RATE))


class FakeSynth:
    sample_rate = RATE
    def __init__(self):
        self.texts = []
    def synthesize(self, text):
        self.texts.append(text)
        return ps.to_wav(np.zeros(RATE // 2, dtype=np.float32), RATE)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.synth = FakeSynth()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ps.make_handler(self.synth, {"config": "fake"}))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def post(self, body: bytes):
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/synthesize", body=body, headers={"Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, r.read()

    def test_returns_mono_pcm16_wav(self):
        status, body = self.post(json.dumps({"text": "سلام"}).encode())
        self.assertEqual(status, 200)
        with wave.open(io.BytesIO(body)) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, RATE))
        self.assertEqual(self.synth.texts, ["سلام"])

    def test_rejects_bad_input_without_synthesizing(self):
        for body in [b"not json", json.dumps({"text": ""}).encode(), json.dumps({"text": "ا" * 601}).encode(),
                     json.dumps({"voice": "x"}).encode(), json.dumps(["سلام"]).encode()]:
            self.assertEqual(self.post(body)[0], 400, body[:40])
        self.assertEqual(self.post(b"x" * 9000)[0], 413)
        self.assertEqual(self.synth.texts, [])

    def test_health(self):
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/health")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(r.read())["ok"])


if __name__ == "__main__":
    unittest.main()
