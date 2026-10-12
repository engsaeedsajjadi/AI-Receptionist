"use client";

/**
 * Renders the actual voice pipeline timings returned by runVoiceTurn.
 * "agent" includes tools/retrieval/LLM, so it is not mislabeled as pure LLM.
 */
export type VoiceLatencyMs = {
  total: number;
  stt?: number;
  agent?: number;
  tts?: number;
  store?: number;
};

export function voiceLatencyStages(value: VoiceLatencyMs) {
  const stage = [
    { key: "stt", label: "تشخیص گفتار (STT)", durationMs: value.stt },
    { key: "agent", label: "منشی و ابزارها (Agent)", durationMs: value.agent },
    { key: "tts", label: "تولید صدا (TTS)", durationMs: value.tts },
    { key: "store", label: "ذخیره صدا", durationMs: value.store },
  ].filter((item): item is { key: string; label: string; durationMs: number } =>
    typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0);
  const total = Number.isFinite(value.total) ? Math.max(0, value.total) : 0;
  return { stages: stage, total, longest: stage.length ?
    stage.reduce((a, b) => a.durationMs >= b.durationMs ? a : b) : null };
}

export function VoiceLatencyBreakdown({
  latencyMs, spokenText, playbackSeconds,
}: {
  latencyMs: VoiceLatencyMs;
  spokenText?: string;
  playbackSeconds?: number | null;
}) {
  const timing = voiceLatencyStages(latencyMs);
  const seconds = (ms: number) => (ms / 1000).toFixed(2);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2 text-sm" aria-label="جزئیات زمان پردازش صدا">
      <p className="font-semibold">تا آماده‌شدن پاسخ: {seconds(timing.total)} ثانیه</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {timing.stages.map(step => (
          <div key={step.key} className="rounded-md bg-white p-2">
            <div className="text-xs text-slate-600">{step.label}</div>
            <div className="font-medium">{seconds(step.durationMs)} ثانیه</div>
            {timing.longest?.key === step.key && <span className="text-xs text-amber-700">کندترین مرحله</span>}
          </div>
        ))}
      </div>
      {spokenText && <p className="text-xs"><strong>متن تبدیل‌شده به صدا:</strong> {spokenText}</p>}
      {typeof playbackSeconds === "number" && Number.isFinite(playbackSeconds) &&
        <p className="text-xs text-slate-600">مدت پخش صوت: {playbackSeconds.toFixed(2)} ثانیه (علاوه بر زمان آماده‌سازی)</p>}
      <p className="text-xs text-slate-500">زمان Agent شامل مدل، ابزارها و جستجو است. زمان کل ممکن است شامل سربارهای دیگر نیز باشد.</p>
    </div>
  );
}
