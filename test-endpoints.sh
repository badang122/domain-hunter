#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Domain Hunter Dashboard — API Endpoints Test Suite
# ═══════════════════════════════════════════════════════════════
# Usage: ./test-endpoints.sh [BASE_URL]
# Default base URL: https://domain-hunter-2pp.pages.dev

BASE="${1:-https://domain-hunter-2pp.pages.dev}"
PASS=0
FAIL=0
SKIP=0

# Colors (POSIX-friendly)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════════════"
echo " Domain Hunter API Test Suite — $BASE"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Test helper
test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expect="$4"   # regex untuk match response body
  local data="$5"     # POST body (optional)
  local timeout="${6:-15}"

  printf "${BLUE}TEST${NC} %-50s " "$name"

  local opts="-s -m $timeout -w \nHTTP_CODE:%{http_code}\nTIME:%{time_total}\n"
  local resp
  if [ "$method" = "POST" ]; then
    resp=$(curl $opts -X POST -H "Content-Type: application/json" -d "$data" "$BASE$path" 2>&1)
  else
    resp=$(curl $opts "$BASE$path" 2>&1)
  fi

  local code=$(echo "$resp" | grep -oE 'HTTP_CODE:[0-9]+' | tail -1 | cut -d: -f2)
  local time=$(echo "$resp" | grep -oE 'TIME:[0-9.]+' | tail -1 | cut -d: -f2)
  local body=$(echo "$resp" | sed '/^HTTP_CODE:/,$d')

  if [ "$code" = "200" ] && echo "$body" | grep -qE "$expect"; then
    printf "${GREEN}✓ PASS${NC} (${time}s, http $code)\n"
    PASS=$((PASS+1))
  elif [ "$code" = "500" ] && [ "$expect" = "ALLOW_500" ]; then
    printf "${YELLOW}⚠ SKIP${NC} (env not set, http 500)\n"
    SKIP=$((SKIP+1))
  else
    printf "${RED}✗ FAIL${NC} (http $code, ${time}s)\n"
    echo "  Body: $(echo "$body" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

# ─── Core endpoints ───
test_endpoint "GET /api/ping"                    GET  "/api/ping"                          '"ok":true'
test_endpoint "GET /api/health"                  GET  "/api/health"                        '"ok":'

# ─── Nawala check ───
test_endpoint "GET /api/check-nawala-mirror (porn domain)"     GET  "/api/check-nawala-mirror?domain=pornhub.com"    '"status":'  ''  20
test_endpoint "GET /api/check-nawala-mirror (safe domain)"     GET  "/api/check-nawala-mirror?domain=google.com"     '"status":"safe"'  ''  20
test_endpoint "GET /api/check-nawala?domain=google.com"        GET  "/api/check-nawala?domain=google.com"            '"domain":"google.com"'  ''  15
test_endpoint "POST /api/check-nawala-bulk (3 domains)"        POST "/api/check-nawala-bulk"                         '"results":'  '{"domains":["google.com","pornhub.com","reddit.com"]}'  20
test_endpoint "GET /api/debug-nawala?domain=pornhub.com"       GET  "/api/debug-nawala?domain=pornhub.com"           '"tests":'

# ─── Availability check ───
test_endpoint "GET /api/check-availability?domain=google.com"  GET  "/api/check-availability?domain=google.com"      '"status":'

# ─── Gist (akan 500 kalau env tidak set) ───
test_endpoint "GET /api/gist/meta"                             GET  "/api/gist/meta"                                  '"updated_at":'

# ─── Summary ───
echo ""
echo "═══════════════════════════════════════════════════════════"
TOTAL=$((PASS+FAIL+SKIP))
printf " Total: $TOTAL · ${GREEN}Pass: $PASS${NC} · ${RED}Fail: $FAIL${NC} · ${YELLOW}Skip: $SKIP${NC}\n"
echo "═══════════════════════════════════════════════════════════"

[ $FAIL -eq 0 ] && exit 0 || exit 1
