// todo mate service worker — offline shell + installability.
// Bump CACHE when you want to force-clear old caches.
const CACHE = "todomate-v1";
const SHELL = [
  "/", "/index.html", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Let the sync API and writes hit the network directly.
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Network-first so deployed updates show up when online; fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || caches.match("/index.html"))
      )
  );
});
