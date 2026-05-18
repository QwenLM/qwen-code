#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! command -v colima >/dev/null 2>&1; then
  echo "colima is required. Install it with: brew install colima" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is required. Install it with: brew install docker" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Starting Colima for local GitHub Actions smoke..."
  colima start --cpu 2 --memory 4 --disk 20
fi

if ! command -v act >/dev/null 2>&1; then
  echo "act is required. Install it with: brew install act" >&2
  exit 1
fi

pr_number="${1:-}"
if [ -z "$pr_number" ] && command -v gh >/dev/null 2>&1; then
  pr_number="$(gh pr view --json number --jq '.number' 2>/dev/null || true)"
fi

if [ -z "$pr_number" ]; then
  echo "Usage: $0 <pr-number>" >&2
  echo "Could not infer a PR number from the current branch." >&2
  exit 1
fi

event_file="$(mktemp)"
trap 'rm -f "$event_file"' EXIT

cat > "$event_file" <<JSON
{
  "action": "edited",
  "changes": {
    "body": {
      "from": "previous body"
    }
  },
  "pull_request": {
    "number": $pr_number,
    "author_association": "MEMBER"
  },
  "repository": {
    "full_name": "${GITHUB_REPOSITORY:-QwenLM/qwen-code}"
  },
  "sender": {
    "login": "${GITHUB_ACTOR:-local-act-smoke}"
  }
}
JSON

token="${GITHUB_TOKEN:-}"
if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then
  token="$(gh auth token 2>/dev/null || true)"
fi

if [ -z "$token" ]; then
  echo "GITHUB_TOKEN is required for gh pr view/diff calls inside the workflow." >&2
  echo "Set GITHUB_TOKEN or authenticate gh before running this smoke." >&2
  exit 1
fi

platform_args=()
case "$(uname -m)" in
  arm64|aarch64)
    platform_args=(--container-architecture linux/arm64)
    ;;
esac

act pull_request_target \
  --bind \
  -W .github/workflows/qwen-code-pr-review.yml \
  -j review-pr \
  -e "$event_file" \
  -P ubuntu-latest="${ACT_UBUNTU_IMAGE:-catthehacker/ubuntu:act-latest}" \
  --var QWEN_PR_REVIEW_MODEL=local-act-smoke \
  --var QWEN_PR_REVIEW_MAX_CHANGED_LINES=50000 \
  --var QWEN_DESIGN_GATE_LLM=false \
  --env ACT=true \
  -s "GITHUB_TOKEN=$token" \
  "${platform_args[@]}"
