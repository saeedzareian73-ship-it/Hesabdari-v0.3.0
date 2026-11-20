/* Service Worker دفتر حساب
   نسخه کش را در هر انتشار جدید تغییر دهید تا فایل‌های قدیمی جایگزین شوند.
   فایل firebase-config.js همیشه با درخواست تازه شبکه بررسی می‌شود؛
   در حالت آفلاین، نسخه قبلی ذخیره‌شده فقط به‌عنوان fallback استفاده می‌شود.
*/
const CACHE_PREFIX = 'daftar-hesab-';
const CACHE_NAME = 'daftar-hesab-v9';
const CORE_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './firebase-config.js',
  './firebase-cloud.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const configPath = new URL('./firebase-config.js', self.registration.scope).pathname;
  const isFirebaseConfig = url.pathname === configPath;

  try {
    // فایل تنظیمات Firebase نباید از HTTP cache قدیمی مرورگر خوانده شود.
    const freshRequest = new Request(request, {
      cache: isFirebaseConfig ? 'no-store' : 'no-cache'
    });
    const response = await fetch(freshRequest);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // درخواست‌های Firebase SDK و سایر سرویس‌های بیرونی را Service Worker دستکاری نمی‌کند.
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request).catch(async () => {
    if (request.mode === 'navigate') {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match('./index.html')) || Response.error();
    }
    return Response.error();
  }));
});
