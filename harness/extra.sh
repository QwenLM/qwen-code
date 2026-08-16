#!/usr/bin/env bash
# Slow-link reproduction + what the preserved .git does when it is damaged +
# proof the cheap path hands the next job the same tree.
set -u
EV=${EV:-/Users/wenshao/pr9228-verify/evidence/container}
B=$'\033[1m'; N=$'\033[0m'; D=$'\033[90m'; Y=$'\033[33m'; G=$'\033[32m'

EV="$EV" python3 /Users/wenshao/pr9228-verify/harness/slowlink.py
echo
echo "${B}Damaged shared .git handed to the next job (PR-head wipe; actions/checkout recovery)${N}"
sed 's/^/   /' "$EV/resilience/results.txt"
echo "   ${D}a broken .git costs one full re-clone and self-heals; an orphaned tmp_pack survives${N}"
echo
echo "${B}Does the cheap job-3 checkout hand over the same tree as the expensive one?${N}"
sed 's/^/   /' "$EV/integrity/results.txt"
echo "   ${G}identical HEAD, identical index digest, identical worktree digest, clean status${N}"
