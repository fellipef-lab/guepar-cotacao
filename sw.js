/* Service worker: deixa o app abrir sem internet e recebe as notificações (Firebase Cloud Messaging) */
importScripts("config.js");
importScripts(
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
);

// Notificações recebidas com o app fechado ou em segundo plano
try {
  firebase.initializeApp(self.FROTA_CONFIG.firebase);
  firebase.messaging().onBackgroundMessage(p => {
    const d = p.data || {};
    return self.registration.showNotification(d.title || "Frota", {
      body: d.body || "",
      tag: d.tag,
      renotify: !!d.tag,
      icon: "icon-192.png",
      badge: "icon-192.png",
      vibrate: [200, 100, 200],
    });
  });
} catch (e) {}

// Ao tocar na notificação, abre o app (no endereço onde ele estiver publicado)
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(lista => {
    const aberto = lista.find(c => c.url.startsWith(self.registration.scope));
    return aberto ? aberto.focus() : self.clients.openWindow(self.registration.scope);
  }));
});

const CACHE = "frota-v1";
const ARQUIVOS = ["./", "index.html", "app.js", "config.js", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  const proprio = u.origin === location.origin && !u.pathname.startsWith("/__/");
  const biblioteca = u.hostname === "www.gstatic.com" || u.hostname === "cdn.jsdelivr.net";
  if (proprio) e.respondWith(redePrimeiro(r));
  else if (biblioteca) e.respondWith(cachePrimeiro(r));
  // Banco de dados, fotos e mapa vão direto para a internet
});

// Arquivos do app: tenta a versão nova; sem internet, usa a guardada
async function redePrimeiro(r) {
  try {
    const resp = await fetch(r);
    if (resp.ok) (await caches.open(CACHE)).put(r, resp.clone());
    return resp;
  } catch (e) {
    return (await caches.match(r)) || (r.mode === "navigate" ? caches.match("index.html") : Response.error());
  }
}

// Bibliotecas com versão fixa: usa a guardada; se não tiver, baixa e guarda
async function cachePrimeiro(r) {
  const c = await caches.match(r);
  if (c) return c;
  const resp = await fetch(r);
  if (resp.ok) (await caches.open(CACHE)).put(r, resp.clone());
  return resp;
}
