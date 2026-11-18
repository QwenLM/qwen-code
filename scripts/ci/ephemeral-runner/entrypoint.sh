#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_JIT_CONFIG:?RUNNER_JIT_CONFIG is required}"
jit_config="$RUNNER_JIT_CONFIG"
unset RUNNER_JIT_CONFIG
cd /home/node/actions-runner
exec ./run.sh --jitconfig "$jit_config"
