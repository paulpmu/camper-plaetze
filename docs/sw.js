// Offline-Unterstützung: App-Hülle aus dem Cache, Platzdaten zuerst frisch aus dem Netz.
const CACHE = "cp-v17";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "wetter.js", "fotos.js", "github.js", "privat.js", "betrieb.js",
  "manifest.webmanifest", "icon-180.png",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js",
  "vendor/markercluster/MarkerCluster.css", "vendor/markercluster/MarkerCluster.Default.css",
  "vendor/markercluster/leaflet.markercluster.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Nur eigene Dateien; Karte, Wetter, Fotos und GitHub gehen direkt zum Anbieter
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    // Nur echte Antworten zwischenspeichern, keine Umleitungen zur Anmeldung und keine Fehlerseiten
    if (r.ok && r.type === "basic" && !r.redirected) {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
