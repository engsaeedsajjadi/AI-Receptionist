"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, EmptyState, LoadingState, PageHeader } from "@/components/dashboard/ui";

type Agent = {
  id: string;
  name: string;
  language: string;
  isActive: boolean;
  systemPrompt: string;
  configuration: Record<string, unknown>;
};

function agentForm(agent?: Agent) {
  const c = agent?.configuration ?? {};
  return { greeting: String(c.greeting ?? ""), tone: String(c.tone ?? ""), businessInfo: String(c.businessInfo ?? ""), systemInstructions: String(c.systemInstructions ?? ""),
    model: String(c.model ?? ""), temperature: Number(c.temperature ?? 0.2), allowedTools: Array.isArray(c.allowedTools) ? c.allowedTools.join(", ") : "*",
    memoryEnabled: c.memoryEnabled === true, retrievalMode: c.retrievalMode === "automatic" ? "automatic" : "tools" };
}

type ChatMsg = { role: "user" | "assistant"; content: string };

export default function AgentPage() {
  const { apiJson } = useAuth();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [form, setForm] = useState(agentForm());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiJson<Agent[]>("/api/v1/agents")
      .then((rows) => {
        if (cancelled) return;
        setAgents(rows);
        const first = rows[0] ?? null;
        setSelected(first);
        if (first) {
          setForm(agentForm(first));
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  if (!agents) return <LoadingState />;
  if (agents.length === 0) return <EmptyState label="منشی هوشمندی پیکربندی نشده است." />;

  return (
    <div>
      <PageHeader title="منشی هوشمند" desc="پیکربندی رفتار منشی و گفت‌وگوی آزمایشی" />
      <div className="mb-4 flex flex-wrap gap-2">
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              setSelected(a);
              setForm(agentForm(a));
              setChat([]);
            }}
            className={`rounded-full px-4 py-1.5 text-sm ${selected?.id === a.id ? "bg-slate-900 text-white" : "bg-white ring-1 ring-slate-200"}`}
          >
            {a.name} {a.isActive ? "" : "(غیرفعال)"}
          </button>
        ))}
      </div>

      {selected ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <form
            className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
            onSubmit={(e) => {
              e.preventDefault();
              setSaving(true);
              setMessage(null);
              apiJson(`/api/v1/agents/${selected.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ configuration: { ...form, model: form.model || null, allowedTools: form.allowedTools.trim() === "*" ? null : form.allowedTools.split(",").map((t) => t.trim()).filter(Boolean) } }),
              })
                .then(() => setMessage("پیکربندی ذخیره شد."))
                .catch((err: Error) => setMessage(err.message))
                .finally(() => setSaving(false));
            }}
          >
            <h2 className="text-sm font-semibold">پیکربندی <Badge>{selected.language}</Badge></h2>
            <label className="block text-sm">مدل (خالی: مدل سرور)<input dir="ltr" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="mt-1 w-full rounded border p-2" /></label>
            <label className="block text-sm">دمای مدل<input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} className="mt-1 w-full rounded border p-2" /></label>
            <label className="block text-sm">ابزارهای مجاز (با ویرگول؛ * همه؛ خالی بدون ابزار)<input dir="ltr" value={form.allowedTools} onChange={(e) => setForm({ ...form, allowedTools: e.target.value })} className="mt-1 w-full rounded border p-2" /></label>
            <label className="block text-sm">بازیابی دانش<select value={form.retrievalMode} onChange={(e) => setForm({ ...form, retrievalMode: e.target.value })} className="m-2 rounded border p-2"><option value="tools">با درخواست ابزار</option><option value="automatic">پیش از هر پاسخ</option></select></label>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.memoryEnabled} onChange={(e) => setForm({ ...form, memoryEnabled: e.target.checked })} />حافظهٔ گفت‌وگو و خلاصهٔ تماس‌های قبلی مشتری</label>
            <p className="text-xs text-slate-500">حافظه فقط در گفت‌وگوی دارای شناسه تماس استفاده می‌شود؛ خلاصه‌سازی مصرف مدل دارد.</p>
            {(
              [
                ["greeting", "جمله خوش‌آمد"],
                ["tone", "لحن پاسخ‌گویی"],
                ["businessInfo", "اطلاعات کسب‌وکار"],
                ["systemInstructions", "دستورات اختصاصی"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block text-sm">
                {label}
                <textarea
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  rows={key === "businessInfo" || key === "systemInstructions" ? 4 : 2}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none"
                />
              </label>
            ))}
            <p className="text-xs text-slate-500">قوانین قطعی سیستم (عدم جعل اطلاعات، صداقت در شکست ابزار) همیشه اعمال می‌شود و با این تنظیمات لغو نمی‌شود.</p>
            {message ? <p className="text-sm text-slate-600">{message}</p> : null}
            <button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </button>
          </form>

          <div className="flex flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-sm font-semibold">گفت‌وگوی آزمایشی</h2>
            <div className="mt-2 min-h-64 flex-1 space-y-2 overflow-auto rounded-lg bg-slate-50 p-3">
              {chat.length === 0 ? (
                <p className="text-sm text-slate-500">پیامی بنویسید تا پاسخ منشی را ببینید. ابزارها واقعاً اجرا می‌شوند.</p>
              ) : (
                chat.map((m, i) => (
                  <div key={i} className={`max-w-[90%] rounded-xl p-2 text-sm ${m.role === "user" ? "bg-slate-900 text-white mr-auto" : "bg-white ring-1 ring-slate-200"}`}>
                    {m.content}
                  </div>
                ))
              )}
            </div>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = input.trim();
                if (!text || chatting) return;
                setInput("");
                setChat((c) => [...c, { role: "user", content: text }]);
                setChatting(true);
                apiJson<{ ok: boolean; reply: string }>(`/api/v1/agent/chat`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message: text, agentId: selected.id }),
                })
                  .then((r) => setChat((c) => [...c, { role: "assistant", content: r.reply }]))
                  .catch((err: Error) => setChat((c) => [...c, { role: "assistant", content: `خطا: ${err.message}` }]))
                  .finally(() => setChatting(false));
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="پیام فارسی…"
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none"
              />
              <button type="submit" disabled={chatting} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {chatting ? "…" : "ارسال"}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
