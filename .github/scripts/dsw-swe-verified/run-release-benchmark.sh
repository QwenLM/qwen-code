#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${QWEN_REF:?QWEN_REF is required}"
: "${QWEN_COMMIT:?QWEN_COMMIT is required}"
: "${INSTANCE_LIMIT:?INSTANCE_LIMIT is required}"
: "${EXECUTOR_COUNT:?EXECUTOR_COUNT is required}"
: "${BENCHMARK_IDEMPOTENCY_KEY:?BENCHMARK_IDEMPOTENCY_KEY is required}"

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pool_root="${DSW_POOL_ROOT:-/mnt/workspace/qwen-benchmark-pool}"
pool_bin="${POOL_BIN:-${pool_root}/venv/bin/qwen-benchmark-pool}"
python_bin="${POOL_PYTHON:-${pool_root}/venv/bin/python}"
dataset_root="${SWE_VERIFIED_DATASET_ROOT:-${pool_root}/datasets/swe-bench-verified}"
runtime_root="${DSW_RELEASE_RUNTIME_ROOT:-/mnt/workspace/qwen-benchmark-dsw-release-v1}"
artifact_root="${DSW_RELEASE_ARTIFACT_ROOT:-/mnt/data/qwen-benchmark/dsw-release-v1}"
database_url="${BENCHMARK_POOL_DATABASE_URL:-postgresql://qwen_benchmark@127.0.0.1:55432/qwen_benchmark_dsw_release_v1}"
model_name="${OPENAI_MODEL:-qwen3.7-max}"
key_file="${OPENAI_KEY_FILE:-${runtime_root}/config/model.key}"
deadline_seconds="${BENCHMARK_DEADLINE_SECONDS:-82800}"
infra_failure_threshold="${INFRA_FAILURE_THRESHOLD:-0}"
execution_mode="${BENCHMARK_EXECUTION_MODE:-harbor}"
output_root="${GITHUB_WORKSPACE:-$(pwd)}/benchmark-output"

if [[ ! "${INSTANCE_LIMIT}" =~ ^[0-9]+$ ]] || (( INSTANCE_LIMIT < 1 || INSTANCE_LIMIT > 500 )); then
  echo "INSTANCE_LIMIT must be between 1 and 500" >&2
  exit 2
fi
if [[ ! "${EXECUTOR_COUNT}" =~ ^[0-9]+$ ]] || (( EXECUTOR_COUNT < 1 || EXECUTOR_COUNT > 10 )); then
  echo "EXECUTOR_COUNT must be between 1 and 10" >&2
  exit 2
fi
for required_path in "${pool_bin}" "${python_bin}" "${dataset_root}"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Required DSW resource is missing: ${required_path}" >&2
    exit 2
  fi
done
if [[ "${execution_mode}" != "harbor" && "${execution_mode}" != "synthetic" ]]; then
  echo "BENCHMARK_EXECUTION_MODE must be harbor or synthetic" >&2
  exit 2
fi
if [[ "${execution_mode}" == "harbor" && ! -s "${key_file}" ]]; then
  echo "Model key file is missing or empty: ${key_file}" >&2
  exit 2
fi

export BENCHMARK_POOL_DATABASE_URL="${database_url}"
if [[ "${execution_mode}" == "harbor" ]]; then
  export OPENAI_API_KEY
  OPENAI_API_KEY="$(tr -d '\r\n' < "${key_file}")"
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
fi

mkdir -p "${runtime_root}/logs" "${runtime_root}/cache/uv" "${artifact_root}/jobs" "${output_root}"
manifest_path="${output_root}/manifest.json"
manifest_args=(
  --dataset-root "${dataset_root}"
  --limit "${INSTANCE_LIMIT}"
  --output "${manifest_path}"
)
if [[ -n "${BENCHMARK_INSTANCE_ID:-}" ]]; then
  manifest_args+=(--instance-id "${BENCHMARK_INSTANCE_ID}")
fi
"${python_bin}" "${script_root}/make-manifest.py" "${manifest_args[@]}"

