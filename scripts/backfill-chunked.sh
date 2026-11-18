#!/bin/bash
# Chunked, polite backfill: many small batches beat one long burst
# because Cloudflare escalates on sustained automated traffic.
# Headful real Chrome pinned via CF_START_MODE — best pass rate once flagged.
cd "$(dirname "$0")/.."
TOTAL_BATCHES=${1:-12}
export CF_START_MODE=chrome-headful
export CF_FRESH_SESSION=1
for i in $(seq 1 "$TOTAL_BATCHES"); do
  echo "===== BATCH $i/$TOTAL_BATCHES ($(date +%H:%M:%S)) ====="
  node scripts/fetch-statements.mjs --limit 6 --delay 15000
  LEFT=$(ls data/statements | wc -l | tr -d ' ')
  echo "statements on disk: $LEFT"
  [ "$LEFT" -ge 122 ] && echo "all statements fetched" && break
  [ "$i" -lt "$TOTAL_BATCHES" ] && sleep 240
done
echo "chunked backfill finished"
