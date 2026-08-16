#!/usr/bin/env bash
# The 9228 x 9220 interaction, rendered from the container evidence.
set -u
EV=${EV:-/Users/wenshao/pr9228-verify/evidence/container-new}
B=$'\033[1m'; N=$'\033[0m'; D=$'\033[90m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'

echo "${B}A corrupt shared .git, handed to the next job through each arm's wipe${N}"
echo "${D}#9220 (landed on main after the first verification) documents this state wedging"
echo "ecs-qwen-runner-64c-23 for two days. Each row: seed a root checkout, corrupt the"
echo "shared .git, run the arm's wipe verbatim, then run the next root depth-0 checkout.${N}"
echo
while IFS= read -r line; do
  case "$line" in
    *"head "*" 1 "*) printf '   %s%s%s\n' "$R" "$line" "$N" ;;
    variant*)        printf '   %s%s%s\n' "$B" "$line" "$N" ;;
    *)               printf '   %s\n' "$line" ;;
  esac
done < "$EV/interaction/results.txt"
echo
echo "${D}   none/ghostref: harmless. nopack: checkout detects the breakage and re-clones (rc=0)."
echo "   unshallow (the #9220 shape): only the narrowed wipe carries it forward.${N}"
echo
echo "${B}What the next job actually hits in the unshallow x head cell${N}"
tr '\r' '\n' < "$EV/interaction/checkout-next-unshallow-head.log" \
  | grep -iE 'unresolved deltas|invalid index-pack|Could not read' | head -4 | sed 's/^/   /'
echo "   ${Y}$(cat "$EV/interaction/heal-unshallow-head.log")${N}"
echo "   ${D}then the retry checkout succeeds — but only review-pr has that heal step.${N}"
