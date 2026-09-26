#!/bin/bash
# attr.sh <module rel packages/core> : run the module's direct importers at base and head (twice each), coverage on the module only
M=$1; W=/projects/qwen-code-testloc-base; F=/tmp/claude-502/-projects-qwen-code/aafb13e7-0fe1-4917-8ec7-fdca963d0d78/scratchpad/r4/final; B=ab61e04161; H=e15058c26b
base=$(basename $M .ts); tag=$(echo $M | tr '/.' '__'); OUT=$F/attr-$tag; mkdir -p $OUT
cd $W && git checkout -q --detach $H
T=$(cd packages/core && grep -rlE "from '[./]*[^']*/$base(\.js)?'" src --include='*.test.ts' | sort -u | tr '\n' ' ')
echo "== $M: $(echo $T | wc -w) importing test files"
for run in base1:$B head1:$H base2:$B head2:$H; do n=${run%%:*}; rev=${run#*:}
  git checkout -q --detach $rev; cd packages/core
  EX=""; for t in $T; do [ -f $t ] && EX="$EX $t"; done
  rm -rf $OUT/cov-$n; CI=1 timeout 900 npx vitest run $EX --coverage.enabled=true --coverage.include=$M --coverage.reporter=lcov --coverage.reportOnFailure=true --coverage.reportsDirectory=$OUT/cov-$n >/dev/null 2>&1
  cd $W; done
git checkout -q --detach $B
CD=/projects/knowledge/qwen-code/scripts/test-loc/coverage-diff.mjs
for p in "base1 head1" "base2 head2" "base1 base2" "head1 head2"; do set -- $p; echo "  $1->$2: $(node $CD $OUT/cov-$1/lcov.info $OUT/cov-$2/lcov.info --files $M --list | grep -E 'C3 lost|^\s+lost' | tr -s ' ' | tr '\n' ';')"; done
