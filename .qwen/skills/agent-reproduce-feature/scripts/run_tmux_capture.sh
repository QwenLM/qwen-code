#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 OUT_DIR COMMAND [ARG...]" >&2
  exit 2
fi

out_dir="$1"
shift

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found." >&2
  exit 127
fi

mkdir -p "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"

session="repro-$(date +%Y%m%d-%H%M%S)-$$"
printf '%q ' "$@" > "${out_dir}/command.txt"
echo >> "${out_dir}/command.txt"

tmux new-session -d -s "${session}" "$@"
cleanup() {
  if [[ "${REPRO_TMUX_KEEP_SESSION:-0}" != "1" ]]; then
    tmux kill-session -t "${session}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

sleep "${REPRO_TMUX_SETTLE_SECONDS:-2}"
tmux capture-pane -t "${session}" -p -S - > "${out_dir}/tmux-pane.txt"

{
  echo "session=${session}"
  echo "attach=tmux attach -t ${session}"
  echo "capture=tmux capture-pane -t ${session} -p -S - > ${out_dir}/tmux-pane.txt"
  echo "kill=tmux kill-session -t ${session}"
  echo "keep_session=REPRO_TMUX_KEEP_SESSION=1"
} > "${out_dir}/tmux-session.txt"

cat "${out_dir}/tmux-session.txt"
