import { describe, expect, it } from "vitest";
import { isDegenerateTranscript } from "@/lib/voice/transcript-quality";

describe("isDegenerateTranscript", () => {
  it("rejects the recognizer loops captured in the live lab", () => {
    // Verbatim shapes from a lab session where the microphone picked up non-speech audio.
    expect(isDegenerateTranscript(Array(45).fill("اینجای").join(" ") + " اینجا")).toBe(true);
    expect(isDegenerateTranscript(Array(4).fill("از اینجاید").join(" ") + " " + Array(32).fill("اینجاید").join(" "))).toBe(true);
    expect(isDegenerateTranscript(Array(12).fill("ممنون از تماشای شما").join(" "))).toBe(true);
    expect(isDegenerateTranscript(Array(10).fill("خیلی خوب").join("، "))).toBe(true);
  });

  it("keeps what callers really say, including the noisy but usable lab transcripts", () => {
    for (const text of [
      "برای فرده ساعته یاز ذه یک نوبد میخوا.",
      "سجادی شما ره تماسم 915 319 721 317",
      "برای امروز ساعت ده یک نوبت می‌خواهم",
      "نه نه نه",
      "بله بله بله بله",
      "الو الو الو صدای من را دارید",
      "شماره من صفر نه یک دو صفر نه یک دو سه چهار پنج است",
      "0912 111 22 33",
      "یک آپارتمان دو خوابه در سعادت‌آباد می‌خواهم که پارکینگ و انباری و آسانسور داشته باشد",
      "",
    ]) {
      expect(isDegenerateTranscript(text), text).toBe(false);
    }
    expect(isDegenerateTranscript(null)).toBe(false);
    expect(isDegenerateTranscript(undefined)).toBe(false);
  });

  it("does not treat a repeated digit group in a phone number as a loop", () => {
    expect(isDegenerateTranscript("صفر نهصد و دوازده صد و یازده صد و یازده صد و یازده")).toBe(false);
    expect(isDegenerateTranscript("09 11 11 11 11 1")).toBe(false);
  });
});
