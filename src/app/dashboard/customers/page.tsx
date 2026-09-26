"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type Customer = { id: string; name: string; phone: string; email: string | null; createdAt: string };

type History = {
  leads: Array<{ id: string; status: string; type: string; createdAt: string }>;
  calls: Array<{ id: string; status: string; createdAt: string }>;
  appointments: Array<{ id: string; status: string; scheduledAt: string | null }>;
};

function CustomerDetail({ customer }: { customer: Customer }) {
  const { apiJson } = useAuth();
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<History>(`/api/v1/customers/${customer.id}/history`)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson, customer.id]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!history) return <p className="text-sm text-slate-500">در حال بارگذاری سوابق…</p>;
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-3">
      <div>
        <p className="font-medium">سرنخ‌ها ({history.leads.length})</p>
        <ul className="mt-1 space-y-1">
          {history.leads.map((l) => (
            <li key={l.id} className="rounded-lg bg-white p-2 text-xs ring-1 ring-slate-200">
              {l.type} — {l.status} — {formatDateTime(l.createdAt)}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium">تماس‌ها ({history.calls.length})</p>
        <ul className="mt-1 space-y-1">
          {history.calls.map((c) => (
            <li key={c.id} className="rounded-lg bg-white p-2 text-xs ring-1 ring-slate-200">
              {c.status} — {formatDateTime(c.createdAt)}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium">نوبت‌ها ({history.appointments.length})</p>
        <ul className="mt-1 space-y-1">
          {history.appointments.map((a) => (
            <li key={a.id} className="rounded-lg bg-white p-2 text-xs ring-1 ring-slate-200">
              {a.status} — {formatDateTime(a.scheduledAt)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function CustomersPage() {
  return (
    <div>
      <PageHeader title="مشتریان" desc="مشتریان یکتا بر اساس شماره تماس" />
      <ResourceTable<Customer>
        endpoint="/api/v1/customers"
        searchKey="q"
        searchPlaceholder="جست‌وجوی نام یا شماره"
        columns={[
          { key: "name", label: "نام", render: (r) => <span>{r.name || "—"}</span> },
          { key: "phone", label: "شماره", render: (r) => <span dir="ltr">{r.phone}</span> },
          { key: "email", label: "ایمیل", render: (r) => <span dir="ltr">{r.email ?? "—"}</span> },
          { key: "createdAt", label: "ثبت", render: (r) => <span>{formatDateTime(r.createdAt)}</span> },
        ]}
        renderDetail={(row) => <CustomerDetail customer={row} />}
        emptyLabel="مشتری‌ای ثبت نشده است."
      />
    </div>
  );
}
