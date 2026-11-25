#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ $# != 1 && $# != 2 ]]; then
  echo "Usage: $0 <github-branch> [internal-branch]" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source_repository="${GITHUB_REPOSITORY:-https://github.com/QwenLM/qwen-code.git}"
source_branch="${1#refs/heads/}"
target_branch="${2:-sync/github/$source_branch}"

if ! git check-ref-format "refs/heads/$source_branch" ||
  ! git check-ref-format "refs/heads/$target_branch"; then
  echo "Invalid branch name: $source_branch -> $target_branch" >&2
  exit 2
fi

git fetch --no-tags "$source_repository" "refs/heads/$source_branch"
source_sha="$(git rev-parse FETCH_HEAD)"
existing_sha="$(git ls-remote origin "refs/heads/$target_branch" | awk 'NR == 1 {print $1}')"
if [[ -n "$existing_sha" ]] && ! git merge-base --is-ancestor "$existing_sha" "$source_sha"; then
  echo "Refusing to overwrite unrelated history on origin/$target_branch ($existing_sha)." >&2
  echo 'Choose another internal branch for this candidate.' >&2
  exit 2
fi

git push origin "$source_sha:refs/heads/$target_branch"
synced_sha="$(git ls-remote origin "refs/heads/$target_branch" | awk 'NR == 1 {print $1}')"
if [[ "$synced_sha" != "$source_sha" ]]; then
  echo "Internal branch verification failed: expected $source_sha, got $synced_sha" >&2
  exit 1
fi

echo "Synced $source_repository#$source_branch ($source_sha) to origin/$target_branch"
echo "Next: run qwen-managed-agent-maven-snapshot on branch $target_branch"
