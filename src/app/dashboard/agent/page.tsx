"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, Card, EmptyState, LoadingState, PageHeader, formatDateTime } from "@/components/dashboard/ui";

type IntentReport = {
  window: { days: number; since: string };
  calls: number;
  turns: number;
  withSlots: number;
  total: number;
  unknownRate: number | null;
  clarificationRate: number | null;
  byIntent: Array<{ intent: string; count: number }>;
  unactionableByIntent: Array<{ intent: string; count: number }>;
};

type Agent = {
  id: string;
  name: string;
  language: string;
  voiceProvider: string;
  voiceId: string;
  isActive: boolean;
  systemPrompt: string;
  configuration: Record<string, unknown>;
};

type AgentVersion = {
  id: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
};

type VoiceTestResult = {
  heard: boolean;
  transcript: string;
  reply: string;
  spokenText: string;
  audioBase64: string | null;
  audioMimeType: string | null;
  latencyMs: { total: number; stt?: number; agent?: number; tts?: number; store?: number };
  usage: {
    sttMinutes: number;
    ttsCharacters: number;
    llmInputTokens: number;
    llmOutputTokens: number;
  };
  toolCalls: Array<{ tool: string; status: string }>;
};

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function IntentQualityPanel() {
  const { apiJson } = useAuth();
  const [report, setReport] = useState<IntentReport | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<IntentReport>(`/api/v1/analytics/intent?days=${days}`)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson, days]);

  return (
    <section className="mb-4 rounded-xl bg-white p-4 ring-1 ring-slate-200" aria-labelledby="intent-quality-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="intent-quality-title" className="font-medium">کیفیت درک تماس‌گیرنده</h2>
        <select
          aria-label="بازه گزارش کیفیت"
          value={days}
          onChange={(e) => {
            setError(null);
            setReport(null);
            setDays(Number(e.target.value));
          }}
          className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
        >
          {[7, 30, 90].map((d) => <option key={d} value={d}>{d} روز گذشته</option>)}
        </select>
      </div>
      {error ? <p role="alert" className="text-xs text-rose-700">{error}</p> : null}
      {!report && !error ? <p className="text-xs text-slate-500">در حال بارگذاری…</p> : null}
      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card title="تماس‌های بررسی‌شده" value={report.calls} sub={`${report.turns} نوبت گفت‌وگو`} />
            <Card title="قصد نامشخص" value={pct(report.unknownRate)} sub="نیاز به پرسش روشن‌سازی" />
            <Card title="غیرقابل‌اقدام" value={pct(report.clarificationRate)} sub="نیاز به تأیید پیش از اقدام" />
            <Card title="با اطلاعات کامل" value={pct(report.turns ? report.withSlots / report.turns : null)} sub="اسلات‌های معتبر استخراج شده" />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-slate-600">پرکاربردترین قصدها</p>
              <ul className="space-y-1 text-xs">
                {report.byIntent.slice(0, 6).map((entry) => (
                  <li key={entry.intent} className="flex items-center justify-between gap-2">
                    <span dir="ltr">{entry.intent}</span><span>{entry.count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-slate-600">نیازمند روشن‌سازی</p>
              <ul className="space-y-1 text-xs">
                {report.unactionableByIntent.slice(0, 6).map((entry) => (
                  <li key={entry.intent} className="flex items-center justify-between gap-2">
                    <span dir="ltr">{entry.intent}</span><Badge tone="amber">{entry.count}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function agentForm(agent?: Agent) {
  const c = agent?.configuration ?? {};
  return {
    greeting: String(c.greeting ?? ""),
    tone: String(c.tone ?? ""),
    businessInfo: String(c.businessInfo ?? ""),
    systemInstructions: String(c.systemInstructions ?? ""),
    model: String(c.model ?? ""),
    temperature: Number(c.temperature ?? 0.2),
    allowedTools: Array.isArray(c.allowedTools) ? c.allowedTools.join(", ") : "*",
    memoryEnabled: c.memoryEnabled === true,
    retrievalMode: c.retrievalMode === "automatic" ? "automatic" : "tools",
    voiceId: agent?.voiceId ?? "fa-default",
    language: agent?.language ?? "fa-IR",
  };
}

function apiErrorMessage(payload: unknown, fallback: string) {
  const body = payload as { error?: { message?: string } };
  return body?.error?.message ?? fallback;
}

export default function AgentPage() {
  const { api, apiJson } = useAuth();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [form, setForm] = useState(agentForm());
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [chat, setChat] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceTest, setVoiceTest] = useState<VoiceTestResult | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const loadAgents = useCallback(async () => {
    const rows = await apiJson<Agent[]>("/api/v1/agents");
    setAgents(rows);
    setSelected((current) => {
      const next = rows.find((row) => row.id === current?.id) ?? rows[0] ?? null;
      if (next) setForm(agentForm(next));
      return next;
    });
  }, [apiJson]);

  const loadVersions = useCallback(async (agentId: string) => {
    const result = await apiJson<{ versions: AgentVersion[] }>(`/api/v1/agents/${agentId}/versions`);
    setVersions(result.versions);
  }, [apiJson]);

  useEffect(() => {
    loadAgents().catch(() => setAgents([]));
  }, [loadAgents]);

  useEffect(() => {
    if (!selected) {
      setVersions([]);
      return;
    }
    loadVersions(selected.id).catch(() => setVersions([]));
  }, [selected?.id, loadVersions]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      const configuration = {
        greeting: form.greeting,
        tone: form.tone,
        businessInfo: form.businessInfo,
        systemInstructions: form.systemInstructions,
        model: form.model || null,
        temperature: form.temperature,
        allowedTools: form.allowedTools.trim() === "*"
          ? null
          : form.allowedTools.split(",").map((tool) => tool.trim()).filter(Boolean),
        memoryEnabled: form.memoryEnabled,
        retrievalMode: form.retrievalMode,
      };
      const updated = await apiJson<Agent>(`/api/v1/agents/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: form.voiceId,
          language: form.language,
          configuration,
        }),
      });
      setSelected(updated);
      setAgents((rows) => rows?.map((row) => row.id === updated.id ? updated : row) ?? rows);
      setForm(agentForm(updated));
      await loadVersions(updated.id);
      setMessage("پیکربندی و نسخه جدید ذخیره شد.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ذخیره ناموفق بود.");
    } finally {
      setSaving(false);
    }
  };

  const previewVoice = async () => {
    if (!selected) return;
    setPreviewing(true);
    setVoiceError(null);
    try {
      const res = await api(`/api/v1/agents/${selected.id}/voice-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: form.greeting || "سلام، من منشی هوشمند شما هستم." }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(apiErrorMessage(payload, `Voice preview failed (${res.status})`));
      }
      const url = URL.createObjectURL(await res.blob());
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "پیش‌نمایش صدا ناموفق بود.");
    } finally {
      setPreviewing(false);
    }
  };

  const sendRecordedAudio = async (audio: Blob) => {
    if (!selected) return;
    setVoiceError(null);
    setVoiceTest(null);
    const formData = new FormData();
    formData.set("audio", audio, "voice-test.webm");
    const res = await api(`/api/v1/agents/${selected.id}/voice-test`, { method: "POST", body: formData });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(payload, `Voice test failed (${res.status})`));
    setVoiceTest(payload as VoiceTestResult);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("مرورگر شما ضبط میکروفون را پشتیبانی نمی‌کند.");
      return;
    }
    try {
      setVoiceError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType || "audio/webm";
        const audio = new Blob(chunksRef.current, { type: mime });
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setRecording(false);
        void sendRecordedAudio(audio).catch((err: Error) => setVoiceError(err.message));
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "دسترسی به میکروفون ممکن نیست.");
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  if (!agents) return <LoadingState />;
  if (agents.length === 0) return <EmptyState label="منشی هوشمندی پیکربندی نشده است." />;

  return (
    <div>
      <PageHeader title="منشی هوشمند" desc="پیکربندی رفتار، صدا، دانش و تست زنده منشی" />
      <IntentQualityPanel />

      <div className="mb-4 flex flex-wrap gap-2" aria-label="انتخاب منشی">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => {
              setSelected(agent);
              setForm(agentForm(agent));
              setChat([]);
              setVoiceTest(null);
              setVoiceError(null);
            }}
            className={`rounded-full px-4 py-1.5 text-sm ${selected?.id === agent.id ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}
          >
            {agent.name} {agent.isActive ? "" : "(غیرفعال)"}
          </button>
        ))}
      </div>

      {selected ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <form
              className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h2 className="text-sm font-semibold">پیکربندی <Badge>{form.language}</Badge></h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">شناسه صدا
                  <input dir="ltr" value={form.voiceId} onChange={(e) => setForm({ ...form, voiceId: e.target.value })} className="mt-1 w-full rounded border p-2" />
                </label>
                <label className="block text-sm">زبان
                  <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className="mt-1 w-full rounded border p-2">
                    <option value="fa-IR">فارسی (fa-IR)</option>
                    <option value="en-US">English (en-US)</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-slate-500">Provider صوتی: <span dir="ltr">{selected.voiceProvider}</span>. صداهای clone فقط با رضایت ثبت‌شده قابل استفاده‌اند.</p>

              <label className="block text-sm">مدل (خالی: مدل سرور)
                <input dir="ltr" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="mt-1 w-full rounded border p-2" />
              </label>
              <label className="block text-sm">دمای مدل
                <input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} className="mt-1 w-full rounded border p-2" />
              </label>
              <label className="block text-sm">ابزارهای مجاز (با ویرگول؛ * همه)
                <input dir="ltr" value={form.allowedTools} onChange={(e) => setForm({ ...form, allowedTools: e.target.value })} className="mt-1 w-full rounded border p-2" />
              </label>
              <label className="block text-sm">بازیابی دانش
                <select value={form.retrievalMode} onChange={(e) => setForm({ ...form, retrievalMode: e.target.value })} className="mt-1 w-full rounded border p-2">
                  <option value="tools">با درخواست ابزار</option>
                  <option value="automatic">پیش از هر پاسخ</option>
                </select>
              </label>
              <label className="flex gap-2 text-sm">
                <input type="checkbox" checked={form.memoryEnabled} onChange={(e) => setForm({ ...form, memoryEnabled: e.target.checked })} />
                حافظه گفت‌وگو فعال باشد
              </label>

              {([
                ["greeting", "جمله خوش‌آمد", 2],
                ["tone", "لحن پاسخ‌گویی", 2],
                ["businessInfo", "اطلاعات کسب‌وکار", 4],
                ["systemInstructions", "دستورات اختصاصی", 4],
              ] as const).map(([key, label, rows]) => (
                <label key={key} className="block text-sm">{label}
                  <textarea value={form[key]} onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))} rows={rows} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                </label>
              ))}
              <p className="text-xs text-slate-500">Guardrailهای سیستم با تنظیمات tenant قابل حذف نیستند.</p>
              {message ? <p role="status" className="text-sm text-slate-600">{message}</p> : null}
              <button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? "در حال ذخیره…" : "ذخیره"}
              </button>
            </form>

            <div className="space-y-4">
              <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-labelledby="voice-lab-heading">
                <h2 id="voice-lab-heading" className="font-semibold">آزمایشگاه صوتی</h2>
                <p className="mt-1 text-xs text-slate-500">پیش‌نمایش TTS و تست میکروفون از همان providerها و quotaهای production استفاده می‌کند؛ در نبود credential خطای واقعی نمایش داده می‌شود.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void previewVoice()} disabled={previewing} className="rounded-lg border px-3 py-2 text-sm">
                    {previewing ? "در حال ساخت صدا…" : "پیش‌نمایش صدا"}
                  </button>
                  <button
                    type="button"
                    onClick={recording ? stopRecording : () => void startRecording()}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
                  >
                    {recording ? "پایان ضبط" : "تست زنده میکروفون"}
                  </button>
                </div>
                {previewUrl ? <audio className="mt-3 w-full" controls src={previewUrl} /> : null}
                {voiceError ? <p role="alert" className="mt-2 text-sm text-rose-700">{voiceError}</p> : null}
                {voiceTest ? (
                  <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
                    <p><strong>شنیده شد:</strong> {voiceTest.transcript || "بدون گفتار"}</p>
                    <p><strong>پاسخ:</strong> {voiceTest.reply || "—"}</p>
                    <p className="text-xs text-slate-500">کل latency: {voiceTest.latencyMs.total}ms · STT: {voiceTest.latencyMs.stt ?? 0}ms · Agent: {voiceTest.latencyMs.agent ?? 0}ms · TTS: {voiceTest.latencyMs.tts ?? 0}ms</p>
                    {voiceTest.audioBase64 && voiceTest.audioMimeType ? (
                      <audio className="w-full" controls src={`data:${voiceTest.audioMimeType};base64,${voiceTest.audioBase64}`} />
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="flex min-h-80 flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-labelledby="chat-test-heading">
                <h2 id="chat-test-heading" className="font-semibold">گفت‌وگوی آزمایشی</h2>
                <div className="mt-2 min-h-52 flex-1 space-y-2 overflow-auto rounded-lg bg-slate-50 p-3">
                  {chat.length === 0 ? <p className="text-sm text-slate-500">پیامی بنویسید؛ ابزارها واقعاً اجرا می‌شوند.</p> : chat.map((item, index) => (
                    <div key={index} className={`max-w-[90%] rounded-xl p-2 text-sm ${item.role === "user" ? "mr-auto bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}>
                      {item.content}
                    </div>
                  ))}
                </div>
                <form className="mt-2 flex gap-2" onSubmit={(event) => {
                  event.preventDefault();
                  const text = input.trim();
                  if (!text || chatting) return;
                  setInput("");
                  setChat((current) => [...current, { role: "user", content: text }]);
                  setChatting(true);
                  apiJson<{ reply: string }>("/api/v1/agent/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: text, agentId: selected.id }),
                  }).then((result) => setChat((current) => [...current, { role: "assistant", content: result.reply }]))
                    .catch((err: Error) => setChat((current) => [...current, { role: "assistant", content: `خطا: ${err.message}` }]))
                    .finally(() => setChatting(false));
                }}>
                  <input aria-label="پیام آزمایشی" value={input} onChange={(e) => setInput(e.target.value)} placeholder="پیام فارسی…" className="flex-1 rounded-lg border px-3 py-2 text-sm" />
                  <button disabled={chatting} className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{chatting ? "…" : "ارسال"}</button>
                </form>
              </section>
            </div>
          </div>

          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-labelledby="versions-heading">
            <h2 id="versions-heading" className="font-semibold">تاریخچه نسخه‌ها و بازگردانی</h2>
            <p className="mt-1 text-xs text-slate-500">بازگردانی destructive نیست: ابتدا وضعیت فعلی snapshot می‌شود و نسخه انتخابی به‌عنوان وضعیت جدید منتشر می‌شود.</p>
            {versions.length === 0 ? <p className="mt-3 text-sm text-slate-500">نسخه قبلی ثبت نشده است.</p> : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-right text-sm">
                  <thead><tr className="border-b"><th className="p-2">زمان</th><th className="p-2">نام</th><th className="p-2">صدا</th><th className="p-2">عملیات</th></tr></thead>
                  <tbody>{versions.slice(0, 20).map((version) => (
                    <tr key={version.id} className="border-b border-slate-100">
                      <td className="p-2">{formatDateTime(version.createdAt)}</td>
                      <td className="p-2">{String(version.snapshot.name ?? "—")}</td>
                      <td className="p-2" dir="ltr">{String(version.snapshot.voiceId ?? "—")}</td>
                      <td className="p-2">
                        <button type="button" className="rounded border px-3 py-1 text-xs" onClick={() => {
                          setMessage(null);
                          apiJson<Agent>(`/api/v1/agents/${selected.id}/versions/${version.id}/restore`, { method: "POST" })
                            .then((updated) => {
                              setSelected(updated);
                              setForm(agentForm(updated));
                              setAgents((rows) => rows?.map((row) => row.id === updated.id ? updated : row) ?? rows);
                              setMessage("نسخه انتخابی بازگردانی شد و نسخه جدیدی از وضعیت قبلی ثبت شد.");
                              return loadVersions(updated.id);
                            })
                            .catch((err: Error) => setMessage(err.message));
                        }}>بازگردانی</button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
