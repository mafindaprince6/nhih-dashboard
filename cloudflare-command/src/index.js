// Cloudflare Worker entry point for the NHIH Command Desk.
// Reverse-proxies the existing NHIH server so /desk and /api remain same-origin.
// Does not store credentials, cache responses, or replicate operational records.
const UPSTREAM = 'https://nhih-ops.tailecbac3.ts.net';
const UPSTREAM_TIMEOUT_MS = 12000;
// Cache only public, non-user-specific install resources at the edge.
const PWA_ASSETS = new Set(['/desk-manifest.webmanifest', '/desk-icon-192.png', '/desk-icon-512.png', '/desk-sw.js', '/desk-logo.jpg']);
const STATIC_ASSET = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|png|jpg|jpeg|svg|woff2?)$/;

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (incoming.pathname === '/') {
      return Response.redirect(new URL('/desk', incoming.origin), 302);
    }

    if (incoming.pathname === '/__command-health') {
      return Response.json({ service: 'nhih-command', worker: 'ready', upstream: 'not-checked' }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const edgeStatic = request.method === 'GET' && !request.headers.has('authorization') && !request.headers.has('cookie') && (PWA_ASSETS.has(incoming.pathname) || STATIC_ASSET.test(incoming.pathname));
    const edgeCache = caches.default;
    const cacheKey = new Request(incoming.origin + incoming.pathname + incoming.search, { method: 'GET' });
    if (edgeStatic) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return cached;
    }

    // A fast, self-contained installation entry point. No dashboard data or credentials.
    if (incoming.pathname === '/desk/install') {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1f4e79"><link rel="manifest" href="/desk-manifest.webmanifest?v=4"><link rel="icon" href="/desk-icon-192.png?v=4"><title>Install NHIH Command</title><style>body{font-family:system-ui,sans-serif;background:#f5f7fa;color:#17324d;min-height:100vh;display:grid;place-items:center;margin:0;padding:20px}main{max-width:420px;background:white;border-radius:18px;padding:28px;box-shadow:0 8px 30px #0001;text-align:center}img{width:100px;height:100px;object-fit:contain}button,a{display:block;margin:14px auto;padding:14px 18px;border-radius:10px;font-size:16px}button{background:#1f4e79;color:white;border:0;width:100%}a{color:#1f4e79}p{line-height:1.5}</style></head><body><main><img src="/desk-icon-192.png?v=4" alt="Ministry of Health logo"><h1>NHIH Command</h1><p>Install the Ministry of Health Command Desk as a standalone app.</p><button id="install" disabled>Checking installation…</button><p id="status" role="status">Preparing app installation.</p><a href="/desk">Open Command Desk in browser</a></main><script>let deferred;const button=document.getElementById('install'),status=document.getElementById('status');if('serviceWorker' in navigator){navigator.serviceWorker.register('/desk-sw.js',{scope:'/desk'}).then(()=>navigator.serviceWorker.ready).then(()=>{status.textContent='App connection ready. Use Chrome menu → Install app if the button is unavailable.'}).catch(e=>{status.textContent='Service worker error: '+e.message})}else{status.textContent='This browser does not support service workers.'}window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;button.disabled=false;button.textContent='Install NHIH Command';status.textContent='Ready to install.'});button.addEventListener('click',async()=>{if(!deferred)return;button.disabled=true;await deferred.prompt();const result=await deferred.userChoice;status.textContent=result.outcome==='accepted'?'Installation requested. Check Samsung Apps to confirm.':'Installation cancelled.';deferred=null});window.addEventListener('appinstalled',()=>{status.textContent='Chrome reported installation. Confirm the app is in Samsung Apps.'});if(window.matchMedia('(display-mode: standalone)').matches){location.replace('/desk')}</script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }

    const target = new URL(incoming.pathname + incoming.search, UPSTREAM);
    const headers = new Headers(request.headers);
    // Let fetch generate Host for the upstream domain.
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-host');
    const upstreamRequest = new Request(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      duplex: 'half'
    });
    let response;
    try {
      response = await fetch(upstreamRequest, { redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (error) {
      console.error('NHIH upstream fetch failed', { path: incoming.pathname, error: String(error) });
      return new Response('NHIH Command could not reach the NHIH server. Please try again later.', {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    const out = new Headers(response.headers);
    out.set('Cache-Control', edgeStatic && response.ok ? 'public, max-age=300' : 'no-store, private');
    out.delete('cdn-cache-control');
    out.delete('content-security-policy-report-only');
    const location = out.get('location');
    if (location) {
      try {
        const redirect = new URL(location, UPSTREAM);
        if (redirect.origin === UPSTREAM) {
          out.set('location', incoming.origin + redirect.pathname + redirect.search + redirect.hash);
        }
      } catch { /* keep original relative redirect */ }
    }
    // Keep cookie attributes, including Secure/HttpOnly/SameSite, unchanged.
    // Origin host-only cookies are set against the new Worker host by the browser.
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
    if (edgeStatic && response.ok && !response.headers.has('set-cookie')) {
      // Never cache authenticated responses or pages containing operational data.
      const cachedHeaders = new Headers(out);
      cachedHeaders.delete('set-cookie');
      const copy = new Response(result.clone().body, { status: result.status, headers: cachedHeaders });
      try { await edgeCache.put(cacheKey, copy); } catch (error) { console.warn('PWA edge cache unavailable', String(error)); }
    }
    return result;
  }
};
