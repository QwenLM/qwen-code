#!/usr/bin/env bash
# Live-progress heartbeat for the autofix round status comment.
#
# A review-address round can run for hours (130-minute agent step, 330-
# minute job) while the PR's status comment stays frozen at "working" —
# a healthy long round and a dead one look identical on the PR page.
# 'Post autofix status comment' starts this script as a detached loop;
# every interval it re-PATCHes the SAME status comment with elapsed time
# and last agent activity, and 'Finalize autofix status comment' kills it
# before writing the terminal text. Full rationale → qwen-autofix.md#af-148.
#
# Subcommands:
#   body — print the full bilingual working-state comment body to stdout.
#          Used for the initial post AND by every loop tick, so the two
#          can never drift apart.
#   loop — sleep–compose–PATCH until killed or a self-exit bound trips.
#
# Environment (both): HB_ROUND (display round, already +1'd by the step),
# HB_CAP, HB_URL, HB_WORKDIR, HB_START_EPOCH; NOW_EPOCH overrides the
# clock for tests. loop additionally needs: HB_REPO, HB_COMMENT_ID, and
# GITHUB_TOKEN for gh; HB_INTERVAL_SECONDS (default 600) and
# HB_MAX_AGE_SECONDS (default 43200) bound the pulse.
#
# Kill contract: the loop writes heartbeat.pid (diagnostics + its own
# self-exit check), checks heartbeat-stop, and exits on either signal or
# when its own age cap trips. The killers target the pid the launch
# recorded in EXPRESSION CONTEXT (steps.post_status.outputs.heartbeat_pid)
# — WORKDIR is sandbox-writable, so no WORKDIR file is ever read as a kill
# target. The round's verification gate kills the loop before running any
# branch code on the host; finalize and the always() cleanup kill again.
#
# PAT note: the loop holds the bot PAT in its environment. Its lifetime is
# bounded to the sandboxed agent phase — the agent executes PR content only
# inside the docker sandbox there, so no fork code runs on the host beside
# this loop; the verification gate ends the loop BEFORE the first step that
# runs branch code on the host. See af-148 for the trade.

# -e is deliberately absent: the (( ... < 0 )) clamp guards exit non-zero
# on a false test and are load-bearing here. pipefail matches the sibling
# scripts' house line.
set -uo pipefail

MARKER='<!-- autofix-status -->'

require() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "autofix-status-heartbeat: ${name} is required" >&2
      exit 2
    fi
  done
}

emit_body() {
  require HB_ROUND HB_CAP HB_URL HB_WORKDIR HB_START_EPOCH
  local now elapsed_min mtime active_min line_en line_zh
  now="${NOW_EPOCH:-$(date +%s)}"
  elapsed_min=$(( (now - HB_START_EPOCH) / 60 ))
  (( elapsed_min < 0 )) && elapsed_min=0
  if [[ -f "${HB_WORKDIR}/agent.log" ]]; then
    # date -r FILE reads the file's mtime on both GNU and BSD date.
    mtime="$(date -r "${HB_WORKDIR}/agent.log" +%s 2>/dev/null || echo "${now}")"
    active_min=$(( (now - mtime) / 60 ))
    (( active_min < 0 )) && active_min=0
    line_en="⏱ Running for ${elapsed_min} min · agent active ${active_min} min ago"
    line_zh="⏱ 已运行 ${elapsed_min} 分钟 · agent 最近活动在 ${active_min} 分钟前"
  else
    line_en="⏱ Running for ${elapsed_min} min · agent starting"
    line_zh="⏱ 已运行 ${elapsed_min} 分钟 · agent 准备中"
  fi
  printf '%s\n\n🔄 **AutoFix is working on this PR** — round %s/%s. [Watch live progress](%s); this round posts its report here when it finishes.\n%s\n\n<details>\n<summary>中文说明</summary>\n\n🔄 **AutoFix 正在处理此 PR** —— 第 %s/%s 轮。[查看实时进度](%s)；本轮结束后会在此发布报告。\n%s\n\n</details>' \
    "${MARKER}" "${HB_ROUND}" "${HB_CAP}" "${HB_URL}" "${line_en}" \
    "${HB_ROUND}" "${HB_CAP}" "${HB_URL}" "${line_zh}"
}

run_loop() {
  require HB_REPO HB_COMMENT_ID HB_WORKDIR
  # Self-detach from the launching step: log to WORKDIR and never hold the
  # step's pipes, or the step would never report completion.
  exec >> "${HB_WORKDIR}/heartbeat.log" 2>&1 < /dev/null
  echo "$$" > "${HB_WORKDIR}/heartbeat.pid"
  local interval="${HB_INTERVAL_SECONDS:-600}"
  local max_age="${HB_MAX_AGE_SECONDS:-43200}"
  # Numeric guards: a malformed or zero override must degrade to the
  # defaults, never into a sleep-less busy loop hammering the API.
  [[ "${interval}" =~ ^[1-9][0-9]*$ ]] || interval=600
  [[ "${max_age}" =~ ^[1-9][0-9]*$ ]] || max_age=43200
  local start="${HB_START_EPOCH:-$(date +%s)}"
  echo "$(date -u +%FT%TZ) heartbeat started: comment ${HB_COMMENT_ID} interval ${interval}s max_age ${max_age}s"
  while :; do
    sleep "${interval}"
    local now age body
    now="$(date +%s)"
    age=$(( now - start ))
    if (( age > max_age )); then
      echo "$(date -u +%FT%TZ) self-exit: age ${age}s exceeds ${max_age}s"
      exit 0
    fi
    if [[ ! -f "${HB_WORKDIR}/heartbeat.pid" ]]; then
      echo "$(date -u +%FT%TZ) self-exit: pid file removed"
      exit 0
    fi
    if [[ -f "${HB_WORKDIR}/heartbeat-stop" ]]; then
      echo "$(date -u +%FT%TZ) self-exit: stop marker present"
      exit 0
    fi
    if ! body="$(emit_body)"; then
      echo "$(date -u +%FT%TZ) body composition failed; skipping this tick"
      continue
    fi
    # Best-effort: a transient API failure skips one tick, never the pulse.
    # `timeout` bounds the request itself — a black-holed connection must
    # not stall the loop past the age cap, which only runs between ticks
    # (a stuck gh would hold the PAT forever). `timeout` is coreutils on
    # the Linux pool; hosts without it (macOS dev runs) fall back to the
    # unbounded call.
    GH_PATCH=(gh)
    if command -v timeout > /dev/null 2>&1; then
      GH_PATCH=(timeout 60 gh)
    fi
    if ! "${GH_PATCH[@]}" api --method PATCH \
      "repos/${HB_REPO}/issues/comments/${HB_COMMENT_ID}" \
      -f body="${body}" > /dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) PATCH failed; continuing"
    fi
  done
}

case "${1:-}" in
  body) emit_body ;;
  loop) run_loop ;;
  *)
    echo "usage: $(basename "$0") {body|loop}" >&2
    exit 2
    ;;
esac
