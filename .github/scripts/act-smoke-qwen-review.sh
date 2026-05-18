#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

usage() {
  cat >&2 <<'EOF'
Usage:
  .github/scripts/act-smoke-qwen-review.sh [pr-number] [case]

Cases:
  pr-edited            pull_request_target.edited body change; runs Design Gate only
  design-gate-comment  issue_comment "@qwen /design-gate"; runs Design Gate only
  oversized            pull_request_target.edited with a low size threshold; stops at size gate
  all                  runs all safe local act cases above

The smoke cases run with ACT=true, do not post PR comments, and do not run the
deep /review action.
EOF
}

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
case_name="${2:-pr-edited}"
if [ -z "$pr_number" ] && command -v gh >/dev/null 2>&1; then
  pr_number="$(gh pr view --json number --jq '.number' 2>/dev/null || true)"
fi

if [ -z "$pr_number" ]; then
  usage
  echo "Could not infer a PR number from the current branch." >&2
  exit 1
fi

token="${GITHUB_TOKEN:-}"
if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then
  token="$(gh auth token 2>/dev/null || true)"
fi

if [ -z "$token" ]; then
  echo "GITHUB_TOKEN is required for gh pr view/diff calls inside the workflow." >&2
  echo "Set GITHUB_TOKEN or authenticate gh before running this smoke." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
log_dir="${ACT_SMOKE_LOG_DIR:-.qwen/tmp/act-smoke/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$log_dir"

secret_file="$tmp_dir/secrets"
chmod 700 "$tmp_dir"
printf 'GITHUB_TOKEN=%s\n' "$token" > "$secret_file"
chmod 600 "$secret_file"

cleanup_generated_files() {
  rm -f \
    qwen-pr-review-size-comment.md \
    qwen-pr-review-fork-comment.md \
    qwen-design-gate-override-comment.md \
    .qwen/tmp/qwen-review-pr-"$pr_number"-shape.json \
    .qwen/tmp/qwen-review-pr-"$pr_number"-history.json \
    .qwen/tmp/qwen-review-pr-"$pr_number"-design-gate.json \
    .qwen/tmp/qwen-review-pr-"$pr_number"-design-gate-comment.md \
    .qwen/tmp/qwen-review-pr-"$pr_number"-design-gate-prompt.md
}

trap 'rm -rf "$tmp_dir"; cleanup_generated_files' EXIT

platform_args=()
case "$(uname -m)" in
  arm64|aarch64)
    platform_args=(--container-architecture linux/arm64)
    ;;
esac

write_event() {
  local name="$1"
  local event_file="$2"

  case "$name" in
    pr-edited|oversized)
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
      ;;
    design-gate-comment)
      cat > "$event_file" <<JSON
{
  "action": "created",
  "issue": {
    "number": $pr_number,
    "pull_request": {
      "url": "https://api.github.com/repos/${GITHUB_REPOSITORY:-QwenLM/qwen-code}/pulls/$pr_number"
    }
  },
  "comment": {
    "body": "@qwen /design-gate",
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
      ;;
    *)
      usage
      echo "Unknown smoke case: $name" >&2
      exit 1
      ;;
  esac
}

event_name_for_case() {
  case "$1" in
    pr-edited|oversized)
      printf 'pull_request_target'
      ;;
    design-gate-comment)
      printf 'issue_comment'
      ;;
  esac
}

max_lines_for_case() {
  case "$1" in
    oversized)
      printf '100'
      ;;
    *)
      printf '50000'
      ;;
  esac
}

summarize_log() {
  local name="$1"
  local log_file="$2"

  echo "----- $name summary -----"
  grep -E 'Run Main (Resolve PR context|Check PR size|Generate PR shape|Scan review history|Run Design Gate)|::set-output:: (should_run_review|gate_only|bypass_design_gate|should_review|status)=|Review scope:|Design Gate status:|Job succeeded|Job failed|Failure -' "$log_file" || true
  echo "Log: $log_file"
}

run_case() {
  local name="$1"
  local event_file="$tmp_dir/$name.json"
  local log_file="$log_dir/$name.log"
  local event_name
  local max_lines

  event_name="$(event_name_for_case "$name")"
  max_lines="$(max_lines_for_case "$name")"
  write_event "$name" "$event_file"
  cleanup_generated_files

  echo "===== Running act smoke case: $name ($event_name) ====="
  if act "$event_name" \
    --bind \
    -W .github/workflows/qwen-code-pr-review.yml \
    -j review-pr \
    -e "$event_file" \
    -P ubuntu-latest="${ACT_UBUNTU_IMAGE:-catthehacker/ubuntu:act-latest}" \
    --var QWEN_PR_REVIEW_MODEL=local-act-smoke \
    --var QWEN_PR_REVIEW_MAX_CHANGED_LINES="$max_lines" \
    --var QWEN_DESIGN_GATE_LLM=false \
    --env ACT=true \
    --secret-file "$secret_file" \
    "${platform_args[@]}" 2>&1 | tee "$log_file"; then
    summarize_log "$name" "$log_file"
  else
    summarize_log "$name" "$log_file"
    exit 1
  fi
}

case "$case_name" in
  all)
    run_case pr-edited
    run_case design-gate-comment
    run_case oversized
    ;;
  pr-edited|design-gate-comment|oversized)
    run_case "$case_name"
    ;;
  *)
    usage
    echo "Unknown smoke case: $case_name" >&2
    exit 1
    ;;
esac
