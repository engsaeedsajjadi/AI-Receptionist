"use client";

import { useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type Doc = {
  id: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  fileName: string | null;
  errorMessage: string | null;
  createdAt: string;
};

function UploadForm({ onDone }: { onDone: () => void }) {
  const { api } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        setMessage(null);
        const form = new FormData();
        form.append("file", file);
        if (title) form.append("title", title);
        api("/api/v1/knowledge/upload", { method: "POST", body: form })
          .then(async (res) => {
            if (!res.ok) {
              const body = (await res.json()) as { error?: { message?: string } };
              throw new Error(body?.error?.message ?? "Upload failed");
            }
            setFile(null);
            setTitle("");
            setMessage("سند با موفقیت بارگذاری و ایندکس شد.");
            onDone();
          })
          .catch((err: Error) => setMessage(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="text-sm font-semibold">بارگذاری سند (PDF / DOCX / TXT / Markdown)</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="عنوان (اختیاری)"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none"
        />
        <button type="submit" disabled={busy || !file} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "در حال ایندکس…" : "بارگذاری"}
        </button>
      </div>
      {message ? <p className="mt-2 text-sm text-slate-600">{message}</p> : null}
    </form>
  );
}

function SearchBox() {
  const { apiJson } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ documentTitle: string; content: string; score: number; source: string }> | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-sm font-semibold">جست‌وجوی آزمایشی پایگاه دانش</h2>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length < 2) return;
          setBusy(true);
          apiJson<{ chunks: Array<{ documentTitle: string; content: string; score: number; source: string }>; degraded: boolean }>("/api/v1/knowledge/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: query.trim(), topK: 5 }),
          })
            .then((r) => {
              setResults(r.chunks);
              setDegraded(r.degraded);
            })
            .catch(() => setResults([]))
            .finally(() => setBusy(false));
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="سؤال خود را بنویسید…"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "…" : "جست‌وجو"}
        </button>
      </form>
      {results ? (
        <div className="mt-3 space-y-2">
          {degraded ? <p className="text-xs text-amber-700">حالت محدود: جست‌وجوی برداری در دسترس نیست و فقط جست‌وجوی کلیدواژه انجام شد.</p> : null}
          {results.length === 0 ? (
            <p className="text-sm text-slate-500">نتیجه‌ای یافت نشد.</p>
          ) : (
            results.map((r, i) => (
              <div key={i} className="rounded-lg bg-slate-50 p-2 text-sm ring-1 ring-slate-200">
                <p className="font-medium">{r.documentTitle} <span className="text-xs text-slate-500">({r.source} · {r.score.toFixed(2)})</span></p>
                <p className="mt-1 text-slate-700">{r.content.slice(0, 400)}</p>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function KnowledgePage() {
  const { apiJson } = useAuth();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <PageHeader
        title="پایگاه دانش"
        desc="اسناد فارسی، ایندکس برداری و جست‌وجوی ترکیبی"
        actions={
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              apiJson("/api/v1/knowledge/reindex", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
                .then(() => setTick((t) => t + 1))
                .finally(() => setBusy(false));
            }}
            className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? "در حال ایندکس مجدد…" : "ایندکس مجدد همه"}
          </button>
        }
      />
      <UploadForm onDone={() => setTick((t) => t + 1)} />
      <SearchBox />
      <div key={tick}>
        <ResourceTable<Doc>
          endpoint="/api/v1/knowledge"
          columns={[
            { key: "title", label: "عنوان" },
            { key: "sourceType", label: "نوع" },
            { key: "status", label: "وضعیت", render: (r) => <Badge tone={r.status === "indexed" ? "green" : r.status === "failed" ? "red" : "amber"}>{r.status}</Badge> },
            { key: "chunkCount", label: "تکه‌ها", render: (r) => <span>{r.chunkCount}</span> },
            { key: "createdAt", label: "ثبت", render: (r) => <span>{formatDateTime(r.createdAt)}</span> },
          ]}
          rowActions={(row, refresh) => (
            <button
              onClick={() => {
                if (!confirm("این سند حذف شود؟")) return;
                apiJson(`/api/v1/knowledge/${row.id}`, { method: "DELETE" }).then(() => refresh());
              }}
              className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
            >
              حذف
            </button>
          )}
          renderDetail={(row) => (
            <div className="text-sm">
              <p>فایل: <span className="text-slate-600" dir="ltr">{row.fileName ?? "—"}</span></p>
              {row.errorMessage ? <p className="mt-1 text-red-700">خطا: {row.errorMessage}</p> : null}
            </div>
          )}
          emptyLabel="سندی ثبت نشده است."
        />
      </div>
    </div>
  );
}
