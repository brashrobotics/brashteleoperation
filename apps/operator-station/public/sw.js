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
  // Let the browser perform normal CORS handling for the robot edge and media
  // gateway. Reconstructing their credentialed cross-origin requests inside a
  // service worker can turn a valid response into an opaque network failure.
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  // Network-only by design. Stale operator or robot state must not be available
  // merely because the application shell was previously opened.
  event.respondWith(fetch(new Request(event.request, { cache: "no-store" })));
});
