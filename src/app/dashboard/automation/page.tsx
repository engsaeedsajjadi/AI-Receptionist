"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { PageHeader, formatDateTime } from "@/components/dashboard/ui";

type Job = { id: string; event: string; status: string; attempts: number; availableAt: string };
type Scheduled = {
  id: string;
  status: string;
  availableAt: string;
  payload: { title?: string; message?: string; channel?: string; recipient?: string | null };
};

export default function AutomationPage() {
  const { apiJson } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    scheduledAt: "",
    channel: "internal",
    recipient: "",
    title: "",
    message: "",
  });

  const refresh = useCallback(async () => {
    const [queue, notifications] = await Promise.all([
      apiJson<{ jobs: Job[] }>("/api/v1/automation/jobs"),
      apiJson<{ scheduled: Scheduled[] }>("/api/v1/notifications/schedule"),
    ]);
    setJobs(queue.jobs);
    setScheduled(notifications.scheduled);
  }, [apiJson]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiJson<{ jobs: Job[] }>("/api/v1/automation/jobs"),
      apiJson<{ scheduled: Scheduled[] }>("/api/v1/notifications/schedule"),
    ])
      .then(([queue, notifications]) => {
        if (cancelled) return;
        setJobs(queue.jobs);
        setScheduled(notifications.scheduled);
      })
      .catch((err: Error) => {
        if (!cancelled) setMessage(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  return (
    <div>
      <PageHeader title="اتوماسیون و اعلان‌ها" desc="صف durable، dead-letter و زمان‌بندی اعلان tenant" />
      {message ? <p role="status" className="mb-3 text-sm text-slate-600">{message}</p> : null}

      <form className="mb-5 grid gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200 md:grid-cols-2" onSubmit={(event) => {
        event.preventDefault();
        const date = new Date(form.scheduledAt);
        if (Number.isNaN(date.getTime())) {
          setMessage("زمان معتبر انتخاب کنید.");
          return;
        }
        apiJson("/api/v1/notifications/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scheduledAt: date.toISOString(),
            channel: form.channel,
            recipient: form.channel === "internal" ? undefined : form.recipient,
            title: form.title,
            message: form.message,
          }),
        }).then(() => {
          setMessage("اعلان در outbox تراکنشی زمان‌بندی شد.");
          setForm({ scheduledAt: "", channel: "internal", recipient: "", title: "", message: "" });
          return refresh();
        }).catch((err: Error) => setMessage(err.message));
      }}>
        <h2 className="md:col-span-2 font-semibold">زمان‌بندی اعلان</h2>
        <label className="text-sm">زمان ارسال
          <input type="datetime-local" required value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="text-sm">کانال
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className="mt-1 w-full rounded border p-2">
            <option value="internal">داخلی</option><option value="email">ایمیل</option><option value="sms">SMS</option><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option>
          </select>
        </label>
        {form.channel !== "internal" ? <label className="text-sm md:col-span-2">گیرنده
          <input required dir="ltr" value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} className="mt-1 w-full rounded border p-2" />
        </label> : null}
        <label className="text-sm md:col-span-2">عنوان
          <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="text-sm md:col-span-2">پیام
          <textarea required rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className="mt-1 w-full rounded border p-2" />
        </label>
        <button className="w-fit rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white">زمان‌بندی</button>
      </form>

      <section className="mb-5 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <h2 className="font-semibold">اعلان‌های زمان‌بندی‌شده</h2>
        {scheduled.length === 0 ? <p className="mt-3 text-sm text-slate-500">اعلان آینده‌ای وجود ندارد.</p> : (
          <div className="mt-3 overflow-x-auto"><table className="w-full text-right text-sm"><thead><tr><th className="p-2">زمان</th><th className="p-2">کانال</th><th className="p-2">عنوان</th><th className="p-2">وضعیت</th></tr></thead>
            <tbody>{scheduled.map((item) => <tr key={item.id} className="border-t"><td className="p-2">{formatDateTime(item.availableAt)}</td><td className="p-2" dir="ltr">{item.payload.channel ?? "internal"}</td><td className="p-2">{item.payload.title ?? "—"}</td><td className="p-2">{item.status}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>

      <section className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <h2 className="font-semibold">صف n8n / Automation</h2>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-right text-sm"><thead><tr>{["رویداد","وضعیت","تلاش","اجرای بعدی","عملیات"].map((title) => <th key={title} className="p-3">{title}</th>)}</tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id} className="border-t"><td className="p-3">{job.event}</td><td>{job.status}</td><td>{job.attempts}</td><td>{formatDateTime(job.availableAt)}</td><td>{job.status === "dead" ? <button className="rounded border p-2" onClick={() => void apiJson("/api/v1/automation/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: job.id }) }).then(refresh).catch((err: Error) => setMessage(err.message))}>تلاش مجدد</button> : null}</td></tr>)}</tbody>
        </table>{jobs.length === 0 ? <p className="p-4 text-sm text-slate-500">رویدادی در صف نیست.</p> : null}</div>
      </section>
    </div>
  );
}
