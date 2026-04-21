# Domain Hunter Dashboard

SEO metrics tracker untuk expired/aged domain hunting.

## Live

- **Cloudflare Pages**: https://domain-hunter.pages.dev/ (auto-deployed dari push)
- **Workers (legacy)**: https://domain-hunter.badangxdirot19.workers.dev/

## Fitur Utama

- 📊 Dashboard DA/PA/DR/UR/BL/Age/Score/Status
- 🔴 Nawala auto-check via Skiddle API + backend `/api/check-nawala`
- 🤖 Multi-provider AI (Groq/Gemini/OpenRouter/Claude)
- 🏠 Property Modal: Deal Tracker, Tags, Pin, Expiry
- 🏆 Leaderboard Top Domains (multiple metrics)
- ⚖️ Compare up to 4 domains
- 📥 Bulk Excel/CSV Import
- 💱 Currency Toggle (IDR/USD)
- 🍅 Pomodoro Timer + 📌 Sticky Notes
- ↩️ Undo/Redo (Ctrl+Z)
- 🌐 Multi-bahasa (12 bahasa)
- 📱 Mobile responsive
- ⌨️ Keyboard shortcuts (tekan `?`)

## Tech Stack

- Vanilla HTML/CSS/JS (no framework)
- Cloudflare Pages + Worker Functions
- localStorage untuk persistence
- Chart.js (CDN)
- SheetJS (CDN) untuk Excel import

## Files

- `index.html` — dashboard frontend (~5000 lines)
- `_worker.js` — Cloudflare Worker entry point (backend API)

## Deploy

Push ke main branch → auto-deploy ke Cloudflare Pages.

---

*Built with Claude Opus 4.7 · Badang 2026*
