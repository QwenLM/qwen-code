#!/usr/bin/env bash
set -euo pipefail

# Only the runner's own cache can be repaired; a configured shared cache
# requires runner provisioning rather than a job changing its permissions.
cache_path="${RUNNER_TOOL_CACHE:?}"
if [ ! -e "$cache_path" ] && [ ! -L "$cache_path" ]; then
  exit 0
fi
tool_cache="$(cd -P -- "$cache_path" && pwd -P)"
runner_work="$(cd -P -- "${RUNNER_TEMP:?}" && cd .. && pwd -P)"
if [ "$tool_cache" != "$runner_work/_tool" ]; then
  echo "::error::Refusing to change Java cache outside this runner's work directory: $tool_cache"
  exit 1
fi

java_cache="$tool_cache/Java_Temurin-Hotspot_jdk"
if [ -L "$java_cache" ] || { [ -e "$java_cache" ] && [ ! -d "$java_cache" ]; }; then
  echo "::error::Refusing to change a redirected or non-directory Java cache: $java_cache"
  exit 1
fi

trap 'echo "::error::Could not restore the runner-local Java cache; the runner needs permission repair: $java_cache"' ERR
owner="$(id -u):$(id -g)"
mkdir -p -- "$java_cache" 2>/dev/null || sudo -n mkdir -p -- "$java_cache"
chown -hR -- "$owner" "$java_cache" 2>/dev/null || sudo -n chown -hR -- "$owner" "$java_cache"
chmod -R u+rwX "$java_cache" 2>/dev/null || sudo -n chmod -R u+rwX "$java_cache"
