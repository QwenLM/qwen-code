#!/usr/bin/env bash

set -euo pipefail

COMMAND="${1:-}"

WORK_DIR="${WORK_DIR:-${AONE_CI_SOURCE:-$PWD}}"
REMOTE_HOST="${REMOTE_HOST:-code.alibaba-inc.com}"
API_BASE="${API_BASE:-https://${REMOTE_HOST}/api/v4}"
CODE_API_BASE="${CODE_API_BASE:-https://${REMOTE_HOST}/api/v5}"
GIT_USER_NAME="${GIT_USER_NAME:-aone-ci-bot}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-ci-bot@alibaba-inc.com}"

AUTH_USERNAME="${AUTH_USERNAME:-${DOMAIN_USER:-}}"
PRIVATE_TOKEN="${PRIVATE_TOKEN:-${DOMAIN_PASSWORD:-}}"
LEGACY_GIT_TOKEN="${LEGACY_GIT_TOKEN:-}"

REPO_PATH="${REPO_PATH:-${AONECI_REPO_PATH:-${CI_PROJECT_PATH:-${CI_REPOSITORY_PATH:-${GIT_REPO_FULL_NAME:-}}}}}"
SOURCE_BRANCH="${SOURCE_BRANCH:-${AONECI_BRANCH:-${CI_COMMIT_REF_NAME:-${GIT_BRANCH:-}}}}"
TARGET_BRANCH="${TARGET_BRANCH:-${AONECI_TARGET_BRANCH:-${CI_DEFAULT_BRANCH:-}}}"

MR_TITLE="${MR_TITLE:-}"
MR_DESCRIPTION="${MR_DESCRIPTION:-Automated MR for CI sync}"
MR_URL_OUTPUT_PATH="${MR_URL_OUTPUT_PATH:-}"
MR_CONFLICT_FILES_OUTPUT_PATH="${MR_CONFLICT_FILES_OUTPUT_PATH:-}"
SKIP_PUSH="${SKIP_PUSH:-0}"

AUTH_USER=""
AUTH_TOKEN=""

log() {
  echo "[upstream-sync-domain-auth] $*" >&2
}

die() {
  echo "[upstream-sync-domain-auth] ERROR: $*" >&2
  exit 1
}

require_var() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    die "missing required variable: $name"
  fi
}

has_git_repo() {
  git rev-parse --git-dir >/dev/null 2>&1
}

urlencode() {
  node -e "console.log(encodeURIComponent(process.argv[1] || ''))" "$1"
}

derive_repo_path_from_origin() {
  local remote_url=""
  if ! remote_url="$(git remote get-url origin 2>/dev/null)"; then
    return 1
  fi

  remote_url="${remote_url%.git}"
  case "$remote_url" in
    git@*:*)
      remote_url="${remote_url#git@}"
      remote_url="${remote_url#*:}"
      ;;
    ssh://git@*/*)
      remote_url="${remote_url#ssh://git@}"
      remote_url="${remote_url#*/}"
      ;;
    https://*/*)
      remote_url="${remote_url#https://}"
      remote_url="${remote_url#*/}"
      ;;
    http://*/*)
      remote_url="${remote_url#http://}"
      remote_url="${remote_url#*/}"
      ;;
  esac

  if [ -z "$remote_url" ] || [ "$remote_url" = "origin" ]; then
    return 1
  fi

  printf '%s\n' "$remote_url"
}

resolve_repo_path() {
  if [ -n "$REPO_PATH" ]; then
    return 0
  fi

  if has_git_repo; then
    REPO_PATH="$(derive_repo_path_from_origin || true)"
  fi

  require_var "REPO_PATH" "$REPO_PATH"
}

resolve_auth() {
  if [ -n "$AUTH_USERNAME" ] && [ -n "$PRIVATE_TOKEN" ]; then
    AUTH_USER="$AUTH_USERNAME"
    AUTH_TOKEN="$PRIVATE_TOKEN"
    return 0
  fi

  if [ -n "$PRIVATE_TOKEN" ]; then
    AUTH_USER="oauth2"
    AUTH_TOKEN="$PRIVATE_TOKEN"
    return 0
  fi

  if [ -n "$LEGACY_GIT_TOKEN" ]; then
    AUTH_USER="oauth2"
    AUTH_TOKEN="$LEGACY_GIT_TOKEN"
    return 0
  fi

  die "missing auth credentials; set PRIVATE_TOKEN (optionally with AUTH_USERNAME) or LEGACY_GIT_TOKEN"
}

