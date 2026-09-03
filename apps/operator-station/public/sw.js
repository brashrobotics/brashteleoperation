const CACHE_PREFIX = "brash-operator";

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Network-only by design. Stale operator or robot state must not be available
  // merely because the application shell was previously opened.
  event.respondWith(fetch(new Request(event.request, { cache: "no-store" })));
});
