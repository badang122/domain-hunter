// ═══════════════════════════════════════════════════════════════════════
// Domain Hunter Dashboard — Cloudflare Pages Functions backend
// ═══════════════════════════════════════════════════════════════════════
// Endpoints:
//   /api/ping                         — health check ringan
//   /api/health                       — diagnostic semua upstream services
//   /api/check-nawala?domain=X        — single domain Nawala check (multi-source)
//   /api/check-nawala-bulk POST       — bulk (max 50)
//   /api/check-nawala-mirror?domain=X — REAL solution: pakai GitHub TP mirror
//                                       (alsyundawy/TrustPositif, daily update)
//   /api/debug-nawala?domain=X        — diagnostic detail Skiddle/TP error
//   /api/check-availability?domain=X  — Namecheap scrape authoritative
//   /api/check-availability-bulk POST — bulk Namecheap (max 30)
//   /api/gemini POST                  — Gemini AI proxy (key di env.GEMINI_KEY)
//   /api/gist GET/POST                — GitHub Gist sync proxy (token di env.GIST_TOKEN)
//   /api/gist/meta                    — gist updated_at lightweight check
// ═══════════════════════════════════════════════════════════════════════

const BLOCK_KEYWORDS = [
  'terblokir', 'site has been blocked', 'diblokir',
  'kominfo telah memblokir', 'konten negatif',
  'situs ini diblokir', 'telah diblokir',
  'positifuntukinternet', 'internet positif', 'internet sehat',
  'internetbaik', 'akses ditolak', 'pemblokiran'
];
const SAFE_KEYWORDS = [
  'tidak terblokir', 'not blocked', 'tidak ditemukan',
  'not found in database', 'aman diakses', 'domain tidak terdaftar',
  'tidak terdaftar dalam database', 'belum terdaftar'
];

// GitHub TP mirror sources — alsyundawy/TrustPositif (updated daily)
// Pakai porn list saja (9MB) supaya muat di CF Worker free tier CPU limit (10ms-50ms)
// Gambling list 29MB akan exceed CPU limit saat parsing.
// Coverage ~50% TP blocking (porn = kategori utama). Yg miss → fallback Skiddle/TP.
const TP_MIRROR_URLS = [
  'https://raw.githubusercontent.com/alsyundawy/TrustPositif/master/alsyundawy_porn_v2.txt',
];

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
      ...extraHeaders
    }
  });
}

// ─── TP MIRROR — HTTP RANGE BINARY SEARCH (no parsing, CPU-friendly) ───
// File alsyundawy_porn_v2.txt is sorted alphabetically. Binary search via
// HTTP Range requests = ~25 sub-requests × 512 bytes = ~12KB total.
// CF caches each range at edge → repeat queries instant.
// Avoids CPU-intensive Set parsing that hits free tier 10ms limit.

const TP_MIRROR_PRIMARY = TP_MIRROR_URLS[0];

// Selalu fetch fresh size (~30-50ms, no module-level cache) — avoid stale value
// dari isolate cache lama. Range bytes=0-0 ringan dan akurat.
async function getMirrorSize() {
  try {
    const r = await fetch(TP_MIRROR_PRIMARY, {
      headers: { 'Range': 'bytes=0-0' }
    });
    if (r.status !== 206 && r.status !== 200) return null;
    const cr = r.headers.get('content-range'); // "bytes 0-0/SIZE"
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) return parseInt(m[1]);
    }
    const cl = parseInt(r.headers.get('content-length') || '0');
    if (cl > 0 && r.status === 200) return cl;
    return null;
  } catch { return null; }
}

