const path = require("node:path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "@playwright", "test"));

const base = process.env.VOICE_UI_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3100";

async function main() {
  console.log("=== LOCAL TELEPHONY UI REGRESSION ===");
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  try {
    const context = await browser.newContext();
    let apiCalls = 0;
    let correctAudio = false;
    await context.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      let payload = {};
      if (pathname.endsWith("/auth/refresh")) payload = { accessToken: "browser-test" };
      else if (pathname.endsWith("/auth/me")) payload = {
        user: { id: "test-user", businessId: "test-tenant", name: "Test", role: "ADMIN", email: "tester@example.test" },
        business: { name: "Local Telephone Test" },
      };
      else if (pathname.endsWith("/business/settings")) payload = { settings: { features: { agent: true, voice: true } } };
      else if (pathname.endsWith("/business/branding")) payload = { enabled: false };
      else if (pathname === "/api/v1/agents") payload = [
        { id: "test-agent", name: "Test Agent", isActive: true },
      ];
      else if (pathname.includes("/telephony-local-test")) {
        if (route.request().method() === "GET") {
          payload = { ready: true, reasons: [], providers: { llm: "compatible", stt: "gemini", tts: "gemini" } };
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
          return;
        }
        apiCalls++;
        const buffer = route.request().postDataBuffer();
        const body = buffer ? buffer.toString("latin1") : "";
        correctAudio = /audio\/basic/.test(body) && /telephone\.ulaw/.test(body) && buffer.length > 16000;
        payload = {
          heard: true, transcript: "Voice test input", reply: "Mock AI reply",
          input: { durationSeconds: 2, rms: 0.12, frames20ms: 100 },
          output: { mulawBytes: 800, frames20ms: 5 },
          playbackWavBase64: null,
          latencyMs: { total: 50 },
        };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__micCalls = [];
      const track = {
        label: "Microphone Array", enabled: true, muted: false,
        getSettings() { return { sampleRate: 48000, channelCount: 1 }; }, stop() {},
      };
      const stream = {
        getTracks() { return [track]; },
        getAudioTracks() { return [track]; },
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          async getUserMedia(c) { window.__micCalls.push(c); return stream; },
          async enumerateDevices() {
            return [
              { kind: "audioinput", deviceId: "stereo", label: "Stereo Mix (Realtek)" },
              { kind: "audioinput", deviceId: "real-mic", label: "Microphone Array" },
            ];
          }
        },
      });
      function wav() {
        const rate = 48000, count = rate * 2, buffer = new ArrayBuffer(44 + count * 2);
        const v = new DataView(buffer);
        function str(i, s) { for (let n = 0; n < s.length; n++) v.setUint8(i + n, s.charCodeAt(n)); }
        str(0, "RIFF"); v.setUint32(4, buffer.byteLength - 8, true);
        str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, "data"); v.setUint32(40, count * 2, true);
        for (let i = 0; i < count; i++) {
          const signal = Math.sin(i * 2 * Math.PI * 200 / rate) * 0.2 + Math.sin(i * 2 * Math.PI * 370 / rate) * 0.1;
          v.setInt16(44 + i * 2, Math.round(signal * 32767), true);
        }
        return new Blob([buffer], { type: "audio/wav" });
      }
      class FakeRecorder {
        constructor() { this.state = "inactive"; this.mimeType = "audio/wav"; }
        start() { this.state = "recording"; }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.ondataavailable?.({ data: wav() });
            this.onstop?.();
          });
        }
      }
      Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeRecorder });
      // Local hands-free VAD is driven by a deterministic microphone signal.
      // Actual codec decode/encode and DOM interaction remain browser-native.
      window.__liveSpeech = false;
      const proto = window.AudioContext.prototype;
      proto.createMediaStreamSource = function () {
        return { connect() {}, disconnect() {} };
      };
      proto.createAnalyser = function () {
        return {
          fftSize: 2048,
          connect() {}, disconnect() {},
          getFloatTimeDomainData(samples) {
            const speaking = window.__liveSpeech;
            for (let i = 0; i < samples.length; i++) samples[i] = speaking ? (i % 2 ? 0.14 : -0.14) : 0;
          },
        };
      };
    });

    await page.goto(base + "/dashboard/telephony-lab", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.getByRole("button", { name: "شناسایی میکروفون‌ها" }).click();
    await page.getByLabel(/فقط کدک تلفنی و پخش محلی/).check();
    await page.waitForFunction(() => document.querySelector('select[aria-label="میکروفون تماس آزمایشی"]')?.value === "real-mic");
    await page.getByRole("button", { name: "شروع تماس محلی" }).click();
    await page.getByRole("button", { name: "پایان صحبت" }).click();
    await page.getByText(/نرخ نمونه‌برداری: 8000Hz/).waitFor({ timeout: 20000 });
    const codecText = await page.locator("body").innerText();
    const codecPassed = codecText.includes("G.711") && apiCalls === 0;
    console.log("CODEC_UI=" + (codecPassed ? "PASS" : "FAIL"));
    console.log("PROVIDER_REQUESTS_AFTER_CODEC=" + apiCalls);

    await page.getByLabel(/مکالمه با Gemini روی دیتابیس ایزوله/).check();
    await page.getByText("اتصال منشی آماده است. پس از پایان صحبت، صدا برای AI ارسال می‌شود.").waitFor();
    await page.getByLabel(/تأیید می‌کنم که Gemini/).check();
    await page.getByRole("button", { name: "شروع تماس محلی" }).click();
    await page.getByRole("button", { name: "پایان صحبت" }).click();
    await page.getByText("Voice test input").waitFor({ timeout: 20000 });
    await page.getByText("Mock AI reply").waitFor({ timeout: 20000 });
    const calls = await page.evaluate(() => window.__micCalls);
    const micMatched = calls.some(c => c.audio?.deviceId?.exact === "real-mic");
    const manualPass = codecPassed && apiCalls === 1 && micMatched && correctAudio;
    console.log("G711_FORM_UPLOAD=" + (correctAudio ? "PASS" : "FAIL"));
    console.log("EXACT_MIC_SELECTED=" + micMatched);
    console.log("AI_ROUTE_MOCKED=" + (apiCalls === 1 ? "PASS" : "FAIL"));
    console.log("MANUAL_TELEPHONY_BROWSER_RESULT=" + (manualPass ? "PASS" : "FAIL"));
    await page.getByLabel(/گفتگوی زنده بدون فشردن دکمه پایان صحبت/).check();
    await page.getByRole("button", { name: "شروع گفتگوی زنده" }).click();
    await page.getByText(/وضعیت: در حال گوش دادن/).waitFor({ timeout: 12000 });
    await page.evaluate(() => { window.__liveSpeech = true; });
    await page.waitForTimeout(850);
    await page.evaluate(() => { window.__liveSpeech = false; });
    const log = page.getByLabel("تاریخچه گفتگوی زنده");
    await log.getByText(/Voice test input/).waitFor({ timeout: 20000 });
    await log.getByText(/Mock AI reply/).waitFor({ timeout: 20000 });
    const livePassed = apiCalls === 2;
    console.log("AUTO_VAD_UTTERANCE=" + (livePassed ? "PASS" : "FAIL"));
    console.log("NO_MANUAL_STOP_REQUIRED=PASS");
    await page.getByRole("button", { name: "پایان گفتگوی زنده" }).click();
    await page.getByText(/وضعیت: متوقف/).waitFor();
    const pass = manualPass && livePassed;
    console.log("LOCAL_TELEPHONY_BROWSER_RESULT=" + (pass ? "PASS" : "FAIL"));
    console.log("REAL_TWILIO_CALLS=0");
    console.log("REAL_GEMINI_REQUESTS=0");
    console.log("DATABASE_MODIFIED=NO");
    if (!pass) process.exitCode = 1;
    await context.close();
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.log("LOCAL_TELEPHONY_BROWSER_RESULT=FAILED");
  console.log("ERROR=" + error.message);
  process.exitCode = 1;
});