"${pool_bin}" init-db
submit_json="$(
  "${pool_bin}" submit \
    --idempotency-key "${BENCHMARK_IDEMPOTENCY_KEY}" \
    --suite "dsw_release_swe_verified_v1" \
    --dataset "swe-bench/swe-bench-verified" \
    --dataset-revision "2" \
    --task-prefix "swe-bench/" \
    --qwen-ref "${QWEN_REF}" \
    --qwen-commit "${QWEN_COMMIT}" \
    --model "${model_name}" \
    --manifest "${manifest_path}" \
    --max-attempts 2 \
    --infra-failure-threshold "${infra_failure_threshold}"
)"
run_id="$("${python_bin}" -c 'import json,sys; print(json.load(sys.stdin)["run_id"])' <<< "${submit_json}")"
log_root="${runtime_root}/logs/${run_id}"
run_artifact_root="${artifact_root}/releases/${RELEASE_TAG}/${run_id}/workflow-attempt-${GITHUB_RUN_ATTEMPT:-1}"
mkdir -p "${log_root}" "${run_artifact_root}"
cp "${manifest_path}" "${run_artifact_root}/manifest.json"

coordinator_pid=""
executor_pids=()
cleanup() {
  local pids=()
  [[ -n "${coordinator_pid}" ]] && pids+=("${coordinator_pid}")
  pids+=("${executor_pids[@]}")
  if (( ${#pids[@]} )); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"${pool_bin}" coordinator --poll-seconds 2 > "${log_root}/coordinator.log" 2>&1 &
coordinator_pid=$!
for executor_index in $(seq 1 "${EXECUTOR_COUNT}"); do
  executor_args=(
    executor
    --mode "${execution_mode}"
    --executor-id "dsw-release-v1-${run_id}-${executor_index}"
    --poll-seconds 2
    --lease-seconds 120
  )
  if [[ "${execution_mode}" == "harbor" ]]; then
    executor_args+=(
      --agent qwen-coder
      --timeout-seconds 7200
      --max-turns 200
      --uv-cache-root "${runtime_root}/cache/uv"
      --jobs-root "${artifact_root}/jobs"
      --verifier-http-timeout 300
    )
  else
    executor_args+=(--synthetic-seconds "${SYNTHETIC_SECONDS:-0.01}")
  fi
  "${pool_bin}" "${executor_args[@]}" \
    > "${log_root}/executor-${executor_index}.log" 2>&1 &
  executor_pids+=("$!")
done

deadline=$((SECONDS + deadline_seconds))
status="RUNNING"
while (( SECONDS < deadline )); do
  "${pool_bin}" status "${run_id}" > "${output_root}/pool-status.json"
  status="$("${python_bin}" -c 'import json,sys; print(json.load(sys.stdin)["status"])' < "${output_root}/pool-status.json")"
  cp "${output_root}/pool-status.json" "${run_artifact_root}/pool-status.json"
  if [[ "${status}" == "SUCCEEDED" || "${status}" == "QUARANTINED" ]]; then
    break
  fi
  sleep 10
done

if [[ "${status}" != "SUCCEEDED" && "${status}" != "QUARANTINED" ]]; then
  status="PIPELINE_TIMEOUT"
fi

"${python_bin}" "${script_root}/summarize.py" \
  --database-url "${database_url}" \
  --run-id "${run_id}" \
  --status-override "${status}" \
  --executor-count "${EXECUTOR_COUNT}" \
  --execution-mode "${execution_mode}" \
  --trigger "${BENCHMARK_TRIGGER:-unknown}" \
  --github-run-url "${GITHUB_RUN_URL:-}" \
  --output-json "${output_root}/public-result.json" \
  --output-markdown "${output_root}/release-result.md"

cp "${output_root}/public-result.json" "${run_artifact_root}/public-result.json"
cp "${output_root}/release-result.md" "${run_artifact_root}/release-result.md"
sha256sum "${run_artifact_root}/manifest.json" \
  "${run_artifact_root}/pool-status.json" \
  "${run_artifact_root}/public-result.json" \
  > "${run_artifact_root}/SHA256SUMS"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "run_id=${run_id}"
    echo "status=${status}"
    echo "artifact_path=${run_artifact_root}"
  } >> "${GITHUB_OUTPUT}"
fi

[[ "${status}" == "SUCCEEDED" ]]
