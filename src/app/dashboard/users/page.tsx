"use client";

import { useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const { apiJson, user } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "AGENT" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setMessage(null);
        apiJson("/api/v1/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        })
          .then(() => {
            setForm({ name: "", email: "", password: "", role: "AGENT" });
            setMessage("کاربر ایجاد شد.");
            onDone();
          })
          .catch((err: Error) => setMessage(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="text-sm font-semibold">کاربر جدید</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="نام" required className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="ایمیل" type="email" required dir="ltr" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <input value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="گذرواژه (حداقل ۸ کاراکتر)" type="password" required dir="ltr" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
          <option value="AGENT">AGENT</option>
          {user?.role === "ADMIN" ? <option value="MANAGER">MANAGER</option> : null}
          {user?.role === "ADMIN" ? <option value="ADMIN">ADMIN</option> : null}
        </select>
        <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "…" : "ایجاد"}
        </button>
      </div>
      {message ? <p className="mt-2 text-sm text-slate-600">{message}</p> : null}
    </form>
  );
}

export default function UsersPage() {
  const { apiJson, user } = useAuth();
  const [tick, setTick] = useState(0);
  const isAdmin = user?.role === "ADMIN";

  return (
    <div>
      <PageHeader title="کاربران" desc="مدیریت کاربران کسب‌وکار و نقش‌ها" />
      <CreateUserForm onDone={() => setTick((t) => t + 1)} />
      <div key={tick}>
        <ResourceTable<User>
          endpoint="/api/v1/users"
          columns={[
            { key: "name", label: "نام" },
            { key: "email", label: "ایمیل", render: (r) => <span dir="ltr">{r.email}</span> },
            { key: "role", label: "نقش", render: (r) => <Badge tone={r.role === "ADMIN" ? "red" : r.role === "MANAGER" ? "amber" : "slate"}>{r.role}</Badge> },
            { key: "isActive", label: "وضعیت", render: (r) => <Badge tone={r.isActive ? "green" : "slate"}>{r.isActive ? "فعال" : "غیرفعال"}</Badge> },
            { key: "lastLoginAt", label: "آخرین ورود", render: (r) => <span>{formatDateTime(r.lastLoginAt)}</span> },
          ]}
          rowActions={isAdmin ? (row, refresh) => (
            <button
              onClick={() => {
                if (!confirm(row.isActive ? "این کاربر غیرفعال شود؟" : "این کاربر فعال شود؟")) return;
                apiJson(`/api/v1/users/${row.id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ isActive: !row.isActive }),
                }).then(() => refresh());
              }}
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs hover:bg-slate-100"
            >
              {row.isActive ? "غیرفعال" : "فعال"}
            </button>
          ) : undefined}
          emptyLabel="کاربری وجود ندارد."
        />
      </div>
    </div>
  );
}
