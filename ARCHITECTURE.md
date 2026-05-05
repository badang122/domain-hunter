# Architecture — Domain Hunter Dashboard

System design detail untuk dashboard domain hunting.

## 🎯 Design Goals

1. **Zero infrastructure cost** — pakai free tier (CF Pages, GitHub, Gist)
2. **Cross-device sync** — buka dimana saja, data sama
3. **No backend required** — pure static HTML + serverless function
4. **Resilient storage** — multi-layer (4 redundancy)
5. **Real-time accurate Nawala/availability check** — multiple data sources

## 🏗️ Stack

```
Frontend:    Vanilla HTML/CSS/JS (~9000 lines, no framework)
Backend:     Cloudflare Pages Functions (_worker.js)
Storage:     localStorage + IndexedDB + GitHub Gist
Hosting:     Cloudflare Pages (free tier, edge global)
Source ctrl: GitHub (badang122/domain-hunter)
```

## 📁 Repo Structure

```
domain-hunter/
├── index.html              # Frontend (~9000 lines)
├── _worker.js              # Backend CF Pages Function
├── README.md               # Overview
├── ARCHITECTURE.md         # System design (file ini)
├── TROUBLESHOOTING.md      # Common issues
├── test-endpoints.sh       # API smoke tests
└── .gitignore
```

## 🔄 Request Flow

### 1. Page Load
```
Browser → cdn.cloudflare.pages-edge.com
       → index.html (cached, ~9000 lines)
       → JS init: showLogin() / showDashboard()
       → setTimeout 2.5s: auto-pull dari /api/gist/meta
       → kalau Gist newer → /api/gist GET → restore localStorage → reload
```

### 2. Add Domain
```
User klik "Tambah Domain"
       → addDomain() di index.html
       → localStorage.setItem('dashboard_custom_domains', ...)
       → trigger _idbSet() (mirror IDB)
       → trigger gistAutoPush() — debounce 8s
       → 8s later: fetch('/api/gist', POST) → CF Worker → GitHub Gist API
       → push success → localStorage.setItem('dashboard_gist_lastsync', Date.now())
```

### 3. Nawala Auto-Gen Belum Dicek
```
User klik 🚀 Auto-Gen
       → autoGenerateAllNawala()
       → Loop batch 50 domain:
         PASS 1: fetch('/api/check-nawala-bulk', POST)
                 → Worker: loadBlocklist() (lazy, 1x per isolate)
                          → fetch GitHub raw blocklist (38MB cached 24h)
                          → parse to Set (~1.5M entries)
                 → Worker: domain.toLowerCase() ∈ Set?
                          → blocked / safe per-domain
                 → Worker: cross-verify "safe" via Skiddle (kalau available)
         PASS 2-4: fallback chain kalau pass 1 ada gagal
       → save meta tiap domain → trigger autoPush
```

### 4. Cross-Device Sync
```
Device A: edit domain → autoPush 8s → /api/gist POST → Gist updated_at = T1
Device B: page load → /api/gist/meta → updated_at: T1 > local lastSync (T0)
        → /api/gist GET → restore localStorage → reload
        → Device B sekarang sync
```

## 💾 Storage Schema

### localStorage keys
```
dashboard_custom_domains       — array of {domain, da, pa, ss, age, dr, ur, bl, rd, ...}
dashboard_custom_domains_backup — mirror dari primary
dashboard_custom_domains_timestamp — last save Date.now()
dashboard_meta                 — {[domain]: {tags, expiryDate, rating, nawala, ...}}
dashboard_deleted_domains      — array of domain strings (soft-deleted)
dashboard_blocked_domains      — array of domain strings (permanent blocked)
dashboard_nawala_history       — {[domain]: {status, when}}
dashboard_session              — {username, role, loginAt}
dashboard_members              — array of {username, password (hash), role, created}
dashboard_admin_master_pwd     — sha256 hash (for Members panel access)
dashboard_gist_lastsync        — Date.now() of last sync
dashboard_gist_token           — fallback PAT (encoded char-code)
dashboard_gist_id              — fallback Gist ID
dashboard_gist_autosync        — '1' atau ''
```

### IndexedDB stores (`domainhunter_db`)
```
custom_domains  — mirror localStorage primary
meta            — mirror dashboard_meta
deleted         — mirror dashboard_deleted_domains
```

### Gist content (single file `domain-hunter-data.json`)
```json
{
  "version": "2.2",
  "exportedAt": "2026-05-05T...",
  "custom_domains": [...],
  "meta": {...},
  "deleted": [...],
  "blocked": [...],
  "favorites": [...],
  "nawalaHistory": {...}
}
```

## 🔌 API Layer (`_worker.js`)

Cloudflare Pages Function handle `/api/*` paths. Static asset (`index.html`, `*.css`, dll) served by `env.ASSETS`.

### Lazy-loaded blocklist
```js
let _blocklistPromise = null; // singleton per isolate
async function loadBlocklist() {
  if (_blocklistPromise) return _blocklistPromise; // cached
  _blocklistPromise = (async () => {
    const set = new Set();
    for (const url of TP_MIRROR_URLS) {
      const res = await fetch(url, { cf: { cacheTtl: 86400 }});
      const text = await res.text();
      text.split('\n').forEach(line => {
        const d = line.trim().toLowerCase();
        if (d && !d.startsWith('#')) set.add(d);
      });
    }
    return set;
  })();
  return _blocklistPromise;
}
```

