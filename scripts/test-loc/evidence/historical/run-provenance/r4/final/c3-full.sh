#!/bin/bash
# c3-full.sh <headRev> : full core suite with coverage, twice at base and twice at head,
# in the measurement worktree. Writes lcov + json per run under r4/final/.
S=/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad
H=$1; B=ab61e04161; W=/projects/qwen-code-testloc-base; OUT=$S/r4/final
cd $W || exit 1
for run in base1:$B head1:$H base2:$B head2:$H; do
  name=${run%%:*}; rev=${run#*:}
  git checkout -q --detach $rev || exit 1
  cd $W/packages/core
  rm -rf $OUT/cov-$name
  start=$(date +%s)
  CI=1 timeout 3000 npx vitest run --coverage.enabled=true --coverage.reporter=lcov --coverage.reportOnFailure=true --coverage.reportsDirectory=$OUT/cov-$name --reporter=json --outputFile=$OUT/res-$name.json >/dev/null 2>&1
  echo "$name $rev exit=$? wall_s=$(( $(date +%s)-start ))"
  node -e "const r=require('$OUT/res-$name.json');console.log('  tests',r.numTotalTests,'failed',r.numFailedTests,'files',r.testResults.length);for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==='failed')console.log('  failed',f.name.split('/packages/core/')[1],'>',a.title.slice(0,90))"
  cd $W
done
git checkout -q --detach $B
CD=/projects/knowledge/qwen-code/scripts/test-loc/coverage-diff.mjs
for p in "base1 head1" "base1 head2" "base2 head1" "base2 head2" "base1 base2" "head1 head2"; do set -- $p
  node $CD $OUT/cov-$1/lcov.info $OUT/cov-$2/lcov.info --list > $OUT/diff-$1-$2.txt 2>&1
  echo "== $1 -> $2: $(grep -E 'C3 lost (lines|branches)' $OUT/diff-$1-$2.txt | tr -s ' ' | tr '\n' ' ')"
done
echo C3_FULL_DONE
