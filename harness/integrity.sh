#!/usr/bin/env bash
# Does the cheap job-3 checkout (PR head: reuses the preserved .git) hand the
# next job the SAME tree the expensive one (base: fresh full clone) does?
# Digest of every worktree file + HEAD + porcelain status, per arm.
set -uo pipefail

VERIFY=/verify
HARNESS=$VERIFY/harness
ACTION=$VERIFY/fixture/checkout-action/dist/index.js
WS=/runner/_work/qwen-code/qwen-code
OUT=/out/integrity
PORT=$((8900 + RANDOM % 90))
SERVER="http://127.0.0.1:$PORT"
LEDGER=$OUT/ledger.jsonl

rm -rf "$OUT"; mkdir -p "$OUT"; : > "$LEDGER"
for f in gh-output gh-env gh-path gh-state gh-summary; do : > "$OUT/$f"; done
echo '{"repository":{"owner":{"id":1}}}' > "$OUT/event.json"

GIT_PROJECT_ROOT=/runner/srv PORT=$PORT LEDGER=$LEDGER RATE_BPS=0 \
  node "$HARNESS/git-http-server.mjs" > "$OUT/server.log" 2>&1 &
SP=$!
for _ in $(seq 1 50); do [ -f "$LEDGER.ready" ] && break; sleep 0.2; done
trap 'kill $SP 2>/dev/null' EXIT

checkout() { # label
  env HOME=/runner GITHUB_WORKSPACE="$WS" RUNNER_TEMP=/runner/_temp RUNNER_OS=Linux \
    GITHUB_REPOSITORY=QwenLM/qwen-code GITHUB_SERVER_URL="$SERVER" \
    GITHUB_EVENT_PATH="$OUT/event.json" GITHUB_OUTPUT="$OUT/gh-output" \
    GITHUB_ENV="$OUT/gh-env" GITHUB_PATH="$OUT/gh-path" GITHUB_STATE="$OUT/gh-state" \
    GITHUB_STEP_SUMMARY="$OUT/gh-summary" INPUT_TOKEN=ghs_dummy \
    INPUT_REPOSITORY=QwenLM/qwen-code INPUT_REF=main INPUT_PATH=. \
    "INPUT_FETCH-DEPTH=0" "INPUT_PERSIST-CREDENTIALS=false" \
    "INPUT_GITHUB-SERVER-URL=$SERVER" \
    node "$ACTION" > "$OUT/checkout-$1.log" 2>&1
}

for ARM in base head; do
  rm -rf "$WS"; mkdir -p "$WS"
  checkout "$ARM-job1"
  # a previous serve-ab run's leftovers
  mkdir -p "$WS/head" "$WS/base"; : > "$WS/head/stale"; : > "$WS/base/stale"
  env HOME=/runner GITHUB_WORKSPACE="$WS" \
    bash --noprofile --norc -eo pipefail "$HARNESS/steps/$ARM/wipe.sh" > "$OUT/wipe-$ARM.log" 2>&1
  checkout "$ARM-job3"
  {
    echo "arm=$ARM"
    echo "  HEAD            $(git -C "$WS" rev-parse HEAD)"
    echo "  porcelain lines $(git -C "$WS" status --porcelain | wc -l)"
    echo "  index digest    $(git -C "$WS" ls-files -s | sha256sum | cut -c1-32)"
    echo "  worktree digest $(cd "$WS" && find . -path ./.git -prune -o -type f -print0 \
                              | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-32)"
    echo "  file count      $(cd "$WS" && find . -path ./.git -prune -o -type f -print | wc -l)"
  } | tee -a "$OUT/results.txt"
done
echo INTEGRITY_DONE
