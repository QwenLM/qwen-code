#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 OUT_DIR REFERENCE_SHELL_COMMAND QWEN_SHELL_COMMAND" >&2
  exit 2
fi

out_dir="$1"
reference_command="$2"
qwen_command="$3"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
feature_run="${script_dir}/../../agent-reproduce-feature/scripts/run_with_mitm.sh"
state_capture="${script_dir}/../../agent-reproduce-feature/scripts/capture_state.py"
reference_agent="${REPRO_REFERENCE_AGENT:-}"
reference_state_root="${REPRO_REFERENCE_STATE_ROOT:-}"

mkdir -p "${out_dir}/reference" "${out_dir}/qwen"

if [[ -n "${reference_agent}" ]]; then
  state_args=(--agent "${reference_agent}")
  if [[ -n "${reference_state_root}" ]]; then
    state_args+=(--root "${reference_state_root}")
  fi

  "${state_capture}" snapshot \
    "${out_dir}/reference/state-before" \
    "${state_args[@]}"
fi

set +e
"${feature_run}" "${out_dir}/reference" -- bash -lc "${reference_command}"
reference_status=$?
set -e

if [[ -n "${reference_agent}" ]]; then
  "${state_capture}" snapshot \
    "${out_dir}/reference/state-after" \
    "${state_args[@]}"
  "${state_capture}" diff \
    "${out_dir}/reference/state-before" \
    "${out_dir}/reference/state-after" \
    --out-dir "${out_dir}/reference/state-diff"
fi

set +e
"${feature_run}" "${out_dir}/qwen" -- bash -lc "${qwen_command}"
qwen_status=$?
set -e

"${script_dir}/normalize_trace.py" "${out_dir}/reference/http.jsonl" > "${out_dir}/reference/normalized.json"
"${script_dir}/normalize_trace.py" "${out_dir}/qwen/http.jsonl" > "${out_dir}/qwen/normalized.json"

set +e
"${script_dir}/compare_traces.py" \
  "${out_dir}/reference/normalized.json" \
  "${out_dir}/qwen/normalized.json" \
  > "${out_dir}/trace.diff"
compare_status=$?
set -e

echo "reference_status=${reference_status}"
echo "qwen_status=${qwen_status}"
echo "compare_status=${compare_status}"
echo "diff=${out_dir}/trace.diff"

if [[ "${reference_status}" -ne 0 || "${qwen_status}" -ne 0 || "${compare_status}" -ne 0 ]]; then
  exit 1
fi
