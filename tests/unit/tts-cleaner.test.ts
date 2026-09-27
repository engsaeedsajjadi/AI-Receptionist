import { describe, expect, it } from "vitest";
import { toSpokenPersian } from "@/lib/voice/cleaner";

describe("toSpokenPersian", () => {
  it("keeps plain Persian untouched", () => {
    const reply = "سلام! چطور می‌تونم کمکتون کنم؟";
    expect(toSpokenPersian(reply)).toBe(reply);
  });

  it("strips markdown formatting", () => {
    expect(toSpokenPersian("**ملک** *دوخوابه* در #سعادت‌آباد")).toBe("ملک دوخوابه در #سعادت‌آباد");
    expect(toSpokenPersian("## عنوان\n- مورد اول\n- مورد دوم")).toBe("عنوان مورد اول مورد دوم");
    expect(toSpokenPersian("> نقل‌قول\n\nمتن اصلی")).toBe("نقل‌قول متن اصلی");
  });

  it("removes code blocks and inline code (incl. tool JSON dumps)", () => {
    const reply = 'نتیجه:\n```json\n{"status": "SUCCESS"}\n```\nتمام شد.';
    expect(toSpokenPersian(reply)).toBe("نتیجه: تمام شد.");
    expect(toSpokenPersian("کد پیگیری `ABC-123` ثبت شد")).toBe("کد پیگیری ثبت شد");
  });

  it("unwraps links and drops bare URLs/emails", () => {
    expect(toSpokenPersian("به [سایت ما](https://example.com) مراجعه کنید")).toBe("به سایت ما مراجعه کنید");
    expect(toSpokenPersian("لینک https://example.com/x و ایمیل a@b.com حذف شود")).toBe("لینک و ایمیل حذف شود");
  });

  it("truncates long replies at a sentence boundary", () => {
    const reply = `${"جمله اول. "} ${"جمله دوم که خیلی طولانی است و باید بریده شود. ".repeat(20)}`;
    const out = toSpokenPersian(reply, 60);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith(".")).toBe(true);
  });

  it("returns empty for unspeakable input", () => {
    expect(toSpokenPersian("")).toBe("");
    expect(toSpokenPersian("```json\n{}\n```")).toBe("");
  });
});
