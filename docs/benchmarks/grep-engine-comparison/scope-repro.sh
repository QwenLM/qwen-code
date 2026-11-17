#!/bin/sh
# Reproduce the search-scope edges between main's git grep strategy and
# preview's ripgrep engine, in a throwaway repository. Requires: git, rg.
# Usage: sh scope-repro.sh
set -eu

T=$(mktemp -d "${TMPDIR:-/tmp}/grep-scope-repro.XXXXXX")
trap 'rm -rf "$T"' EXIT
cd "$T"
git init -q .
git config user.email repro@example.com
git config user.name repro

mkdir -p dist ignored
printf 'needle\n' > src.txt
printf 'needle\n' > dist/bundle.js
printf 'needle\n' > ignored/x.txt
printf 'needle\n' > force.txt
printf 'dist/\nignored/\n' > .gitignore
git add -f force.txt
git add src.txt .gitignore
git commit -qm init
printf 'needle\n' > untracked.txt
printf 'needle\n' > hidden-secret.txt
printf 'hidden-secret.txt\n' > .rgignore
ln -s src.txt symlink.txt

echo '=== 1. git grep --untracked (main strategy 1) ==='
git grep --untracked -l -E --ignore-case -e needle | sort
echo
echo '=== 2. rg --hidden (preview engine flags) ==='
rg --hidden -l needle -- . | sort
echo
echo 'Expected differences:'
echo '  - force-added ignored file (force.txt): git grep YES, rg NO (rg does not read the index)'
echo '  - .rgignore-hidden file (hidden-secret.txt): git grep YES, rg NO (repo-controlled exclusion)'
echo '  - ignored build output (dist/, ignored/): both NO'
echo '  - untracked non-ignored (untracked.txt): both YES'
echo
echo '=== 3. old main fallback (grep -r, pre-fix) ==='
grep -r -l -E --exclude-dir=.git -e needle . | sort
echo 'Expected: also lists dist/bundle.js and ignored/x.txt (the scope pollution this PR fixes)'
echo
echo '=== 4. fixed main fallback corpus (git ls-files | grep) ==='
git ls-files -z --cached --others --exclude-standard | xargs -0 grep -l -E --ignore-case -e needle | sort
echo 'Expected: identical file set to section 1'
echo
echo '=== 5. symlink edge ==='
echo 'git grep (untracked symlink reads link text):'
git grep --untracked -l -E -e needle -- symlink.txt || echo '  (no match: link text is "src.txt")'
echo 'rg default (skips symlinks):'
rg -l needle -- symlink.txt || echo '  (no match)'
echo 'rg --follow (searches target):'
rg --follow -l needle -- symlink.txt || echo '  (no match)'