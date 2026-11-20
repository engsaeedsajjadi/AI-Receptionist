"use client";

import { useEffect, useRef, useState } from "react";
import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import { useAuth } from "@/components/dashboard/auth";
import { liveOutputToPlayback, micToLiveInput, rms } from "@/lib/voice/live-audio";

type Grant = { sessionId: string; model: string; token: string; expiresAt: string; config: LiveConnectConfig; tools: string[] };
type Readiness = { ready: boolean; reasons: string[] };
type Line = { id: number; who: "caller" | "agent" | "tool"; text: string };
type Phase = "idle" | "connecting" | "live" | "closed" | "error";

/** ~100 ms of microphone audio per message: small enough for fast turn-taking. */
const SEND_BLOCK_MS = 100;
/** Microphone level above which the caller is treated as talking (for the latency readout). */
const SPEECH_RMS = 0.02;

/** Same-origin module: the CSP (script-src 'self') refuses blob: worklets. */
const CAPTURE_WORKLET_URL = "/worklets/live-capture.js";

/**
 * Gemini Live (speech-to-speech) mode of the DEVELOPER telephone lab.
 *
 * One model hears, decides and speaks, so there is no STT → LLM → TTS chain
 * and the model itself handles turn-taking and interruptions. The browser
 * holds only a single-use ephemeral token; tool calls are sent back to the app
 * server, which runs them through the audited registry. Not a phone call.
 */
