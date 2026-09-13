// 动作卡离线壳：先给缓存（秒开），后台再拉新版；拉到不同版本就通知页面弹「刷新」条。
// 页面是 4MB 单文件，网络优先会让每次打开都等下载，所以走 cache-first + 后台校验。
// 校验时机：① 冷启动的导航请求 ② 页面回到前台时发来 {type:'check'}（主屏 App 从后台切回
// 不会重新导航，只靠 ① 永远弹不出更新条）③ 新版 sw.js 激活时（install 已拉过新页面）。
const CACHE = 'coach-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

const UPD_MARK = './__update-pending';  // install 时已有旧 SW → 这是升级不是首装，activate 后要提醒

self.addEventListener('install', e => {
  // cache:'reload' 绕过 HTTP 缓存（Pages 的 max-age=600），保证 install 拿到的是真新版
  const upgrading = !!self.registration.active;
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))
      .then(() => upgrading && c.put(UPD_MARK, new Response('1'))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(async () => {  // 升级激活 = 有新版本（install 已把新页面放进缓存），提醒正开着的页面；首装不提醒
      const c = await caches.open(CACHE);
      if (await c.match(UPD_MARK)) { await c.delete(UPD_MARK); await notify(); }
    }));
});

const sig = r => (r && (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length'))) || '';

async function notify() {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  cs.forEach(c => c.postMessage({ type: 'coach-updated' }));
}

// 后台刷新 './'：拉新页面 → 写缓存 → 与旧缓存签名不同就通知。同一时刻只跑一份（避免双下载 4MB）。
let inflight = null;
function refreshShell(req) {
  if (inflight) return inflight;
  inflight = (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match('./');
    const res = await fetch(req || new Request('./', { cache: 'no-cache' }));
    if (!res.ok) return res;
    const changed = hit && sig(hit) !== sig(res);
    await cache.put('./', res.clone());
    if (changed) await notify();
    return res;
  })().finally(() => { inflight = null; });
  return inflight;
}

// 页面回到前台时问一句：先 HEAD 比签名（不下载正文），变了才真拉
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'check') return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match('./');
    if (!hit) return;
    const head = await fetch(new Request('./', { method: 'HEAD', cache: 'no-cache' }));
    if (head.ok && sig(head) !== sig(hit)) await refreshShell();
  })().catch(() => {}));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const nav = req.mode === 'navigate';
  const key = nav ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    const refresh = nav ? refreshShell(new Request(req, { cache: 'no-cache' }))
      : fetch(req, { cache: 'no-cache' }).then(async res => {
          if (res.ok) await cache.put(key, res.clone());
          return res;
        });
    if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
    try { return await refresh; }
    catch (err) { const fb = await cache.match('./'); if (fb && nav) return fb; throw err; }
  })());
});
