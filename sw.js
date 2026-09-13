// 动作卡离线壳：先给缓存（秒开），后台再拉新版；拉到不同版本就通知页面弹「刷新」条。
// 页面是 4MB 单文件，网络优先会让每次打开都等下载，所以走 cache-first + 后台校验。
const CACHE = 'coach-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const sig = r => (r && (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length'))) || '';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    const refresh = fetch(req, { cache: 'no-cache' }).then(async res => {
      if (!res.ok) return res;
      const changed = hit && sig(hit) !== sig(res);
      await cache.put(key, res.clone());
      if (changed && req.mode === 'navigate') {
        const cs = await self.clients.matchAll({ type: 'window' });
        cs.forEach(c => c.postMessage({ type: 'coach-updated' }));
      }
      return res;
    });
    if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
    try { return await refresh; }
    catch (err) { const fb = await cache.match('./'); if (fb && req.mode === 'navigate') return fb; throw err; }
  })());
});
