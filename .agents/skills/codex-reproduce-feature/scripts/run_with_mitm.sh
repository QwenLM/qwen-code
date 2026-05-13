#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 3 || "${2:-}" != "--" ]]; then
  echo "Usage: $0 OUT_DIR -- COMMAND [ARG...]" >&2
  exit 2
fi

out_dir="$1"
shift 2

mkdir -p "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"

port="${REPRO_PROXY_PORT:-18080}"
ca_file="${MITMPROXY_CA_FILE:-${HOME}/.mitmproxy/mitmproxy-ca-cert.pem}"
http_out="${out_dir}/http.jsonl"
mitm_log="${out_dir}/mitm.log"

if ! command -v mitmdump >/dev/null 2>&1; then
  echo "mitmdump not found. Install mitmproxy first." >&2
  exit 127
fi

: > "${http_out}"
: > "${mitm_log}"

REPRO_CAPTURE_OUT="${http_out}" \
  mitmdump \
    --listen-host 127.0.0.1 \
    --listen-port "${port}" \
    --set block_global=false \
    --set ssl_insecure=true \
    -s "${script_dir}/llm_dump.py" \
    >"${mitm_log}" 2>&1 &

mitm_pid="$!"
cleanup() {
  kill "${mitm_pid}" >/dev/null 2>&1 || true
  wait "${mitm_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 1

{
  echo "out_dir=${out_dir}"
  echo "proxy=http://127.0.0.1:${port}"
  echo "ca_file=${ca_file}"
  echo "command=$*"
} > "${out_dir}/env.txt"

set +e
HTTP_PROXY="http://127.0.0.1:${port}" \
HTTPS_PROXY="http://127.0.0.1:${port}" \
ALL_PROXY="http://127.0.0.1:${port}" \
NODE_EXTRA_CA_CERTS="${ca_file}" \
SSL_CERT_FILE="${ca_file}" \
REQUESTS_CA_BUNDLE="${ca_file}" \
REPRO_CAPTURE_OUT="${http_out}" \
  "$@" >"${out_dir}/command.stdout" 2>"${out_dir}/command.stderr"
status=$?
set -e

echo "${status}" > "${out_dir}/command.exit"
exit "${status}"
