const VERSION = "ai-receptionist-shell-v1";
const SHELL = ["/offline", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    // Authenticated HTML is always network-only; offline falls back to a public,
    // non-tenant page rather than exposing stale customer/call data.
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline")));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/favicon.svg") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(VERSION).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
