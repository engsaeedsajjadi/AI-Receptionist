/**
 * Voice media sidecar: WebSocket server for bidirectional telephony audio.
 *
 * Telephony gateways connect here (after the app's `startStream` call points
 * them at VOICE_MEDIA_PUBLIC_URL) and exchange the protocol documented in
 * src/lib/voice/media-server.ts: start → audio chunks → utterance-end →
 * agent-audio → … → stop.
 *
 * Usage: npm run media:server   (requires VOICE_MEDIA_TOKEN)
 * Health: GET /healthz → 200 { status, sessions, states }
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AppError } from "../src/lib/errors";
import { MediaServer, MediaSession, MediaSocketOpen } from "../src/lib/voice/media-server";

function parseOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function main() {
  const { getEnv } = await import("../src/lib/env");
  const e = getEnv();
  if (!e.VOICE_MEDIA_TOKEN) {
    throw new Error("VOICE_MEDIA_TOKEN is required to run the media server");
  }
  const port = e.VOICE_MEDIA_PORT;
  const allowedOrigins = parseOrigins(e.VOICE_MEDIA_ALLOWED_ORIGINS);

  const media = new MediaServer({
    token: e.VOICE_MEDIA_TOKEN,
    maxSessions: e.VOICE_MAX_CONCURRENT_SESSIONS,
    idleTimeoutMs: e.VOICE_SESSION_TIMEOUT_MS,
    maxBufferBytes: e.VOICE_MAX_AUDIO_BUFFER_BYTES,
    maxFrameBytes: e.VOICE_MEDIA_MAX_FRAME_BYTES,
    silenceTimeoutMs: e.VOICE_SILENCE_TIMEOUT_MS,
    maxReprompts: e.VOICE_SILENCE_MAX_REPROMPTS,
    sessionTtlSeconds: Math.ceil(e.VOICE_SESSION_TIMEOUT_MS / 1000),
  });

  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...media.snapshot() }));
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
    // Optional origin allowlist (defence in depth; the media token is the
    // real authenticator and is always required at `start`).
    if (allowedOrigins.size > 0) {
      const origin = String(req.headers.origin ?? "").trim().toLowerCase();
      if (!origin || !allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      let session: MediaSession;
      try {
        session = media.accept({
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
      } catch (err) {
        // At capacity: 1013 (try again later), never a silent hang.
        const code = err instanceof AppError && err.code === "SERVER_FULL" ? 1013 : 1011;
        try {
          ws.close(code, err instanceof Error ? err.message : "unavailable");
        } catch {
          // ignore
        }
        return;
      }
      // Text frames carry JSON control messages; binary frames carry audio.
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        const payload = isBinary ? Buffer.from(data) : data.toString("utf8");
        void session.handleMessage(payload);
      });
      const cleanup = () => {
        media.release(session);
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
    media.closeAll();
    httpServer.close(() => process.exit(0));
    wss.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[media] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
