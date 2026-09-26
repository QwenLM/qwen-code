#!/bin/bash
# c1.sh <headRev> : fault replay (100-fault corpus + 6 targeted) at head in the measurement worktree
H=$1; cd /projects/qwen-code-testloc-base && git checkout -q --detach $H || exit 1
node /projects/knowledge/qwen-code/scripts/test-loc/fault-replay.mjs run --repo /projects/qwen-code-testloc-base --pkg packages/core --corpus /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/corpus-core.json --out /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/c1-head.json
node /projects/knowledge/qwen-code/scripts/test-loc/fault-replay.mjs run --repo /projects/qwen-code-testloc-base --pkg packages/core --corpus /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/corpus-targeted.json --out /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/c1-head-targeted.json
git checkout -q --detach ab61e04161
echo C1_DONE
