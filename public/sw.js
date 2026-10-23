/**
 * SalonBill service worker — offline shell.
 *
 * Network-first for every GET so the app never goes stale; on network
 * failure the last cached copy is served, so the counter can still open
 * (billing itself writes to IndexedDB and works fully offline). Cache is
 * versioned and pruned on activate.
 */
const CACHE = "salonbill-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith("http")) return;
  // Never intercept server-function RPCs — they must reach the network.
  if (req.headers.get("accept")?.includes("text/x-component")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(req, copy))
            .catch(() => undefined);
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Navigations fall back to the app shell so routes resolve offline.
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return new Response("Offline — connect to the internet and try again.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }),
  );
});