CF Worker isolate reuse → first request loads 38MB, subsequent <1ms (Set lookup O(1)).

### Multi-source agreement (Nawala)
```
Source 1: TP Mirror (GitHub, daily updated)        — primary, no rate limit
Source 2: Skiddle API (api.skiddle.id)             — cross-verify (kalau alive)
Source 3: Trust Positif scrape direct              — fallback (geo-block dari edge)

Decision tree:
  - Mirror = blocked → BLOCKED (high confidence)
  - Skiddle/TP = blocked (override mirror safe) → BLOCKED (catch new entries)
  - Mirror = safe + Skiddle/TP = safe → SAFE (high)
  - Mirror = safe alone → SAFE (medium)
  - All sources fail → UNKNOWN
```

### Multi-source agreement (Availability)
```
Source 1: Verisign RDAP (.com, .net)
Source 2: PIR RDAP (.org)
Source 3: Other TLD-specific RDAP servers
Source 4: DNS multi-provider (Google + Cloudflare DoH)
Source 5: Namecheap scrape (FINAL VERIFY)

Decision:
  - DNS resolve any record → REGISTERED (immediate)
  - RDAP returns 200 → REGISTERED
  - RDAP returns 404 + DNS unanimous NXDOMAIN → AVAILABLE candidate
  - FINAL VERIFY: Namecheap scrape kalau "REGISTERED IN" → override AVAILABLE → REGISTERED
```

## 🛡️ Security Model

### Tier 1: Client-side auth (current)
- Login modal di JS, password SHA-256 + `_domainsalt`
- Session di localStorage
- **Bypass-able** via DevTools — purely UX gate, NOT real security
- Acceptable untuk personal use, low-sensitivity data

### Tier 2: Token server-side (current)
- GitHub PAT moved to CF Pages env vars (encrypted)
- Client never sees token (calls `/api/gist`)
- Fallback: char-code-encoded PAT in HTML kalau env not set (graceful degrade)

### Tier 3: Real auth (future, kalau perlu)
- Supabase / Firebase Auth
- Real JWT, session expiry, MFA
- Per-row RLS untuk multi-user
- Cost: $0 free tier, scale dengan usage

## 🧪 Testing Strategy

### Smoke tests (`test-endpoints.sh`)
Auto-curl tiap `/api/*` endpoint, verify:
- HTTP 200
- Response body match expected pattern (regex)
- Latency < timeout

Run via:
```bash
./test-endpoints.sh
```

### Health endpoint (`/api/health`)
Live diagnostic — probe semua upstream services:
```json
{
  "ok": true/false,
  "tests": {
    "skiddle":          {"ok": false, "elapsed_ms": 34, "error": "1016"},
    "trust_positif":    {"ok": false, "elapsed_ms": 20929, "status": 522},
    "verisign_rdap":    {"ok": true,  "elapsed_ms": 120,  "status": 200},
    "pir_rdap":         {"ok": true,  "elapsed_ms": 180,  "status": 200},
    "namecheap":        {"ok": true,  "elapsed_ms": 350,  "status": 200},
    "github_tp_mirror": {"ok": true,  "elapsed_ms": 95,   "status": 200},
    "blocklist_loaded": {"ok": true,  "count": 1450000},
    "gist_token_set":   {"ok": true,  "configured": true},
    "gemini_key_set":   {"ok": true,  "configured": true}
  }
}
```

### Manual UAT
- Add domain → check sync to Gist
- Edit on device A → reload device B → confirm propagation
- Delete domain → check moved to deleted list
- Restore deleted → confirm re-appear

## 🚀 Deploy

### Auto-deploy (recommended)
```bash
git push origin main
# CF Pages detect push → build ~60s → live
```

### Manual deploy via wrangler (advanced)
```bash
npx wrangler pages deploy . --project-name=domain-hunter
```

### Verify deploy
```bash
curl https://domain-hunter-2pp.pages.dev/api/ping
# → {"ok":true,"ts":...,"version":"..."}
```

## 📈 Scale Considerations

Current setup tested up to **5,000 domains** in dashboard. Beyond that:

| Issue | Threshold | Solution |
|---|---|---|
| Gist file size | > 1MB JSON | Migrate to GitHub raw repo (10MB) atau Supabase |
| localStorage limit | ~5-10MB browser dependent | IndexedDB primary instead of localStorage |
| Nawala bulk batch | > 50/call | Sudah handled via batching loop |
| Browser memory | > 10K rows | Virtual scrolling (react-window equivalent) |
| Search performance | > 10K rows | Add fuzzy index (e.g., Fuse.js) |

## 🔧 Performance Optimizations

1. **CF Pages caching**: static assets cached at edge, near-zero latency for repeat visits
2. **Worker isolate reuse**: blocklist Set persists across requests in same isolate
3. **CF cache for sub-requests**: `cf: { cacheTtl: ... }` — TP mirror cached 24h
4. **localStorage primary path**: zero network for reads
5. **Gist push debouncing**: 8s window — coalesce burst writes
6. **DNS check parallel**: 8 providers simultaneous via Promise.all

## 🐛 Known Limitations

- Skiddle.id sering down (per 2026-05-05) → mitigated via TP mirror primary
- Trust Positif scrape geo-blocked dari CF edge non-Indonesia → tidak dipakai sebagai primary
- PIR RDAP for .org sometimes inaccurate → mitigated via Namecheap final verify
- Login bypass-able via DevTools → acceptable untuk personal tool

---

*Architecture documented 2026-05-05*
