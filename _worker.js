// Cloudflare Pages Functions - backend API + static assets fallback
// Endpoint: /api/check-nawala?domain=example.com
// Server-side fetch ke Trust Positif Kominfo — no CORS issue.

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

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

async function fetchWithRetry(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeout || 9000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if (res.status === 429 && i < retries) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
      return res;
    } catch (e) {
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  return null;
}

// Source 1: Skiddle API (single)
async function checkViaSkiddle(domain) {
  try {
    const res = await fetchWithRetry(`https://check.skiddle.id/?domain=${encodeURIComponent(domain)}&json=true`, {
      cf: { cacheTtl: 300, cacheEverything: true }, timeout: 8000
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const r = data[domain] || data[domain.toLowerCase()];
    if (!r || typeof r.blocked !== 'boolean') return null;
    return { status: r.blocked ? 'blocked' : 'safe', source: 'skiddle' };
  } catch { return null; }
}

// Source 1b: Skiddle bulk (lebih efisien)
async function checkViaSkiddleBulk(domains) {
  if (!domains.length) return {};
  const out = {};
  try {
    const url = `https://check.skiddle.id/?domains=${domains.map(encodeURIComponent).join(',')}&json=true`;
    const res = await fetchWithRetry(url, { cf: { cacheTtl: 300, cacheEverything: true }, timeout: 15000 });
    if (!res || !res.ok) return out;
    const data = await res.json();
    for (const d of domains) {
      const r = data[d] || data[d.toLowerCase()];
      if (r && typeof r.blocked === 'boolean') out[d] = { status: r.blocked ? 'blocked' : 'safe', source: 'skiddle-bulk' };
    }
  } catch {}
  return out;
}

// Source 2: Trust Positif scrape — coba 2 path URL sekaligus
async function checkViaTrustPositif(domain) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
  };
  const urls = [
    `https://trustpositif.komdigi.go.id/?trpdomain=${encodeURIComponent(domain)}`,
    `https://trustpositif.komdigi.go.id/Public/Search?term=${encodeURIComponent(domain)}`
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, { headers, redirect: 'follow', cf: { cacheTtl: 300, cacheEverything: true }, timeout: 10000 });
      if (!res || !res.ok) continue;
      const html = await res.text();
      const lower = html.toLowerCase();
      const domainLow = domain.toLowerCase();
      // Exact-match heuristic: pencarian kasus "blocked"
      for (const kw of BLOCK_KEYWORDS) {
        if (lower.includes(kw)) {
          // Konfirmasi domain juga muncul di halaman, atau block kata muncul cukup awal
          if (lower.includes(domainLow) || lower.indexOf(kw) < 8000) {
            return { status: 'blocked', source: 'tp', matched: kw };
          }
        }
      }
      for (const kw of SAFE_KEYWORDS) {
        if (lower.includes(kw)) return { status: 'safe', source: 'tp', matched: kw };
      }
    } catch {}
  }
  return null;
}

