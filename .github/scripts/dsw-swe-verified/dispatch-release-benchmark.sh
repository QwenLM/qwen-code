#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${QWEN_REF:?QWEN_REF is required}"
: "${QWEN_COMMIT:?QWEN_COMMIT is required}"
: "${INSTANCE_LIMIT:?INSTANCE_LIMIT is required}"
: "${BENCHMARK_IDEMPOTENCY_KEY:?BENCHMARK_IDEMPOTENCY_KEY is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pool_root="${DSW_POOL_ROOT:-/mnt/workspace/qwen-benchmark-pool}"
pool_bin="${POOL_BIN:-${pool_root}/venv/bin/qwen-benchmark-pool}"
python_bin="${POOL_PYTHON:-${pool_root}/venv/bin/python}"
dataset_root="${SWE_VERIFIED_DATASET_ROOT:-${pool_root}/datasets/swe-bench-verified}"
database_url="${BENCHMARK_POOL_DATABASE_URL:-postgresql://qwen_benchmark@127.0.0.1:55432/qwen_benchmark_dsw_release_v1}"
model_name="${OPENAI_MODEL:-qwen3.7-max}"
output_root="${GITHUB_WORKSPACE:-$(pwd)}/benchmark-output"

if [[ ! "${INSTANCE_LIMIT}" =~ ^[0-9]+$ ]] || (( INSTANCE_LIMIT < 1 || INSTANCE_LIMIT > 500 )); then
  echo "INSTANCE_LIMIT must be between 1 and 500" >&2
  exit 2
fi
for required_path in "${pool_bin}" "${python_bin}" "${dataset_root}"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Required DSW resource is missing: ${required_path}" >&2
    exit 2
  fi
done

mkdir -p "${output_root}"
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

export BENCHMARK_POOL_DATABASE_URL="${database_url}"
"${pool_bin}" init-db >/dev/null
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
    --infra-failure-threshold 0 \
    --repository "${GITHUB_REPOSITORY}" \
    --release-id "${RELEASE_ID}" \
    --release-tag "${RELEASE_TAG}" \
    --github-run-url "${GITHUB_RUN_URL:-}"
)"
run_id="$("${python_bin}" -c 'import json,sys; print(json.load(sys.stdin)["run_id"])' <<< "${submit_json}")"

jq -n \
  --arg status "QUEUED" \
  --arg run_id "${run_id}" \
  --arg release_tag "${RELEASE_TAG}" \
  --arg qwen_ref "${QWEN_REF}" \
  --arg qwen_commit "${QWEN_COMMIT}" \
  --argjson expected_instances "${INSTANCE_LIMIT}" \
  --argjson executor_count "${EXECUTOR_COUNT:-10}" \
  '{
    status: $status,
    run_id: $run_id,
    release_tag: $release_tag,
    qwen_ref: $qwen_ref,
    qwen_commit: $qwen_commit,
    expected_instances: $expected_instances,
    executor_count: $executor_count
  }' > "${output_root}/dispatch-receipt.json"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "run_id=${run_id}"
    echo "status=QUEUED"
  } >> "${GITHUB_OUTPUT}"
fi

echo "Queued ${INSTANCE_LIMIT} SWE-bench Verified instances as ${run_id}."
