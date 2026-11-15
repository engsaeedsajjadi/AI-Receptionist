/**
 * Cross-tab session coordination.
 *
 * Access tokens live in memory per tab, so without coordination a logout (or a
 * fresh login) in one tab leaves other tabs showing stale authenticated state.
 * `BroadcastChannel` is same-origin only, so nothing external can inject
 * session events; the bus additionally ignores its own messages to avoid loops
 * and ignores malformed payloads instead of throwing.
 *
 * The module is dependency-free and accepts an injectable channel factory so it
 * can be unit tested without a browser.
 */

export const SESSION_CHANNEL_NAME = "ar-session";

export type SessionEventType = "login" | "logout" | "refresh";

export type SessionEvent = {
  /** Unique per announcement; also used to ignore our own echo. */
  id: string;
  type: SessionEventType;
  sender: string;
  at: number;
};

type ChannelLike = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener?: (type: "message", listener: (event: { data: unknown }) => void) => void;
  close?: () => void;
};

export type SessionBus = {
  /** false when BroadcastChannel is unavailable (SSR, old browser, tests). */
  supported: boolean;
  /** Publish a session event to the other tabs. Never throws. */
  announce: (type: SessionEventType) => void;
  /** Subscribe to events from other tabs. Returns an unsubscribe function. */
  subscribe: (handler: (event: SessionEvent) => void) => () => void;
  close: () => void;
};

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionEvent>;
  return (
    (event.type === "login" || event.type === "logout" || event.type === "refresh") &&
    typeof event.id === "string" &&
    event.id.length > 0 &&
    typeof event.sender === "string" &&
    event.sender.length > 0
  );
}

function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSessionBus(options?: { factory?: () => ChannelLike | null; sender?: string }): SessionBus {
  const sender = options?.sender ?? randomId();
  const factory =
    options?.factory ??
    (() => {
      const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
      return typeof Ctor === "function" ? new Ctor(SESSION_CHANNEL_NAME) : null;
    });

  let channel: ChannelLike | null = null;
  try {
    channel = factory();
  } catch {
    channel = null;
  }
  if (!channel) {
    return { supported: false, announce: () => undefined, subscribe: () => () => undefined, close: () => undefined };
  }

  const handlers = new Set<(event: SessionEvent) => void>();
  const listener = (event: { data: unknown }) => {
    if (!isSessionEvent(event.data)) return;
    if (event.data.sender === sender) return; // our own announcement
    for (const handler of handlers) {
      try {
        handler(event.data);
      } catch {
        // A misbehaving listener must not break other tabs' handlers.
      }
    }
  };
  channel.addEventListener("message", listener);

  return {
    supported: true,
    announce: (type) => {
      try {
        channel?.postMessage({ id: randomId(), type, sender, at: Date.now() } satisfies SessionEvent);
      } catch {
        // Posting is best effort: the local tab state is already correct.
      }
    },
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      handlers.clear();
      channel?.removeEventListener?.("message", listener);
      channel?.close?.();
    },
  };
}