// Source 3: DNS via DoH dengan Indonesian filtering DNS resolver
// Family Cloudflare DNS (1.1.1.3) filter adult+malware tapi gak Trust Positif specific
// AdGuard family (94.140.14.15) juga gak Indonesian
// Skip — DNS-based unreliable untuk Trust Positif
async function checkViaDNSResolve(domain) {
  // Pakai Quad9 dengan filter (9.9.9.9) sebagai signal tambahan
  // Status:3 (NXDOMAIN) di filter resolver = potentially blocked
  // Tapi masih unreliable untuk Indonesia, jadi cuma sinyal lemah
  try {
    const res = await fetchWithRetry(
      `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: 'application/dns-json' }, timeout: 4000 }
    );
    if (!res || !res.ok) return null;
    const j = await res.json();
    if (j.Status === 3) return { status: 'maybe_blocked', source: 'dns-quad9' };
    if (typeof j.Status === 'number') return { status: 'safe', source: 'dns-quad9' };
  } catch {}
  return null;
}

// Multi-source check dengan agreement logic
async function checkNawala(domain) {
  // Run sumber paralel untuk speed
  const [skid, tp] = await Promise.all([
    checkViaSkiddle(domain),
    checkViaTrustPositif(domain)
  ]);

  // Agreement: 2 source confirm = high confidence
  if (skid && tp && skid.status === tp.status) {
    return { status: skid.status, source: 'skiddle+tp', confidence: 'high' };
  }
  // Skiddle alone (most reliable)
  if (skid) return { ...skid, confidence: 'medium' };
  // TP alone
  if (tp) return { ...tp, confidence: 'medium' };
  // Last resort
  return { status: 'unknown', error: 'all methods failed', confidence: 'none' };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ping') {
      return jsonResp({ ok: true, ts: Date.now() });
    }

    if (url.pathname === '/api/check-nawala') {
      const domain = (url.searchParams.get('domain') || '').trim();
      if (!domain) return jsonResp({ error: 'missing domain param' }, 400);
      const result = await checkNawala(domain);
      return jsonResp({ domain, ...result });
    }

    // Gemini AI proxy — key disimpan server-side di env.GEMINI_KEY
    // Body: { model?: 'gemini-2.5-flash', contents: [...] }
    if (url.pathname === '/api/gemini' && request.method === 'POST') {
      const apiKey = env.GEMINI_KEY;
      if (!apiKey) return jsonResp({ error: 'GEMINI_KEY not configured in CF Pages env vars' }, 500);
      try {
        const body = await request.json();
        const model = body.model || 'gemini-2.5-flash';
        const upstream = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        // Strip 'model' field from body before forwarding (Gemini API doesn't expect it)
        const { model: _m, ...payload } = body;
        const res = await fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return jsonResp({ error: String(e) }, 500);
      }
    }

    if (url.pathname === '/api/check-nawala-bulk' && request.method === 'POST') {
      try {
        const body = await request.json();
        const domains = (body.domains || []).slice(0, 50); // bumped from 20
        if (!domains.length) return jsonResp({ results: [] });

        // Pass 1: Skiddle bulk (fastest)
        const bulkRes = await checkViaSkiddleBulk(domains);
        const missing = domains.filter(d => !bulkRes[d]);

        // Pass 2: per-domain checkNawala (paralel) untuk yg gagal di bulk
        const fallbackResults = {};
        if (missing.length) {
          const checks = await Promise.all(missing.map(d => checkNawala(d).then(r => [d, r])));
          for (const [d, r] of checks) fallbackResults[d] = r;
        }

        const results = domains.map(d => ({ domain: d, ...(bulkRes[d] || fallbackResults[d] || { status: 'unknown' }) }));
        return jsonResp({ results });
      } catch (e) {
        return jsonResp({ error: String(e) }, 400);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // GitHub Gist proxy — token disimpan di env.GIST_TOKEN (server-side)
    // Endpoint:
    //   GET  /api/gist           → fetch gist content (read sync data)
    //   POST /api/gist           → update gist content (push sync data)
    //   GET  /api/gist/meta      → fetch updated_at timestamp (cek freshness)
    // ════════════════════════════════════════════════════════════════
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
        // META: cuma return updated_at (lightweight check kalau Gist lebih baru dari local)
        if (url.pathname === '/api/gist/meta') {
          const r = await fetch(`https://api.github.com/gists/${gid}`, { headers: ghHeaders });
          if (!r.ok) return jsonResp({ error: `gist meta http ${r.status}` }, r.status);
          const j = await r.json();
          return jsonResp({ updated_at: j.updated_at, files: Object.keys(j.files || {}) });
        }
        // GET: return file content (untuk pull)
        if (url.pathname === '/api/gist' && request.method === 'GET') {
          const r = await fetch(`https://api.github.com/gists/${gid}`, { headers: ghHeaders });
          if (!r.ok) return jsonResp({ error: `gist get http ${r.status}` }, r.status);
          const j = await r.json();
          const filename = 'domain-hunter-data.json';
          const file = j.files[filename] || Object.values(j.files)[0];
          if (!file) return jsonResp({ error: 'gist file kosong' }, 404);
          // Return file content + metadata
          return jsonResp({ content: file.content, updated_at: j.updated_at, filename: file.filename });
        }
        // POST/PATCH: update gist (untuk push)
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
      } catch (e) {
        return jsonResp({ error: String(e) }, 500);
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
// rebuild 1776749098
