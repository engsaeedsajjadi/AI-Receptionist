import { describe, expect, it, vi } from "vitest";
import { createSessionBus, isSessionEvent, SESSION_CHANNEL_NAME } from "@/lib/cross-tab";

/** In-memory BroadcastChannel stand-in: one instance per bus under test. */
function fakeChannel() {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const posted: unknown[] = [];
  return {
    posted,
    postMessage: (message: unknown) => posted.push(message),
    addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => listeners.delete(listener),
    close: () => listeners.clear(),
    emit: (data: unknown) => listeners.forEach((listener) => listener({ data })),
    listenerCount: () => listeners.size,
  };
}

describe("cross-tab session bus", () => {
  it("uses a same-origin channel name and defaults to unsupported without BroadcastChannel", () => {
    expect(SESSION_CHANNEL_NAME).toBe("ar-session");
    const bus = createSessionBus({ factory: () => null });
    expect(bus.supported).toBe(false);
    expect(() => bus.announce("logout")).not.toThrow();
    expect(bus.subscribe(() => undefined)()).toBeUndefined();
    expect(() => bus.close()).not.toThrow();
  });

  it("survives a factory that throws (private mode / blocked storage)", () => {
    const bus = createSessionBus({
      factory: () => {
        throw new Error("blocked");
      },
    });
    expect(bus.supported).toBe(false);
  });

  it("announces typed events with an id, sender and timestamp", () => {
    const channel = fakeChannel();
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    expect(bus.supported).toBe(true);
    bus.announce("logout");
    bus.announce("login");
    expect(channel.posted).toHaveLength(2);
    for (const message of channel.posted) {
      expect(isSessionEvent(message)).toBe(true);
      expect((message as { sender: string }).sender).toBe("tab-1");
      expect((message as { at: number }).at).toBeGreaterThan(0);
    }
    expect(channel.posted.map((m) => (m as { type: string }).type)).toEqual(["logout", "login"]);
  });

  it("delivers other tabs' events and ignores its own echo", () => {
    const channel = fakeChannel();
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    const handler = vi.fn();
    bus.subscribe(handler);

    channel.emit({ id: "e1", type: "logout", sender: "tab-2", at: Date.now() });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "logout", sender: "tab-2" });

    // Own announcement must not re-trigger the local handler (no feedback loop).
    bus.announce("logout");
    channel.emit((channel.posted.at(-1) as { data?: unknown }) ?? channel.posted.at(-1));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed and unknown payloads instead of throwing", () => {
    const channel = fakeChannel();
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    const handler = vi.fn();
    bus.subscribe(handler);

    for (const payload of [null, undefined, "logout", 42, {}, { type: "hacked", id: "x", sender: "y", at: 1 }]) {
      channel.emit(payload);
    }
    expect(handler).not.toHaveBeenCalled();

    expect(isSessionEvent(null)).toBe(false);
    expect(isSessionEvent({ type: "login", id: "", sender: "s", at: 1 })).toBe(false);
    expect(isSessionEvent({ type: "login", id: "i", sender: "", at: 1 })).toBe(false);
    expect(isSessionEvent({ type: "login", id: "i", sender: "s", at: 1 })).toBe(true);
  });

  it("isolates listener failures so one bad handler cannot break the others", () => {
    const channel = fakeChannel();
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("listener exploded");
    });
    bus.subscribe(good);
    channel.emit({ id: "e2", type: "refresh", sender: "tab-2", at: Date.now() });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes and closes cleanly", () => {
    const channel = fakeChannel();
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    const handler = vi.fn();
    const unsubscribe = bus.subscribe(handler);
    unsubscribe();
    channel.emit({ id: "e3", type: "login", sender: "tab-2", at: Date.now() });
    expect(handler).not.toHaveBeenCalled();
    expect(channel.listenerCount()).toBe(1);
    bus.close();
    expect(channel.listenerCount()).toBe(0);
  });

  it("never throws when posting fails", () => {
    const channel = fakeChannel();
    channel.postMessage = () => {
      throw new Error("channel closed");
    };
    const bus = createSessionBus({ factory: () => channel, sender: "tab-1" });
    expect(() => bus.announce("refresh")).not.toThrow();
  });
});
