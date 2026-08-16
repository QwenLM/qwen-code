#!/usr/bin/env bash
# The narrowed wipe hands the NEXT job whatever state the shared .git was left
# in — including the half-written state the PR's own motivation describes (a
# fetch that died mid-pack). Does actions/checkout recover, or does the runner
# stay wedged? One case per damage mode, PR-head wipe only.
set -uo pipefail

VERIFY=/verify
HARNESS=$VERIFY/harness
ACTION=$VERIFY/fixture/checkout-action/dist/index.js
WS=/runner/_work/qwen-code/qwen-code
OUT=/out/resilience
PORT=$((8700 + RANDOM % 200))
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

mark() { node -e 'require("fs").appendFileSync(process.argv[1],JSON.stringify({kind:"mark",label:process.argv[2],t:Date.now()})+"\n")' "$LEDGER" "$1"; }

checkout() { # ref path depth label
  mark "checkout:start:$4"
  env HOME=/runner GITHUB_WORKSPACE="$WS" RUNNER_TEMP=/runner/_temp RUNNER_OS=Linux \
    GITHUB_REPOSITORY=QwenLM/qwen-code GITHUB_SERVER_URL="$SERVER" \
    GITHUB_EVENT_PATH="$OUT/event.json" GITHUB_OUTPUT="$OUT/gh-output" \
    GITHUB_ENV="$OUT/gh-env" GITHUB_PATH="$OUT/gh-path" GITHUB_STATE="$OUT/gh-state" \
    GITHUB_STEP_SUMMARY="$OUT/gh-summary" INPUT_TOKEN=ghs_dummy \
    INPUT_REPOSITORY=QwenLM/qwen-code INPUT_REF="$1" INPUT_PATH="$2" \
    "INPUT_FETCH-DEPTH=$3" "INPUT_PERSIST-CREDENTIALS=false" \
    "INPUT_GITHUB-SERVER-URL=$SERVER" \
    node "$ACTION" > "$OUT/checkout-$4.log" 2>&1
  local rc=$?
  mark "checkout:end:$4:rc=$rc"
  return $rc
}

bytes_since() { # mark-label -> bytes booked after that mark
  node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
let t=0; for (const r of rows) if (r.kind==="mark" && r.label===process.argv[2]) t=r.t;
const b=rows.filter(r=>r.kind==="req" && r.t>=t).reduce((a,r)=>a+r.respBytes,0);
console.log((b/1048576).toFixed(1)+" MB");' "$LEDGER" "$1"
}

seed() { # fresh workspace with a full-history root .git
  rm -rf "$WS"; mkdir -p "$WS"
  checkout main "." 0 "seed-$1" || { echo "seed failed"; exit 1; }
}

damage_truncate_pack() {
  local p
  p=$(ls "$WS"/.git/objects/pack/*.pack | head -1)
  chmod u+w "$p"
  truncate -s $(( $(stat -c%s "$p") / 2 )) "$p"
}
damage_kill_head()      { rm -f "$WS/.git/HEAD"; }
damage_leave_tmp_pack() { head -c 419430400 /dev/urandom > "$WS/.git/objects/pack/tmp_pack_dead"; }
damage_index_lock()     { : > "$WS/.git/index.lock"; }
damage_gitfile()        { rm -rf "$WS/.git.bak"; mv "$WS/.git" "$WS/.git.bak"; echo 'gitdir: /nowhere/.git/worktrees/x' > "$WS/.git"; }
damage_none()           { :; }

printf '%-30s %-10s %-8s %-12s %s\n' case wipe-rc ckout-rc bytes result | tee "$OUT/results.txt"
for case in ${CASES:-none truncate_pack kill_head leave_tmp_pack index_lock}; do
  seed "$case"
  "damage_$case"
  before_git=$(du -sb "$WS/.git" | cut -f1)
  mark "damaged:$case"
  env HOME=/runner GITHUB_WORKSPACE="$WS" \
    bash --noprofile --norc -eo pipefail "$HARNESS/steps/head/wipe.sh" \
    > "$OUT/wipe-$case.log" 2>&1
  wrc=$?
  mark "wiped:$case"
  checkout main "." 0 "after-$case"
  crc=$?
  files=$(find "$WS" -maxdepth 1 -mindepth 1 ! -name .git | wc -l)
  tmp_left=$(ls "$WS"/.git/objects/pack/tmp_pack_* 2>/dev/null | wc -l)
  printf '%-30s %-10s %-8s %-12s %s\n' "$case" "$wrc" "$crc" "$(bytes_since "wiped:$case")" \
    "worktree=$files entries, tmp_pack leftovers=$tmp_left" | tee -a "$OUT/results.txt"
done
echo RESILIENCE_DONE
