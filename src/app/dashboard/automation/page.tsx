"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
type Job = { id: string; event: string; status: string; attempts: number; availableAt: string };
export default function AutomationPage() {
  const { apiJson } = useAuth(); const [jobs, setJobs] = useState<Job[]>([]); const [message, setMessage] = useState("");
  useEffect(() => { apiJson<{ jobs: Job[] }>("/api/v1/automation/jobs").then((data) => setJobs(data.jobs)).catch((e: Error) => setMessage(e.message)); }, [apiJson]);
  return <div><h1 className="mb-4 text-2xl font-bold">صف اتوماسیون</h1><p role="status">{message}</p><div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-right"><thead><tr>{["رویداد", "وضعیت", "تلاش", "اجرای بعدی", "عملیات"].map((t) => <th key={t} className="p-3">{t}</th>)}</tr></thead><tbody>{jobs.map((job) => <tr key={job.id} className="border-t"><td className="p-3">{job.event}</td><td>{job.status}</td><td>{job.attempts}</td><td>{new Date(job.availableAt).toLocaleString("fa-IR")}</td><td>{job.status === "dead" && <button className="rounded border p-2" onClick={() => void apiJson("/api/v1/automation/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: job.id }) }).then(() => { setJobs(jobs.map((j) => j.id === job.id ? { ...j, status: "pending", attempts: 0 } : j)); }).catch((e: Error) => setMessage(e.message))}>تلاش مجدد</button>}</td></tr>)}</tbody></table>{jobs.length === 0 && <p className="p-4">رویدادی در صف نیست.</p>}</div></div>;
}
