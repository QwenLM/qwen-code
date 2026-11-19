#!/bin/sh
# Reproduce the search-scope edges between main's git grep strategy and
# preview's ripgrep engine, in a throwaway repository. Requires: git, rg.
# Usage: sh scope-repro.sh
set -eu

# Every measurement below ends in `| sort` or `|| echo '(no match)'`, so `set -e`
# never fires on a missing binary: a host without ripgrep would print the very
# "(no match)" text the section claims to demonstrate, and the transcript would
# read as a complete reproduction. Fail loudly instead.
for bin in git grep rg; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ERROR: $bin not found on PATH; refusing to print a fake reproduction." >&2
    exit 1
  }
done

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
# force.txt must be listed here, otherwise `git add -f` is a no-op and the
# force-added-ignored-file difference section 1 claims is never created.
printf 'dist/\nignored/\nforce.txt\n' > .gitignore
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
rg --hidden --glob '!.git' --glob '!.jj' --glob '!.svn' --glob '!.hg' --glob '!.bzr' --glob '!.sl' -l needle -- . | sort
echo
echo 'Expected differences:'
echo '  - force-added ignored file (force.txt): git grep --untracked NO, rg NO.'
echo '    Measured on git 2.50.1: --untracked applies the exclude machinery to'
echo '    tracked files too, while plain git grep and git grep --cached DO find'
echo '    it. The fixed fallback corpus (ls-files --cached) also lists it, so in'
echo '    this one edge the fallbacks search a file the primary skips (section 4).'
echo '  - .rgignore-hidden file (hidden-secret.txt): git grep YES, rg NO (repo-controlled exclusion)'
echo '  - ignored build output (dist/, ignored/): both NO'
echo '  - untracked non-ignored (untracked.txt): both YES'
echo
echo '=== 3. old main fallback (grep -r, pre-fix) ==='
grep -r -l -E --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=bower_components --exclude-dir=.svn --exclude-dir=.hg -e needle . | sort
echo 'Expected: also lists dist/bundle.js and ignored/x.txt (the scope pollution this PR fixes)'
echo
echo '=== 4. fixed main fallback corpus (git ls-files | grep) ==='
echo 'corpus filtered to regular files the way grep.ts filters it, and with'
echo '--ignore-case, matching the shipped system-grep argv (-l stands in for'
echo '-n -H --null here, for readability):'
git ls-files --cached --others --exclude-standard |
  while IFS= read -r f; do
    if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\n' "$f"; fi
  done |
  xargs grep -l -E --ignore-case -e needle | sort
echo 'Expected: section 1 plus force.txt. The corpus comes from ls-files --cached,'
echo '          which lists force-added ignored files that git grep --untracked'
echo '          skips; every other entry matches section 1.'
echo
echo 'same flags over the UNFILTERED ls-files output:'
git ls-files -z --cached --others --exclude-standard |
  xargs -0 grep -l -E --ignore-case -e needle | sort
echo 'Expected: also lists symlink.txt -- grep dereferences a symlink handed to it'
echo '          as an explicit operand and reports the target content as a match'
echo '          inside the repository. That is what the filter above removes.'
echo
echo '=== 5. symlink edge ==='
echo 'git grep (skips symlink entries entirely -- neither target nor link text):'
git grep --untracked -l -E -e needle -- symlink.txt || echo '  (no match: the target is not searched)'
git grep --untracked -n -E -e 'src\.txt' -- symlink.txt || echo '  (no match: the link text is not searched either)'
echo 'rg during recursion (skips symlinks it encounters):'
rg --hidden -l needle -- . | grep symlink.txt || echo '  (symlink.txt not listed)'
echo 'rg with the symlink as an explicit operand (follows it, same as grep):'
rg -l needle -- symlink.txt || echo '  (no match)'
echo 'fixed main fallback: the corpus drops symlinks, so they never become an operand.'
echo 'pre-fix behaviour, symlink as a plain grep operand:'
grep -l -E -e needle -- symlink.txt || echo '  (no match)'
echo '  ^ listing symlink.txt here means grep read src.txt through the link'
echo 'explicit recursive operand: BSD grep 2.6.0-FreeBSD skips it; GNU grep follows:'
grep -r -l -E -e needle -- symlink.txt || echo '  (no match: -r does not follow an explicit symlink operand)'
echo 'the pre-fix JavaScript arm DID follow: globStream yields the link and'
echo 'readFile dereferences it. The corpus filter closes both.'
