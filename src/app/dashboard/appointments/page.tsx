"use client";

import { useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type Appointment = {
  id: string;
  status: string;
  scheduledAt: string | null;
  durationMinutes: number;
  notes: string | null;
  createdAt: string;
};

type Availability = { date: string; timezone: string; slots: Array<{ start: string; end: string; available: boolean }> };

function AvailabilityChecker() {
  const { apiJson } = useAuth();
  const [date, setDate] = useState("");
  const [result, setResult] = useState<Availability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-sm font-semibold">بررسی ظرفیت روز</h2>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!date) return;
          setBusy(true);
          setError(null);
          apiJson<Availability>(`/api/v1/appointments?date=${date}`)
            .then(setResult)
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "…" : "بررسی"}
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      {result ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.slots.length === 0 ? (
            <p className="text-sm text-slate-500">در این روز ظرفیتی وجود ندارد.</p>
          ) : (
            result.slots.map((s) => (
              <span key={s.start} className={`rounded-full px-2.5 py-1 text-xs ${s.available ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-400 line-through"}`}>
                {new Date(s.start).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function AppointmentsPage() {
  const { apiJson } = useAuth();
  const [cancelling, setCancelling] = useState<string | null>(null);

  return (
    <div>
      <PageHeader title="نوبت‌ها" desc="نوبت‌های بازدید و ظرفیت روزانه" />
      <AvailabilityChecker />
      <ResourceTable<Appointment>
        endpoint="/api/v1/appointments"
        filters={[
          {
            key: "status",
            label: "وضعیت",
            options: ["REQUESTED", "SCHEDULED", "CANCELLED", "COMPLETED"].map((s) => ({ value: s, label: s })),
          },
        ]}
        columns={[
          { key: "scheduledAt", label: "زمان نوبت", render: (r) => <span>{formatDateTime(r.scheduledAt)}</span> },
          { key: "durationMinutes", label: "مدت (دقیقه)", render: (r) => <span>{r.durationMinutes}</span> },
          { key: "status", label: "وضعیت", render: (r) => <Badge tone={r.status === "SCHEDULED" ? "green" : r.status === "CANCELLED" ? "red" : "slate"}>{r.status}</Badge> },
        ]}
        rowActions={(row, refresh) =>
          row.status === "SCHEDULED" || row.status === "REQUESTED" ? (
            <button
              disabled={cancelling === row.id}
              onClick={() => {
                setCancelling(row.id);
                apiJson(`/api/v1/appointments/${row.id}`, { method: "DELETE" })
                  .then(() => refresh())
                  .catch(() => setCancelling(null))
                  .finally(() => setCancelling(null));
              }}
              className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {cancelling === row.id ? "…" : "لغو"}
            </button>
          ) : null
        }
        renderDetail={(row) => (
          <p className="text-sm text-slate-700">یادداشت: {row.notes || "—"}</p>
        )}
        emptyLabel="نوبتی ثبت نشده است."
      />
    </div>
  );
}
