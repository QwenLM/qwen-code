#!/usr/bin/env bash
# Provision the review dependency cache on the persistent runners
# (qwen-code-pr-review.yml, 'Provision review dependency cache' — #10108).
#
# The review worktree `fetch-pr` builds is a bare checkout, and a full
# `npm ci` plus the prepare build does not fit inside a review agent's tool
# budget — so every probe that decided the right evidence was "run the test"
# burned its budget on a doomed install and the round downgraded to a
# disclosed read-only audit (PR #9729 rounds 13/15, PR #9940's own review).
# On the persistent pool the install can instead happen ONCE, here, before
# the agent starts and outside any agent's budget: this script keeps
# $HOME/.qwen-review-deps/<lockfile-sha256> populated — a real `npm ci`
# result (root and nested node_modules, every workspace's built dist, the
# lockfile that produced them, npm's own completeness marker) snapshotted by
# hardlink and renamed into place atomically, marker file last — and
# `fetch-pr` link-farms the entry matching the PR's OWN lockfile into the
# worktree it creates (QWEN_REVIEW_DEPS_CACHE, exported below).
#
# A cold cache or a PR that changes the lockfile falls back to today's
# behaviour inside `fetch-pr`, so this script must never fail the job: the
# step's continue-on-error is the belt, the guards below are the suspenders,
# and its timeout-minutes bounds a hung registry the way the capture-tools
# step bounds a hung mirror. Exercised — real bash, stubbed npm/df — by
# scripts/tests/qwen-pr-review-workflow.test.js.

# Deliberately +e: every failure below degrades to the pre-cache behaviour,
# and the trailing `exit 0` makes that total.
set -u
set +e
CACHE_ROOT="$HOME/.qwen-review-deps"
mkdir -p "$CACHE_ROOT" || exit 0
# Export unconditionally and FIRST: the worktree's lockfile picks the entry,
# so an OLDER entry can still serve a PR based before a lockfile bump even
# when this run's population fails or is skipped.
echo "QWEN_REVIEW_DEPS_CACHE=$CACHE_ROOT" >> "$GITHUB_ENV"
if [ ! -f package-lock.json ]; then
  echo 'no package-lock.json in the checkout; nothing to provision'
  exit 0
fi
HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
ENTRY="$CACHE_ROOT/$HASH"
# An entry is served only while it is still what the population step
# published: the recorded source revision must equal this checkout's HEAD
# (the entry is keyed on the lockfile ALONE, so a source-only base change
# would otherwise keep serving sibling dist built from an older commit), and
# every file must hash back to the manifest staged before the atomic rename
# — file count included, an added file is a write nobody vouched for. The
# entry lives on a path writable by the unsandboxed PR code this same job
# executes, so the completeness marker alone cannot be trusted.
entry_verifies() {
  local e="$1" recorded current listed actual
  recorded="$(cat "$e/.qwen-review-source-rev" 2>/dev/null)"
  current="$(git rev-parse HEAD 2>/dev/null)"
  [ -n "$recorded" ] && [ "$recorded" = "$current" ] || return 1
  [ -f "$e/.qwen-review-deps-manifest" ] || return 1
  ( cd "$e" && sha256sum -c --quiet .qwen-review-deps-manifest >/dev/null 2>&1 ) || return 1
  listed=$(wc -l < "$e/.qwen-review-deps-manifest")
  actual=$(
    cd "$e" && find . -type f       ! -name .qwen-review-deps-manifest       ! -name .qwen-review-deps-complete | wc -l
  )
  [ "$listed" -eq "$actual" ]
}
if [ -f "$ENTRY/.qwen-review-deps-complete" ]; then
  if entry_verifies "$ENTRY"; then
    # Freshen the mtime the prune below sorts by, so an entry that is still
    # serving reviews is never the one evicted.
    touch "$ENTRY" 2>/dev/null
    echo "dependency cache warm: $ENTRY"
    exit 0
  fi
  # Failed verification: stale revision or modified content. Drop it and
  # repopulate below rather than serve it.
  echo "dependency cache entry failed verification; rebuilding it"
  rm -rf "$ENTRY"
fi
# Disk gate, same contract as build-test's: an `npm ci` that dies on ENOSPC
# leaves a partial tree AND a full disk for every later step. The install
# plus the snapshot need roughly two tree copies.
free_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt 10485760 ]; then
  echo "::warning::dependency cache not populated: ${free_kb}KB free under \$HOME (need ~10G)"
  exit 0
fi
echo "dependency cache cold for lockfile ${HASH}; installing (once per lockfile per runner, outside every agent's budget)"
# Plain `npm ci`, prepare hook INCLUDED: the hook builds every workspace's
# dist, which is exactly the prebuilt-sibling half of what the cache exists
# to serve.
if ! npm ci --no-audit --no-fund --progress=false; then
  echo '::warning::npm ci failed; reviews on this runner keep the uncached behaviour'
  exit 0
