"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type Call = {
  id: string;
  phoneNumber: string;
  status: string;
  direction: string;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
  createdAt: string;
};

type LiveCall = {
  call: Call;
  messages: Array<{ id: string; role: string; content: string; timestamp: string; metadata: Record<string, unknown> }>;
  usage: Array<{ id: string; type: string; quantity: string; unit: string; provider: string | null; estimatedCost: string | null; createdAt: string }>;
  retrieval: Array<{ id: string; outcome: string; resultCount: number; usedDocumentIds: string[]; reranker: string | null; retrievalMs: number; createdAt: string }>;
  serverTime: string;
};

const ACTIVE = new Set(["RINGING", "CONNECTED", "IN_PROGRESS", "ANSWERED", "TRANSFER_REQUESTED", "TRANSFERRING"]);
const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "red" | "blue"> = {
  COMPLETED: "green", TRANSFERRED: "blue", FAILED: "red", MISSED: "amber", TRANSFER_FAILED: "red",
  IN_PROGRESS: "blue", CONNECTED: "blue", RINGING: "amber", TRANSFERRING: "amber",
};

function TransferButton({ call }: { call: Call }) {
  const { apiJson } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!ACTIVE.has(call.status)) return null;
  return (
    <div>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(null);
          apiJson<{ message: string }>(`/api/v1/calls/${call.id}/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "manual transfer from live console" }),
          }).then((result) => setMessage(result.message))
            .catch((err: Error) => setMessage(err.message))
            .finally(() => setBusy(false));
        }}
        className="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? "در حال انتقال…" : "انتقال به انسان"}
      </button>
      {message ? <p role="status" className="mt-2 text-xs text-slate-600">{message}</p> : null}
    </div>
  );
}

function LiveCallConsole({ call }: { call: Call }) {
  const { apiJson } = useAuth();
  const [live, setLive] = useState<LiveCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isActive = ACTIVE.has(call.status);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = () => apiJson<LiveCall>(`/api/v1/calls/${call.id}/live`)
      .then((result) => {
        if (!cancelled) {
          setLive(result);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    void load();
    if (isActive) timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [apiJson, call.id, isActive]);

  const current = live?.call ?? call;
  const estimatedCost = live?.usage.reduce((sum, row) => sum + Number(row.estimatedCost ?? 0), 0) ?? 0;
  const llmTokens = live?.usage
    .filter((row) => row.type === "llm_input_tokens" || row.type === "llm_output_tokens")
    .reduce((sum, row) => sum + Number(row.quantity), 0) ?? 0;
  const latestRetrieval = live?.retrieval[0];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3" aria-labelledby={`live-${call.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`live-${call.id}`} className="font-semibold">کنسول تماس {isActive ? "زنده" : "ثبت‌شده"}</h3>
          <p className="text-xs text-slate-500">وضعیت و transcript از server خوانده می‌شود؛ در تماس فعال هر ۲.۵ ثانیه تازه می‌شود.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[current.status] ?? "slate"}>{current.status}</Badge>
          <TransferButton call={current} />
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p> : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2 text-xs"><span className="text-slate-500">مدت</span><p className="font-semibold">{current.durationSeconds ?? 0} ثانیه</p></div>
        <div className="rounded-lg bg-slate-50 p-2 text-xs"><span className="text-slate-500">توکن LLM</span><p className="font-semibold">{llmTokens}</p></div>
        <div className="rounded-lg bg-slate-50 p-2 text-xs"><span className="text-slate-500">هزینه تخمینی</span><p className="font-semibold" dir="ltr">${estimatedCost.toFixed(5)} USD</p></div>
        <div className="rounded-lg bg-slate-50 p-2 text-xs"><span className="text-slate-500">RAG آخرین turn</span><p className="font-semibold">{latestRetrieval ? `${latestRetrieval.usedDocumentIds?.length ?? 0} سند / ${latestRetrieval.retrievalMs}ms` : "—"}</p></div>
      </div>

      <div className="mt-3 max-h-72 space-y-2 overflow-auto rounded-lg bg-slate-50 p-3" aria-live="polite">
        {live?.messages.length ? live.messages.map((message) => (
          <div key={message.id} className="rounded-lg bg-white p-2 text-xs ring-1 ring-slate-200">
            <div className="mb-1 flex justify-between gap-2 text-[11px] text-slate-500">
              <span dir="ltr">{message.role}</span><span>{formatDateTime(message.timestamp)}</span>
            </div>
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        )) : (
          <p className="whitespace-pre-wrap text-sm text-slate-700">{current.transcript || "پیام ساختاریافته‌ای برای این تماس ثبت نشده است."}</p>
        )}
      </div>

      {live?.usage.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium">مصرف providerها ({live.usage.length})</summary>
          <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            {live.usage.slice(0, 12).map((item) => (
              <div key={item.id} className="rounded border p-2">
                <span dir="ltr">{item.type}: {item.quantity} {item.unit}</span>
                {item.provider ? <span className="mr-2 text-slate-500" dir="ltr">[{item.provider}]</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export default function CallsPage() {
  return (
    <div>
      <PageHeader title="تماس‌ها" desc="تاریخچه، transcript، RAG/usage و کنسول زنده تماس" />
      <ResourceTable<Call>
        endpoint="/api/v1/calls"
        searchKey="phone"
        searchPlaceholder="جست‌وجوی شماره تماس"
        filters={[{
          key: "status",
          label: "وضعیت",
          options: ["RINGING", "IN_PROGRESS", "COMPLETED", "MISSED", "FAILED", "TRANSFERRED", "TRANSFER_FAILED"].map((status) => ({ value: status, label: status })),
        }]}
        columns={[
          { key: "phoneNumber", label: "شماره", render: (row) => <span dir="ltr">{row.phoneNumber}</span> },
          { key: "status", label: "وضعیت", render: (row) => <Badge tone={STATUS_TONE[row.status] ?? "slate"}>{row.status}</Badge> },
          { key: "durationSeconds", label: "مدت (ثانیه)", render: (row) => <span>{row.durationSeconds ?? "—"}</span> },
          { key: "summary", label: "خلاصه", render: (row) => <span>{row.summary || "—"}</span> },
          { key: "createdAt", label: "زمان", render: (row) => <span>{formatDateTime(row.createdAt)}</span> },
        ]}
        renderDetail={(row) => (
          <div className="space-y-3 text-sm">
            <LiveCallConsole call={row} />
            <div><p className="font-medium">خلاصه</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{row.summary || "خلاصه‌ای ثبت نشده است."}</p></div>
            {row.recordingUrl ? <p className="text-xs">فایل ضبط: <a href={row.recordingUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline" dir="ltr">پخش/دانلود امن</a></p> : null}
          </div>
        )}
        emptyLabel="تماسی ثبت نشده است."
      />
    </div>
  );
}
