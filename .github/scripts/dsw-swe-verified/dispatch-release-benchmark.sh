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
agent_cache_root="${QWEN_BENCHMARK_CACHE_ROOT:-/mnt/workspace/qwen-benchmark-cache}"
agent_cache_prepare="${pool_root}/service/deploy/prepare-agent-cache.py"
database_url="${BENCHMARK_POOL_DATABASE_URL:-postgresql://qwen_benchmark@127.0.0.1:55432/qwen_benchmark_dsw_release_v1}"
model_name="${OPENAI_MODEL:-qwen3.7-max}"
dataset_revision="2"
max_attempts="${BENCHMARK_MAX_ATTEMPTS:-4}"
retry_backoff_seconds="${BENCHMARK_RETRY_BACKOFF_SECONDS:-60}"
output_root="${GITHUB_WORKSPACE:-$(pwd)}/benchmark-output"

if [[ ! "${INSTANCE_LIMIT}" =~ ^[0-9]+$ ]] || (( INSTANCE_LIMIT < 1 || INSTANCE_LIMIT > 500 )); then
  echo "INSTANCE_LIMIT must be between 1 and 500" >&2
  exit 2
fi
if [[ ! "${max_attempts}" =~ ^[0-9]+$ ]] || (( max_attempts < 1 || max_attempts > 8 )); then
  echo "BENCHMARK_MAX_ATTEMPTS must be between 1 and 8" >&2
  exit 2
fi
if [[ ! "${retry_backoff_seconds}" =~ ^[0-9]+$ ]]; then
  echo "BENCHMARK_RETRY_BACKOFF_SECONDS must be a non-negative integer" >&2
  exit 2
fi
for required_path in "${pool_bin}" "${python_bin}" "${dataset_root}" "${agent_cache_prepare}"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Required DSW resource is missing: ${required_path}" >&2
    exit 2
  fi
done
agent_cache_dirs=(
  "${agent_cache_root}"
  "${agent_cache_root}/node"
  "${agent_cache_root}/nvm"
  "${agent_cache_root}/npm"
  "${agent_cache_root}/qwen-code"
)
for cache_dir in "${agent_cache_dirs[@]}"; do
  if [[ ! -d "${cache_dir}" ]]; then
    echo "::error::Benchmark cache directory is missing: ${cache_dir}" >&2
    exit 2
  fi
  if [[ ! -w "${cache_dir}" ]]; then
    echo "::error::Benchmark cache directory is not writable by $(id -un): ${cache_dir}" >&2
    exit 2
  fi
done

mkdir -p "${output_root}"
manifest_path="${output_root}/manifest.json"
manifest_args=(
  --dataset-root "${dataset_root}"
  --dataset-revision "${dataset_revision}"
  --limit "${INSTANCE_LIMIT}"
  --output "${manifest_path}"
)
if [[ -n "${BENCHMARK_INSTANCE_ID:-}" ]]; then
  manifest_args+=(--instance-id "${BENCHMARK_INSTANCE_ID}")
fi
"${python_bin}" "${script_root}/make-manifest.py" "${manifest_args[@]}"

# Cache the exact published Qwen Code version and its Node/npm runtime before
# tasks become claimable. This normally takes seconds on a warm DSW cache and
# does not wait for the benchmark itself.
qwen_version="${QWEN_REF#v}"
"${python_bin}" "${agent_cache_prepare}" \
  --cache-root "${agent_cache_root}" \
  --node-version "${QWEN_BENCHMARK_NODE_VERSION:-v22.23.1}" \
  --nvm-version "${QWEN_BENCHMARK_NVM_VERSION:-v0.40.2}" \
  --qwen-version "${qwen_version}" \
  --npm-registry "${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org}" \
  > "${output_root}/agent-cache-manifest-path.txt"

export BENCHMARK_POOL_DATABASE_URL="${database_url}"
"${pool_bin}" init-db >/dev/null
submit_json="$(
  "${pool_bin}" submit \
    --idempotency-key "${BENCHMARK_IDEMPOTENCY_KEY}" \
    --suite "dsw_release_swe_verified_v1" \
    --dataset "swe-bench/swe-bench-verified" \
    --dataset-revision "${dataset_revision}" \
    --task-prefix "swe-bench/" \
    --qwen-ref "${QWEN_REF}" \
    --qwen-commit "${QWEN_COMMIT}" \
    --model "${model_name}" \
    --manifest "${manifest_path}" \
    --max-attempts "${max_attempts}" \
    --retry-backoff-seconds "${retry_backoff_seconds}" \
    --infra-failure-threshold 0 \
    --repository "${GITHUB_REPOSITORY}" \
    --release-id "${RELEASE_ID}" \
    --release-tag "${RELEASE_TAG}" \
    --github-run-url "${GITHUB_RUN_URL:-}"
)"
run_id="$(
  "${python_bin}" -c '
import json
import re
import sys

try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit("pool submit returned invalid JSON") from None
run_id = payload.get("run_id") if isinstance(payload, dict) else None
if not isinstance(run_id, str) or not run_id:
    raise SystemExit("pool submit response is missing a non-empty run_id")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
    raise SystemExit("pool submit returned an invalid run_id")
print(run_id)
' <<< "${submit_json}"
)"

jq -n \
  --arg status "QUEUED" \
  --arg run_id "${run_id}" \
  --arg release_tag "${RELEASE_TAG}" \
  --arg qwen_ref "${QWEN_REF}" \
  --arg qwen_commit "${QWEN_COMMIT}" \
  --argjson expected_instances "${INSTANCE_LIMIT}" \
  '{
    status: $status,
    run_id: $run_id,
    release_tag: $release_tag,
    qwen_ref: $qwen_ref,
    qwen_commit: $qwen_commit,
    expected_instances: $expected_instances
  }' > "${output_root}/dispatch-receipt.json"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "run_id=${run_id}"
    echo "status=QUEUED"
  } >> "${GITHUB_OUTPUT}"
fi

echo "Queued ${INSTANCE_LIMIT} SWE-bench Verified instances as ${run_id}."
