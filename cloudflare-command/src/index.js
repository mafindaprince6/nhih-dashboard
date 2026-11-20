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

    const edgeStatic = request.method === 'GET' && (PWA_ASSETS.has(incoming.pathname) || STATIC_ASSET.test(incoming.pathname));
    const edgeCache = caches.default;
    const cacheKey = new Request(incoming.origin + incoming.pathname + incoming.search, { method: 'GET' });
    if (edgeStatic) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return cached;
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
      await edgeCache.put(cacheKey, copy);
    }
    return result;
  }
};
