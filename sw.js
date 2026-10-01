/* Kimi service worker — offline shell, notification actions, background due-checks. */
importScripts('./core.js');
const Core = self.KimiCore;

const VERSION = 'kimi-v5.0.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];
const FONT_CACHE = 'kimi-fonts';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache after first load so the app looks the same offline
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') cache.put(req, r.clone());
        return r;
      } catch { return Response.error(); }
    })());
    return;
  }
  if (url.origin !== location.origin) return;

  // Pages: versioned shell (instant + offline). New versions arrive through SW updates.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = (await cache.match('./index.html')) || (await cache.match('./'));
      if (hit) return hit;
      try { return await fetch(req); } catch { return Response.error(); }
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch { return Response.error(); }
  })());
});

/* ───── Shared state (same IndexedDB the app uses) ───── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kimi', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function readState() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get('state');
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
async function writeState(state) {
  state.updatedAt = Date.now();
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(state, 'state');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function tellClients(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach(c => c.postMessage(msg));
  return all;
}

function notifyFor(rem) {
  const bits = [];
  if (rem.amount != null) bits.push(Core.money(rem.amount, rem.currency));
  bits.push(Core.whenLabel(rem.due));
  return self.registration.showNotification((rem.type === 'task' ? '⏰ ' : rem.type === 'bill' ? '🧾 ' : '🔁 ') + rem.title, {
    body: bits.join(' · ') + '\nTap Done or Snooze',
    tag: 'kimi-' + rem.id,
    renotify: true,
    requireInteraction: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    vibrate: [200, 100, 200, 100, 300],
    data: { id: rem.id },
    actions: [{ action: 'done', title: rem.type === 'task' ? '✓ Done' : '✓ Paid' }, { action: 'snooze', title: '⏰ 1 hour' }]
  });
}

/* Background check (Chrome on Android, installed app; the browser decides how often) */
async function backgroundCheck() {
  const state = await readState();
  if (!state || !state.settings || state.settings.notifications === false) return;
  const due = Core.dueReminders(state, new Date());
  if (!due.length) return;
  for (const r of due.slice(0, 4)) { await notifyFor(r); r.alertedFor = r.due; }
  await writeState(state);
  await tellClients({ type: 'state-changed' });
  if (self.navigator.setAppBadge) self.navigator.setAppBadge(due.length).catch(() => {});
}
self.addEventListener('periodicsync', e => {
  if (e.tag === 'kimi-due-check') e.waitUntil(backgroundCheck());
});

self.addEventListener('notificationclick', e => {
  const id = e.notification.data && e.notification.data.id;
  e.notification.close();
  e.waitUntil((async () => {
    if (id && (e.action === 'done' || e.action === 'snooze')) {
      const state = await readState();
      const rem = state && state.reminders.find(r => r.id === id);
      if (rem) {
        if (e.action === 'done') Core.completeReminder(rem, new Date());
        else Core.snoozeReminder(rem, new Date(Date.now() + 3600000));
        state.log = state.log || [];
        state.log.unshift({ id: rem.id, title: rem.title, action: e.action, at: Core.toLocal(new Date()) });
        state.log.length = Math.min(state.log.length, 200);
        await writeState(state);
        await tellClients({ type: 'state-changed' });
      }
      return;
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-reminder', id }); return c.focus(); }
    }
    return self.clients.openWindow('./?open=' + encodeURIComponent(id || ''));
  })());
});
