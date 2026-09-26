#!/bin/bash
while pgrep -f 'r4/runner.sh' >/dev/null; do sleep 15; done
cd /projects/qwen-code-testloc || exit 1
echo "== runner exited $(date +%T)"; tail -8 /tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/runner.log
echo "== worktree status:"; git status --short | head -20
H=$(git rev-parse --short HEAD); echo "== head $H, commits over base: $(git rev-list --count ab61e04161..HEAD)"
echo "== non-test files changed vs base:"; git diff --name-only ab61e04161..HEAD | grep -vE '\.test\.tsx?$|__snapshots__' 
cd packages/core && echo "== tsc"; timeout 900 npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5; echo "tsc exit ${PIPESTATUS[0]}"
cd /projects/qwen-code-testloc && FILES=$(git diff --name-only ab61e04161..HEAD -- 'packages/core/*.ts')
echo "== prettier ($(echo $FILES | wc -w) files)"; npx prettier --check $FILES 2>&1 | tail -3
echo "== eslint"; timeout 1200 npx eslint $FILES 2>&1 | tail -5; echo "eslint exit ${PIPESTATUS[0]}"
/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final/all.sh $H
