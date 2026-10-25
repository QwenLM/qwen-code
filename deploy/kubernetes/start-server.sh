#!/bin/sh
set -eu
umask 077

if [ "${QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED:-}" != false ] || \
   [ -n "${QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY:-}${QWEN_HOME:-}" ]; then
  # Kubelet may widen PVC permissions for fsGroup before this process starts.
  for directory in "${QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY:?}" "${QWEN_HOME:?}"; do
    if [ -L "$directory" ]; then
      echo >&2 'Runtime private directory must not be a symlink.'
      exit 1
    fi
    if [ ! -e "$directory" ]; then
      mkdir -m 700 -- "$directory"
    fi
    if [ ! -d "$directory" ] || \
       [ -n "$(find "$directory" ! -uid "$(id -u)" -print -quit)" ] || \
       [ -n "$(find "$directory" ! -type d ! -type f -print -quit)" ]; then
      echo >&2 'Runtime private state contains an unowned or unsupported entry.'
      exit 1
    fi
    find "$directory" -type d -exec chmod 700 {} +
    find "$directory" -type f -exec chmod 600 {} +
  done
fi

exec "${JAVA_HOME:?}/bin/java" -jar /app/qwen-managed-agent-server.jar "$@"