log_auth_inputs() {
  log "auth diag: AUTH_USERNAME=$([ -n "$AUTH_USERNAME" ] && echo set || echo unset), PRIVATE_TOKEN=$([ -n "$PRIVATE_TOKEN" ] && echo set || echo unset), LEGACY_GIT_TOKEN=$([ -n "$LEGACY_GIT_TOKEN" ] && echo set || echo unset)"
  log "repo diag: REPO_PATH=${REPO_PATH:-<unset>}, SOURCE_BRANCH=${SOURCE_BRANCH:-<unset>}, TARGET_BRANCH=${TARGET_BRANCH:-<unset>}, WORK_DIR=${WORK_DIR}"
}

origin_url() {
  printf 'https://%s:%s@%s/%s.git' \
    "$(urlencode "$AUTH_USER")" \
    "$(urlencode "$AUTH_TOKEN")" \
    "$REMOTE_HOST" \
    "$REPO_PATH"
}

project_encoded() {
  node -e "console.log(encodeURIComponent(process.argv[1] || ''))" "$REPO_PATH"
}

extract_json_field() {
  local key="$1"
  node -e "
    const raw = require('fs').readFileSync(0, 'utf8').trim();
    if (!raw) {
      process.exit(1);
    }
    const data = JSON.parse(raw);
    const value = data?.[process.argv[1]];
    if (!value) {
      process.exit(1);
    }
    console.log(value);
  " "$key"
}

extract_first_mr_url() {
  node -e "
    const remoteHost = process.argv[1] || 'code.alibaba-inc.com';
    const repoPath = process.argv[2] || '';
    const raw = require('fs').readFileSync(0, 'utf8').trim();
    if (!raw) {
      process.exit(1);
    }

    const data = JSON.parse(raw);
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.data?.list)
        ? data.data.list
      : Array.isArray(data?.list)
        ? data.list
        : data?.data?.mergeRequest
          ? [data.data.mergeRequest]
        : data?.mergeRequest
          ? [data.mergeRequest]
          : [data];
    const keys = [
      'detail_url',
      'detailUrl',
      'web_url',
      'webUrl',
      'html_url',
      'url',
    ];
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      for (const key of keys) {
        if (typeof item[key] === 'string' && item[key].startsWith('http')) {
          console.log(item[key]);
          process.exit(0);
        }
      }
      if (repoPath && item.id !== undefined && item.id !== null) {
        const id = String(item.id);
        if (/^[0-9]+$/.test(id)) {
          console.log('https://' + remoteHost + '/' + repoPath + '/codereview/' + id);
          process.exit(0);
        }
      }
    }
    process.exit(1);
  " "$REMOTE_HOST" "$REPO_PATH"
}

write_conflict_files_from_mr_response() {
  local response="$1"
  if [ -z "$MR_CONFLICT_FILES_OUTPUT_PATH" ]; then
    return 0
  fi

  printf '%s' "$response" | node -e "
    const raw = require('fs').readFileSync(0, 'utf8').trim();
    if (!raw) {
      process.exit(0);
    }

    const data = JSON.parse(raw);
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.data?.list)
        ? data.data.list
      : Array.isArray(data?.list)
        ? data.list
        : data?.data?.mergeRequest
          ? [data.data.mergeRequest]
        : data?.mergeRequest
          ? [data.mergeRequest]
          : [data];
    const description = items
      .map((item) => (item && typeof item.description === 'string' ? item.description : ''))
      .find(Boolean);
    if (!description) {
      process.exit(0);
    }

    const files = [];
    const seen = new Set();
    const tick = String.fromCharCode(96);
    for (const line of description.split(/\\r?\\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ' + tick) || !trimmed.endsWith(tick)) {
        continue;
      }
      const file = trimmed.slice(3, -1);
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    if (files.length > 0) {
      console.log(files.join('\\n'));
    }
  " > "$MR_CONFLICT_FILES_OUTPUT_PATH"
}

ensure_repo() {
  cd "$WORK_DIR"

  if ! has_git_repo; then
    resolve_auth
    resolve_repo_path
    log "initializing git repository in $WORK_DIR"
    git init
    git remote remove origin >/dev/null 2>&1 || true
    git remote add origin "$(origin_url)"
  else
    resolve_repo_path
  fi

  git config user.name "$GIT_USER_NAME"
  git config user.email "$GIT_USER_EMAIL"
}

configure_authenticated_origin() {
  resolve_auth
  resolve_repo_path
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "$(origin_url)"
}

prepare_repo() {
  log_auth_inputs
  ensure_repo

  if [ -z "$SOURCE_BRANCH" ]; then
    log "prepare: SOURCE_BRANCH is unset; skip branch checkout"
    return 0
  fi

  if git ls-remote --heads origin "$SOURCE_BRANCH" | grep -q "$SOURCE_BRANCH"; then
    git fetch origin "$SOURCE_BRANCH"
    git checkout -B "$SOURCE_BRANCH" "origin/$SOURCE_BRANCH"
  else
    git checkout -B "$SOURCE_BRANCH"
  fi
}

