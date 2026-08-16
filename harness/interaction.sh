#!/usr/bin/env bash
# 9228 x 9220 interaction.
#
# #9220 (landed on main after the first verification) documents a shared .git
# that wedges every later checkout: refs claim objects the object store no
# longer has, and each fetch dies in negotiation. Before this PR, serve-ab's
# whole-workspace wipe destroyed that state as a side effect. With the
# narrowed wipe it survives. So, per corruption variant and per arm:
#
#   seed a full root checkout -> corrupt the shared .git -> run the arm's
#   wipe verbatim -> run the next root depth-0 checkout. If that checkout
#   fails, run #9220's heal step verbatim and retry, exactly as review-pr does.
set -uo pipefail

VERIFY=/verify
HARNESS=$VERIFY/harness
ACTION=$VERIFY/fixture/checkout-action/dist/index.js
WS=/runner/_work/qwen-code/qwen-code
RUNNER_WS=/runner/_work/qwen-code
OUT=/out/interaction
PORT=$((9100 + RANDOM % 200))
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

checkout() { # label [depth]
  local depth="${2:-0}"
  env HOME=/runner GITHUB_WORKSPACE="$WS" RUNNER_TEMP=/runner/_temp RUNNER_OS=Linux \
    RUNNER_WORKSPACE="$RUNNER_WS" \
    GITHUB_REPOSITORY=QwenLM/qwen-code GITHUB_SERVER_URL="$SERVER" \
    GITHUB_EVENT_PATH="$OUT/event.json" GITHUB_OUTPUT="$OUT/gh-output" \
    GITHUB_ENV="$OUT/gh-env" GITHUB_PATH="$OUT/gh-path" GITHUB_STATE="$OUT/gh-state" \
    GITHUB_STEP_SUMMARY="$OUT/gh-summary" INPUT_TOKEN=ghs_dummy \
    INPUT_REPOSITORY=QwenLM/qwen-code INPUT_REF=main INPUT_PATH=. \
    "INPUT_FETCH-DEPTH=$depth" "INPUT_PERSIST-CREDENTIALS=false" \
    "INPUT_GITHUB-SERVER-URL=$SERVER" \
    node "$ACTION" > "$OUT/checkout-$1.log" 2>&1
}

# Seed depth per variant: `unshallow` needs a truncated object store.
seed_depth() { case "$1" in unshallow) echo 1 ;; *) echo 0 ;; esac; }

bytes_since() {
  node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
let t=0; for (const r of rows) if (r.kind==="mark" && r.label===process.argv[2]) t=r.t;
const b=rows.filter(r=>r.kind==="req" && r.t>=t).reduce((a,r)=>a+r.respBytes,0);
console.log((b/1048576).toFixed(1));' "$LEDGER" "$1"
}

# --- corruption variants -----------------------------------------------------
corrupt_nopack() {
  # The pack data is gone but the .idx still advertises every object: refs
  # resolve, the repo looks healthy, and the failure only surfaces in fetch.
  chmod -R u+w "$WS/.git/objects/pack"
  rm -f "$WS"/.git/objects/pack/*.pack
}
corrupt_ghostref() {
  # A remote-tracking ref left pointing at an object this store never got —
  # the "refs claim objects missing from its object store" shape.
  mkdir -p "$WS/.git/refs/remotes/origin"
  printf '%s\n' 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' > "$WS/.git/refs/remotes/origin/ghost"
}
corrupt_unshallow() {
  # The shape #9220 describes: the store is truncated (shallow) but the
  # marker that tells git so is gone, so the next fetch offers "have"s it
  # cannot back and negotiation dies on missing objects.
  chmod -R u+w "$WS/.git" 2>/dev/null
  rm -f "$WS/.git/shallow"
}
corrupt_none() { :; }

printf '%-12s %-6s %-9s %-9s %-8s %-9s %s\n' \
  variant arm wipe-rc ckout-rc MB heal? 'retry-rc / MB / verdict' | tee "$OUT/results.txt"

for variant in ${VARIANTS:-none nopack ghostref unshallow}; do
  for arm in base head; do
    tag="$variant-$arm"
    rm -rf "$WS"; mkdir -p "$WS"
    checkout "seed-$tag" "$(seed_depth "$variant")"
    "corrupt_$variant"
    survived_before=$( [ -d "$WS/.git" ] && echo yes || echo no )

    mark "wipe:$tag"
    env HOME=/runner GITHUB_WORKSPACE="$WS" \
      bash --noprofile --norc -eo pipefail "$HARNESS/steps/$arm/wipe.sh" \
      > "$OUT/wipe-$tag.log" 2>&1
    wrc=$?
    kept=$( [ -d "$WS/.git" ] && echo kept || echo wiped )

    mark "ckout:$tag"
    checkout "next-$tag"
    crc=$?
    mb=$(bytes_since "ckout:$tag")

    heal='n/a'; retry='-'
    if [ "$crc" != '0' ]; then
      # Exactly what review-pr does on a failed first checkout (#9220).
      heal='ran'
      mark "heal:$tag"
      env HOME=/runner GITHUB_WORKSPACE="$WS" RUNNER_WORKSPACE="$RUNNER_WS" \
        bash --noprofile --norc -eo pipefail "$HARNESS/steps/heal/heal.sh" \
        > "$OUT/heal-$tag.log" 2>&1
      hrc=$?
      mark "retry:$tag"
      checkout "retry-$tag"
      rrc=$?
      retry="rc=$rrc / $(bytes_since "retry:$tag") MB / heal-rc=$hrc"
    fi

    verdict="$kept .git; $retry"
    printf '%-12s %-6s %-9s %-9s %-8s %-9s %s\n' \
      "$variant" "$arm" "$wrc" "$crc" "$mb" "$heal" "$verdict" | tee -a "$OUT/results.txt"
  done
done
echo INTERACTION_DONE
