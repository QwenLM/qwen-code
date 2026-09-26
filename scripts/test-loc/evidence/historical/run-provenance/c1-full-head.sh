#!/bin/bash
until grep -q 'T1_DONE' "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/t1.log" 2>/dev/null; do sleep 30; done
cd /projects/qwen-code-testloc-base && git checkout -q --detach a2317f0fc8 && node /projects/knowledge/qwen-code/scripts/test-loc/fault-replay.mjs run --repo /projects/qwen-code-testloc-base --pkg packages/core --corpus "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/corpus-core.json" --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/head-c1.json"
echo "C1_FULL_HEAD_DONE"