query_existing_mrs() {
  local include_target="${1:-1}"
  if [ "$include_target" = "1" ]; then
    curl -fsS -G \
      -H "PRIVATE-TOKEN: ${AUTH_TOKEN}" \
      --data-urlencode "state=opened" \
      --data-urlencode "source_branch=${SOURCE_BRANCH}" \
      --data-urlencode "target_branch=${TARGET_BRANCH}" \
      "${API_BASE}/projects/$(project_encoded)/merge_requests"
  else
    curl -fsS -G \
      -H "PRIVATE-TOKEN: ${AUTH_TOKEN}" \
      --data-urlencode "state=opened" \
      --data-urlencode "source_branch=${SOURCE_BRANCH}" \
      "${API_BASE}/projects/$(project_encoded)/merge_requests"
  fi
}

query_existing_code_reviews() {
  curl -fsS -G \
    -H "PRIVATE-TOKEN: ${AUTH_TOKEN}" \
    --data-urlencode "order_by=updated_at" \
    --data-urlencode "page=1" \
    --data-urlencode "per_page=20" \
    --data-urlencode "q=repo:${REPO_PATH} AND state:opened,reopened AND target_branch:${TARGET_BRANCH} AND source_branch:${SOURCE_BRANCH}" \
    --data-urlencode "sort=desc" \
    --data-urlencode "v2=true" \
    "${CODE_API_BASE}/code_review/search"
}

find_existing_mr_url() {
  local response mr_url
  if response="$(query_existing_mrs 1)" && \
    mr_url="$(printf '%s' "$response" | extract_first_mr_url)"; then
    write_conflict_files_from_mr_response "$response"
    printf '%s\n' "$mr_url"
    return 0
  fi

  log "existing MR exact lookup returned no URL; retrying by source branch only"
  if response="$(query_existing_mrs 0)" && \
    mr_url="$(printf '%s' "$response" | extract_first_mr_url)"; then
    write_conflict_files_from_mr_response "$response"
    printf '%s\n' "$mr_url"
    return 0
  fi

  log "existing MR source lookup returned no URL; retrying code review search"
  if response="$(query_existing_code_reviews)" && \
    mr_url="$(printf '%s' "$response" | extract_first_mr_url)"; then
    write_conflict_files_from_mr_response "$response"
    printf '%s\n' "$mr_url"
    return 0
  fi

  return 1
}

publish_mr() {
  local response http_code body mr_url

  log_auth_inputs
  require_var "SOURCE_BRANCH" "$SOURCE_BRANCH"
  require_var "TARGET_BRANCH" "$TARGET_BRANCH"
  require_var "MR_TITLE" "$MR_TITLE"

  ensure_repo
  configure_authenticated_origin

  if [ "$SKIP_PUSH" != "1" ]; then
    git push origin "$SOURCE_BRANCH" --force
  else
    log "publish: skip push and reuse existing remote branch ${SOURCE_BRANCH}"
  fi

  response="$(
    curl -sS -w '\n%{http_code}' -X POST \
      -H "PRIVATE-TOKEN: ${AUTH_TOKEN}" \
      --data-urlencode "source_branch=${SOURCE_BRANCH}" \
      --data-urlencode "target_branch=${TARGET_BRANCH}" \
      --data-urlencode "title=${MR_TITLE}" \
      --data-urlencode "description=${MR_DESCRIPTION}" \
      "${API_BASE}/projects/$(project_encoded)/merge_requests"
  )"

  http_code="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"

  case "$http_code" in
    201)
      mr_url="$(printf '%s' "$body" | extract_json_field web_url)" || \
        die "merge request created but web_url missing: $body"
      ;;
    409)
      mr_url="$(printf '%s' "$body" | extract_first_mr_url 2>/dev/null || true)"
      if [ -z "$mr_url" ]; then
        mr_url="$(find_existing_mr_url)" || \
        die "merge request already exists but failed to query existing MR URL"
      fi
      ;;
    *)
      die "merge request creation failed (HTTP ${http_code}): ${body}"
      ;;
  esac

  if [ -n "$MR_URL_OUTPUT_PATH" ]; then
    printf '%s\n' "$mr_url" > "$MR_URL_OUTPUT_PATH"
  fi

  printf '%s\n' "$mr_url"
}

case "$COMMAND" in
  prepare)
    prepare_repo
    ;;
  publish)
    publish_mr
    ;;
  *)
    die "usage: $0 <prepare|publish>"
    ;;
esac
