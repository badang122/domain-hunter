# Troubleshooting — Domain Hunter Dashboard

Common issues + diagnostic + solutions.

## 🔬 First Step: Health Check

Buka di browser:
```
https://domain-hunter-2pp.pages.dev/api/health
```

Atau via curl:
```bash
curl -s https://domain-hunter-2pp.pages.dev/api/health | python -m json.tool
```

Output akan tampilkan status semua upstream service. `ok: true` semua = healthy.

---

## 🚨 Issue: Auto-Gen Nawala gagal (semua "Belum")

**Symptoms**: Klik 🚀 Auto-Gen → progress jalan, tapi semua hasil "Belum dicek" / failed.

**Diagnosis**:
```
curl 'https://domain-hunter-2pp.pages.dev/api/debug-nawala?domain=pornhub.com'
```

**Possible causes & fixes**:

### A. Skiddle.id down (CF error 1016)
Skiddle service-side outage — DNS error di sisi mereka. Tidak bisa diperbaiki dari dashboard.

**Solution**: Sudah handled — `/api/check-nawala-bulk` otomatis fallback ke TP mirror (GitHub `alsyundawy/TrustPositif`). Pastikan latest worker version live:
```bash
curl -s https://domain-hunter-2pp.pages.dev/api/ping | grep version
# Should return version >= "2026-05-05-v3"
```

### B. TP mirror gagal load
Worker tidak bisa fetch GitHub raw blocklist file.

**Diagnosis**:
```bash
curl https://domain-hunter-2pp.pages.dev/api/health | python -c "
import sys,json; d=json.load(sys.stdin); print(d['tests']['github_tp_mirror'], d['tests']['blocklist_loaded'])
"
```

**Solution**:
- Kalau `github_tp_mirror.ok = false` → GitHub down (rare). Wait & retry.
- Kalau `blocklist_loaded.count = 0` → parse error. Check worker logs di CF Pages dashboard.

### C. CF Worker timeout
Worker hang lebih dari 30s.

**Solution**: Worker sekarang punya hard timeout 10s di `checkNawala()`. Kalau masih hang, redeploy:
```bash
git commit --allow-empty -m "trigger redeploy"
git push origin main
```

---

## 🚨 Issue: .org domain mark "Available" padahal di Namecheap "Registered"

**Cause**: PIR RDAP untuk .org kadang return 404 untuk domain parked/redemption padahal registered.

**Solution**: Sudah handled via `FINAL VERIFY` pass — setelah Check Available, semua "available" candidates di-cross-check via Namecheap scrape (`/api/check-availability-bulk`). Override jadi "registered" kalau Namecheap konfirmasi.

**Verify**: Check Available result table — domain harus tampil dengan icon source. Kalau ada `verifiedSource: 'namecheap'` di results, berarti final verify pass jalan.

---

## 🚨 Issue: Cross-device sync gagal

**Symptoms**: Edit di Device A, refresh Device B, data tidak update.

**Diagnosis**:
```
# Check Gist endpoint
curl https://domain-hunter-2pp.pages.dev/api/gist/meta
```

Should return `{"updated_at": "...", "files": [...]}`.

**Possible causes**:

### A. Env vars tidak ke-set
Worker can't authenticate to GitHub Gist.

**Symptom**: Endpoint return `{"error": "GIST_TOKEN / GIST_ID belum di-set..."}`.

**Solution**: Set env vars di CF Pages dashboard:
1. Buka https://dash.cloudflare.com → Workers & Pages → `domain-hunter`
2. Settings → Environment variables
3. Add:
   - `GIST_TOKEN` (secret_text) = `ghp_...`
   - `GIST_ID` (plain_text) = `6187f6461dd155b9cd74b6b2c78e4bbd`
4. Save → Retry deployment

Atau via API:
```bash
curl -X PATCH \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deployment_configs":{"production":{"env_vars":{"GIST_TOKEN":{"value":"ghp_...","type":"secret_text"}}}}}' \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/domain-hunter"
```

### B. Token GitHub expired / revoked
Gist API return 401.

