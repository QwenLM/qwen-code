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

if [[ ! -f "${ca_file}" ]]; then
  echo "WARNING: CA cert not found at ${ca_file}." >&2
  echo "Run mitmproxy once to generate it, or set MITMPROXY_CA_FILE." >&2
fi

: > "${http_out}"
: > "${mitm_log}"

# --set ssl_insecure=true disables upstream TLS verification so mitmproxy
# can intercept HTTPS calls from the wrapped command. Intended for local
# dev only; do NOT run this script on shared or untrusted networks.
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

proxy_ready=0
for _attempt in {1..50}; do
  if ! kill -0 "${mitm_pid}" >/dev/null 2>&1; then
    echo "mitmdump exited before the wrapped command started." >&2
    cat "${mitm_log}" >&2
    exit 1
  fi
  if python3 - "${port}" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.2):
    pass
PY
  then
    proxy_ready=1
    break
  fi
  sleep 0.1
done

if [[ "${proxy_ready}" != "1" ]]; then
  echo "mitmdump did not start listening on 127.0.0.1:${port}." >&2
  cat "${mitm_log}" >&2
  exit 1
fi

redacted_command="$(
  # Note: avoid the GNU-only /I (case-insensitive) sed flag — BSD sed
  # (macOS pre-Sequoia) silently fails to match with /I, so previously
  # `API_KEY=…`, `Secret=…`, etc. would not be redacted on macOS. Use
  # explicit per-letter character classes for the case-insensitive
  # token-name matches; both BSD and GNU sed accept them.
  printf '%q ' "$@" |
    sed -E \
      -e 's/sk-[A-Za-z0-9_-]{12,}/sk-<redacted>/g' \
      -e 's/AKIA[0-9A-Z]{16}/AKIA<redacted>/g' \
      -e 's/AIza[0-9A-Za-z_-]{20,}/AIza<redacted>/g' \
      -e 's/(ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}/gh_<redacted>/g' \
      -e 's/github_pat_[A-Za-z0-9_]{20,}/github_pat_<redacted>/g' \
      -e 's/([A-Za-z0-9_.-]*([Aa][Pp][Ii][-_]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll])[A-Za-z0-9_.-]*=)[^[:space:]]+/\1<redacted>/g'
)"

{
  echo "out_dir=${out_dir}"
  echo "proxy=http://127.0.0.1:${port}"
  echo "ca_file=${ca_file}"
  echo "command=${redacted_command}"
} > "${out_dir}/env.txt"

set +e
HTTP_PROXY="http://127.0.0.1:${port}" \
HTTPS_PROXY="http://127.0.0.1:${port}" \
ALL_PROXY="http://127.0.0.1:${port}" \
http_proxy="http://127.0.0.1:${port}" \
https_proxy="http://127.0.0.1:${port}" \
all_proxy="http://127.0.0.1:${port}" \
NO_PROXY="localhost,127.0.0.1" \
no_proxy="localhost,127.0.0.1" \
NODE_EXTRA_CA_CERTS="${ca_file}" \
SSL_CERT_FILE="${ca_file}" \
REQUESTS_CA_BUNDLE="${ca_file}" \
REPRO_CAPTURE_OUT="${http_out}" \
  "$@" >"${out_dir}/command.stdout" 2>"${out_dir}/command.stderr"
status=$?
set -e

sleep "${REPRO_MITM_DRAIN_SECONDS:-1}"

echo "${status}" > "${out_dir}/command.exit"
if [[ "${status}" -ne 0 ]]; then
  echo "command_failed: exit=${status}" >&2
  echo "stdout=${out_dir}/command.stdout" >&2
  echo "stderr=${out_dir}/command.stderr" >&2
fi
exit "${status}"
