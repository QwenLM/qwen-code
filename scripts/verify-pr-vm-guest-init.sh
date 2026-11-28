#!/bin/sh
# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
#
# Standard PID-1 init entrypoint for NIC-less `/verify-pr` microVMs.
# Mounts virtual filesystems, brings up loopback only, launches the guest
# runner, and powers off cleanly on exit (avoiding a PID-1 kernel panic).
set -eu

if [ -x /bin/busybox ] && [ ! -e /bin/mount ]; then
  /bin/busybox --install -s
fi

export PATH="/opt/python/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LD_LIBRARY_PATH="/opt/python/lib:/lib/aarch64-linux-gnu:/lib/x86_64-linux-gnu"
export HOME="/run"
export TMPDIR="/run"
export PYTHONNOUSERSITE="1"
export PYTHONDONTWRITEBYTECODE="1"
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

mkdir -p /proc /sys /dev /run
if ! mountpoint -q /dev 2>/dev/null; then
  mount -t devtmpfs devtmpfs /dev
fi
if ! mountpoint -q /proc 2>/dev/null; then
  mount -t proc proc /proc
fi
if ! mountpoint -q /sys 2>/dev/null; then
  mount -t sysfs sys /sys
fi
if ! mountpoint -q /run 2>/dev/null; then
  mount -t tmpfs tmpfs /run
fi

if command -v modprobe >/dev/null 2>&1; then
  modprobe virtio_vsock 2>/dev/null || true
fi

if command -v ip >/dev/null 2>&1; then
  ip link set lo up 2>/dev/null || true
elif command -v ifconfig >/dev/null 2>&1; then
  ifconfig lo 127.0.0.1 up 2>/dev/null || true
fi

PYTHON_BIN="${QWEN_GUEST_PYTHON:-/opt/python/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
RUNNER_SCRIPT="${QWEN_GUEST_RUNNER:-/opt/qwen/guest-runner.py}"

RC=1
if [ -n "$PYTHON_BIN" ] && [ -x "$PYTHON_BIN" ] && [ -f "$RUNNER_SCRIPT" ]; then
  set +e
  "$PYTHON_BIN" "$RUNNER_SCRIPT" --from-cmdline
  RC=$?
  set -e
else
  echo "verify-pr guest-init: missing python3 or $RUNNER_SCRIPT" >&2
fi

sync || true
if [ "$$" -eq 1 ]; then
  if command -v poweroff >/dev/null 2>&1; then
    poweroff -f || true
  fi
  if command -v reboot >/dev/null 2>&1; then
    reboot -f || true
  fi
fi
exit "$RC"
