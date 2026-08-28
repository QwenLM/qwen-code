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
# lockfile that produced them) snapshotted by hardlink and renamed into
# place atomically, marker file last — and `fetch-pr` link-farms the entry
# matching the PR's OWN lockfile into the worktree it creates
# (QWEN_REVIEW_DEPS_CACHE, exported below).
#
# Trust separation, not content attestation, is the gate: the entry would
# otherwise sit on a path writable by the unsandboxed PR code this same job
# executes next, and no manifest re-hash can close that class (a write side
# can always re-author the state it is checked against). On pool members
# with passwordless sudo the cache root and every published entry are
# therefore elevated to root ownership at publish time — the PR code keeps
# the read access the farm needs and loses the write every tamper channel
# needs — and prune/teardown removals go through the same sudo. Where sudo
# is unavailable the publish degrades to a user-owned entry and the
# manifest/source-rev re-verification below remains the backstop (proven
# incomplete as a primary gate, but better than none).
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
# Passwordless sudo, probed ONCE with the same pattern the workflow's
# ownership-repair steps use: the elevation below is only attempted where it
# can actually run, and every later `sudo -n` re-uses the probe's answer.
SUDO_OK=false
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO_OK=true
fi
# Removal that works on root-owned paths too: a plain rm first (user-owned
# entries, and every path this script itself created), then the sudo leg.
# Both legs failing only warns — the leftover costs a later run the same way
# a failed population does, never the job.
drop_path() {
  rm -rf "$1" 2>/dev/null && return 0
  if [ "$SUDO_OK" = true ]; then
    sudo -n rm -rf "$1" 2>/dev/null && return 0
  fi
  echo "::warning::could not remove $1; a later run retries"
  return 1
}
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
# — file count included, an added file is a write nobody vouched for. On
# sudo members the root ownership IS the seal and this is the staleness
# check plus the degraded-mode backstop; where the publish had to stay
# user-owned it is the only tripwire there is.
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
    # serving reviews is never the one evicted. Root-owned entries need the
    # sudo leg to touch it.
    touch "$ENTRY" 2>/dev/null || {
      [ "$SUDO_OK" = true ] && sudo -n touch "$ENTRY" 2>/dev/null
    }
    echo "dependency cache warm: $ENTRY"
    exit 0
  fi
  # Failed verification: stale revision or modified content. Drop it and
  # repopulate below rather than serve it.
  echo "dependency cache entry failed verification; rebuilding it"
  drop_path "$ENTRY"
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
# Stage where the cache root is writable (inside it, so the hardlinks and
# the final rename stay on one filesystem) and otherwise — a root-owned
# cache root after an elevated publish — under $HOME, same filesystem as the
# cache root, so the sudo mv below is still an atomic rename.
if [ -w "$CACHE_ROOT" ]; then
  STAGE="$(mktemp -d "$CACHE_ROOT/.stage.XXXXXX")" || exit 0
else
  STAGE="$(mktemp -d "$HOME/.qwen-review-deps-stage.XXXXXX")" || exit 0
fi
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
  drop_path "$STAGE"
  exit 0
fi
# Publish only an entry later runs can verify: record the revision the dist
# trees were built from and hash every staged file into the manifest. Both
# land BEFORE the marker, so the atomic rename seals them with it, and the
# warm check above (and the provisioning library) refuses an entry that
# does not carry them or does not match them. The manifest temp lives under
# $HOME: the cache root may already be root-owned, and the final mv only
# needs one filesystem.
SOURCE_REV="$(git rev-parse HEAD 2>/dev/null)"
printf '%s\n' "$SOURCE_REV" > "$STAGE/.qwen-review-source-rev" || ok=false
if [ "$ok" = true ]; then
  MANIFEST_TMP="$(mktemp "$HOME/.qwen-review-deps-manifest.XXXXXX" 2>/dev/null)" || ok=false
fi
if [ "$ok" = true ]; then
  ( cd "$STAGE" && find . -type f -exec sha256sum {} + ) > "$MANIFEST_TMP" || ok=false
fi
if [ "$ok" != true ]; then
  echo '::warning::dependency-cache snapshot could not be sealed; discarding the stage'
  drop_path "$STAGE"
  [ -n "${MANIFEST_TMP:-}" ] && rm -rf "$MANIFEST_TMP"
  exit 0
fi
mv "$MANIFEST_TMP" "$STAGE/.qwen-review-deps-manifest" || { drop_path "$STAGE"; exit 0; }
: > "$STAGE/.qwen-review-deps-complete"
# Publish. On a sudo member the entry and the cache root become root-owned:
# the unsandboxed PR code this job executes next keeps the read access the
# farm needs and loses every write path into the shared entry (in-place
# rewrite, unlink-and-recreate, wholesale replacement, a symlink planted at
# the entry name). Members without passwordless sudo keep the user-owned
# publish, where the manifest re-verification stays the backstop.
if [ "$SUDO_OK" = true ]; then
  # Immutable files BEFORE the elevation (the user still owns the stage),
  # so a degraded re-publish never serves writable payloads either.
  find "$STAGE" -type f -exec chmod a-w {} + 2>/dev/null
  if sudo -n chown -R root:root "$STAGE" 2>/dev/null &&
     sudo -n chown root:root "$CACHE_ROOT" 2>/dev/null &&
     sudo -n chmod go-w "$CACHE_ROOT" 2>/dev/null &&
     sudo -n mv -T "$STAGE" "$ENTRY" 2>/dev/null; then
    echo "dependency cache populated: $ENTRY"
  else
    # Elevation lost mid-flight (or the entry appeared some other way):
    # discard the stage rather than publish it half-owned, and let the next
    # run retry. The warm path above already served an intact entry.
    echo '::warning::dependency-cache elevation failed; the entry was not published'
    drop_path "$STAGE"
  fi
elif mv -T "$STAGE" "$ENTRY" 2>/dev/null; then
  # Immutable files after publish: a write through a farm link by the PR
  # code this job is about to execute dies EACCES instead of corrupting
  # every later review served from this entry. Directories stay writable,
  # so the prune and any teardown can still unlink.
  find "$ENTRY" -type f -exec chmod a-w {} + 2>/dev/null
  echo "dependency cache populated: $ENTRY"
else
  # Lost a same-host race, or the entry appeared some other way — either way
  # the stage is surplus.
  drop_path "$STAGE"
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
# inodes). Root-owned entries need the sudo leg to unlink.
find "$CACHE_ROOT" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %f\n' 2>/dev/null |
  sort -rn | awk '{print $2}' | grep -Ex '[0-9a-f]{64}' | tail -n +4 |
  while IFS= read -r old; do drop_path "${CACHE_ROOT:?}/$old"; done
find "$CACHE_ROOT" -maxdepth 1 \( -name '.stage.*' -o -name '.manifest.*' \) -mmin +240 -exec rm -rf {} + 2>/dev/null
# Torn stages and abandoned manifest temps from an elevated publish live
# under $HOME, outside the (possibly root-owned) cache root.
find "$HOME" -maxdepth 1 \( -name '.qwen-review-deps-stage.*' -o -name '.qwen-review-deps-manifest.*' \) -mmin +240 -exec rm -rf {} + 2>/dev/null
exit 0
