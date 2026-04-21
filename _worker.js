// Cloudflare Pages Functions - backend API + static assets fallback
// Endpoint: /api/check-nawala?domain=example.com
// Server-side fetch ke Trust Positif Kominfo — no CORS issue.

const BLOCK_KEYWORDS = [
  'terblokir', 'site has been blocked', 'diblokir',
  'kominfo telah memblokir', 'konten negatif',
  'situs ini diblokir', 'telah diblokir'
];
const SAFE_KEYWORDS = [
  'tidak terblokir', 'not blocked', 'tidak ditemukan',
  'not found in database', 'aman diakses', 'domain tidak terdaftar'
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

async function checkNawala(domain) {
  const tpUrl = `https://trustpositif.komdigi.go.id/?trpdomain=${encodeURIComponent(domain)}`;
  try {
    const res = await fetch(tpUrl, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });
    if (!res.ok) return { status: 'error', httpStatus: res.status };
    const html = await res.text();
    const lower = html.toLowerCase();
    const domainLow = domain.toLowerCase();

    for (const kw of BLOCK_KEYWORDS) {
      if (lower.includes(kw)) {
        if (lower.includes(domainLow) || lower.indexOf(kw) < 5000) {
          return { status: 'blocked', matched: kw };
        }
      }
    }
    for (const kw of SAFE_KEYWORDS) {
      if (lower.includes(kw)) return { status: 'safe', matched: kw };
    }
    return { status: 'unknown', htmlLength: html.length };
  } catch (e) {
    return { status: 'error', error: String(e) };
  }
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

    if (url.pathname === '/api/check-nawala-bulk' && request.method === 'POST') {
      try {
        const body = await request.json();
        const domains = (body.domains || []).slice(0, 20);
        const results = await Promise.all(domains.map(d => checkNawala(d).then(r => ({ domain: d, ...r }))));
        return jsonResp({ results });
      } catch (e) {
        return jsonResp({ error: String(e) }, 400);
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
