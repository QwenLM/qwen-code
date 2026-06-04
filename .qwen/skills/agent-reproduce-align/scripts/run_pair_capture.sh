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

set +e
"${script_dir}/normalize_trace.py" "${out_dir}/reference/http.jsonl" \
  > "${out_dir}/reference/normalized.json" \
  2> "${out_dir}/reference/normalize.err"
normalize_ref_status=$?
"${script_dir}/normalize_trace.py" "${out_dir}/qwen/http.jsonl" \
  > "${out_dir}/qwen/normalized.json" \
  2> "${out_dir}/qwen/normalize.err"
normalize_qwen_status=$?
set -e

compare_status=0
if [[ "${normalize_ref_status}" -ne 0 || "${normalize_qwen_status}" -ne 0 ]]; then
  {
    echo "Trace normalization failed."
    echo "reference_normalize_status=${normalize_ref_status}"
    echo "qwen_normalize_status=${normalize_qwen_status}"
    echo "reference_normalize_err=${out_dir}/reference/normalize.err"
    echo "qwen_normalize_err=${out_dir}/qwen/normalize.err"
  } > "${out_dir}/trace.diff"
  compare_status=2
else
  request_counts="$(
    python3 - "${out_dir}/reference/normalized.json" "${out_dir}/qwen/normalized.json" <<'PY'
import json
import sys

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        print(json.load(handle).get("request_count", 0))
PY
  )"
  reference_count="$(printf '%s\n' "${request_counts}" | sed -n '1p')"
  qwen_count="$(printf '%s\n' "${request_counts}" | sed -n '2p')"
  if [[ "${reference_count}" == "0" && "${qwen_count}" == "0" ]]; then
    {
      echo "Both captures produced empty traces."
      echo "reference_http=${out_dir}/reference/http.jsonl"
      echo "qwen_http=${out_dir}/qwen/http.jsonl"
    } > "${out_dir}/trace.diff"
    compare_status=1
  else
    set +e
    "${script_dir}/compare_traces.py" \
      "${out_dir}/reference/normalized.json" \
      "${out_dir}/qwen/normalized.json" \
      > "${out_dir}/trace.diff"
    compare_status=$?
    set -e
  fi
fi

echo "reference_status=${reference_status}"
echo "qwen_status=${qwen_status}"
echo "normalize_reference_status=${normalize_ref_status}"
echo "normalize_qwen_status=${normalize_qwen_status}"
echo "compare_status=${compare_status}"
echo "diff=${out_dir}/trace.diff"
echo "reference_stdout=${out_dir}/reference/command.stdout"
echo "reference_stderr=${out_dir}/reference/command.stderr"
echo "qwen_stdout=${out_dir}/qwen/command.stdout"
echo "qwen_stderr=${out_dir}/qwen/command.stderr"

if [[ "${reference_status}" -ne 0 || "${qwen_status}" -ne 0 || "${normalize_ref_status}" -ne 0 || "${normalize_qwen_status}" -ne 0 || "${compare_status}" -ne 0 ]]; then
  exit 1
fi
