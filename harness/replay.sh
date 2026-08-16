#!/usr/bin/env bash
# Replay three consecutive jobs sharing ONE reusable self-hosted runner
# workspace, with the serve-ab wipe step taken verbatim from the arm's
# serve-ab.yml:
#
#   job 1  ci.yml `Test`     - actions/checkout at the workspace ROOT, depth 0
#   job 2  serve-ab.yml `ab` - ownership restore + WIPE + checkout head/ + base/
#   job 3  ci.yml `Test`     - actions/checkout at the workspace ROOT, depth 0
#
# Job 3 is the measurement: how much does the runner have to re-download from
# "github.com" because of what job 2's wipe did.
set -uo pipefail

ARM="${1:?arm: base|head}"
RATE="${2:-0}"     # response throttle in bytes/sec (0 = local disk speed)
TAG="${3:-full}"

VERIFY=/verify
HARNESS=$VERIFY/harness
ACTION=$VERIFY/fixture/checkout-action/dist/index.js
STEPS=$HARNESS/steps/$ARM
SRVROOT=/runner/srv
WS=/runner/_work/qwen-code/qwen-code
OUT=/out/$ARM-$TAG
LEDGER=$OUT/ledger.jsonl
PORT=$((8100 + RANDOM % 500))
SERVER="http://127.0.0.1:$PORT"

MAIN_REF="${MAIN_REF:-main}"
HEAD_SHA="${HEAD_SHA:?}"
BASE_SHA="${BASE_SHA:?}"

rm -rf "$OUT"; mkdir -p "$OUT"
: > "$LEDGER"
# The runner pre-creates these command files; @actions/core hard-fails without.
for f in gh-output gh-env gh-path gh-state gh-summary; do : > "$OUT/$f"; done
# Jobs 1-2 always run at local disk speed; only job 3 (the phase under
# measurement) is throttled to the pool link speed when RATE > 0.
RATE_FILE="$OUT/rate"; echo 0 > "$RATE_FILE"
echo '{"repository":{"owner":{"id":1},"full_name":"QwenLM/qwen-code"}}' > "$OUT/event.json"

mark() {
  node -e 'require("fs").appendFileSync(process.argv[1],JSON.stringify({kind:"mark",label:process.argv[2],t:Date.now()})+"\n")' "$LEDGER" "$1"
}

say() { echo "== $*" | tee -a "$OUT/replay.log"; }

# ---- fake github.com -------------------------------------------------------
GIT_PROJECT_ROOT=$SRVROOT PORT=$PORT LEDGER=$LEDGER RATE_BPS=0 RATE_FILE=$RATE_FILE \
  node "$HARNESS/git-http-server.mjs" > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -f "$LEDGER.ready" ] && break; sleep 0.2; done
trap 'kill $SERVER_PID 2>/dev/null' EXIT
say "arm=$ARM rate=${RATE}B/s server=$SERVER pid=$SERVER_PID"

checkout() { # ref path depth label
  local ref="$1" p="$2" depth="$3" label="$4"
  mark "checkout:start:$label"
  local t0 t1
  t0=$(date +%s.%N)
  env \
    HOME=/runner \
    GITHUB_WORKSPACE="$WS" \
    RUNNER_TEMP=/runner/_temp \
    RUNNER_OS=Linux \
    GITHUB_REPOSITORY=QwenLM/qwen-code \
    GITHUB_SERVER_URL="$SERVER" \
    GITHUB_EVENT_PATH="$OUT/event.json" \
    GITHUB_OUTPUT="$OUT/gh-output" \
    GITHUB_ENV="$OUT/gh-env" \
    GITHUB_PATH="$OUT/gh-path" \
    GITHUB_STATE="$OUT/gh-state" \
    GITHUB_STEP_SUMMARY="$OUT/gh-summary" \
    INPUT_TOKEN=ghs_dummy \
    INPUT_REPOSITORY=QwenLM/qwen-code \
    INPUT_REF="$ref" \
    INPUT_PATH="$p" \
    "INPUT_FETCH-DEPTH=$depth" \
    "INPUT_PERSIST-CREDENTIALS=false" \
    "INPUT_GITHUB-SERVER-URL=$SERVER" \
    node "$ACTION" > "$OUT/checkout-$label.log" 2>&1
  local rc=$?
  t1=$(date +%s.%N)
  mark "checkout:end:$label:rc=$rc"
  say "checkout[$label] ref=$ref path=$p depth=$depth rc=$rc $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')s"
  return $rc
}