async function checkViaMirror(domain) {
  const size = await getMirrorSize();
  if (!size) return null;
  const target = domain.toLowerCase().replace(/^www\./, '');

  let lo = 0, hi = size - 1;
  // 25 iterations = handles up to 33M lines (way more than needed)
  for (let iter = 0; iter < 25 && hi - lo > 512; iter++) {
    const mid = Math.floor((lo + hi) / 2);
    const start = Math.max(0, mid - 256);
    const end = Math.min(size - 1, mid + 256);
    try {
      const r = await fetch(TP_MIRROR_PRIMARY, {
        headers: { 'Range': `bytes=${start}-${end}` },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (r.status !== 206 && r.status !== 200) return null;
      const chunk = await r.text();
      // Skip partial first line, take complete lines
      const firstNL = chunk.indexOf('\n');
      const lastNL = chunk.lastIndexOf('\n');
      if (firstNL < 0 || firstNL === lastNL) {
        lo = end + 1; continue;
      }
      const lines = chunk.substring(firstNL + 1, lastNL).split('\n');
      // Check direct match
      for (const line of lines) {
        const ln = line.trim().toLowerCase();
        if (ln === target) return { status: 'blocked', source: 'tp-mirror', confidence: 'high' };
      }
      // Direction decision via lexicographic comparison
      const midLine = lines[Math.floor(lines.length / 2)].trim().toLowerCase();
      if (!midLine) { lo = end + 1; continue; }
      if (target < midLine) hi = start;
      else lo = end;
    } catch { return null; }
  }
  // Final check: fetch tight range and search linearly
  try {
    const r = await fetch(TP_MIRROR_PRIMARY, {
      headers: { 'Range': `bytes=${lo}-${Math.min(hi, lo + 2048)}` },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (r.status !== 206 && r.status !== 200) return null;
    const chunk = await r.text();
    if (chunk.toLowerCase().includes('\n' + target + '\n') ||
        chunk.toLowerCase().startsWith(target + '\n')) {
      return { status: 'blocked', source: 'tp-mirror', confidence: 'high' };
    }
    // Cek parent domain juga
    const parts = target.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      if (chunk.toLowerCase().includes('\n' + parent + '\n')) {
        return { status: 'blocked', source: 'tp-mirror-parent', matched_parent: parent, confidence: 'high' };
      }
    }
  } catch {}
  return { status: 'safe', source: 'tp-mirror', confidence: 'medium' };
}

// ─── SKIDDLE (legacy, masih dicoba kalau service pulih) ───
async function checkViaSkiddle(domain) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://check.skiddle.id/?domain=${encodeURIComponent(domain)}&json=true`, {
      signal: ctrl.signal,
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const r = data[domain] || data[domain.toLowerCase()];
    if (!r || typeof r.blocked !== 'boolean') return null;
    return { status: r.blocked ? 'blocked' : 'safe', source: 'skiddle' };
  } catch { return null; }
}

async function checkViaSkiddleBulk(domains) {
  if (!domains.length) return {};
  const out = {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const url = `https://check.skiddle.id/?domains=${domains.map(encodeURIComponent).join(',')}&json=true`;
    const res = await fetch(url, { signal: ctrl.signal, cf: { cacheTtl: 300, cacheEverything: true } });
    clearTimeout(t);
    if (!res.ok) return out;
    const data = await res.json();
    for (const d of domains) {
      const r = data[d] || data[d.toLowerCase()];
      if (r && typeof r.blocked === 'boolean') out[d] = { status: r.blocked ? 'blocked' : 'safe', source: 'skiddle-bulk' };
    }
  } catch {}
  return out;
}

// ─── TRUST POSITIF DIRECT SCRAPE (geo-blocked dari edge non-ID) ───
async function checkViaTrustPositif(domain) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
  };
  const url = `https://trustpositif.komdigi.go.id/?trpdomain=${encodeURIComponent(domain)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal, cf: { cacheTtl: 300, cacheEverything: true } });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    const lower = html.toLowerCase();
    const domainLow = domain.toLowerCase();
    for (const kw of BLOCK_KEYWORDS) {
      if (lower.includes(kw)) {
        if (lower.includes(domainLow) || lower.indexOf(kw) < 8000) {
          return { status: 'blocked', source: 'tp', matched: kw };
        }
      }
    }
    for (const kw of SAFE_KEYWORDS) {
      if (lower.includes(kw)) return { status: 'safe', source: 'tp', matched: kw };
    }
  } catch {}
  return null;
}

// ─── MULTI-SOURCE NAWALA CHECK (mirror PRIMARY, Skiddle/TP fallback) ───
async function checkNawala(domain) {
  const overallTimeout = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 10000));
  const work = (async () => {
    // PRIMARY: TP Mirror (always reliable, no rate limit)
    const mirror = await checkViaMirror(domain).catch(() => null);
    if (mirror && mirror.status === 'blocked') return mirror;
    // Verify "safe" with secondary sources kalau mirror bilang safe
    const [skid, tp] = await Promise.all([
      checkViaSkiddle(domain).catch(() => null),
      checkViaTrustPositif(domain).catch(() => null)
    ]);
    // Kalau ada source kedua bilang blocked → blocked (mirror mungkin tidak update terbaru)
    if (skid?.status === 'blocked') return { status: 'blocked', source: 'skiddle-override', confidence: 'high' };
    if (tp?.status === 'blocked') return { status: 'blocked', source: 'tp-override', confidence: 'high' };
    // Multi source agree pada safe
    if (mirror && (skid?.status === 'safe' || tp?.status === 'safe')) {
      return { status: 'safe', source: 'multi', confidence: 'high' };
    }
    if (mirror) return mirror; // mirror alone = medium confidence
    if (skid) return { ...skid, confidence: 'medium' };
    if (tp) return { ...tp, confidence: 'medium' };
    return { status: 'unknown', error: 'all methods failed', confidence: 'none' };
  })();
  const r = await Promise.race([work, overallTimeout]);
  if (r === 'TIMEOUT') return { status: 'unknown', error: 'global timeout 10s', confidence: 'none' };
  return r;
}

// ─── NAMECHEAP SCRAPE (untuk availability check) ───
async function checkViaNamecheap(domain) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(`https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(domain)}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = (await res.text()).toLowerCase();
    const regIndicators = ['registered in 19', 'registered in 20', 'make offer', 'marketplace</', 'domain is taken', 'this domain is taken', 'is unavailable'];
    for (const ind of regIndicators) {
      if (html.includes(ind)) return { status: 'registered', source: 'namecheap', matched: ind };
    }
    const domainEsc = domain.toLowerCase().replace(/\./g, '\\.');
    const rx = new RegExp(`${domainEsc}[\\s\\S]{0,1500}(?:add to cart|buy it now)`, 'i');
    if (rx.test(html)) return { status: 'available', source: 'namecheap', matched: 'add-to-cart' };
    return null;
  } catch { return null; }
}

