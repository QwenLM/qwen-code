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

mkdir -p "${out_dir}/reference" "${out_dir}/qwen"

set +e
"${feature_run}" "${out_dir}/reference" -- bash -lc "${reference_command}"
reference_status=$?
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
