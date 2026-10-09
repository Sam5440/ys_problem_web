#!/usr/bin/env bash
# End-to-end exercise of the data-branch model against a throwaway fixture
# remote (bare repo + clones). Verifies, in order:
#
#   1. cold restore (no data branches yet) is graceful
#   2. push-data-branches creates data/problems + today's data/misc-* with the
#      injected no-preview vercel.json and correct trees
#   3. re-running with no changes skips (idempotent)
#   4. a concurrent update pushed by another clone survives ours (union)
#   5. a new UTC day chains onto the latest surviving misc branch
#   6. prune deletes misc branches older than the retention window (boundary kept)
#   6b. runtime branch: orphan snapshot + unchanged skip + content replace +
#       restore-data --runtime round-trip + deploy layers public/compiler
#   7. publish-deploy produces an orphan deploy snapshot (code+data), skips
#      when unchanged, and force-replaces itself when data moves
#   8. a fresh clone restores the full data set with a clean index
#
# Usage: bash scripts/tests/e2e-data-branches.sh [source-repo-path]
# (defaults to the repo containing this script; it clones the COMMITTED state
#  of the source's HEAD, so commit local changes first)
set -euo pipefail

TODAY=$(date -u +%F)
AGO() { date -u -v-"$1"d +%F 2>/dev/null || date -u -d "$1 days ago" +%F; }

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORK="$(mktemp -d /tmp/ysp-e2e-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "== fixture: $WORK (source: $SRC)"

git clone --quiet --no-local "$SRC" "$WORK/origin-repo" --bare
git clone --quiet "$WORK/origin-repo" "$WORK/a"
git clone --quiet "$WORK/origin-repo" "$WORK/b"
for repo in "$WORK/a" "$WORK/b"; do
  git -C "$repo" config user.name e2e-tester
  git -C "$repo" config user.email e2e@test.invalid
done
cd "$WORK/a"

step() { echo; echo "── $* ──"; }

step "1. cold restore"
node scripts/restore-data.mjs

step "2. seed data + first push"
mkdir -p data/statements public/ci-logs
echo '{"code":"1000A"}' > data/statements/1000a.json
echo '{"days":[]}' > data/daily.json
echo '{"users":[]}' > data/leaderboard.json
echo sha-1 > data/.upstream-sha
echo lbsha-1 > data/.leaderboard-sha
echo 'log-1' > public/ci-logs/2026-10-05-111.log
echo 'sum-1' > public/ci-logs/2026-10-05-111.json
node scripts/push-data-branches.mjs --problems --misc --prune

git fetch --quiet origin
PROBLEMS_TOP=$(git ls-tree --name-only origin/data/problems | sort | tr '\n' ' ')
[ "$PROBLEMS_TOP" = "data vercel.json " ] || { echo "FAIL: problems tree top = [$PROBLEMS_TOP]"; exit 1; }
git cat-file -e "origin/data/misc-$TODAY:data/leaderboard.json" || { echo "FAIL: leaderboard missing on misc"; exit 1; }
git cat-file -e "origin/data/misc-$TODAY:data/.upstream-sha" || { echo "FAIL: marker missing on misc"; exit 1; }
git cat-file -e "origin/data/misc-$TODAY:public/ci-logs/2026-10-05-111.log" || { echo "FAIL: log missing on misc"; exit 1; }
git show origin/data/problems:vercel.json | grep -q '"data/\*"' || { echo "FAIL: no-preview vercel.json missing/wrong"; exit 1; }
echo "branch layout OK"

step "3. idempotent re-push"
OUT=$(node scripts/push-data-branches.mjs --problems --misc)
echo "$OUT" | grep -q "unchanged" || { echo "FAIL: expected unchanged skip, got: $OUT"; exit 1; }

step "4. concurrent push from another clone survives (union)"
cd "$WORK/b"
git fetch --quiet origin data/problems
git checkout --quiet -B data/problems FETCH_HEAD
echo '{"code":"1000B"}' > data/statements/1000b.json
git add -f data/statements
git commit -qm "concurrent"
git push --quiet origin data/problems
cd "$WORK/a"
echo '{"code":"1000C"}' > data/statements/1000c.json
node scripts/push-data-branches.mjs --problems
git fetch --quiet origin
COUNT=$(git ls-tree origin/data/problems data/statements/ | wc -l | tr -d ' ')
[ "$COUNT" = "3" ] || { echo "FAIL: union lost files ($COUNT != 3: 1000a/1000b/1000c)"; exit 1; }
echo "union OK — all 3 statements on data/problems"

step "5. new UTC day chains onto the latest surviving misc branch"
OLD="data/misc-$(AGO 2)"
cd "$WORK/b"
git checkout --quiet main
git fetch --quiet origin
git checkout --quiet -b "$OLD" "origin/data/misc-$TODAY"
echo '{"users":[2]}' > data/leaderboard.json
git add -f data
git commit -qm "older day data"
git push --quiet origin "$OLD"
git push --quiet origin --delete "data/misc-$TODAY"
cd "$WORK/a"
node scripts/push-data-branches.mjs --misc
git fetch --quiet origin
PARENT=$(git rev-parse --short "origin/data/misc-$TODAY^")
OLD_TIP=$(git rev-parse --short "origin/$OLD")
[ "$PARENT" = "$OLD_TIP" ] || { echo "FAIL: today's misc not chained onto $OLD (parent=$PARENT want=$OLD_TIP)"; exit 1; }
echo "day rollover chains OK ($OLD → $TODAY)"

step "6. prune expired branches"
cd "$WORK/a"
for d in 61 70 100; do
  B="data/misc-$(AGO $d)"
  git branch -q "$B" "origin/data/misc-$TODAY"
  git push --quiet origin "$B"
