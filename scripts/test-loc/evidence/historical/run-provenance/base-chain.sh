#!/bin/bash
S=/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad
B=/projects/qwen-code-testloc-base
set -x
git -C /projects/qwen-code worktree add --detach "$B" origin/main || exit 1
cd "$B" || exit 1
corepack pnpm install --frozen-lockfile --offline || corepack pnpm install --frozen-lockfile || exit 1
npm run build || exit 1
echo "BUILD_DONE $(date +%s)"
cd "$B/packages/core" || exit 1
start=$(date +%s)
npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true --reporter=json --outputFile="$S/base-core-results.json" > "$S/base-core-run.log" 2>&1
echo "COVERAGE_DONE exit=$? wall_s=$(( $(date +%s) - start ))"
cp coverage/lcov.info "$S/base-core.lcov"
cd "$B" || exit 1
node /projects/knowledge/qwen-code/scripts/test-loc/fault-replay.mjs run --repo "$B" --pkg packages/core --corpus "$S/corpus-core.json" --out "$S/base-c1.json" > "$S/base-c1.log" 2>&1
echo "C1_DONE exit=$?"
echo "CHAIN_DONE"
