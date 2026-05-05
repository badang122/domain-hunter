# Domain Hunter Dashboard

Dashboard untuk track expired/aged domain hunting — DA, PA, DR, BL, Age, Nawala, Score, Status, Notes.

**Production**: https://domain-hunter-2pp.pages.dev/

## ⚡ Quick Start

```bash
git clone https://github.com/badang122/domain-hunter.git
cd domain-hunter
# Edit index.html (frontend) atau _worker.js (backend)
git push origin main  # auto-deploy ke CF Pages ~60s
```

Test endpoints (live):
```bash
chmod +x test-endpoints.sh
./test-endpoints.sh
```

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  Browser (User di Indonesia)                 │
│  • localStorage primary  • IndexedDB backup                  │
│  • index.html (~9000 lines vanilla JS)                       │
└──────────────────────────────┬───────────────────────────────┘
                               │ /api/*
                               ▼
┌──────────────────────────────────────────────────────────────┐
│         Cloudflare Pages Function (_worker.js)               │
│  • Server-side proxy: Nawala, Namecheap, Gemini, Gist        │
│  • Env vars: GIST_TOKEN, GIST_ID, GEMINI_KEY (encrypted)     │
└──────┬─────────────┬──────────────┬───────────────┬──────────┘
       │             │              │               │
       ▼             ▼              ▼               ▼
   ┌──────┐  ┌─────────────┐  ┌──────────┐  ┌────────────┐
   │ TP   │  │  Namecheap  │  │  Gemini  │  │ GitHub     │
   │Mirror│  │ search HTML │  │   API    │  │   Gist     │
   │GitHub│  │   scrape    │  │  proxy   │  │ cross-sync │
   └──────┘  └─────────────┘  └──────────┘  └────────────┘
```

**Storage layers** (resilience):
1. localStorage primary — fast, persists in browser
2. localStorage backup — auto-mirror
3. IndexedDB — survives cache clear
4. GitHub Gist — cross-device sync (auto pull/push)

## 🎯 API Endpoints (`_worker.js`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/ping` | GET | Health check ringan |
| `/api/health` | GET | Comprehensive system status |
| `/api/check-nawala-mirror?domain=X` | GET | **PRIMARY**: pakai TP mirror GitHub |
| `/api/check-nawala?domain=X` | GET | Multi-source: mirror + Skiddle + TP scrape |
| `/api/check-nawala-bulk` | POST | Bulk Nawala (max 50) |
| `/api/debug-nawala?domain=X` | GET | Diagnostic per source |
| `/api/check-availability?domain=X` | GET | Namecheap scrape authoritative |
| `/api/check-availability-bulk` | POST | Bulk Namecheap (max 30) |
| `/api/gemini` | POST | Gemini AI proxy |
| `/api/gist` | GET/POST | Sync proxy |
| `/api/gist/meta` | GET | Gist metadata |

## 🚀 Deploy Pipeline

1. Edit `index.html` atau `_worker.js`
2. `git add . && git commit -m "..." && git push origin main`
3. CF Pages auto-rebuild ~60 detik

**Source mirror pattern**: Code utama di `C:\Users\user12\ahrefs_checker\netlify_index.html`. Sebelum push, copy ke `domain-hunter-repo/index.html`.

## 🔐 Cloudflare Pages Environment Variables

Set di Cloudflare Dashboard → Workers & Pages → `domain-hunter` → Settings → Environment variables:

| Variable | Type | Purpose |
|---|---|---|
| `GIST_TOKEN` | secret_text | GitHub PAT scope=gist |
| `GIST_ID` | plain_text | Target Gist ID |
| `GEMINI_KEY` | secret_text | Google Gemini API |

## ✨ Fitur Utama

### Domain Tracking
- Tabel 16+ kolom dengan sort & filter
- Search super (domain + RD list + GoodBL + Notes + Tags)
- Sticky header

### Auto-Status by Expiry Date
5 kategori auto-derived dari `expiryDate`:
- ✅ aman (>90 hari)
- ⚠️ warning (31-90 hari)
- 🚨 urgent (≤30 hari)
- 💀 expired (sudah lewat)
- — belum lengkap (no expiry)

Klik pill → filter tabel, counter live update.

### Nawala Check (Trust Positif)
- 🚀 Auto-Gen 4-pass (mirror → Skiddle bulk → server → retry)
- 🇮🇩 Real Verify via iframe TP
- Per-row delete + bulk delete by filter
- Cross-validation multi-source

**Real solution**: pakai TP mirror dari GitHub repo `alsyundawy/TrustPositif` (updated daily) sebagai primary source — lebih reliable dari Skiddle yang sering down.

### Availability Check
- Multi-pass: RDAP per-TLD + DNS multi-provider
- **FINAL VERIFY** via Namecheap scrape (fix .org false positives)
- Binary status: Available / Registered

### AI Tools (Gemini)
Summary · Top 5 · Berisiko · Strategi · Smart Buy · Portfolio Valuation · Outreach Email · Trend Score · Screenshot OCR.

### Cross-Device Sync (Gist)
- Hybrid: server primary, direct GitHub fallback
- Auto-pull on page load (Gist newer than local)
- Auto-push 8s debounce
- beforeunload flush dengan keepalive

## 🧪 Testing

```bash
./test-endpoints.sh                                # production
./test-endpoints.sh https://preview.pages.dev      # preview
```

Test coverage:
- All `/api/*` endpoints respond 200
- Mirror returns `blocked` untuk porn domain
- Mirror returns `safe` untuk google.com
- Bulk endpoints accept POST + return correct shape
- Health endpoint reports all upstream status

## 📖 Documentation

- [README.md](README.md) — overview (file ini)
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design detail
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common issues & fixes

## 📊 Status

- Domains tracked: 700+
- Hosting: Cloudflare Pages (free tier)
- Cost: $0/month
- Security: Tier 2 (PAT server-side via env vars + char-code fallback)

---

*Built dengan Claude Opus 4.7 · Badang 2026*
