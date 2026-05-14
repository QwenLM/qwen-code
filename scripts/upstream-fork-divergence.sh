#!/usr/bin/env bash
# upstream-fork-divergence.sh
# Automatically analyzes all divergences between internal fork and upstream.
# Generates a comprehensive markdown report to stdout.
# No manual manifest needed — everything derived from git diff.

set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

if ! git rev-parse --verify "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >/dev/null 2>&1; then
  echo "Ref $UPSTREAM_REMOTE/$UPSTREAM_BRANCH not found locally, fetching..."
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" 2>/dev/null || {
    echo "ERROR: Failed to fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
    exit 1
  }
fi

MERGE_BASE=$(git merge-base HEAD "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
INTERNAL_HEAD=$(git rev-parse --short HEAD)
UPSTREAM_HEAD=$(git rev-parse --short "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

INTERNAL_FILES=$(git diff --name-only "$MERGE_BASE" HEAD | sort)
UPSTREAM_FILES=$(git diff --name-only "$MERGE_BASE" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort)

INTERNAL_ONLY=$(comm -23 <(echo "$INTERNAL_FILES") <(echo "$UPSTREAM_FILES"))
UPSTREAM_ONLY=$(comm -13 <(echo "$INTERNAL_FILES") <(echo "$UPSTREAM_FILES"))
BOTH_CHANGED=$(comm -12 <(echo "$INTERNAL_FILES") <(echo "$UPSTREAM_FILES"))

INTERNAL_ONLY_COUNT=$(echo "$INTERNAL_ONLY" | grep -c . || true)
UPSTREAM_ONLY_COUNT=$(echo "$UPSTREAM_ONLY" | grep -c . || true)
BOTH_CHANGED_COUNT=$(echo "$BOTH_CHANGED" | grep -c . || true)

categorize_file() {
  local file="$1"
  case "$file" in
    packages/cli/src/ui/components/Header.tsx|packages/cli/src/ui/components/Tips.tsx|packages/cli/src/ui/components/AsciiArt.ts)
      echo "branding" ;;
    .qwen/*|.aoneci/*|.dataworks*)
      echo "internal-config" ;;
    packages/cli/src/config/settingsSchema.ts)
      echo "feature-flags" ;;
    packages/cli/src/gemini.tsx|packages/cli/src/ui/components/Composer.tsx)
      echo "feature-gated" ;;
    docs/superpowers/*|scripts/upstream-*)
      echo "sync-infra" ;;
    packages/core/*)
      echo "core" ;;
    packages/cli/*)
      echo "cli" ;;
    packages/sdk-*|packages/webui/*|packages/vscode-*|packages/zed-*)
      echo "packages" ;;
    *.md|docs/*|docs-site/*)
      echo "docs" ;;
    *.test.ts|integration-tests/*)
      echo "tests" ;;
    package.json|package-lock.json|tsconfig*|eslint*|esbuild*)
      echo "build-config" ;;
    .github/*)
      echo "github-ci" ;;
    *)
      echo "other" ;;
  esac
}

declare -A CAT_COUNTS_INTERNAL CAT_COUNTS_BOTH

while IFS= read -r f; do
  [ -z "$f" ] && continue
  cat=$(categorize_file "$f")
  CAT_COUNTS_INTERNAL[$cat]=$(( ${CAT_COUNTS_INTERNAL[$cat]:-0} + 1 ))
done <<< "$INTERNAL_ONLY"

while IFS= read -r f; do
  [ -z "$f" ] && continue
  cat=$(categorize_file "$f")
  CAT_COUNTS_BOTH[$cat]=$(( ${CAT_COUNTS_BOTH[$cat]:-0} + 1 ))
done <<< "$BOTH_CHANGED"

cat <<EOF
# Fork Divergence Report - $(date +%Y-%m-%d)

## Overview

| Metric | Value |
|---|---|
| Merge base | \`$MERGE_BASE\` |
| Internal HEAD | \`$INTERNAL_HEAD\` |
| Upstream HEAD | \`$UPSTREAM_HEAD\` |
| Total internal-only files | $INTERNAL_ONLY_COUNT |
| Total upstream-only files | $UPSTREAM_ONLY_COUNT |
| Total both-changed files | $BOTH_CHANGED_COUNT |
| **Divergence score** | **$BOTH_CHANGED_COUNT** (lower is better) |

## Internal-Only Changes by Category

These files only exist or are modified on the internal fork:

| Category | Count | Intent |
|---|---|---|
EOF

for cat in branding internal-config feature-flags feature-gated sync-infra core cli packages docs tests build-config github-ci other; do
  count=${CAT_COUNTS_INTERNAL[$cat]:-0}
  if [ "$count" -gt 0 ]; then
    case "$cat" in
      branding)          intent="permanent (feature-flagged)" ;;
      internal-config)   intent="permanent (internal infra)" ;;
      feature-flags)     intent="permanent (config-driven)" ;;
      feature-gated)     intent="converging (feature-flagged)" ;;
      sync-infra)        intent="permanent (sync tooling)" ;;
      core|cli|packages) intent="review needed" ;;
      docs)              intent="may converge" ;;
      tests)             intent="may converge" ;;
      build-config)      intent="review needed" ;;
      github-ci)         intent="upstream-only CI, skip" ;;
      *)                 intent="unknown" ;;
    esac
    echo "| $cat | $count | $intent |"
  fi
done

cat <<EOF

## Both-Changed Files (Conflict Risk)

These files are modified on both sides — merges may produce conflicts:

| Category | Count | Resolution Strategy |
|---|---|---|
EOF

for cat in branding internal-config feature-flags feature-gated sync-infra core cli packages docs tests build-config github-ci other; do
  count=${CAT_COUNTS_BOTH[$cat]:-0}
  if [ "$count" -gt 0 ]; then
    case "$cat" in
      branding)          strategy="keep-ours (feature-flagged)" ;;
      internal-config)   strategy="keep-ours" ;;
      feature-flags)     strategy="manual merge (preserve both)" ;;
      feature-gated)     strategy="ai-resolve" ;;
      core|cli|packages) strategy="ai-resolve" ;;
      docs)              strategy="keep-theirs" ;;
      tests)             strategy="ai-resolve" ;;
      build-config)      strategy="manual merge" ;;
      github-ci)         strategy="keep-theirs" ;;
      *)                 strategy="ai-resolve" ;;
    esac
    echo "| $cat | $count | $strategy |"
  fi
done

cat <<EOF

## Internal-Only Files Detail

EOF

echo "$INTERNAL_ONLY" | head -50 | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "- \`$f\` ($(categorize_file "$f"))"
done

REMAINING_INTERNAL=$(( INTERNAL_ONLY_COUNT - 50 ))
if [ "$REMAINING_INTERNAL" -gt 0 ]; then
  echo "- ... and $REMAINING_INTERNAL more"
fi

cat <<EOF

## Both-Changed Files Detail

EOF

echo "$BOTH_CHANGED" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "- \`$f\` ($(categorize_file "$f"))"
done

cat <<EOF

## Convergence Summary

EOF

PERMANENT=0
CONVERGING=0
REVIEW_NEEDED=0

for cat in branding internal-config feature-flags sync-infra; do
  PERMANENT=$(( PERMANENT + ${CAT_COUNTS_INTERNAL[$cat]:-0} ))
done
for cat in feature-gated docs tests; do
  CONVERGING=$(( CONVERGING + ${CAT_COUNTS_INTERNAL[$cat]:-0} ))
done
for cat in core cli packages build-config other; do
  REVIEW_NEEDED=$(( REVIEW_NEEDED + ${CAT_COUNTS_INTERNAL[$cat]:-0} ))
done

cat <<EOF
| Status | Files | Description |
|---|---|---|
| Permanent | $PERMANENT | Feature-flagged or internal-only infra, no convergence needed |
| Converging | $CONVERGING | Can be merged back to upstream with feature flags |
| Review needed | $REVIEW_NEEDED | Need manual assessment for convergence path |

## Recommendation

EOF

TOTAL_DIVERGENCE=$(( INTERNAL_ONLY_COUNT + BOTH_CHANGED_COUNT ))
if [ "$TOTAL_DIVERGENCE" -lt 20 ]; then
  echo "Fork divergence is low ($TOTAL_DIVERGENCE files). Maintenance cost is manageable."
elif [ "$TOTAL_DIVERGENCE" -lt 50 ]; then
  echo "Fork divergence is moderate ($TOTAL_DIVERGENCE files). Consider converging \`feature-gated\` files."
else
  echo "Fork divergence is high ($TOTAL_DIVERGENCE files). Prioritize convergence to reduce sync friction."
fi
EOF