// ─── ROUTER ───
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // ─── HEALTH & DIAGNOSTIC ───
    if (url.pathname === '/api/ping') {
      return jsonResp({ ok: true, ts: Date.now(), version: '2026-05-05-v3' });
    }

    // /api/health — comprehensive system status
    if (url.pathname === '/api/health') {
      const tests = {};
      const probe = async (name, fn) => {
        const t0 = Date.now();
        try {
          const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
          tests[name] = { ok: true, elapsed_ms: Date.now() - t0, ...r };
        } catch (e) { tests[name] = { ok: false, error: String(e).slice(0, 200), elapsed_ms: Date.now() - t0 }; }
      };
      // Probe each upstream
      await Promise.all([
        probe('skiddle', async () => {
          const r = await fetch('https://check.skiddle.id/?domain=google.com&json=true');
          return { status: r.status, content_length: r.headers.get('content-length') };
        }),
        probe('trust_positif', async () => {
          const r = await fetch('https://trustpositif.komdigi.go.id/');
          return { status: r.status };
        }),
        probe('verisign_rdap', async () => {
          const r = await fetch('https://rdap.verisign.com/com/v1/domain/google.com');
          return { status: r.status };
        }),
        probe('pir_rdap', async () => {
          const r = await fetch('https://rdap.publicinterestregistry.org/rdap/domain/google.org');
          return { status: r.status };
        }),
        probe('namecheap', async () => {
          const r = await fetch('https://www.namecheap.com/domains/registration/results/?domain=google.com');
          return { status: r.status };
        }),
        probe('github_tp_mirror', async () => {
          const r = await fetch(TP_MIRROR_URLS[0], { method: 'HEAD' });
          return { status: r.status, content_length: r.headers.get('content-length') };
        }),
        probe('mirror_size', async () => {
          const size = await getMirrorSize();
          return { size_bytes: size, ready: !!size };
        }),
        probe('gist_token_set', async () => {
          return { configured: !!env.GIST_TOKEN, gist_id_set: !!env.GIST_ID };
        }),
        probe('gemini_key_set', async () => {
          return { configured: !!env.GEMINI_KEY };
        }),
      ]);
      const allOk = Object.values(tests).every(t => t.ok);
      return jsonResp({ ok: allOk, ts: Date.now(), version: '2026-05-05-v3', tests });
    }

    // /api/debug-nawala — detail probe Skiddle + TP untuk specific domain
    if (url.pathname === '/api/debug-nawala') {
      const domain = (url.searchParams.get('domain') || 'pornhub.com').trim();
      const debug = { domain, tests: {} };
      try {
        const t0 = Date.now();
        const res = await fetch(`https://check.skiddle.id/?domain=${encodeURIComponent(domain)}&json=true`);
        debug.tests.skiddle = {
          status: res.status, ok: res.ok, elapsed_ms: Date.now() - t0,
          body: (await res.text()).slice(0, 500)
        };
      } catch (e) { debug.tests.skiddle = { error: String(e) }; }
      try {
        const t0 = Date.now();
        const res = await fetch(`https://trustpositif.komdigi.go.id/?trpdomain=${encodeURIComponent(domain)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Accept': 'text/html' }, redirect: 'follow'
        });
        debug.tests.tp = {
          status: res.status, ok: res.ok, elapsed_ms: Date.now() - t0,
          body_preview: (await res.text()).slice(0, 300)
        };
      } catch (e) { debug.tests.tp = { error: String(e) }; }
      try {
        const t0 = Date.now();
        const r = await checkViaMirror(domain);
        debug.tests.mirror = { ok: true, elapsed_ms: Date.now() - t0, ...r };
      } catch (e) { debug.tests.mirror = { error: String(e) }; }
      return jsonResp(debug);
    }

    // ─── NAWALA CHECK ENDPOINTS ───
    if (url.pathname === '/api/check-nawala') {
      const domain = (url.searchParams.get('domain') || '').trim();
      if (!domain) return jsonResp({ error: 'missing domain param' }, 400);
      const result = await checkNawala(domain);
      return jsonResp({ domain, ...result });
    }

    // /api/check-nawala-mirror — pure mirror check (no Skiddle/TP)
    // Lebih cepat, no rate limit, daily-updated dari github.com/alsyundawy/TrustPositif
    if (url.pathname === '/api/check-nawala-mirror') {
      const domain = (url.searchParams.get('domain') || '').trim();
      if (!domain) return jsonResp({ error: 'missing domain' }, 400);
      const result = await checkViaMirror(domain);
      return jsonResp({ domain, ...result });
    }

    if (url.pathname === '/api/check-nawala-bulk' && request.method === 'POST') {
      try {
        const body = await request.json();
        const domains = (body.domains || []).slice(0, 30); // reduced from 50 (mirror = 25 sub-req/domain)
        if (!domains.length) return jsonResp({ results: [] });
        // PASS 1: Skiddle bulk (kalau alive, paling efisien — 1 sub-req)
        const skidResults = await checkViaSkiddleBulk(domains);
        // PASS 2: untuk yg gagal di Skiddle, pakai mirror (HTTP Range search per-domain)
        const missing = domains.filter(d => !skidResults[d]);
        const mirrorResults = {};
        if (missing.length > 0 && missing.length <= 5) {
          // Per-domain mirror sequential (max 5 untuk avoid sub-req limit)
          for (const d of missing) {
            try {
              const r = await checkViaMirror(d);
              if (r) mirrorResults[d] = r;
            } catch {}
          }
        }
        // Compose
        const results = domains.map(d => {
          const sk = skidResults[d];
          const mr = mirrorResults[d];
          if (sk) return { domain: d, ...sk };
          if (mr) return { domain: d, ...mr };
          return { domain: d, status: 'unknown', error: 'all sources failed' };
        });
        return jsonResp({ results });
      } catch (e) {
        return jsonResp({ error: String(e) }, 400);
      }
    }

    // ─── AVAILABILITY CHECK ENDPOINTS ───
    if (url.pathname === '/api/check-availability') {
      const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
      if (!domain) return jsonResp({ error: 'missing domain' }, 400);
      const r = await checkViaNamecheap(domain);
      return jsonResp({ domain, ...(r || { status: 'unknown', error: 'parse failed' }) });
    }

    if (url.pathname === '/api/check-availability-bulk' && request.method === 'POST') {
      try {
        const body = await request.json();
        const domains = (body.domains || []).slice(0, 30);
        const results = await Promise.all(domains.map(async d => {
          const r = await checkViaNamecheap(d);
          return { domain: d, ...(r || { status: 'unknown' }) };
        }));
        return jsonResp({ results });
      } catch (e) { return jsonResp({ error: String(e) }, 400); }
    }

    // ─── GEMINI AI PROXY ───
    if (url.pathname === '/api/gemini' && request.method === 'POST') {
      const apiKey = env.GEMINI_KEY;
      if (!apiKey) return jsonResp({ error: 'GEMINI_KEY not configured in CF Pages env vars' }, 500);
      try {
        const body = await request.json();
        const model = body.model || 'gemini-2.5-flash';
        const upstream = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const { model: _m, ...payload } = body;
        const res = await fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) { return jsonResp({ error: String(e) }, 500); }
    }

    // ─── GIST SYNC PROXY ───
    if (url.pathname.startsWith('/api/gist')) {
      const token = env.GIST_TOKEN;
      const gid = env.GIST_ID;
      if (!token || !gid) {
        return jsonResp({ error: 'GIST_TOKEN / GIST_ID belum di-set di CF Pages env vars' }, 500);
      }
      const ghHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'domain-hunter-dashboard'
      };
      try {
        if (url.pathname === '/api/gist/meta') {
          const r = await fetch(`https://api.github.com/gists/${gid}`, { headers: ghHeaders });
          if (!r.ok) return jsonResp({ error: `gist meta http ${r.status}` }, r.status);
          const j = await r.json();
          return jsonResp({ updated_at: j.updated_at, files: Object.keys(j.files || {}) });
        }
        if (url.pathname === '/api/gist' && request.method === 'GET') {
          const r = await fetch(`https://api.github.com/gists/${gid}`, { headers: ghHeaders });
          if (!r.ok) return jsonResp({ error: `gist get http ${r.status}` }, r.status);
          const j = await r.json();
          const filename = 'domain-hunter-data.json';
          const file = j.files[filename] || Object.values(j.files)[0];
          if (!file) return jsonResp({ error: 'gist file kosong' }, 404);
          return jsonResp({ content: file.content, updated_at: j.updated_at, filename: file.filename });
        }
        if (url.pathname === '/api/gist' && (request.method === 'POST' || request.method === 'PATCH')) {
          const body = await request.json();
          const filename = body.filename || 'domain-hunter-data.json';
          const content = body.content;
          if (!content) return jsonResp({ error: 'missing content' }, 400);
          const r = await fetch(`https://api.github.com/gists/${gid}`, {
            method: 'PATCH',
            headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { [filename]: { content } } })
          });
          if (!r.ok) {
            const errText = await r.text();
            return jsonResp({ error: `gist patch http ${r.status}`, detail: errText.slice(0, 500) }, r.status);
          }
          const j = await r.json();
          return jsonResp({ ok: true, updated_at: j.updated_at, gist_id: j.id });
        }
        return jsonResp({ error: 'method not allowed' }, 405);
      } catch (e) { return jsonResp({ error: String(e) }, 500); }
    }

    // Static assets fallback
    return env.ASSETS.fetch(request);
  }
};
