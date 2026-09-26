#!/bin/bash
R="node /projects/knowledge/qwen-code/scripts/test-loc/fault-replay.mjs run --repo /projects/qwen-code-testloc-base --pkg packages/core --corpus /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/corpus-targeted.json"
cd /projects/qwen-code-testloc-base && git checkout -q --detach ab61e04161 && $R --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/targeted-base.json"
cd /projects/qwen-code-testloc-base && git checkout -q --detach 2765ef8e68 && $R --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/targeted-head.json"
echo "TARGETED_DONE"
