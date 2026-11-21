// Кеш оболонки додатку, щоб він відкривався без інтернету. Дані кешує сам Firebase.
const CACHE = "aptechka-v5";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/store.js", "js/scan.js", "js/drugs.js", "js/firebase-config.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Власні файли: спершу мережа (щоб оновлення приходили одразу), без мережі — кеш.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