export function TelephonyGeminiLive({ agentId, microphoneId }: { agentId: string; microphoneId: string }) {
  const { api, apiJson } = useAuth();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [telephone, setTelephone] = useState(true);
  const [typed, setTyped] = useState("");
  const [latencies, setLatencies] = useState<number[]>([]);
  const [volume, setVolume] = useState(0);
  const runtime = useRef({
    session: null as Session | null,
    grant: null as Grant | null,
    stream: null as MediaStream | null,
    micContext: null as AudioContext | null,
    playContext: null as AudioContext | null,
    playHead: 0,
    sources: new Set<AudioBufferSourceNode>(),
    pending: [] as Float32Array[],
    pendingSamples: 0,
    lastSpeechAt: 0,
    awaitingReply: false,
    lineSeq: 0,
    telephone: true,
    epoch: 0,
  });

  useEffect(() => {
    let current = true;
    apiJson<Readiness>(`/api/v1/agents/${agentId}/live-session`)
      .then(data => { if (current) setReadiness(data); })
      .catch(err => { if (current) setReadiness({ ready: false, reasons: [err instanceof Error ? err.message : "Gemini Live در دسترس نیست."] }); });
    return () => { current = false; };
  }, [agentId, apiJson]);

  useEffect(() => () => { void stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const appendLine = (who: Line["who"], text: string) => {
    const r = runtime.current;
    setLines(previous => {
      const last = previous[previous.length - 1];
      // Transcripts arrive in fragments: grow the current line until the speaker changes.
      if (last && last.who === who && who !== "tool") {
        return [...previous.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...previous.slice(-40), { id: ++r.lineSeq, who, text }];
    });
  };

  const stopPlayback = () => {
    const r = runtime.current;
    for (const source of r.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    r.sources.clear();
    r.playHead = 0;
  };

  const play = (base64: string) => {
    const r = runtime.current;
    const ctx = r.playContext;
    if (!ctx) return;
    const { samples, sampleRate } = liveOutputToPlayback(base64, r.telephone);
    if (!samples.length) return;
    if (r.awaitingReply && r.lastSpeechAt) {
      const waited = Date.now() - r.lastSpeechAt;
      setLatencies(previous => [...previous.slice(-9), waited]);
    }
    r.awaitingReply = false;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, r.playHead);
    source.start(startAt);
    r.playHead = startAt + buffer.duration;
    r.sources.add(source);
    source.onended = () => r.sources.delete(source);
  };

  const runTools = async (message: LiveServerMessage, epoch: number) => {
    const r = runtime.current;
    const calls = message.toolCall?.functionCalls ?? [];
    const functionResponses = [];
    for (const call of calls) {
      if (!call.name) continue;
      appendLine("tool", `ابزار ${call.name} اجرا شد …`);
      let response: Record<string, unknown>;
      try {
        response = await apiJson<Record<string, unknown>>(`/api/v1/agents/${agentId}/live-session/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: r.grant?.sessionId, name: call.name, args: call.args ?? {} }),
        });
      } catch (err) {
        response = { status: "FAILED", error: err instanceof Error ? err.message : "Tool call failed" };
      }
      appendLine("tool", ` ${String(response.status)}`);
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    if (r.epoch !== epoch || !r.session || !functionResponses.length) return;
    r.session.sendToolResponse({ functionResponses });
  };

  const onMessage = (message: LiveServerMessage, epoch: number) => {
    const r = runtime.current;
    if (r.epoch !== epoch) return;
    const content = message.serverContent;
    if (content?.interrupted) stopPlayback();
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) play(part.inlineData.data);
    }
    if (content?.inputTranscription?.text) appendLine("caller", content.inputTranscription.text);
    if (content?.outputTranscription?.text) appendLine("agent", content.outputTranscription.text);
    if (message.toolCall) void runTools(message, epoch);
    if (message.goAway) setDetail("Gemini به‌زودی اتصال را می‌بندد (حداکثر حدود ۱۰ دقیقه برای هر اتصال).");
  };

  const sendBlock = () => {
    const r = runtime.current;
    if (!r.session || !r.micContext || !r.pendingSamples) return;
    const block = new Float32Array(r.pendingSamples);
    let offset = 0;
    for (const chunk of r.pending) { block.set(chunk, offset); offset += chunk.length; }
    r.pending = [];
    r.pendingSamples = 0;
    const level = rms(block);
    setVolume(Math.min(100, Math.round(level * 500)));
    if (level > SPEECH_RMS) { r.lastSpeechAt = Date.now(); r.awaitingReply = true; }
    r.session.sendRealtimeInput({
      audio: { data: micToLiveInput(block, r.micContext.sampleRate, r.telephone), mimeType: "audio/pcm;rate=16000" },
    });
  };

  async function start() {
    if (phase === "connecting" || phase === "live") return;
    const r = runtime.current;
    const epoch = ++r.epoch;
    r.telephone = telephone;
    setError("");
    setLines([]);
    setLatencies([]);
    setPhase("connecting");
    setDetail("در حال گرفتن مجوز کوتاه‌مدت از سرور برنامه …");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
        },
      });
      r.stream = stream;
      const response = await api(`/api/v1/agents/${agentId}/live-session`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      const grant = payload as Grant;
      r.grant = grant;
      if (r.epoch !== epoch) return;

      r.playContext = new AudioContext();
      r.micContext = new AudioContext();
      await r.micContext.audioWorklet.addModule(CAPTURE_WORKLET_URL);

      setDetail(`در حال اتصال به ${grant.model} …`);
      // Ephemeral tokens are served on v1beta.
      const ai = new GoogleGenAI({ apiKey: grant.token, httpOptions: { apiVersion: "v1beta" } });
      const session = await ai.live.connect({
        model: grant.model,
        config: grant.config,
        callbacks: {
          onmessage: message => onMessage(message, epoch),
          onerror: event => {
            if (r.epoch !== epoch) return;
            setError(`خطای اتصال Gemini Live: ${(event as ErrorEvent).message || "نامشخص"}`);
          },
          onclose: event => {
            if (r.epoch !== epoch) return;
            const reason = (event as CloseEvent).reason;
            setPhase(current => current === "error" ? current : "closed");
            setDetail(reason ? `اتصال بسته شد: ${reason}` : "اتصال بسته شد.");
            void teardown();
          },
        },
      });
      if (r.epoch !== epoch) { session.close(); return; }
      r.session = session;

      const source = r.micContext.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(r.micContext, "live-capture");
      const blockSamples = Math.round((r.micContext.sampleRate * SEND_BLOCK_MS) / 1000);
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
        r.pending.push(event.data);
        r.pendingSamples += event.data.length;
        if (r.pendingSamples >= blockSamples) sendBlock();
      };
      source.connect(capture);
      setPhase("live");
      setDetail("تماس برقرار است؛ صحبت کنید. می‌توانید وسط حرف منشی صحبت کنید. هدفون پیشنهاد می‌شود.");
      // The receptionist answers the phone first, as on a real call.
      session.sendRealtimeInput({ text: "[تماس تلفنی تازه وصل شد. با خوشامدگویی کوتاه شروع کن.]" });
    } catch (err) {
      if (r.epoch !== epoch) return;
      setPhase("error");
      setError(err instanceof Error ? err.message : "اتصال به Gemini Live ممکن نشد.");
      await teardown();
    }
  }

  async function teardown() {
    const r = runtime.current;
    stopPlayback();
    r.stream?.getTracks().forEach(track => track.stop());
    r.stream = null;
    r.pending = [];
    r.pendingSamples = 0;
    const contexts = [r.micContext, r.playContext];
    r.micContext = null;
    r.playContext = null;
    r.session = null;
    await Promise.all(contexts.map(ctx => ctx?.close().catch(() => undefined)));
  }

  async function stop() {
    const r = runtime.current;
    r.epoch++;
    const session = r.session;
    r.session = null;
    try { session?.close(); } catch { /* already closed */ }
    await teardown();
    setPhase(current => current === "idle" ? current : "closed");
    setDetail("تماس پایان یافت.");
  }

  function sendTyped() {
    const r = runtime.current;
    const text = typed.trim();
    if (!r.session || !text) return;
    appendLine("caller", `⌨ ${text}`);
    r.lastSpeechAt = Date.now();
    r.awaitingReply = true;
    r.session.sendRealtimeInput({ text });
    setTyped("");
  }

  const averageLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  return (
    <section className="space-y-4 rounded-xl border border-violet-200 bg-white p-5" aria-label="گفتگوی هم‌زمان Gemini Live">
      <h2 className="font-semibold">گفتگوی هم‌زمان با Gemini Live (آزمایشی)</h2>
      <p className="text-sm text-slate-600">
        یک مدل هم می‌شنود، هم تصمیم می‌گیرد و هم حرف می‌زند؛ تبدیل گفتار به متن و ساخت صدا جدا انجام نمی‌شود.
        ثبت نوبت و سرنخ همچنان با ابزارهای خود برنامه روی دیتابیس آزمایشی انجام می‌شود. تماس تلفنی واقعی برقرار نمی‌شود.
      </p>
      <div role="status" className="rounded-lg bg-slate-50 p-2 text-sm">
        {!readiness ? "در حال بررسی آمادگی Gemini Live …" :
          readiness.ready ? "Gemini Live آماده است." :
          <span className="text-red-700">آماده نیست: {readiness.reasons.join(" | ")}</span>}
      </div>
      <label className="block text-sm">
        <input type="checkbox" checked={telephone} disabled={phase === "connecting" || phase === "live"}
          onChange={e => setTelephone(e.target.checked)} /> شبیه‌سازی کیفیت خط تلفن (۸ کیلوهرتز G.711) در هر دو جهت
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void start()} disabled={!readiness?.ready || phase === "connecting" || phase === "live"}
          className="rounded-lg bg-violet-700 px-4 py-2 font-medium text-white disabled:opacity-50">شروع تماس Gemini Live</button>
        <button type="button" onClick={() => void stop()} disabled={phase !== "live" && phase !== "connecting"}
          className="rounded-lg bg-rose-700 px-4 py-2 text-white disabled:opacity-50">پایان تماس</button>
        <span className="text-sm" aria-label="سطح صدای میکروفون">میکروفون: {phase === "live" ? `${volume}%` : "-"}</span>
      </div>
      {detail && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm" aria-label="وضعیت Gemini Live">{detail}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); sendTyped(); }}>
        <input aria-label="ارسال متن به جای صحبت" value={typed} onChange={e => setTyped(e.target.value)} disabled={phase !== "live"}
          placeholder="یا اینجا بنویسید (برای آزمایش بدون میکروفون)" className="flex-1 rounded-lg border p-2 text-sm" />
        <button type="submit" disabled={phase !== "live" || !typed.trim()} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">ارسال</button>
      </form>
      {averageLatency !== null && (
        <p className="text-sm" aria-label="تأخیر پاسخ Gemini Live">
          تأخیر از پایان صحبت تا شروع پاسخ: آخرین {(latencies[latencies.length - 1] / 1000).toFixed(2)} ثانیه،
          میانگین {(averageLatency / 1000).toFixed(2)} ثانیه ({latencies.length} نوبت)
        </p>
      )}
      {lines.length > 0 && (
        <ol className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm" aria-label="متن مکالمه Gemini Live">
          {lines.map(line => (
            <li key={line.id} className={line.who === "tool" ? "text-xs text-slate-500" : ""}>
              <strong>{line.who === "caller" ? "تماس‌گیرنده: " : line.who === "agent" ? "منشی: " : ""}</strong>{line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
