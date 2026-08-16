#!/usr/bin/env bash
# Edge cases for the two wipe scripts, each run through GitHub's default
# `shell: bash` wrapper (bash --noprofile --norc -eo pipefail) in a throwaway
# workspace. Prints one line per case per arm.
set -uo pipefail

HARNESS=/verify/harness
OUT=/out/edge
rm -rf "$OUT"; mkdir -p "$OUT"
RESULT="$OUT/results.txt"
: > "$RESULT"

run_wipe() { # arm workspace -> rc
  env HOME=/runner GITHUB_WORKSPACE="$1" \
    bash --noprofile --norc -eo pipefail "$HARNESS/steps/$2/wipe.sh" \
    > "$OUT/$3.log" 2>&1
}

emit() { printf '%-34s %-6s %s\n' "$1" "$2" "$3" | tee -a "$RESULT"; }

for ARM in base head; do
  # ---- E1: GITHUB_WORKSPACE unset -----------------------------------------
  WS=$OUT/$ARM-e1; mkdir -p "$WS"; echo keep > "$WS/canary.txt"
  ( unset GITHUB_WORKSPACE
    env -u GITHUB_WORKSPACE HOME=/runner \
      bash --noprofile --norc -eo pipefail "$HARNESS/steps/$ARM/wipe.sh" \
      > "$OUT/$ARM-e1.log" 2>&1 )
  rc=$?
  emit "E1 GITHUB_WORKSPACE unset" "$ARM" "rc=$rc canary=$([ -f "$WS/canary.txt" ] && echo intact || echo DELETED)"

  # ---- E2: orphaned tmp_pack_* inside the shared .git ----------------------
  WS=$OUT/$ARM-e2; mkdir -p "$WS/.git/objects/pack"
  head -c 4194304 /dev/urandom > "$WS/.git/objects/pack/tmp_pack_abc123"
  GITHUB_WORKSPACE=$WS run_wipe "$WS" "$ARM" "$ARM-e2"; rc=$?
  emit "E2 orphaned tmp_pack_* in .git" "$ARM" "rc=$rc tmp_pack=$([ -f "$WS/.git/objects/pack/tmp_pack_abc123" ] && echo SURVIVES || echo reclaimed)"

  # ---- E3: dot-entries whose names merely START with .git ------------------
  WS=$OUT/$ARM-e3; mkdir -p "$WS/.git"
  : > "$WS/.git-credentials"; : > "$WS/.gitconfig"; mkdir -p "$WS/.gitcache"
  GITHUB_WORKSPACE=$WS run_wipe "$WS" "$ARM" "$ARM-e3"; rc=$?
  left=$(cd "$WS" && ls -A1 | tr '\n' ' ')
  emit "E3 .git-credentials/.gitconfig" "$ARM" "rc=$rc left=[${left% }]"

  # ---- E4: workspace root is a linked worktree (.git is a FILE) -----------
  WS=$OUT/$ARM-e4; mkdir -p "$WS"; echo 'gitdir: /elsewhere/.git/worktrees/x' > "$WS/.git"
  : > "$WS/junk"
  GITHUB_WORKSPACE=$WS run_wipe "$WS" "$ARM" "$ARM-e4"; rc=$?
  emit "E4 .git is a gitfile, not a dir" "$ARM" "rc=$rc gitfile=$([ -f "$WS/.git" ] && echo kept || echo removed) junk=$([ -e "$WS/junk" ] && echo PRESENT || echo gone)"

  # ---- E5: empty workspace ------------------------------------------------
  WS=$OUT/$ARM-e5; mkdir -p "$WS"
  GITHUB_WORKSPACE=$WS run_wipe "$WS" "$ARM" "$ARM-e5"; rc=$?
  emit "E5 already-empty workspace" "$ARM" "rc=$rc"

  # ---- E6: read-only leftovers + odd names --------------------------------
  WS=$OUT/$ARM-e6; mkdir -p "$WS/.git" "$WS/dir with space" "$WS/-dash"
  : > "$WS/dir with space/f"; : > "$WS/-dash/f"; : > "$WS/ro.txt"; chmod 0444 "$WS/ro.txt"
  chmod 0555 "$WS/dir with space"
  GITHUB_WORKSPACE=$WS run_wipe "$WS" "$ARM" "$ARM-e6"; rc=$?
  left=$(cd "$WS" && ls -A1 | tr '\n' ' ')
  emit "E6 read-only + odd names" "$ARM" "rc=$rc left=[${left% }]"
done
echo "EDGE_DONE"
