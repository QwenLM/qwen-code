#!/bin/bash
node /projects/knowledge/qwen-code/scripts/test-loc/mutation-sample.mjs --repo /projects/qwen-code-testloc-c2 --pkg packages/core --stryker "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/stryker" --modules src/core/llm-chat.ts,src/core/client.ts,src/config/config.ts --windows 6 --window-size 150 --seed 20260925 --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/c2-base"
echo "C2_BASE_DONE exit=$?"
