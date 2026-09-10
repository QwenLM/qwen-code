#!/usr/bin/env bash
set -euo pipefail

if ((EUID != 0)); then
  echo 'Run this installer as root.' >&2
  exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -Dm755 "$source_dir/qwen-docker-cleanup" /usr/local/sbin/qwen-docker-cleanup
install -Dm644 "$source_dir/qwen-docker-cleanup.service" /etc/systemd/system/qwen-docker-cleanup.service
install -Dm644 "$source_dir/qwen-docker-cleanup.timer" /etc/systemd/system/qwen-docker-cleanup.timer
systemctl daemon-reload
systemctl enable --now qwen-docker-cleanup.timer
