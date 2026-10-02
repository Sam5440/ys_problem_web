#!/bin/bash
# Chunked, polite backfill: many small batches beat one long burst
# because Cloudflare escalates on sustained automated traffic.
cd "$(dirname "$0")/.."
TOTAL_BATCHES=${1:-12}
for i in $(seq 1 "$TOTAL_BATCHES"); do
  echo "===== BATCH $i/$TOTAL_BATCHES ($(date +%H:%M:%S)) ====="
  node scripts/fetch-statements.mjs --limit 10 --delay 12000
  LEFT=$(ls data/statements | wc -l | tr -d ' ')
  echo "statements on disk: $LEFT"
  [ "$i" -lt "$TOTAL_BATCHES" ] && sleep 180
done
echo "chunked backfill finished"
