"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/dashboard/auth";
import { TelephonyLiveConversation } from "@/components/dashboard/telephony-live-conversation";
import { VoiceLatencyBreakdown } from "@/components/dashboard/voice-latency-breakdown";

type Mic = { id: string; label: string };
type Agent = { id: string; name: string; isActive: boolean };
type AgentReadiness = {
  ready: boolean;
  reasons: string[];
  providers: { llm: string; stt: string; tts: string };
};
type AiResult = {
  heard: boolean;
  transcript: string;
  reply: string;
  spokenText?: string;
  input: { durationSeconds: number; rms: number; frames20ms: number };
  output: { mulawBytes: number; frames20ms: number } | null;
  playbackWavBase64: string | null;
  latencyMs: { total: number; stt?: number; agent?: number; tts?: number; store?: number };
};

const TARGET_RATE = 8000;
const REC_LIMIT_MS = 20000;

function mulawEncode(value: number): number {
  let sign = 0;
  let pcm = value;
  if (pcm < 0) { pcm = -pcm; sign = 0x80; }
  pcm = Math.min(pcm, 32635) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15)) & 255;
}

function mulawDecode(value: number): number {
  const u = (~value) & 255;
  const magnitude = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
  return (u & 128) ? 132 - magnitude : magnitude - 132;
}

function mulawWav(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(44 + bytes.length * 2);
  const view = new DataView(buffer);
  const str = (start: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(start + i, value.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, bytes.length * 2, true);
  for (let i = 0; i < bytes.length; i++) view.setInt16(44 + 2 * i, mulawDecode(bytes[i]), true);
  return new Blob([buffer], { type: "audio/wav" });
}

async function recordedToMulaw(blob: Blob) {
  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.round(decoded.duration * TARGET_RATE);
    if (frames < 5600 || frames > TARGET_RATE * 20) {
      throw new Error("مدت ضبط باید بین ۰٫۷ تا ۲۰ ثانیه باشد.");
    }
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const bytes = new Uint8Array(samples.length);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      energy += sample * sample;
      bytes[i] = mulawEncode(Math.round(sample < 0 ? sample * 32768 : sample * 32767));
    }
    const rms = Math.sqrt(energy / samples.length);
    if (rms < 0.001) throw new Error("صدا تقریباً ساکت است؛ هیچ داده‌ای برای تشخیص گفتار ارسال نشد.");
    return { bytes, rms, durationSeconds: samples.length / TARGET_RATE };
  } finally {
    await audioCtx.close();
  }
}

function fromBase64(base64: string): Blob {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes.buffer], { type: "audio/wav" });
}