fi
# Stage INSIDE the cache root so the hardlinks and the final rename stay on
# one filesystem; the rename is what makes a torn snapshot impossible to
# observe (the completeness marker lands in the stage, so it exists only in
# entries that arrived whole).
STAGE="$(mktemp -d "$CACHE_ROOT/.stage.XXXXXX")" || exit 0
snapshot() {
  # Hardlink first (instant, and npm replaces files rather than editing in
  # place, so shared inodes stay what `npm ci` wrote); plain copy as the
  # cross-device fallback.
  local rel="$1"
  mkdir -p "$STAGE/$(dirname "$rel")" &&
    { cp -al "$rel" "$STAGE/$rel" 2>/dev/null || { rm -rf "${STAGE:?}/$rel"; cp -a "$rel" "$STAGE/$rel"; }; }
}
ok=true
snapshot package-lock.json || ok=false
while IFS= read -r path; do
  snapshot "${path#./}" || { ok=false; break; }
done < <(find . \( -name .git -prune \) -o \( -type d -name node_modules -print -prune \))
while IFS= read -r path; do
  snapshot "${path#./}" || { ok=false; break; }
done < <(find . \( -name .git -o -name node_modules \) -prune -o -type d -name dist ! -path ./dist -print -prune)
if [ "$ok" != true ]; then
  echo '::warning::dependency-cache snapshot failed; discarding the stage'
  rm -rf "$STAGE"
  exit 0
fi
# Publish only an entry later runs can verify: record the revision the dist
# trees were built from and hash every staged file into a manifest. Both
# land BEFORE the marker, so the atomic rename seals them with it, and the
# warm check above (and the provisioning library) refuses an entry that
# does not carry them or does not match them.
SOURCE_REV="$(git rev-parse HEAD 2>/dev/null)"
printf '%s\n' "$SOURCE_REV" > "$STAGE/.qwen-review-source-rev" || ok=false
if [ "$ok" = true ]; then
  MANIFEST_TMP="$(mktemp "$CACHE_ROOT/.manifest.XXXXXX" 2>/dev/null)" || ok=false
fi
if [ "$ok" = true ]; then
  ( cd "$STAGE" && find . -type f -exec sha256sum {} + ) > "$MANIFEST_TMP" || ok=false
fi
if [ "$ok" != true ]; then
  echo '::warning::dependency-cache snapshot could not be sealed; discarding the stage'
  rm -rf "$STAGE"
  [ -n "${MANIFEST_TMP:-}" ] && rm -rf "$MANIFEST_TMP"
  exit 0
fi
mv "$MANIFEST_TMP" "$STAGE/.qwen-review-deps-manifest" || { rm -rf "$STAGE"; exit 0; }
: > "$STAGE/.qwen-review-deps-complete"
if mv -T "$STAGE" "$ENTRY" 2>/dev/null; then
  # Immutable files after publish: a write through a farm link by the PR
  # code this job is about to execute dies EACCES instead of corrupting
  # every later review served from this entry. Directories stay writable,
  # so the prune and any teardown can still unlink.
  find "$ENTRY" -type f -exec chmod a-w {} + 2>/dev/null
  echo "dependency cache populated: $ENTRY"
else
  # Lost a same-host race, or the entry appeared some other way — either way
  # the stage is surplus.
  rm -rf "$STAGE"
  if [ -f "$ENTRY/.qwen-review-deps-complete" ]; then
    echo "dependency cache populated concurrently: $ENTRY"
  else
    echo '::warning::could not move the staged dependency cache into place'
  fi
fi
# The built state now lives in the cache; drop it from the workspace so the
# next job's checkout clean and ownership repair do not crawl a two-gigabyte
# tree that no longer serves anything.
find . \( -name .git -prune \) -o \( -type d -name node_modules -print -prune \) | while IFS= read -r path; do rm -rf "$path"; done
find . \( -name .git -o -name node_modules \) -prune -o -type d -name dist -print -prune | while IFS= read -r path; do rm -rf "$path"; done
# Prune: newest three entries stay (~2G each; distinct installs share no
# inodes). Sweep stale stages too — an entry name is 64 hex chars, so
# neither pattern can touch the other's files.
find "$CACHE_ROOT" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %f\n' 2>/dev/null |
  sort -rn | awk '{print $2}' | grep -Ex '[0-9a-f]{64}' | tail -n +4 |
  while IFS= read -r old; do rm -rf "${CACHE_ROOT:?}/$old"; done
find "$CACHE_ROOT" -maxdepth 1 \( -name '.stage.*' -o -name '.manifest.*' \) -mmin +240 -exec rm -rf {} + 2>/dev/null
exit 0