done
KEEP="data/misc-$(AGO 60)"
git branch -q "$KEEP" "origin/data/misc-$TODAY"
git push --quiet origin "$KEEP"
node scripts/push-data-branches.mjs --prune
LEFT=$(git ls-remote --heads origin 'refs/heads/data/misc-*' | wc -l | tr -d ' ')
echo "misc branches left: $LEFT (expect 3: today, -2d, -60d boundary)"
[ "$LEFT" = "3" ] || { echo "FAIL: expected 3 misc branches after prune, got $LEFT"; exit 1; }

step "6b. runtime branch: orphan snapshot + unchanged skip + replace + restore"
mkdir -p public/compiler
for f in clang22 clang22-noeh lld22 lld22-noeh sysroot22.tar memfs; do
  echo "bin-$f" > "public/compiler/$f"
done
node scripts/push-runtime-branch.mjs
git fetch --quiet origin data/runtime
RT_TOP=$(git ls-tree --name-only origin/data/runtime | sort | tr '\n' ' ')
[ "$RT_TOP" = "public vercel.json " ] || { echo "FAIL: runtime tree top = [$RT_TOP]"; exit 1; }
PARENTS=$(git rev-list --parents -n1 origin/data/runtime | wc -w | tr -d ' ')
[ "$PARENTS" = "1" ] || { echo "FAIL: runtime commit is not an orphan (rev-list words = $PARENTS)"; exit 1; }
git show origin/data/runtime:vercel.json | grep -q '"data/\*"' || { echo "FAIL: runtime no-preview vercel.json missing/wrong"; exit 1; }
OUT=$(node scripts/push-runtime-branch.mjs)
echo "$OUT" | grep -q "skipping push" || { echo "FAIL: unchanged runtime should skip, got: $OUT"; exit 1; }
echo bin-memfs-v2 > public/compiler/memfs
node scripts/push-runtime-branch.mjs
git fetch --quiet origin data/runtime
[ "$(git show origin/data/runtime:public/compiler/memfs)" = "bin-memfs-v2" ] || { echo "FAIL: runtime content replace lost"; exit 1; }
rm -rf public/compiler
node scripts/restore-data.mjs --runtime
[ "$(cat public/compiler/memfs)" = "bin-memfs-v2" ] || { echo "FAIL: restore-data --runtime did not restore"; exit 1; }
STAGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
[ "$STAGED" = "0" ] || { echo "FAIL: runtime restore staged $STAGED files"; exit 1; }
echo "runtime branch OK (orphan + skip + replace + restore round-trip)"

step "7. publish-deploy"
node scripts/publish-deploy.mjs
git fetch --quiet origin deploy
DEPLOY_TOP=$(git ls-tree --name-only origin/deploy | sort | tr '\n' ' ')
echo "deploy root: $DEPLOY_TOP"
for expect in README.md data package.json public scripts; do
  echo "$DEPLOY_TOP" | grep -qw "$expect" || { echo "FAIL: deploy tree missing $expect"; exit 1; }
done
git cat-file -e origin/deploy:data/daily.json || { echo "FAIL: daily.json missing on deploy"; exit 1; }
PARENTS=$(git rev-list --parents -n1 origin/deploy | wc -w | tr -d ' ')
[ "$PARENTS" = "1" ] || { echo "FAIL: deploy commit is not an orphan (rev-list words = $PARENTS)"; exit 1; }
D1=$(git rev-parse origin/deploy)
OUT=$(node scripts/publish-deploy.mjs)
echo "$OUT" | grep -q "skipping push" || { echo "FAIL: unchanged deploy should skip, got: $OUT"; exit 1; }
echo '{"code":"1000D"}' > data/statements/1000d.json
echo sha-2 > data/.upstream-sha
node scripts/publish-deploy.mjs
git fetch --quiet origin deploy
D2=$(git rev-parse origin/deploy)
[ "$D1" != "$D2" ] || { echo "FAIL: deploy not replaced after data change"; exit 1; }
PARENTS=$(git rev-list --parents -n1 origin/deploy | wc -w | tr -d ' ')
[ "$PARENTS" = "1" ] || { echo "FAIL: replacement deploy commit not orphan"; exit 1; }
git show origin/deploy:data/statements/1000d.json | grep -q 1000D || { echo "FAIL: new data missing on deploy"; exit 1; }
git cat-file -e origin/deploy:public/compiler/memfs || { echo "FAIL: deploy did not layer public/compiler"; exit 1; }
echo "deploy orphan + replace OK"

step "8. fresh clone restore"
cd "$WORK/b"
git checkout --quiet main --
rm -rf data public/ci-logs
node scripts/restore-data.mjs
[ -f data/statements/1000a.json ] || { echo "FAIL: statements not restored"; exit 1; }
[ -f data/leaderboard.json ] || { echo "FAIL: leaderboard not restored"; exit 1; }
[ -f data/.upstream-sha ] || { echo "FAIL: markers not restored"; exit 1; }
[ -f data/daily.json ] || { echo "FAIL: daily.json not restored from deploy"; exit 1; }
[ -f public/ci-logs/2026-10-05-111.log ] || { echo "FAIL: ci-logs not restored"; exit 1; }
STAGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
[ "$STAGED" = "0" ] || { echo "FAIL: restore staged $STAGED files into the index"; exit 1; }
DIRTY=$(git status --porcelain | { grep -v '^??' || true; } | wc -l | tr -d ' ')
[ "$DIRTY" = "0" ] || { echo "FAIL: restore dirtied tracked files"; exit 1; }
echo "fresh-clone restore OK, index clean"

echo
echo "ALL E2E CHECKS PASSED"