**Solution**: Generate PAT baru:
1. https://github.com/settings/tokens
2. Generate new token (classic), scope = `gist`
3. Update env var `GIST_TOKEN` di CF Pages

### C. Sync conflict (race condition)
Dua device edit bersamaan.

**Resolution**: Last-write-wins. Untuk avoid, hindari edit bersamaan dari multi-device. Atau gunakan Settings → Cloud Sync → Pull Now di device kedua sebelum edit.

---

## 🚨 Issue: Login bypass via DevTools

**Symptom**: User non-admin dapat akses admin panel via JS console.

**Status**: Known limitation. Auth current adalah client-side only — bypass-able via:
```js
localStorage.setItem('dashboard_session', JSON.stringify({username:'admin',role:'admin'}))
location.reload()
```

**Why acceptable**: Dashboard untuk personal use. URL tidak public-shared.

**Real solution (kalau perlu)**: Migrate ke Supabase Auth (Tier 3 security):
- Real JWT token via OAuth
- Server-validated session
- Row Level Security per-user
- Cost: $0 free tier
- Effort: ~4-8 jam migrasi code

---

## 🚨 Issue: Stat values invisible di light mode

**Status**: Fixed in commit `fix(light): stat-value text invisible — override webkit-text-fill-color`.

**Root cause**: `.stat-value { -webkit-text-fill-color: white !important }` overrided `color` rule. Even kalau body.light set color #0f172a, webkit-text-fill takes priority.

**Fix**: Scope rule putih ke `body:not(.light)` saja, plus explicit `body.light .stat-value { -webkit-text-fill-color: #0f172a !important }`.

---

## 🚨 Issue: Tabel terasa silau / sakit mata

**Status**: Fixed in commits `ui(table): soften colors`, `ui(calm): minimalist desaturated theme`, `ui(light): soften pure white`.

**Improvements applied**:
- Pure white #ffffff → off-white #f5f7fa (light mode)
- Saturated colors → pastel low-opacity
- Multi-color stat accents → single indigo soft uniform
- Form section gradient → flat neutral
- RDP-friendly: solid hex bg (dark mode) bukan opacity-based

Kalau masih terasa loud, screenshot bagian spesifik untuk targeted fix.

---

## 🚨 Issue: Worker timeout (slow response)

**Symptom**: `/api/check-nawala?domain=X` takes >10s atau timeout.

**Diagnosis**:
```bash
curl -w "\ntime: %{time_total}s\n" https://domain-hunter-2pp.pages.dev/api/check-nawala?domain=google.com
```

**Solution**: Worker has hard timeout 10s. Kalau hit timeout, return `{status: "unknown", error: "global timeout 10s"}` — frontend akan retry via fallback paths.

---

## 🛠️ Reset / Recovery

### Force re-sync from Gist (kalau localStorage corrupt)
DevTools console:
```js
localStorage.clear()
location.reload()
// Auto-pull dari Gist akan trigger setelah ~2.5s
```

### Force update password hash (after password rotation)
```js
localStorage.removeItem('dashboard_members_version')
location.reload()
```

### Wipe all & reset (nuclear option)
```js
indexedDB.deleteDatabase('domainhunter_db')
localStorage.clear()
location.reload()
// Akan show login modal — login dengan default admin/1901Fcbarcelona
// Sync from Gist akan auto-restore data
```

---

## 📞 Diagnostic Toolkit

### Lihat semua status
```bash
curl -s https://domain-hunter-2pp.pages.dev/api/health | python -m json.tool
```

### Test specific domain
```bash
curl 'https://domain-hunter-2pp.pages.dev/api/debug-nawala?domain=pornhub.com'
```

### Run all endpoint tests
```bash
./test-endpoints.sh
```

### Check version deployed
```bash
curl -s https://domain-hunter-2pp.pages.dev/api/ping | python -c "import sys,json; print(json.load(sys.stdin)['version'])"
```

### Check Gist last sync
DevTools console:
```js
new Date(parseInt(localStorage.getItem('dashboard_gist_lastsync')))
```

---

*Troubleshooting guide updated 2026-05-05*