export default function TelephonyLabPage() {
  const { api, apiJson, loading } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [mics, setMics] = useState<Mic[]>([]);
  const [micId, setMicId] = useState("");
  const [mode, setMode] = useState<"codec" | "ai">("ai");
  const [allowUsage, setAllowUsage] = useState(false);
  const [conversationMode, setConversationMode] = useState<"manual" | "live">("manual");
  const [briefReplies, setBriefReplies] = useState(true);
  const [ttsEngine, setTtsEngine] = useState<"configured" | "piper">("configured");
  const [piperVoice, setPiperVoice] = useState("fa_IR-amir-medium");
  const [piperStyle, setPiperStyle] = useState<"natural" | "warm" | "calm">("natural");
  const [voiceSample, setVoiceSample] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleTtsMs, setSampleTtsMs] = useState<number | null>(null);
  const [sttEngine, setSttEngine] = useState<"configured" | "faster-whisper">("configured");
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [readinessError, setReadinessError] = useState("");
  const [stage, setStage] = useState("پس از انتخاب منشی، اتصال آزمایشی بررسی می‌شود.");
  const [state, setState] = useState<"idle" | "recording" | "processing" | "complete">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<AiResult | null>(null);
  const [metrics, setMetrics] = useState<{ durationSeconds: number; rms: number; bytes: number } | null>(null);
  const [inputUrl, setInputUrl] = useState<string | null>(null);
  const [replyUrl, setReplyUrl] = useState<string | null>(null);
  const [micError, setMicError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || loading) return;
    let mounted = true;
    apiJson<Agent[]>("/api/v1/agents").then(list => {
      if (mounted) {
        setAgents(list.filter(a => a.isActive));
        setAgentId(current => current || list.find(a => a.isActive)?.id || "");
      }
    }).catch(e => { if (mounted) setError(e instanceof Error ? e.message : "فهرست منشی‌ها در دسترس نیست."); });
    return () => { mounted = false; };
  }, [apiJson, loading]);

  useEffect(() => {
    if (loading || mode !== "ai" || !agentId) return;
    let current = true;
    apiJson<AgentReadiness>(`/api/v1/agents/${agentId}/telephony-local-test`)
      .then(data => { if (current) setReadiness(data); })
      .catch(err => { if (current) setReadinessError(err instanceof Error ? err.message : "ارتباط با منشی آزمایشی برقرار نیست."); });
    return () => { current = false; };
  }, [apiJson, agentId, loading, mode]);

  useEffect(() => () => {
    if (inputUrl) URL.revokeObjectURL(inputUrl);
  }, [inputUrl]);
  useEffect(() => () => {
    if (replyUrl) URL.revokeObjectURL(replyUrl);
  }, [replyUrl]);
  useEffect(() => () => {
    if (voiceSample) URL.revokeObjectURL(voiceSample);
  }, [voiceSample]);
  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
    recorder.current?.state === "recording" && recorder.current.stop();
    stream.current?.getTracks().forEach(track => track.stop());
  }, []);

  async function previewPiperVoice() {
    if (sampleBusy || !agentId) return;
    setSampleBusy(true);
    setError("");
    setVoiceSample(null);
    setSampleTtsMs(null);
    try {
      const form = new FormData();
      form.set("voicePreview", "piper");
      form.set("piperVoice", piperVoice);
      form.set("piperStyle", piperStyle);
      const response = await api(`/api/v1/agents/${agentId}/telephony-local-test`, {
        method: "POST", body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      if (typeof payload.playbackWavBase64 !== "string") {
        throw new Error("Piper فایل پیش‌نمایش صوتی برنگرداند.");
      }
      setVoiceSample(URL.createObjectURL(fromBase64(payload.playbackWavBase64)));
      setSampleTtsMs(payload.ttsMs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "پیش‌نمایش Piper ممکن نشد.");
    } finally {
      setSampleBusy(false);
    }
  }

  async function detectMics() {
    setMicError("");
    let probe: MediaStream | null = null;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === "audioinput" && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `میکروفون ${i + 1}` }));
      setMics(devices);
      setMicId(previous => devices.some(d => d.id === previous) ? previous :
        (devices.find(d => !/stereo\s*mix|wave\s*out\s*mix/i.test(d.label))?.id || ""));
      if (!devices.length) setMicError("هیچ میکروفونی پیدا نشد.");
    } catch (e) {
      setMicError(e instanceof Error ? e.message : "مجوز میکروفون صادر نشد.");
    } finally {
      probe?.getTracks().forEach(t => t.stop());
    }
  }

  async function start() {
    setError("");
    setResult(null);
    setMetrics(null);
    setInputUrl(null);
    setReplyUrl(null);
    setStage("در حال آماده‌سازی برای ضبط ...");
    if (!micId) { setError("ابتدا میکروفون واقعی را انتخاب کنید."); return; }
    if (mode === "ai") {
      if (!agentId) {
        setError("هیچ منشی فعالی در دیتابیس آزمایشی پیدا نشد. ابتدا منشی را در همین محیط ایجاد کنید.");
        return;
      }
      if (readinessError) {
        setError("اتصال به منشی آزمایشی ناموفق است: " + readinessError);
        return;
      }
      if (!readiness?.ready) {
        setError(readiness ? readiness.reasons.join(" | ") : "تنظیمات منشی هنوز بررسی نشده‌اند.");
        return;
      }
      if (!allowUsage) {
        setError("برای ارسال صدای واقعی به Gemini، ابتدا تیک تأیید مصرف API را فعال کنید.");
        return;
      }
    }
    try {
      const currentStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: micId }, echoCancellation: true, noiseSuppression: true }
      });
      stream.current = currentStream;
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(currentStream);
      recorder.current = rec;
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onerror = () => setError("خطای ضبط در مرورگر.");
      rec.onstop = async () => {
        if (timeout.current) clearTimeout(timeout.current);
        currentStream.getTracks().forEach(track => track.stop());
        stream.current = null;
        setState("processing");
        setStage("در حال تبدیل صدای میکروفون به کدک G.711 ...");
        try {
          const audio = await recordedToMulaw(new Blob(chunks, { type: rec.mimeType }));
          setMetrics({ durationSeconds: audio.durationSeconds, rms: audio.rms, bytes: audio.bytes.length });
          setInputUrl(URL.createObjectURL(mulawWav(audio.bytes)));
          if (mode === "ai") {
            setStage("صدا آماده شد؛ در حال ارسال به منشی و انتظار برای STT، پاسخ و TTS ...");
            const form = new FormData();
            form.append("audio", new Blob([audio.bytes.buffer as ArrayBuffer], { type: "audio/basic" }), "telephone.ulaw");
            form.set("responseStyle", briefReplies ? "brief" : "normal");
            form.set("ttsEngine", ttsEngine);
            form.set("piperVoice", piperVoice);
            form.set("piperStyle", piperStyle);
            form.set("sttEngine", sttEngine);
            const response = await api(`/api/v1/agents/${agentId}/telephony-local-test`, { method: "POST", body: form });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error?.message || `Local telephone test failed (${response.status})`);
            const data = payload as AiResult;
            setResult(data);
            setStage(data.heard ? "پاسخ منشی دریافت شد." : "تشخیص گفتار متنی برنگرداند؛ منشی پاسخی تولید نکرد.");
            if (data.playbackWavBase64) setReplyUrl(URL.createObjectURL(fromBase64(data.playbackWavBase64)));
          }
          if (mode === "codec") setStage("تست کدک کامل شد؛ این حالت هیچ صدایی به منشی ارسال نمی‌کند.");
          setState("complete");
        } catch (e) {
          setStage("ارسال یا پردازش صدا ناموفق بود.");
          setError(e instanceof Error ? e.message : "تبدیل یا پردازش صدا ناموفق بود.");
          setState("idle");
        }
      };
      rec.start();
      setState("recording");
      setStage("در حال ضبط؛ برای ارسال به منشی، پس از گفتن جمله روی «پایان صحبت» کلیک کنید.");
      timeout.current = setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, REC_LIMIT_MS);
    } catch (e) {
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
      setError(e instanceof Error ? e.message : "دسترسی به میکروفون امکان‌پذیر نیست.");
      setState("idle");
    }
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  if (process.env.NODE_ENV === "production") return <p>این آزمایشگاه فقط در محیط توسعه در دسترس است.</p>;

  return (
    <div className="space-y-5" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">آزمایشگاه تماس تلفنی محلی</h1>
        <p className="mt-2 text-sm text-slate-600">شبیه‌سازی کدک تلفنی G.711 μ-law، تک‌کاناله، ۸ کیلوهرتز. این یک تماس PSTN/Twilio نیست؛ شماره‌گیری، انتقال اپراتور یا ایجاد رکورد CallSid انجام نمی‌شود.</p>
        <Link className="text-sm text-blue-700 underline" href="/dashboard/agent">بازگشت به منشی هوشمند</Link>
      </div>
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <h2 className="font-semibold">تنظیمات تماس آزمایشی</h2>
        <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
          برای دریافت پاسخ از منشی، حالت «مکالمه با Gemini» را انتخاب کنید.
          در روش دستی پس از زدن «پایان صحبت» ارسال انجام می‌شود؛ در «گفتگوی زنده»
          پایان جمله به‌صورت خودکار تشخیص داده می‌شود.
          حالت «فقط کدک» صدا را به منشی نمی‌فرستد.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void detectMics()} className="rounded-lg border px-3 py-2 text-sm">شناسایی میکروفون‌ها</button>
          <select aria-label="میکروفون تماس آزمایشی" value={micId} onChange={e => setMicId(e.target.value)} className="min-w-64 flex-1 rounded-lg border p-2">
            <option value="">انتخاب میکروفون</option>
            {mics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        {micError && <p role="alert" className="text-sm text-red-700">{micError}</p>}
        <fieldset className="space-y-2">
          <legend className="font-medium">نوع آزمایش</legend>
          <label className="block text-sm"><input type="radio" checked={mode === "codec"} disabled={state === "recording" || state === "processing"} onChange={() => setMode("codec")} /> فقط کدک تلفنی و پخش محلی (بدون هزینه)</label>
          <label className="block text-sm"><input type="radio" checked={mode === "ai"} disabled={state === "recording" || state === "processing"} onChange={() => setMode("ai")} /> مکالمه با Gemini روی دیتابیس ایزوله (مصرف واقعی API)</label>
        </fieldset>
        {mode === "ai" && (
          <div className="space-y-2 border-r-2 border-amber-500 pr-3">
            {!agents.length && <p role="alert" className="text-sm text-red-700">در این دیتابیس منشی فعال یافت نشد. از صفحه «منشی هوشمند» یک منشی فعال بسازید.</p>}
            <label className="block text-sm">انتخاب منشی
              <select aria-label="انتخاب منشی آزمایشی" className="mr-2 rounded-lg border p-2" value={agentId} onChange={e => {
                setAgentId(e.target.value);
                setReadiness(null);
                setReadinessError("");
              }}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <div role="status" aria-label="آمادگی اتصال به منشی" className="rounded-lg bg-slate-50 p-2 text-sm">
              {readinessError ? <span className="text-red-700">اتصال آماده نیست: {readinessError}</span> :
                !agentId ? "انتخاب منشی ضروری است." :
                !readiness ? "در حال بررسی اتصال منشی و دیتابیس آزمایشی ..." :
                readiness.ready ? "اتصال منشی آماده است. پس از پایان صحبت، صدا برای AI ارسال می‌شود." :
                <span className="text-red-700">اتصال آماده نیست: {readiness.reasons.join(" | ")}</span>}
            </div>
            <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3">
              <legend className="text-sm font-semibold">روش گفتگو با منشی</legend>
              <label className="block text-sm"><input type="radio" name="conversationMode" checked={conversationMode === "manual"} disabled={state === "recording" || state === "processing"} onChange={() => setConversationMode("manual")} /> ضبط و ارسال دستی (پایان صحبت با دکمه)</label>
              <label className="block text-sm"><input type="radio" name="conversationMode" checked={conversationMode === "live"} disabled={state === "recording" || state === "processing"} onChange={() => setConversationMode("live")} /> گفتگوی زنده بدون فشردن دکمه پایان صحبت</label>
            </fieldset>
            <label className="block text-sm">موتور تولید صدای پاسخ
              <select aria-label="موتور تولید صدای پاسخ" className="mr-2 rounded-lg border p-2"
                value={ttsEngine} onChange={e => setTtsEngine(e.target.value as "configured" | "piper")}>
                <option value="configured">موتور تنظیم‌شده فعلی (Gemini)</option>
                <option value="piper">Piper محلی فارسی (آزمایشی، بدون هزینه API صوت)</option>
              </select>
            </label>
            {ttsEngine === "piper" && <div className="space-y-2 rounded-lg bg-slate-50 p-3">
              <label className="block text-sm">گوینده فارسی
                <select aria-label="گوینده فارسی Piper" className="mr-2 rounded-lg border p-2"
                  value={piperVoice} onChange={e => setPiperVoice(e.target.value)}>
                  <option value="fa_IR-amir-medium">Amir — صدای فعلی</option>
                  <option value="fa_IR-ganji-medium">Ganji</option>
                  <option value="fa_IR-ganji_adabi-medium">Ganji Adabi</option>
                  <option value="fa_IR-gyro-medium">Gyro</option>
                  <option value="fa_IR-reza_ibrahim-medium">Reza Ibrahim</option>
                </select>
              </label>
              <label className="block text-sm">لحن و آهنگ گفتار
                <select aria-label="لحن صدای Piper" className="mr-2 rounded-lg border p-2"
                  value={piperStyle} onChange={e => setPiperStyle(e.target.value as "natural" | "warm" | "calm")}>
                  <option value="natural">طبیعی (پیش‌فرض)</option>
                  <option value="warm">گرم و روان (آزمایشی)</option>
                  <option value="calm">آرام و شمرده (آزمایشی)</option>
                </select>
              </label>
              <button type="button" onClick={() => void previewPiperVoice()} disabled={sampleBusy || !agentId}
                className="rounded-lg border border-teal-600 px-3 py-2 text-sm text-teal-800 disabled:opacity-50">
                {sampleBusy ? "در حال تولید نمونه ..." : "شنیدن نمونه صدا بدون Gemini"}
              </button>
              {voiceSample && <div className="space-y-1">
                <audio controls src={voiceSample} aria-label="پیش‌نمایش صوت Piper"/>
                <p className="text-xs text-slate-600">زمان تولید نمونه: {typeof sampleTtsMs === "number" ? (sampleTtsMs / 1000).toFixed(2) : "-"} ثانیه</p>
              </div>}
              <p className="text-xs text-amber-700">برای هر گوینده، دو فایل ONNX و JSON آن را در پوشه Piper دانلود کنید؛ Piper در نبود صدا ممکن است به گوینده پیش‌فرض برگردد. تغییر لحن جایگزین کیفیت ذاتی مدل نیست.</p>
            </div>}
            <label className="block text-sm">موتور تشخیص گفتار (STT)
              <select aria-label="موتور تشخیص گفتار" className="mr-2 rounded-lg border p-2"
                value={sttEngine} onChange={e => setSttEngine(e.target.value as "configured" | "faster-whisper")}>
                <option value="configured">Gemini فعلی</option>
                <option value="faster-whisper">Faster-Whisper روی CPU (آزمایشی)</option>
              </select>
            </label>
            {sttEngine === "faster-whisper" && <p className="text-xs text-amber-700">سرور STT محلی باید روی پورت 5001 روشن باشد؛ ابتدا سرعت و دقت مدل tiny را بسنجید. اشتباه در تشخیص گفتار ممکن است پاسخ منشی را تغییر دهد.</p>}
            <label className="block text-sm"><input type="checkbox" checked={briefReplies} onChange={e => setBriefReplies(e.target.checked)} /> پاسخ صوتی کوتاه (یک یا دو جمله؛ بدون حذف اطلاعات ضروری)</label>
            <label className="block text-sm"><input type="checkbox" checked={allowUsage} onChange={e => setAllowUsage(e.target.checked)} /> تأیید می‌کنم که Gemini/STT/TTS و سهمیه دیتابیس ai_receptionist_test ممکن است مصرف شود؛ تماس واقعی برقرار نمی‌شود.</label>
          </div>
        )}
        {(mode === "codec" || conversationMode === "manual") && <div className="flex flex-wrap gap-3">
          <button type="button" aria-label="شروع تماس محلی" disabled={state === "recording" || state === "processing"} onClick={() => void start()} className="rounded-lg bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50">شروع تماس محلی</button>
          <button type="button" aria-label="پایان صحبت" disabled={state !== "recording"} onClick={stop} className="rounded-lg bg-rose-700 px-4 py-2 text-white disabled:opacity-50">پایان صحبت</button>
          <p role="status" className="self-center text-sm">وضعیت: {state === "idle" ? "آماده" : state === "recording" ? "در حال ضبط صدای تماس‌گیرنده" : state === "processing" ? "در حال پردازش" : "آزمایش کامل شد"}</p>
        </div>}
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm" aria-label="مرحله پردازش تماس">{stage}</p>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </section>
      {mode === "ai" && conversationMode === "live" && (!allowUsage || !readiness?.ready) && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          برای فعال‌شدن گفتگوی زنده، اتصال منشی باید آماده باشد و تأیید مصرف API فعال شود.
        </p>
      )}
      {mode === "ai" && conversationMode === "live" && allowUsage && Boolean(readiness?.ready) && (
        <TelephonyLiveConversation key={agentId + ":" + micId}
          agentId={agentId}
          microphoneId={micId}
          ready={Boolean(readiness?.ready)}
          allowUsage={allowUsage}
          briefReplies={briefReplies}
          ttsEngine={ttsEngine}
          piperVoice={piperVoice}
          piperStyle={piperStyle}
          sttEngine={sttEngine}
        />
      )}
      {metrics && (
        <section className="rounded-xl border bg-white p-5 space-y-3">
          <h2 className="font-semibold">خروجی کانال تلفنی شبیه‌سازی‌شده</h2>
          <p className="text-sm">نرخ نمونه‌برداری: 8000Hz | کدک: G.711 μ-law | فریم: 20ms / 160 bytes</p>
          <p className="text-sm">مدت: {metrics.durationSeconds.toFixed(2)} ثانیه | RMS: {metrics.rms.toFixed(5)} | داده: {metrics.bytes} بایت | تعداد فریم: {Math.ceil(metrics.bytes / 160)}</p>
          {inputUrl && <><p className="text-sm">بازپخش صدای تبدیل‌شده به کیفیت خط تلفن:</p><audio controls src={inputUrl} /></>}
        </section>
      )}
      {result && (
        <section className="rounded-xl border bg-white p-5 space-y-3">
          <h2 className="font-semibold">مکالمه با منشی (پردازش واقعی AI، حمل تلفنی شبیه‌سازی‌شده)</h2>
          <p><strong>شنیده شد:</strong> {result.transcript || "گفتاری تشخیص داده نشد"}</p>
          <p><strong>پاسخ:</strong> {result.reply || "پاسخی تولید نشد"}</p>
          <VoiceLatencyBreakdown latencyMs={result.latencyMs} spokenText={result.spokenText} playbackSeconds={result.output ? result.output.frames20ms * 0.02 : null} />
          <p className="text-sm">بسته‌های خروجی: {result.output?.frames20ms ?? 0} | بایت‌های G.711 خروجی: {result.output?.mulawBytes ?? 0}</p>
          {replyUrl && <><p className="text-sm">صدای پاسخ پس از تبدیل به کیفیت تلفن:</p><audio controls autoPlay src={replyUrl} /></>}
        </section>
      )}
    </div>
  );
}
