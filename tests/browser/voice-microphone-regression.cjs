const path = require("node:path");

const repo = path.resolve(__dirname, "../..");
const { chromium } = require(path.join(repo, "node_modules", "@playwright", "test"));
const base = process.env.VOICE_UI_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3100";

const START_LABEL = "\u062a\u0633\u062a \u0632\u0646\u062f\u0647 \u0645\u06cc\u06a9\u0631\u0648\u0641\u0648\u0646";
const STOP_LABEL = "\u067e\u0627\u06cc\u0627\u0646 \u0636\u0628\u0637";

async function scenario(browser, mode) {
  const context = await browser.newContext();
  let voiceRequests = 0;

  try {
    await context.route("**/api/v1/**", async route => {
      const p = new URL(route.request().url()).pathname;
      let body = {};

      if (p.endsWith("/auth/refresh")) {
        body = { accessToken: "mock-token" };
      } else if (p.endsWith("/auth/me")) {
        body = {
          user: {
            id: "test-user",
            businessId: "test-tenant",
            name: "Browser Test",
            email: "browser@example.test",
            role: "ADMIN"
          },
          business: { name: "Browser Voice Test" }
        };
      } else if (p.endsWith("/business/settings")) {
        body = { settings: { features: { agent: true, voice: true } } };
      } else if (p.endsWith("/business/branding")) {
        body = { enabled: false };
      } else if (p === "/api/v1/agents") {
        body = [{
          id: "mock-agent",
          name: "Mock Agent",
          language: "fa-IR",
          voiceProvider: "gemini",
          voiceId: "Kore",
          isActive: true,
          systemPrompt: "",
          configuration: {}
        }];
      } else if (p.endsWith("/versions")) {
        body = { versions: [] };
      } else if (p.endsWith("/analytics/intent")) {
        body = {
          window: { days: 30, since: "2026-10-01" },
          calls: 0, turns: 0, withSlots: 0, total: 0,
          unknownRate: null, clarificationRate: null,
          byIntent: [], unactionableByIntent: []
        };
      } else if (p.endsWith("/voice-test")) {
        voiceRequests++;
        body = {
          heard: true,
          transcript: "Browser audio test",
          reply: "Mocked response",
          spokenText: "Mocked response",
          audioBase64: null,
          audioMimeType: null,
          latencyMs: { total: 10, stt: 3, agent: 4, tts: 3 },
          usage: {
            sttMinutes: 0,
            ttsCharacters: 0,
            llmInputTokens: 0,
            llmOutputTokens: 0
          },
          toolCalls: []
        };
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    });

    const page = await context.newPage();

    await page.addInitScript(mode => {
      window.__micCalls = [];

      const track = {
        label: "Microphone Array (Test Device)",
        enabled: true,
        muted: false,
        getSettings: () => ({ sampleRate: 16000, channelCount: 1 }),
        stop() {}
      };

      const stream = {
        getTracks: () => [track],
        getAudioTracks: () => [track]
      };

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          async getUserMedia(options) {
            window.__micCalls.push(options);
            return stream;
          },
          async enumerateDevices() {
            return [
              { kind: "audioinput", deviceId: "stereo", label: "Stereo Mix (Realtek)" },
              { kind: "audioinput", deviceId: "real-mic", label: "Microphone Array (Test Device)" }
            ];
          }
        }
      });

      function makeWav() {
        const rate = 16000;
        const count = rate * 2;
        const buffer = new ArrayBuffer(44 + count * 2);
        const view = new DataView(buffer);

        const write = (offset, value) => {
          for (let i = 0; i < value.length; i++)
            view.setUint8(offset + i, value.charCodeAt(i));
        };

        write(0, "RIFF");
        view.setUint32(4, buffer.byteLength - 8, true);
        write(8, "WAVE");
        write(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        write(36, "data");
        view.setUint32(40, count * 2, true);

        for (let i = 0; i < count; i++) {
          const sample = mode === "silent"
            ? 0
            : Math.sin(2 * Math.PI * 440 * i / rate) * 0.2;

          view.setInt16(44 + 2 * i, Math.round(sample * 32767), true);
        }

        return new Blob([buffer], { type: "audio/wav" });
      }

      class TestRecorder {
        constructor() {
          this.state = "inactive";
          this.mimeType = "audio/wav";
          this.ondataavailable = null;
          this.onstop = null;
        }

        start() {
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          const audio = makeWav();
          queueMicrotask(() => {
            this.ondataavailable?.({ data: audio });
            this.onstop?.();
          });
        }
      }

      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: TestRecorder
      });
    }, mode);

    await page.goto(base + "/dashboard/agent", {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    const selector = page.getByLabel("Select microphone input");
    await selector.waitFor({ timeout: 30000 });

    await page.getByRole("button", {
      name: "Detect microphones"
    }).click();

    await page.waitForFunction(() =>
      document.querySelector('select[aria-label="Select microphone input"]')?.value === "real-mic"
    );

    const selected = await selector.inputValue();

    await page.getByRole("button", { name: START_LABEL }).click();
    await page.getByRole("button", { name: STOP_LABEL }).click();

    if (mode === "silent") {
      await page.getByText(/Recording too short or nearly silent/)
        .waitFor({ timeout: 20000 });
    } else {
      await page.getByText("Browser audio test")
        .waitFor({ timeout: 20000 });
    }

    const calls = await page.evaluate(() => window.__micCalls);

    const exact = calls.some(
      x => x.audio?.deviceId?.exact === "real-mic"
    );

    const expected = mode === "silent" ? 0 : 1;

    const pass =
      selected === "real-mic" &&
      exact &&
      voiceRequests === expected;

    console.log("MODE=" + mode);
    console.log("SELECTED_MIC=" + selected);
    console.log("EXACT_DEVICE_USED=" + exact);
    console.log("VOICE_API_REQUESTS=" + voiceRequests);
    console.log("SCENARIO_RESULT=" + (pass ? "PASS" : "FAIL"));

    return pass;
  } finally {
    await context.close();
  }
}

async function main() {
  console.log("=== STEP 222: UNICODE-SAFE CHROME TEST ===");

  const health = await fetch(base + "/api/health/live", {
    signal: AbortSignal.timeout(5000)
  }).catch(() => null);

  if (health?.status !== 200)
    throw Error("TEST_SERVER_3100_NOT_RUNNING");

  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
    headless: true,
    timeout: 15000
  });

  try {
    console.log("BROWSER_VERSION=" + browser.version());
    console.log("TEST_SERVER=HEALTHY");

    const silent = await scenario(browser, "silent");
    const signal = await scenario(browser, "signal");

    console.log("SILENCE_GUARD=" + (silent ? "PASS" : "FAIL"));
    console.log("MICROPHONE_SELECTION=" + (signal ? "PASS" : "FAIL"));
    console.log("STEP_222_RESULT=" + (silent && signal ? "PASS" : "FAIL"));
    console.log("REAL_GEMINI_REQUESTS=0");
    console.log("DATABASE_MODIFIED=NO");
    console.log("GITHUB_PUSH=NO");

    if (!silent || !signal) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.log("STEP_222_RESULT=FAILED");
  console.log("ERROR=" + error.message);
  process.exitCode = 1;
});
