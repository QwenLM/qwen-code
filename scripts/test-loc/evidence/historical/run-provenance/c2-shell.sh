#!/bin/bash
M="node /projects/knowledge/qwen-code/scripts/test-loc/mutation-sample.mjs --repo /projects/qwen-code-testloc-c2 --pkg packages/core --stryker /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/stryker --modules src/tools/shell.ts --windows 6 --window-size 150 --seed 20260925"
cd /projects/qwen-code-testloc-c2 && git checkout -q --detach ab61e04161 && $M --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/c2-base"
cd /projects/qwen-code-testloc-c2 && git checkout -q --detach 2765ef8e68 && $M --out "/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/c2-exp5"
echo "C2_SHELL_DONE"
