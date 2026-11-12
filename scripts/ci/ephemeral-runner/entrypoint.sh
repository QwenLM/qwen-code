#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_JIT_CONFIG:?RUNNER_JIT_CONFIG is required}"
jit_config="$RUNNER_JIT_CONFIG"
unset RUNNER_JIT_CONFIG

# Seed the interpreter archives the image carries into the directory the job's
# own cache step points at. The seed itself is root-owned and only readable, so
# it cannot be the cache: marking an archive used writes its mtime, and the
# weekly sweep removes entries, both of which need a writable directory the job
# owns. Copying is what keeps those working — and a copy that fails is not
# fatal, because the fetch falls back to downloading exactly as before.
#
# Only files that are absent are copied. A container is created per job, so
# this normally seeds an empty directory; skipping an existing name means a
# future image that mounts a real cache keeps whatever that cache verified.
if [ -n "${QWEN_CI_BAKED_RUNTIME_CACHE:-}" ] &&
  [ -d "${QWEN_CI_BAKED_RUNTIME_CACHE}" ]; then
  runtime_cache="${HOME}/.cache/qwen-code/standalone-runtimes"
  if mkdir -p "$runtime_cache" 2>/dev/null; then
    for archive in "${QWEN_CI_BAKED_RUNTIME_CACHE}"/*.tgz; do
      [ -f "$archive" ] || continue
      target="${runtime_cache}/$(basename "$archive")"
      [ -e "$target" ] && continue
      cp "$archive" "$target" 2>/dev/null ||
        echo "could not seed ${target}; the job will download it" >&2
    done
  else
    echo "could not create ${runtime_cache}; the job will download the runtimes" >&2
  fi
fi

cd /home/node/actions-runner
exec ./run.sh --jitconfig "$jit_config"
