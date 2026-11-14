import { describe, expect, it } from "vitest";
import { buildSystemPrompt, describeCurrentTime, SYSTEM_GUARDRAILS_FA } from "@/lib/guardrails";

/**
 * The assistant can only resolve "فردا ساعت ۱۰" if it is told what "today" is in
 * the business time zone and which UTC offset tool arguments must carry. These
 * tests pin that clock with fixed instants, including the day boundary where
 * the UTC date and the Tehran date differ.
 */
describe("describeCurrentTime", () => {
  it("reports the Tehran date, not the UTC date, late in the UTC evening", () => {
    // 20:45 UTC on Thursday 12 Nov is already 00:15 on Friday 13 Nov in Tehran.
    const t = describeCurrentTime(new Date("2026-11-12T20:45:00Z"), "Asia/Tehran");
    expect(t).toMatchObject({
      timeZone: "Asia/Tehran", date: "2026-11-13", time: "00:15", offset: "+03:30", weekday: "Fri",
      iso: "2026-11-13T00:15:00+03:30",
    });
    expect(new Date(t.iso).toISOString()).toBe("2026-11-12T20:45:00.000Z");
    expect(t.jalali).toContain("1405");
    expect(t.jalali).toContain("آبان");
    expect(t.jalali).toContain("22");
  });

  it("keeps Tehran at +03:30 all year (no daylight saving since 2022)", () => {
    expect(describeCurrentTime(new Date("2026-07-01T12:00:00Z"), "Asia/Tehran")).toMatchObject({
      date: "2026-07-01", time: "15:30", offset: "+03:30",
    });
    expect(describeCurrentTime(new Date("2027-01-15T12:00:00Z"), "Asia/Tehran")).toMatchObject({
      date: "2027-01-15", time: "15:30", offset: "+03:30",
    });
  });

  it("renders midnight as 00:xx and handles the Jalali new year", () => {
    // Nowruz 1405: 20 March 2026, 20:30 UTC is 00:00 on 1 Farvardin in Tehran.
    const t = describeCurrentTime(new Date("2026-03-20T20:30:00Z"), "Asia/Tehran");
    expect(t).toMatchObject({ date: "2026-03-21", time: "00:00" });
    expect(t.jalali).toContain("1405");
    expect(t.jalali).toContain("فروردین");
  });

  it("follows daylight saving and negative offsets for other tenants", () => {
    expect(describeCurrentTime(new Date("2026-07-01T02:00:00Z"), "America/New_York")).toMatchObject({
      date: "2026-06-30", time: "22:00", offset: "-04:00", weekday: "Tue",
    });
    expect(describeCurrentTime(new Date("2026-12-01T02:00:00Z"), "America/New_York")).toMatchObject({
      date: "2026-11-30", time: "21:00", offset: "-05:00",
    });
    expect(describeCurrentTime(new Date("2026-11-12T20:45:00Z"), "UTC")).toMatchObject({
      date: "2026-11-12", time: "20:45", offset: "+00:00", iso: "2026-11-12T20:45:00+00:00",
    });
  });

  it("falls back to Asia/Tehran for an unknown time zone instead of failing the call", () => {
    const t = describeCurrentTime(new Date("2026-11-12T20:45:00Z"), "Mars/Olympus_Mons");
    expect(t).toMatchObject({ timeZone: "Asia/Tehran", date: "2026-11-13", offset: "+03:30" });
  });
});

describe("buildSystemPrompt clock section", () => {
  const now = new Date("2026-11-12T20:45:00Z");

  it("tells the Persian assistant today's date, weekday, offset and how to pass times to tools", () => {
    const prompt = buildSystemPrompt({
      language: "fa", businessName: "آژانس آرنا", currentTime: { now, timeZone: "Asia/Tehran" },
    });
    expect(prompt.startsWith(SYSTEM_GUARDRAILS_FA)).toBe(true);
    expect(prompt).toContain("تاریخ و ساعت فعلی کسب‌وکار");
    expect(prompt).toContain("جمعه");
    expect(prompt).toContain("2026-11-13");
    expect(prompt).toContain("00:15");
    expect(prompt).toContain("UTC+03:30");
    expect(prompt).toContain("2026-11-13T00:15:00+03:30");
    expect(prompt).toContain("فردا");
    // The UTC calendar date must not be presented as "today".
    expect(prompt).not.toContain("2026-11-12");
  });

  it("uses English wording for English assistants", () => {
    const prompt = buildSystemPrompt({
      language: "en", businessName: "Arena", currentTime: { now, timeZone: "Asia/Tehran" },
    });
    expect(prompt).toContain("Current date and time at the business");
    expect(prompt).toContain("Friday 2026-11-13 00:15");
    expect(prompt).toContain("offset +03:30");
  });

  it("adds nothing when no clock is supplied", () => {
    const prompt = buildSystemPrompt({ language: "fa", businessName: "آژانس آرنا" });
    expect(prompt).not.toContain("تاریخ و ساعت فعلی");
  });
});