snapshot() { # label
  local label="$1"
  {
    echo "--- snapshot: $label"
    echo "workspace top level:"
    (cd "$WS" && ls -A1 | sort | sed 's/^/    /')
    echo "root .git present: $([ -d "$WS/.git" ] && echo yes || echo no)"
    if [ -d "$WS/.git" ]; then
      echo "root .git bytes: $(du -sb "$WS/.git" | cut -f1)"
      echo "root .git objects: $(git -C "$WS" count-objects -v | tr '\n' ' ')"
      echo "planted post-checkout hook present: $([ -f "$WS/.git/hooks/post-checkout" ] && echo yes || echo no)"
    fi
    echo "worktree files tracked-present: $(find "$WS" -maxdepth 1 -mindepth 1 ! -name .git | wc -l)"
    echo "stale sentinels still present:"
    for f in head/STALE-FROM-PREVIOUS-PR.txt base/STALE-FROM-PREVIOUS-PR.txt \
             .git-credentials .stale-cache/leftover.bin readonly-leftover.txt; do
      printf '    %-42s %s\n' "$f" "$([ -e "$WS/$f" ] && echo PRESENT || echo gone)"
    done
    echo "hook fire log: $([ -f /out/hook-fired-$ARM.txt ] && wc -l < /out/hook-fired-$ARM.txt || echo 0) line(s)"
  } >> "$OUT/snapshots.txt" 2>&1
}

plant_leftovers() {
  # What a previous serve-ab run on this same runner leaves behind, plus the
  # git-level exec vector the old whole-workspace wipe used to destroy.
  mkdir -p "$WS/head" "$WS/base" "$WS/.stale-cache"
  echo 'stale head build from PR #0000' > "$WS/head/STALE-FROM-PREVIOUS-PR.txt"
  echo 'stale base build from PR #0000' > "$WS/base/STALE-FROM-PREVIOUS-PR.txt"
  echo 'x=1' > "$WS/.git-credentials"
  head -c 1048576 /dev/urandom > "$WS/.stale-cache/leftover.bin"
  echo 'read-only leftover' > "$WS/readonly-leftover.txt"
  chmod 0444 "$WS/readonly-leftover.txt"
  cat > "$WS/.git/hooks/post-checkout" <<EOF
#!/bin/sh
echo "post-checkout hook ran as \$(id -un) in \$(pwd) at \$(date -Is)" >> /out/hook-fired-$ARM.txt
EOF
  chmod +x "$WS/.git/hooks/post-checkout"
}

run_step() { # script label
  local script="$1" label="$2"
  mark "step:start:$label"
  local t0 t1 rc
  t0=$(date +%s.%N)
  # GitHub's default `shell: bash` wrapper.
  env HOME=/runner GITHUB_WORKSPACE="$WS" RUNNER_TEMP=/runner/_temp \
    bash --noprofile --norc -eo pipefail "$script" > "$OUT/step-$label.log" 2>&1
  rc=$?
  t1=$(date +%s.%N)
  mark "step:end:$label:rc=$rc"
  say "step[$label] rc=$rc $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')s  ($script)"
  return $rc
}

# ---------------------------------------------------------------- job 1 ----
rm -rf "$WS"; mkdir -p "$WS"
rm -f "/out/hook-fired-$ARM.txt"
say "JOB 1 (ci.yml Test): actions/checkout at the workspace root, fetch-depth 0"
mark "job1:start"
checkout "$MAIN_REF" "." 0 job1-root-full
mark "job1:end"
snapshot "after job 1 (shared root .git now exists)"

say "planting the leftovers a previous serve-ab run would have left"
plant_leftovers
snapshot "after planting leftovers"

# ---------------------------------------------------------------- job 2 ----
say "JOB 2 (serve-ab.yml ab, arm=$ARM): ownership restore + wipe + A/B checkouts"
mark "job2:start"
run_step "$STEPS/ownership.sh" ownership
run_step "$STEPS/wipe.sh" wipe
snapshot "after the wipe step (arm=$ARM)"
checkout "$HEAD_SHA" head 1 job2-head
checkout "$BASE_SHA" base 1 job2-base
mark "job2:end"
snapshot "after job 2 A/B checkouts"

# ---------------------------------------------------------------- job 3 ----
echo "$RATE" > "$RATE_FILE"
say "JOB 3 (next ci.yml Test on the same runner): checkout at root, fetch-depth 0 [link=${RATE}B/s]"
mark "job3:start"
checkout "$MAIN_REF" "." 0 job3-root-full
mark "job3:end"
snapshot "after job 3"

kill $SERVER_PID 2>/dev/null
sleep 0.3
say "done"
