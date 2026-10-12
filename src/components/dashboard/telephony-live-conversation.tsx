"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { recordedToMulaw, fromBase64 } from "@/lib/voice/browser-telephony";

type AiResult = {
  heard: boolean;
  transcript: string;
  reply: string;
  playbackWavBase64: string | null;
  latencyMs: { total: number };
  output: { frames20ms: number } | null;
};

type Props = {
  agentId: string;
  microphoneId: string;
  ready: boolean;
  allowUsage: boolean;
};

type ConversationLine = { id: number; transcript: string; reply: string; latencyMs: number };
type Phase = "idle" | "listening" | "processing" | "speaking" | "error";

const VAD_INTERVAL_MS = 50;
const VAD_START_FRAMES = 3;
const VAD_SILENCE_MS = 850;
const VAD_MIN_UTTERANCE_MS = 650;
const MAX_SEGMENT_MS = 16_000;

/**
 * Hands-free local conversation. Continuously monitors the actual microphone
 * and automatically closes speech turns, but transports one bounded turn at
 * a time over the authenticated DEV-ONLY REST lab. This is NOT a Twilio
 * websocket, not an inbound PSTN call and not full-duplex media streaming.
 */
export function TelephonyLiveConversation({ agentId, microphoneId, ready, allowUsage }: Props) {
  const { api } = useAuth();
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("شروع گفتگو را بزنید و با منشی صحبت کنید.");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<ConversationLine[]>([]);
  const [volume, setVolume] = useState(0);
  const [turnCount, setTurnCount] = useState(0);

  const runtime = useRef<{
    active: boolean;
    epoch: number;
    recorder: MediaRecorder | null;
    stream: MediaStream | null;
    context: AudioContext | null;
    analyser: AnalyserNode | null;
    source: MediaStreamAudioSourceNode | null;
    timer: ReturnType<typeof setInterval> | null;
    controller: AbortController | null;
    player: HTMLAudioElement | null;
    playbackUrl: string | null;
    phase: Phase;
    noise: number;
    onsetFrames: number;
    startedTalking: number;
    lastTalking: number;
    recordingSince: number;
    turning: boolean;
  }>({
    active: false, epoch: 0, recorder: null, stream: null, context: null,
    analyser: null, source: null, timer: null, controller: null, player: null,
    playbackUrl: null, phase: "idle", noise: 0.002, onsetFrames: 0,
    startedTalking: 0, lastTalking: 0, recordingSince: 0, turning: false,
  });

  const setPhaseLive = (next: Phase, label: string) => {
    runtime.current.phase = next;
    setPhase(next);
    setDetail(label);
  };

  const releasePlayback = () => {
    const r = runtime.current;
    if (r.player) {
      r.player.pause();
      r.player.onended = null;
      r.player.onerror = null;
      r.player = null;
    }
    if (r.playbackUrl) {
      URL.revokeObjectURL(r.playbackUrl);
      r.playbackUrl = null;
    }
  };

  const finish = (message = "مکالمه پایان یافت.") => {
    const r = runtime.current;
    r.active = false;
    r.epoch++;
    if (r.timer) clearInterval(r.timer);
    r.timer = null;
    r.controller?.abort();
    r.controller = null;
    releasePlayback();
    if (r.recorder && r.recorder.state === "recording") {
      r.recorder.onstop = null;
      r.recorder.stop();
    }
    r.recorder = null;
    r.source?.disconnect();
    r.source = null;
    r.analyser?.disconnect();
    r.analyser = null;
    void r.context?.close().catch(() => undefined);
    r.context = null;
    r.stream?.getTracks().forEach(track => track.stop());
    r.stream = null;
    r.startedTalking = 0;
    r.turning = false;
    setVolume(0);
    setPhaseLive("idle", message);
  };

  // No microphone, fetch or audio survives unmount or a tenant/agent change.
  useEffect(() => () => {
    const r = runtime.current;
    r.active = false;
    r.epoch++;
    if (r.timer) clearInterval(r.timer);
    r.controller?.abort();
    if (r.player) { r.player.pause(); r.player.onended = null; }
    if (r.playbackUrl) URL.revokeObjectURL(r.playbackUrl);
    if (r.recorder?.state === "recording") {
      r.recorder.onstop = null;
      r.recorder.stop();
    }
    r.source?.disconnect();
    r.analyser?.disconnect();
    void r.context?.close().catch(() => undefined);
    r.stream?.getTracks().forEach(track => track.stop());
  }, [agentId, microphoneId]);

  const beginSegment = () => {
    const r = runtime.current;
    if (!r.active || !r.stream || r.recorder?.state === "recording") return;
    const recorder = new MediaRecorder(r.stream);
    const chunks: Blob[] = [];
    r.recordingSince = Date.now();
    r.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onstop = () => {
      if (!r.active) return;
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (r.turning) {
        r.turning = false;
        void deliver(blob, r.epoch);
      } else if (r.phase === "listening") {
        beginSegment();
      }
    };
    recorder.start();
  };

  const deliver = async (blob: Blob, epoch: number) => {
    const r = runtime.current;
    const stillCurrent = () => r.active && r.epoch === epoch;
    r.controller = new AbortController();
    try {
      const encoded = await recordedToMulaw(blob);
      if (!stillCurrent()) return;
      setPhaseLive("processing", "در حال تشخیص گفتار، پردازش توسط منشی و تولید پاسخ صوتی ...");
      const form = new FormData();
      form.append("audio", new Blob([encoded.bytes.buffer as ArrayBuffer], { type: "audio/basic" }), "live-utterance.ulaw");
      const response = await api(`/api/v1/agents/${agentId}/telephony-local-test`, {
        method: "POST", body: form, signal: r.controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!stillCurrent()) return;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `درخواست منشی ناموفق بود (HTTP ${response.status})`);
      }
      const result = payload as AiResult;
      if (!result.heard || !result.transcript?.trim()) {
        setPhaseLive("listening", "صدای قابل تشخیص دریافت نشد؛ دوباره صحبت کنید.");
        beginSegment();
        return;
      }
      setLines(history => [...history.slice(-9), {
        id: epoch * 1000 + history.length,
        transcript: result.transcript,
        reply: result.reply || "پاسخی تولید نشد.",
        latencyMs: result.latencyMs?.total ?? 0,
      }]);
      setTurnCount(count => count + 1);
      if (!result.playbackWavBase64) {
        setPhaseLive("listening", "پاسخ متنی دریافت شد؛ فایل صوتی برنگشت. دوباره صحبت کنید.");
        beginSegment();
        return;
      }
      const url = URL.createObjectURL(fromBase64(result.playbackWavBase64));
      r.playbackUrl = url;
      const player = new Audio(url);
      r.player = player;
      setPhaseLive("speaking", "منشی در حال پاسخ دادن است. با صحبت کردن می‌توانید صدایش را قطع کنید؛ استفاده از هدفون بهتر است.");
      // Listen during playback, allowing user speech to interrupt the agent.
      beginSegment();
      player.onended = () => {
        if (!stillCurrent() || r.phase !== "speaking") return;
        releasePlayback();
        // Discard any agent audio that the microphone might have picked up.
        if (r.recorder?.state === "recording") {
          r.recorder.onstop = null;
          r.recorder.stop();
          r.recorder = null;
        }
        r.onsetFrames = 0;
        r.startedTalking = 0;
        setPhaseLive("listening", "در حال گوش دادن؛ جمله بعدی را بگویید.");
        beginSegment();
      };
      player.onerror = () => {
        if (!stillCurrent()) return;
        releasePlayback();
        setError("پخش صوت پاسخ ممکن نشد؛ متن پاسخ ثبت شد.");
        setPhaseLive("listening", "در حال گوش دادن؛ جمله بعدی را بگویید.");
        beginSegment();
      };
      await player.play();
    } catch (err) {
      if (!stillCurrent()) return;
      setError(err instanceof Error ? err.message : "پردازش مکالمه ناموفق بود.");
      setPhaseLive("error", "خطای پردازش مکالمه؛ برای جلوگیری از درخواست‌های تکراری، ارسال متوقف شد.");
      finishCaptureOnError();
    } finally {
      if (r.epoch === epoch) r.controller = null;
    }
  };

  const finishCaptureOnError = () => {
    const r = runtime.current;
    if (r.timer) clearInterval(r.timer);
    r.timer = null;
    r.active = false;
    if (r.recorder?.state === "recording") {
      r.recorder.onstop = null;
      r.recorder.stop();
    }
    r.recorder = null;
    r.stream?.getTracks().forEach(track => track.stop());
    r.stream = null;
    r.source?.disconnect();
    r.source = null;
    void r.context?.close().catch(() => undefined);
    r.context = null;
  };

  const monitor = () => {
    const r = runtime.current;
    if (!r.active || !r.analyser || r.phase === "processing" || r.phase === "error") return;
    const data = new Float32Array(r.analyser.fftSize);
    r.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    const rms = Math.sqrt(sum / data.length);
    setVolume(Math.min(100, Math.round(rms * 500)));

    const threshold = Math.max(0.016, r.noise * 3);
    const speech = rms > threshold;
    const now = Date.now();
    if (!speech && r.startedTalking === 0) {
      r.noise = 0.94 * r.noise + 0.06 * rms;
    }
    if (speech) {
      r.onsetFrames++;
      r.lastTalking = now;
      if (r.onsetFrames >= VAD_START_FRAMES && r.startedTalking === 0) {
        r.startedTalking = now - VAD_INTERVAL_MS * (VAD_START_FRAMES - 1);
        if (r.phase === "speaking") {
          releasePlayback();
          setPhaseLive("listening", "صحبت شما پاسخ قبلی را قطع کرد؛ در حال گوش دادن.");
        } else {
          setDetail("صدای شما تشخیص داده شد؛ بعد از مکث کوتاه، جمله خودکار ارسال می‌شود.");
        }
      }
    } else if (r.startedTalking === 0) {
      r.onsetFrames = 0;
    }
    if (r.startedTalking > 0 && r.recorder?.state === "recording") {
      const spokenFor = now - r.startedTalking;
      const silenceFor = now - r.lastTalking;
      if ((spokenFor >= VAD_MIN_UTTERANCE_MS && silenceFor >= VAD_SILENCE_MS) ||
        now - r.recordingSince >= MAX_SEGMENT_MS) {
        r.startedTalking = 0;
        r.onsetFrames = 0;
        r.turning = true;
        setPhaseLive("processing", "پایان جمله به‌صورت خودکار تشخیص داده شد؛ ارسال به منشی ...");
        r.recorder.stop();
      }
    } else if (r.startedTalking === 0 && r.recorder?.state === "recording" &&
      now - r.recordingSince >= MAX_SEGMENT_MS) {
      // Bound idle audio memory; do not issue STT requests for silence.
      r.recorder.stop();
      r.recorder = null;
    }
  };

  async function startLive() {
    if (runtime.current.active) return;
    setError("");
    if (!agentId || !microphoneId || !ready || !allowUsage) {
      setError("میکروفون، منشی فعال، وضعیت آماده و تأیید مصرف API لازم است.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: microphoneId }, echoCancellation: true,
          noiseSuppression: true, autoGainControl: true },
      });
      const r = runtime.current;
      r.stream = stream;
      const context = new AudioContext();
      r.context = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      r.source = source;
      r.analyser = analyser;
      await context.resume();
      r.active = true;
      r.epoch++;
      r.noise = 0.002;
      r.startedTalking = 0;
      r.onsetFrames = 0;
      r.lastTalking = Date.now();
      setPhaseLive("listening", "در حال گوش دادن؛ صحبت کنید. پایان جمله به‌صورت خودکار تشخیص داده می‌شود.");
      beginSegment();
      r.timer = setInterval(monitor, VAD_INTERVAL_MS);
    } catch (err) {
      finish();
      setError(err instanceof Error ? err.message : "مجوز میکروفون یا ایجاد شنود زنده ناموفق بود.");
    }
  }

  return (
    <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-5 space-y-3" aria-label="گفتگوی زنده با منشی">
      <h2 className="font-semibold text-lg">گفتگوی زنده با منشی هوشمند</h2>
      <p className="text-sm text-slate-700">
        میکروفون را یک‌بار روشن کنید و طبیعی صحبت کنید. بعد از مکث حدود یک ثانیه، جمله به‌صورت خودکار ارسال می‌شود و پاسخ فارسی پخش می‌شود.
        گفتگوی محلی بر اساس نوبت‌های گفتار است؛ این مسیر اتصال تلفنی Twilio یا استریم تمام‌دوطرفه نیست.
      </p>
      <p className="text-xs text-amber-800">
        در این حالت درخواست‌های واقعی Gemini و مصرف سهمیه ممکن‌اند. برای جلوگیری از تکرار صدای منشی، هدفون توصیه می‌شود.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-label="شروع گفتگوی زنده" disabled={phase !== "idle" && phase !== "error"} onClick={() => void startLive()}
          className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">شروع گفتگوی زنده</button>
        <button type="button" aria-label="پایان گفتگوی زنده" disabled={phase === "idle"} onClick={() => finish()}
          className="rounded-lg bg-rose-700 px-4 py-2 font-semibold text-white disabled:opacity-50">پایان گفتگو</button>
        <span role="status">وضعیت: {phase === "idle" ? "متوقف" : phase === "listening" ? "در حال گوش دادن" :
          phase === "processing" ? "در حال پردازش" : phase === "speaking" ? "منشی در حال صحبت" : "خطا"}</span>
      </div>
      <div role="status" aria-label="جزئیات گفتگوی زنده" className="rounded-lg bg-white p-3 text-sm">{detail}</div>
      <div className="flex items-center gap-3 text-sm">
        <span>سطح میکروفون</span>
        <progress aria-label="سطح میکروفون" max="100" value={volume} className="w-48"/>
        <span>نوبت‌های پاسخ: {turnCount}</span>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div aria-label="تاریخچه گفتگوی زنده" className="space-y-3">
        {lines.map(line => (
          <div key={line.id} className="rounded-lg border bg-white p-3 space-y-1">
            <p className="text-sm"><strong>شما:</strong> {line.transcript}</p>
            <p className="text-sm"><strong>منشی:</strong> {line.reply}</p>
            <p className="text-xs text-slate-500">زمان پردازش: {line.latencyMs} میلی‌ثانیه</p>
          </div>
        ))}
      </div>
    </section>
  );
}
