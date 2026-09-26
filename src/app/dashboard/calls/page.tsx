"use client";

import { useState } from "react";
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

const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "red" | "blue"> = {
  COMPLETED: "green",
  TRANSFERRED: "blue",
  FAILED: "red",
  MISSED: "amber",
  TRANSFER_FAILED: "red",
};

function TransferButton({ call }: { call: Call }) {
  const { apiJson } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!["RINGING", "CONNECTED", "ANSWERED", "IN_PROGRESS"].includes(call.status)) return null;
  return (
    <div className="mt-3">
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(null);
          apiJson<{ status: string; message: string }>(`/api/v1/calls/${call.id}/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "manual transfer from dashboard" }),
          })
            .then((r) => setMessage(r.message))
            .catch((err: Error) => setMessage(err.message))
            .finally(() => setBusy(false));
        }}
        className="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50"
      >
        {busy ? "در حال انتقال…" : "انتقال به انسان"}
      </button>
      {message ? <p className="mt-2 text-xs text-slate-600">{message}</p> : null}
    </div>
  );
}

export default function CallsPage() {
  return (
    <div>
      <PageHeader title="تماس‌ها" desc="تاریخچه تماس‌ها، متن گفت‌وگو و خلاصه" />
      <ResourceTable<Call>
        endpoint="/api/v1/calls"
        searchKey="phone"
        searchPlaceholder="جست‌وجوی شماره تماس"
        filters={[
          {
            key: "status",
            label: "وضعیت",
            options: ["RINGING", "IN_PROGRESS", "COMPLETED", "MISSED", "FAILED", "TRANSFERRED", "TRANSFER_FAILED"].map((s) => ({
              value: s,
              label: s,
            })),
          },
        ]}
        columns={[
          { key: "phoneNumber", label: "شماره", render: (r) => <span dir="ltr">{r.phoneNumber}</span> },
          { key: "status", label: "وضعیت", render: (r) => <Badge tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Badge> },
          { key: "durationSeconds", label: "مدت (ثانیه)", render: (r) => <span>{r.durationSeconds ?? "—"}</span> },
          { key: "createdAt", label: "زمان", render: (r) => <span>{formatDateTime(r.createdAt)}</span> },
        ]}
        renderDetail={(row) => (
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium">خلاصه</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{row.summary || "خلاصه‌ای ثبت نشده است."}</p>
            </div>
            <div>
              <p className="font-medium">متن گفت‌وگو</p>
              <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-slate-700 ring-1 ring-slate-200">
                {row.transcript || "متنی ثبت نشده است."}
              </p>
            </div>
            {row.recordingUrl ? (
              <p className="text-xs">
                فایل ضبط:{" "}
                <a href={row.recordingUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline" dir="ltr">
                  {row.recordingUrl}
                </a>
              </p>
            ) : null}
            <TransferButton call={row} />
          </div>
        )}
        emptyLabel="تماسی ثبت نشده است."
      />
    </div>
  );
}
