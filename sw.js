/* 工作台 Service Worker：缓存、后台检查、可选 Notification Triggers */
importScripts("./js/shared.js");

const CACHE = "workbench-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/shared.js",
  "./js/sortable.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        if (cached) return cached;
        if (req.mode === "navigate") return caches.match("./index.html");
        throw err;
      }
    })()
  );
});

function notifOptions(copy, taskId) {
  return {
    body: copy.body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: copy.tag,
    renotify: true,
    lang: "zh-CN",
    data: { url: "./", taskId }
  };
}

async function checkFromIdb() {
  const state = await WB.loadState();
  if (!state) return;
  const now = Date.now();
  let changed = false;
  for (const task of state.tasks || []) {
    const rem = WB.reminderForTask(task, state.settings);
    if (!rem) continue;
    const key = WB.reminderKey(task.id, rem.at);
    if (state.notified[key]) continue;
    if (rem.at.getTime() <= now && now - rem.at.getTime() <= 24 * 3600 * 1000) {
      const copy = WB.notificationCopy(task, rem);
      try {
        await self.registration.showNotification(copy.title, notifOptions(copy, task.id));
      } catch (err) {
        // ignore
      }
      state.notified[key] = now;
      changed = true;
    }
  }
  if (changed) await WB.saveState(state);
}

async function scheduleTriggers() {
  const state = await WB.loadState();
  if (!state) return;
  if (typeof TimestampTrigger === "undefined") {
    await checkFromIdb();
    return;
  }
  for (const task of state.tasks || []) {
    const rem = WB.reminderForTask(task, state.settings);
    if (!rem) continue;
    const key = WB.reminderKey(task.id, rem.at);
    if (state.notified[key]) continue;
    if (rem.at.getTime() <= Date.now()) continue;
    const copy = WB.notificationCopy(task, rem);
    try {
      await self.registration.showNotification(copy.title, Object.assign(notifOptions(copy, task.id), {
        showTrigger: new TimestampTrigger(rem.at.getTime())
      }));
    } catch (err) {
      // API not actually usable
    }
  }
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-reminders") event.waitUntil(checkFromIdb());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "check-reminders") event.waitUntil(checkFromIdb());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SCHEDULE") event.waitUntil(scheduleTriggers());
  if (data.type === "CHECK") event.waitUntil(checkFromIdb());
  if (data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL("./", self.location.href).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })()
  );
});
