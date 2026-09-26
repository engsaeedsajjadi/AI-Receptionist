"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Card, ErrorState, LoadingState, PageHeader, ResourceTable, formatDateTime } from "@/components/dashboard/ui";

type UsageRow = {
  id: string;
  type: string;
  quantity: string;
  unit: string;
  provider: string | null;
  estimatedCost: string | null;
  createdAt: string;
};

export default function UsagePage() {
  const { apiJson } = useAuth();
  const [totals, setTotals] = useState<{ totals: Array<{ type: string; total: string }>; estimatedCostUsd: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<{ totals: Array<{ type: string; total: string }>; estimatedCostUsd: string }>("/api/v1/usage?limit=1")
      .then((r) => {
        if (!cancelled) setTotals(r);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  return (
    <div>
      <PageHeader title="مصرف" desc="مصرف سرویس‌ها و هزینه تقریبی" />
      {error ? (
        <ErrorState message={error} />
      ) : !totals ? (
        <LoadingState />
      ) : (
        <section className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="هزینه تقریبی (دلار)" value={Number(totals.estimatedCostUsd).toFixed(4)} />
          {totals.totals.slice(0, 7).map((t) => (
            <Card key={t.type} title={t.type} value={t.total} />
          ))}
        </section>
      )}
      <ResourceTable<UsageRow>
        endpoint="/api/v1/usage"
        filters={[
          {
            key: "type",
            label: "نوع",
            options: ["voice_minutes", "stt_minutes", "tts_characters", "llm_input_tokens", "llm_output_tokens", "embedding_tokens", "calls", "storage_bytes", "notifications"].map((s) => ({ value: s, label: s })),
          },
        ]}
        columns={[
          { key: "type", label: "نوع", render: (r) => <span dir="ltr">{r.type}</span> },
          { key: "quantity", label: "مقدار", render: (r) => <span>{r.quantity} {r.unit}</span> },
          { key: "provider", label: "ارائه‌دهنده", render: (r) => <span>{r.provider ?? "—"}</span> },
          { key: "estimatedCost", label: "هزینه ($)", render: (r) => <span>{r.estimatedCost ?? "—"}</span> },
          { key: "createdAt", label: "زمان", render: (r) => <span>{formatDateTime(r.createdAt)}</span> },
        ]}
        emptyLabel="رکورد مصرفی وجود ندارد."
      />
    </div>
  );
}
