"use client";

import { useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type Lead = {
  id: string;
  status: string;
  type: string;
  source: string;
  location: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  bedrooms: number | null;
  notes: string | null;
  createdAt: string;
};

const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "VISIT_REQUESTED", "VISIT_SCHEDULED", "NEGOTIATION", "WON", "LOST"];

function LeadDetail({ lead, refresh }: { lead: Lead; refresh: () => void }) {
  const { apiJson } = useAuth();
  const [status, setStatus] = useState(lead.status);
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState<Array<{ id: string; note: string; createdAt: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadNotes = () => {
    apiJson<Array<{ id: string; note: string; createdAt: string }>>(`/api/v1/leads/${lead.id}/notes`)
      .then(setNotes)
      .catch((err: Error) => setMessage(err.message));
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-3">
        <p>نوع: <Badge>{lead.type}</Badge></p>
        <p>منبع: <span className="text-slate-600">{lead.source}</span></p>
        <p>منطقه: <span className="text-slate-600">{lead.location ?? "—"}</span></p>
        <p>بودجه: <span className="text-slate-600" dir="ltr">{lead.budgetMin ?? "?"} – {lead.budgetMax ?? "?"}</span></p>
        <p>خواب: <span className="text-slate-600">{lead.bedrooms ?? "—"}</span></p>
        <p>ثبت: <span className="text-slate-600">{formatDateTime(lead.createdAt)}</span></p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            apiJson(`/api/v1/leads/${lead.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status }),
            })
              .then(() => {
                setMessage("وضعیت به‌روزرسانی شد.");
                refresh();
              })
              .catch((err: Error) => setMessage(err.message))
              .finally(() => setBusy(false));
          }}
          className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          ذخیره وضعیت
        </button>
        <button onClick={loadNotes} className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs hover:bg-white">
          مشاهده یادداشت‌ها
        </button>
      </div>
      {notes ? (
        <ul className="space-y-1">
          {notes.length === 0 ? <li className="text-slate-500">یادداشتی ثبت نشده است.</li> : notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
              <p>{n.note}</p>
              <p className="mt-1 text-xs text-slate-500">{formatDateTime(n.createdAt)}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          setBusy(true);
          apiJson(`/api/v1/leads/${lead.id}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note: note.trim() }),
          })
            .then(() => {
              setNote("");
              setMessage("یادداشت ثبت شد.");
              loadNotes();
            })
            .catch((err: Error) => setMessage(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="یادداشت جدید…"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          ثبت
        </button>
      </form>
      {message ? <p className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
}

export default function LeadsPage() {
  return (
    <div>
      <PageHeader title="سرنخ‌ها" desc="سرنخ‌های فروش ثبت‌شده از تماس‌ها و ثبت دستی" />
      <ResourceTable<Lead>
        endpoint="/api/v1/leads"
        filters={[
          { key: "status", label: "وضعیت", options: LEAD_STATUSES.map((s) => ({ value: s, label: s })) },
          { key: "type", label: "نوع", options: ["BUY", "RENT", "SELL", "OTHER"].map((s) => ({ value: s, label: s })) },
        ]}
        columns={[
          { key: "status", label: "وضعیت", render: (r) => <Badge tone={r.status === "LOST" ? "red" : r.status === "WON" ? "green" : "blue"}>{r.status}</Badge> },
          { key: "type", label: "نوع", render: (r) => <span>{r.type}</span> },
          { key: "location", label: "منطقه", render: (r) => <span>{r.location ?? "—"}</span> },
          { key: "createdAt", label: "ثبت", render: (r) => <span>{formatDateTime(r.createdAt)}</span> },
        ]}
        renderDetail={(row, refresh) => <LeadDetail lead={row} refresh={refresh} />}
        emptyLabel="سرنخی ثبت نشده است."
      />
    </div>
  );
}
