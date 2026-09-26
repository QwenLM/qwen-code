#!/bin/bash
# c2.sh <headRev> : mutation sample on 8 round-4 modules, base then head, then mutant-by-mutant diff
H=$1; MODS=src/hooks/sessionHooksManager.ts,src/utils/filesearch/fileSearch.ts,src/services/image-generation-service.ts,src/hooks/asyncHookRegistry.ts,src/utils/memoryImportProcessor.ts,src/agents/workflow-run-registry.ts,src/utils/gitDiff.ts,src/tools/shell.ts
cd /projects/qwen-code-testloc-c2 || exit 1
for side in base:ab61e04161 head:$H; do n=${side%%:*}; rev=${side#*:}
  git checkout -q --detach $rev || exit 1
  node /projects/knowledge/qwen-code/scripts/test-loc/mutation-sample.mjs --repo /projects/qwen-code-testloc-c2 --pkg packages/core --stryker /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/stryker --modules $MODS --windows 6 --window-size 150 --seed 20260926 --out /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/c2-$n
  git -C /projects/qwen-code-testloc-c2 checkout -q -- . 2>/dev/null
done
for m in $(echo $MODS | tr , ' '); do k=$(echo $m | tr '/.' '__'); echo "== $m"; node /projects/knowledge/qwen-code/scripts/test-loc/mutation-diff.mjs /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/c2-base/$k.mutation.json /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/c2-head/$k.mutation.json --list | head -30; done
echo C2_DONE
