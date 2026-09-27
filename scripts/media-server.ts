/**
 * Voice media sidecar: WebSocket server for bidirectional telephony audio.
 *
 * Telephony gateways connect here (after the app's `startStream` call points
 * them at VOICE_MEDIA_PUBLIC_URL) and exchange the protocol documented in
 * src/lib/voice/media-server.ts: start → audio chunks → utterance-end →
 * agent-audio → … → stop.
 *
 * Usage: npm run media:server   (requires VOICE_MEDIA_TOKEN)
 * Health: GET /healthz → 200 { status: "ok", sessions: n }
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { MediaServer, MediaSession, MediaSocketOpen } from "../src/lib/voice/media-server";

async function main() {
  const { getEnv } = await import("../src/lib/env");
  const e = getEnv();
  if (!e.VOICE_MEDIA_TOKEN) {
    throw new Error("VOICE_MEDIA_TOKEN is required to run the media server");
  }
  const port = e.VOICE_MEDIA_PORT;

  const media = new MediaServer({
    token: e.VOICE_MEDIA_TOKEN,
    idleTimeoutMs: e.VOICE_MEDIA_IDLE_TIMEOUT_MS,
    maxBufferBytes: e.VOICE_MEDIA_MAX_BUFFER_BYTES,
    maxFrameBytes: e.VOICE_MEDIA_MAX_FRAME_BYTES,
    vadEnabled: e.VOICE_VAD_ENABLED,
    vadSpeechThreshold: e.VOICE_VAD_SPEECH_THRESHOLD,
    vadSilenceMs: e.VOICE_VAD_SILENCE_MS,
    vadMinSpeechMs: e.VOICE_VAD_MIN_SPEECH_MS,
    vadMaxUtteranceMs: e.VOICE_VAD_MAX_UTTERANCE_MS,
    defaultCodec: e.VOICE_MEDIA_CODEC,
    defaultSampleRate: e.VOICE_MEDIA_SAMPLE_RATE,
    allowStaticToken: false,
    maxConcurrentSessions: e.VOICE_MAX_CONCURRENT_SESSIONS,
  });
  const sessions = new Set<MediaSession>();

  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: sessions.size, capacity: e.VOICE_MAX_CONCURRENT_SESSIONS }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: e.VOICE_MEDIA_MAX_FRAME_BYTES });
  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Only the media path speaks WebSocket; everything else is rejected.
    if (!req.url || !req.url.startsWith("/media")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const session = media.accept({
        send: (data) => {
          if (ws.readyState === MediaSocketOpen) ws.send(data);
        },
        close: (code, reason) => {
          try {
            ws.close(code ?? 1000, reason ?? "");
          } catch {
            // ignore
          }
        },
        get readyState() {
          return ws.readyState;
        },
      });
      sessions.add(session);
      // Text frames carry JSON control messages; binary frames carry audio.
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        const payload = isBinary ? Buffer.from(data) : data.toString("utf8");
        void session.handleMessage(payload);
      });
      const cleanup = () => {
        sessions.delete(session);
        session.handleClose();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  console.log(`[media] listening on 0.0.0.0:${port} (ws path /media, health /healthz)`);

  const shutdown = () => {
    console.log("[media] shutting down...");
    httpServer.close(() => process.exit(0));
    wss.close();
    for (const s of sessions) s.handleClose();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[media] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
