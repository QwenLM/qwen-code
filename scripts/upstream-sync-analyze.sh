#!/usr/bin/env bash
# upstream-sync-analyze.sh
# Analyzes differences between internal fork and upstream repository.
# Outputs a markdown report to stdout.

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

NEW_UPSTREAM_COMMITS=$(git log --oneline "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --no-merges | wc -l | tr -d ' ')
NEW_INTERNAL_COMMITS=$(git log --oneline "$MERGE_BASE..HEAD" --no-merges | wc -l | tr -d ' ')

UPSTREAM_FIRST_DATE=$(git log --format='%ci' "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --no-merges --reverse | head -1 | cut -d' ' -f1)
UPSTREAM_LAST_DATE=$(git log --format='%ci' -1 "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | cut -d' ' -f1)

INTERNAL_ONLY=$(comm -23 <(git diff --name-only "$MERGE_BASE" HEAD | sort) <(git diff --name-only "$MERGE_BASE" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort) | wc -l | tr -d ' ')
UPSTREAM_ONLY=$(comm -13 <(git diff --name-only "$MERGE_BASE" HEAD | sort) <(git diff --name-only "$MERGE_BASE" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort) | wc -l | tr -d ' ')
BOTH_CHANGED=$(comm -12 <(git diff --name-only "$MERGE_BASE" HEAD | sort) <(git diff --name-only "$MERGE_BASE" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort) | wc -l | tr -d ' ')

cat <<EOF
# Upstream Sync Report - $(date +%Y-%m-%d)

## Summary

| Metric | Value |
|---|---|
| Merge base | \`$MERGE_BASE\` |
| Internal HEAD | \`$INTERNAL_HEAD\` ($NEW_INTERNAL_COMMITS commits ahead) |
| Upstream HEAD | \`$UPSTREAM_HEAD\` ($NEW_UPSTREAM_COMMITS new commits) |
| Date range | $UPSTREAM_FIRST_DATE ~ $UPSTREAM_LAST_DATE |

## File Overlap

| Category | Count | Risk |
|---|---|---|
| Internal-only files | $INTERNAL_ONLY | Safe (no conflict) |
| Upstream-only files | $UPSTREAM_ONLY | Auto-merge |
| Both-changed files | $BOTH_CHANGED | Needs review |

## Upstream Commits by Area

EOF

# Categorize upstream commits by conventional commit scope
git log --oneline --no-merges "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | while IFS= read -r line; do
  echo "$line"
done | grep -oP '(?:fix|feat|refactor|chore|docs|test|ci|build)\(([^)]+)\)' | \
  sed 's/.*(\(.*\))/\1/' | sort | uniq -c | sort -rn | head -20 | while read count area; do
    echo "- **$area**: $count commits"
  done

cat <<EOF

## Both-Changed Files (potential conflicts)

EOF

comm -12 <(git diff --name-only "$MERGE_BASE" HEAD | sort) <(git diff --name-only "$MERGE_BASE" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort) | \
  sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -15 | while read count dir; do
    echo "- \`$dir/\`: $count files"
  done

cat <<EOF

## Latest Upstream Commits

EOF

git log --oneline --no-merges "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | head -20 | while IFS= read -r line; do
  echo "- \`$line\`"
done

REMAINING=$(( NEW_UPSTREAM_COMMITS - 20 ))
if [ "$REMAINING" -gt 0 ]; then
  echo "- ... and $REMAINING more"
fi

cat <<EOF

## Recommendation

EOF

if [ "$BOTH_CHANGED" -eq 0 ]; then
  echo "All changes are in separate files. Safe to auto-merge."
elif [ "$BOTH_CHANGED" -lt 10 ]; then
  echo "Low conflict risk ($BOTH_CHANGED overlapping files). LLM auto-resolve should handle this."
elif [ "$BOTH_CHANGED" -lt 50 ]; then
  echo "Medium conflict risk ($BOTH_CHANGED overlapping files). Review recommended before merge."
else
  echo "High conflict risk ($BOTH_CHANGED overlapping files). Manual review strongly recommended."
fi
