#!/usr/bin/env bash
# Live-progress heartbeat for the autofix round status comment.
#
# A review-address round can run for hours (130-minute agent step, 330-
# minute job) while the PR's status comment stays frozen at "working" —
# a healthy long round and a dead one look identical on the PR page.
# 'Post autofix status comment' starts this script as a detached loop;
# every interval it re-PATCHes the SAME status comment with elapsed time
# and last agent activity, and 'Finalize autofix status comment' kills it
# before writing the terminal text. Full rationale → qwen-autofix.md#af-149.
#
# Subcommands:
#   body — print the full bilingual working-state comment body to stdout.
#          Used for the initial post AND by every loop tick, so the two
#          can never drift apart.
#   loop — sleep–compose–PATCH until killed or a self-exit bound trips.
#
# Environment (both): HB_ROUND (display round, already +1'd by the step),
# HB_CAP, HB_URL, HB_WORKDIR, HB_START_EPOCH; NOW_EPOCH overrides the
# clock for tests. loop additionally needs: HB_REPO, HB_COMMENT_ID,
# GITHUB_TOKEN for gh, and TRUSTED_PATH (the launcher's stage-time PATH
# capture the tick re-pins; a launch without it fails fast);
# HB_INTERVAL_SECONDS (default 600) and HB_MAX_AGE_SECONDS (default
# 20400) bound the pulse.
#
# Kill contract: the loop writes heartbeat.pid (diagnostics + its own
# self-exit check), checks heartbeat-stop, and exits on either signal or
# when its own age cap trips. The killers target the pid the launch
# recorded in EXPRESSION CONTEXT (steps.post_status.outputs.heartbeat_pid)
# — WORKDIR is sandbox-writable, so no WORKDIR file is ever read as a kill
# target — and kill the pid, its process group, AND its whole session:
# each tick's `timeout 60 gh` subtree runs in its OWN process group
# (coreutils timeout default) under the loop's setsid session, so a
# group/pid kill alone leaves it alive holding the PAT for up to 60s. The
# round's verification gate kills the loop before running any branch code
# on the host; finalize and the always() cleanup kill again. Every killer
# confirms the pid's LIFECYCLE before signaling: the launch also records
# the loop's start time (heartbeat_start_ticks), and a pid reused between
# launch and kill belongs to a different process — a killer signals only
# a pid whose /proc/<pid>/stat start time still matches the launch
# capture, and kills nothing otherwise (a dead pid has no stat and a
# reused one a different start time, so a failed check always means the
# loop is already gone). Each tick additionally stamps
# heartbeat-tick-inflight with its start epoch around its gh call and
# removes it after: finalize drains that stamp before its terminal PATCH,
# because killing the client cannot cancel a request the server already
# accepted.
#
# PAT note: the loop holds the bot PAT in its environment. Its lifetime is
# bounded to the sandboxed agent phase — the agent executes PR content only
# inside the docker sandbox there, so no fork code runs on the host beside
# this loop; the verification gate ends the loop BEFORE the first step that
# runs branch code on the host. Every gh call additionally runs under the
# af-112 hermetic pins (pinned GH_HOST, dropped GH_TOKEN/GH_ENTERPRISE_TOKEN,
# a GH_CONFIG_DIR minted fresh milliseconds before the call and removed right
# after — a long-lived minted dir under the same-UID-writable RUNNER_TEMP is
# plantable between calls, R11-1), so a transport reroute planted in the
# shared HOME's gh config cannot intercept the token. See af-149 for the trade.

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
  # NOW_EPOCH is the test-only clock override — no production launcher
  # sets it, so a value can only arrive through an env plant. Bash
  # arithmetic expansion recursively evaluates the variable's value, so a
  # planted value's embedded command substitution would EXECUTE inside
  # this PAT-holding process. Accept a numeric override only; anything
  # else falls back to the real clock.
  now="${NOW_EPOCH:-}"
  [[ "${now}" =~ ^[0-9]+$ ]] || now="$(date +%s)"
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
  # Validate EVERYTHING a tick needs, not just the loop's own three: a
  # launch missing a body var would otherwise produce an immortal loop
  # that never pulses — the exact "healthy round looks dead" failure this
  # feature eliminates. Fail fast instead.
  require HB_REPO HB_COMMENT_ID HB_WORKDIR HB_ROUND HB_CAP HB_URL HB_START_EPOCH TRUSTED_PATH
  # gh auth rides on the step-level GITHUB_TOKEN only: the hermetic pins
  # below drop any planted GH_TOKEN/GH_ENTERPRISE_TOKEN (a planted channel
  # must not outrank the inline token), so accepting them here would admit
  # a launch the pins then leave credential-less — an immortal loop logging
  # "PATCH failed" every tick and never pulsing. Fail fast instead.
  [[ -n "${GITHUB_TOKEN:-}" ]] || {
    echo "autofix-status-heartbeat: GITHUB_TOKEN is required" >&2
    exit 2
  }
  # Binary-resolution channel: the tick resolves its externals (gh,
  # timeout, sleep, date, cat — and the mktemp below) by name, and the
  # ambient PATH carries same-UID-writable dirs ahead of the system ones
  # (the job's own $GITHUB_PATH append puts ${RUNNER_TEMP}/qwen-bin
  # there), so a plant in one of them would be resolved by the next tick
  # with the PAT in env. Pin PATH from the launcher's step-level
  # TRUSTED_PATH instead — the R6-3 doctrine: expression-context
  # derived, and step env outranks $GITHUB_ENV plants. post_status pins
  # its own PATH the same way before the launch; the loop re-pins so no
  # future launcher can hand it an ambient PATH.
  # Full rationale → qwen-autofix.md#af-149
  export PATH="${TRUSTED_PATH}"
  # Hermetic pins for every gh call this loop makes (the af-112 doctrine):
  # pinned host and planted tokens dropped here, at launch. The config dir
  # is NOT minted here: it is minted per tick, milliseconds before each gh
  # call, and removed right after (below) — RUNNER_TEMP is same-UID-writable,
  # so a dir minted once at launch and reused across ticks is plantable: a
  # watcher knowing the stable prefix writes a config.yml carrying
  # http_unix_socket into it, and every later tick delivers the PATCH's
  # Authorization header (the bot PAT) to the planted socket — for the loop
  # the 600s sleep before the first call made the window a certainty, not a
  # race (R11-1, probe-verified). The per-call shape shrinks the window to
  # one call's mint→use race, the residual the pin documents.
  export GH_HOST=github.com
  unset GH_ENTERPRISE_TOKEN GH_TOKEN
  # Self-detach from the launching step: log to WORKDIR and never hold the
  # step's pipes, or the step would never report completion.
  exec >> "${HB_WORKDIR}/heartbeat.log" 2>&1 < /dev/null
  echo "$$" > "${HB_WORKDIR}/heartbeat.pid"
  local interval="${HB_INTERVAL_SECONDS:-600}"
  # Just past the 330-minute job envelope: a live round's loop dies at the
  # gate or finalize well inside the job, so only a crash-leftover orphan
  # ever reaches the cap — and the cap bounds how long that orphan holds
  # the PAT in /proc/<pid>/environ, so it stays tight.
  local max_age="${HB_MAX_AGE_SECONDS:-20400}"
  # Numeric guards: a malformed or zero override must degrade to the
  # defaults, never into a sleep-less busy loop hammering the API.
  # Shape alone is not enough: the loop sleeps BEFORE its age check,
  # so a well-formed huge interval — no production launcher sets
  # either variable, so such a value can only arrive through an env
  # plant — means the loop never wakes again (zero pulses, and the
  # age cap that bounds an orphan's PAT window becomes unreachable),
  # while a tiny age cap silently kills the pulse after the first
  # sleep — the frozen comment this feature eliminates. Bound the
  # magnitude too; the cap's floor is the 330-minute job envelope, so
  # a live round's pulse always outlives the round.
  [[ "${interval}" =~ ^[1-9][0-9]*$ ]] || interval=600
  (( interval <= 3600 )) || interval=600
  [[ "${max_age}" =~ ^[1-9][0-9]*$ ]] || max_age=20400
  (( max_age >= 19800 && max_age <= 21600 )) || max_age=20400
  local start="${HB_START_EPOCH}"
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
    # IDENTITY, not existence: WORKDIR is PR-scoped (/tmp/autofix-review-<pr>),
    # so after a crashed round's reset the NEXT round recreates heartbeat.pid
    # at the same path. An existence check would let the orphaned old loop
    # pass and keep PATCHing with its stale launch env, alternating with the
    # new round's body on the same comment. The file must still hold THIS
    # loop's own pid — removed OR replaced (by a newer round) ends the loop.
    # This reads the file to self-identify only; it never kills anything.
    # The read is BOUNDED: WORKDIR is sandbox-writable, so the path can hold
    # a planted FIFO whose open blocks cat indefinitely — stalling the loop
    # inside the tick, past the age cap above. Mirrors the gh wrapper's
    # conditional timeout form below; a timeout kill yields empty → identity
    # mismatch → the clean self-exit just below.
    local pid_now
    if command -v timeout > /dev/null 2>&1; then
      pid_now="$(timeout 5 cat "${HB_WORKDIR}/heartbeat.pid" 2> /dev/null)"
    else
      pid_now="$(cat "${HB_WORKDIR}/heartbeat.pid" 2> /dev/null)"
    fi
    if [[ "${pid_now}" != "$$" ]]; then
      echo "$(date -u +%FT%TZ) self-exit: pid file removed or replaced"
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
    # Hermetic gh config, minted milliseconds before the call and removed
    # right after (the R11-1 shape): a dir reused across ticks is plantable
    # under the same-UID-writable RUNNER_TEMP, and a planted http_unix_socket
    # would capture the PATCH's Authorization header (the bot PAT). Fail
    # CLOSED: a failed mint skips the tick, never runs gh with the PAT
    # against the shared ~/.config/gh — a skip degrades one pulse, never
    # the loop (the age cap still bounds it).
    local gh_config_dir
    if ! gh_config_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/autofix-gh-config.XXXXXX")"; then
      echo "$(date -u +%FT%TZ) gh config mint failed; skipping this tick"
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
    # In-flight stamp for finalize's drain: killing this loop ends the
    # client, but a PATCH the server already ACCEPTED still commits (the
    # race that flipped a terminal comment back to "working"), so
    # finalize must wait the last tick's request out before writing the
    # terminal text. The stamp carries the tick's start epoch; the
    # bounded call above gives finalize the 65s completion bound it
    # drains against. The write is bounded like the pid-identity read:
    # WORKDIR is sandbox-writable, and a planted FIFO at this path would
    # otherwise block the loop inside the tick, past the age cap. A
    # failed stamp degrades to the pre-drain race, never stalls the
    # pulse.
    if command -v timeout > /dev/null 2>&1; then
      # shellcheck disable=SC2016
      timeout 5 bash -c 'date +%s > "$0"' "${HB_WORKDIR}/heartbeat-tick-inflight" 2> /dev/null || true
    else
      date +%s > "${HB_WORKDIR}/heartbeat-tick-inflight" 2> /dev/null || true
    fi
    if ! GH_CONFIG_DIR="${gh_config_dir}" "${GH_PATCH[@]}" api --method PATCH \
      "repos/${HB_REPO}/issues/comments/${HB_COMMENT_ID}" \
      -f body="${body}" > /dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) PATCH failed; continuing"
    fi
    rm -f "${HB_WORKDIR}/heartbeat-tick-inflight" 2> /dev/null || true
    rm -rf "${gh_config_dir}"
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
