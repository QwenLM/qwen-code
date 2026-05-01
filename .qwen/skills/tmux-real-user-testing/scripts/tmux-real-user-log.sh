#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
tmux-real-user-log.sh - helper for readable tmux real-user test logs

Usage:
  tmux-real-user-log.sh start <scenario> <workdir> <command...>
  tmux-real-user-log.sh snapshot <session> <outdir> <label> [scrollback]
  tmux-real-user-log.sh send <session> <keys...>
  tmux-real-user-log.sh type-submit <session> <text>
  tmux-real-user-log.sh wait-for <session> <outdir> <regex> [attempts] [sleep_seconds] [scrollback]
  tmux-real-user-log.sh finish <session> <outdir>
  tmux-real-user-log.sh help

Examples:
  eval "$(tmux-real-user-log.sh start mytest . npm run dev -- --approval-mode yolo)"
  tmux-real-user-log.sh snapshot mytest-... /tmp/run "01 initial screen"
  tmux-real-user-log.sh type-submit mytest-... /auth
  tmux-real-user-log.sh send mytest-... Down Enter
  tmux-real-user-log.sh wait-for mytest-... /tmp/run "Ready|Error"
  tmux-real-user-log.sh finish mytest-... /tmp/run
EOF
}

require_args() {
  local need=$1
  local got=$2
  local cmd=$3
  if (( got < need )); then
    echo "error: '$cmd' expects at least $need args, got $got" >&2
    usage >&2
    exit 2
  fi
}

cmd=${1:-help}
shift || true

case "$cmd" in
  start)
    require_args 3 $# start
    scenario=$1
    workdir=$2
    shift 2
    ts=$(date +%Y%m%d-%H%M%S)
    outdir="$workdir/tmp/${scenario}-tmux-${ts}"
    session="${scenario}-tmux-${ts}"

    # Fail early if session name already exists
    if tmux has-session -t "$session" 2>/dev/null; then
      echo "error: tmux session '$session' already exists" >&2
      exit 1
    fi

    mkdir -p "$outdir"
    shell_command=$(printf '%q ' "$@")
    tmux new-session -d -s "$session" -x 200 -y 50 -c "$workdir" "$shell_command"
    # Eval-friendly: source this output to get SESSION/OUTDIR/LOG in your shell
    printf 'export SESSION=%q\n' "$session"
    printf 'export OUTDIR=%q\n' "$outdir"
    printf 'export LOG=%q/tmux-readable-full.log\n' "$outdir"
    ;;

  snapshot)
    require_args 3 $# snapshot
    session=$1
    outdir=$2
    label=$3
    scrollback=${4:--300}
    mkdir -p "$outdir"
    log="$outdir/tmux-readable-full.log"
    {
      printf '\n===== %s =====\n' "$label"
      tmux capture-pane -t "$session" -p -S "$scrollback"
    } >> "$log"
    ;;

  send)
    require_args 2 $# send
    session=$1
    shift
    for key in "$@"; do
      tmux send-keys -t "$session" -- "$key"
      sleep 0.15
    done
    ;;

  type-submit)
    require_args 2 $# type-submit
    session=$1
    text=$2
    tmux send-keys -t "$session" -- "$text"
    sleep 0.5
    tmux send-keys -t "$session" Enter
    ;;

  wait-for)
    require_args 3 $# wait-for
    session=$1
    outdir=$2
    regex=$3
    attempts=${4:-60}
    sleep_seconds=${5:-2}
    scrollback=${6:--400}
    mkdir -p "$outdir"
    for _ in $(seq 1 "$attempts"); do
      sleep "$sleep_seconds"
      tmux capture-pane -t "$session" -p -S "$scrollback" > "$outdir/current-pane.txt"
      if grep -Eq "$regex" "$outdir/current-pane.txt"; then
        cat "$outdir/current-pane.txt"
        exit 0
      fi
    done
    cat "$outdir/current-pane.txt"
    exit 1
    ;;

  finish)
    require_args 2 $# finish
    session=$1
    outdir=$2
    log="$outdir/tmux-readable-full.log"
    tmux capture-pane -t "$session" -p -S -10000 > "$outdir/tmux-final-capture.log"
    {
      printf '\n===== final capture before cleanup =====\n'
      cat "$outdir/tmux-final-capture.log"
    } >> "$log"
    tmux kill-session -t "$session"
    wc -l "$log" "$outdir/tmux-final-capture.log"
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    echo "error: unknown command '$cmd'" >&2
    usage >&2
    exit 2
    ;;
esac
