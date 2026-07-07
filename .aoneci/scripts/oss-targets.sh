#!/usr/bin/env bash
# Shared OSS target and credential helpers for qwen-code AoneCI uploads.

oss_die() {
  echo "ERROR: $*" >&2
  exit 1
}

oss_helper_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

oss_upload_targets() {
  local raw="${OSS_UPLOAD_TARGETS:-public finance}"
  printf '%s\n' "${raw}" \
    | tr ',;' '  ' \
    | tr '[:space:]' '\n' \
    | while IFS= read -r target; do
        [ -n "${target}" ] && printf '%s\n' "${target}"
      done \
    | awk '!seen[$0]++'
}

oss_target_endpoint() {
  case "$1" in
    public) printf '%s' "${PUBLIC_OSS_ENDPOINT:-https://oss-cn-shanghai.aliyuncs.com}" ;;
    finance) printf '%s' "${FINANCE_OSS_ENDPOINT:-https://oss-cn-shanghai-finance-1.aliyuncs.com}" ;;
    *) oss_die "unsupported OSS upload target: $1" ;;
  esac
}

oss_target_bucket() {
  case "$1" in
    public) printf '%s' "${PUBLIC_OSS_BUCKET:-dataworks-notebook-cn-shanghai}" ;;
    finance) printf '%s' "${FINANCE_OSS_BUCKET:-dataworks-notebook-cn-shanghai-finance-1}" ;;
    *) oss_die "unsupported OSS upload target: $1" ;;
  esac
}

oss_endpoint_host() {
  local endpoint="$1"
  endpoint="${endpoint#https://}"
  endpoint="${endpoint#http://}"
  printf '%s' "${endpoint}"
}

oss_http_url() {
  local bucket="$1"
  local endpoint="$2"
  local key="$3"
  printf 'https://%s.%s/%s' "${bucket}" "$(oss_endpoint_host "${endpoint}")" "${key}"
}

oss_current_http_url() {
  oss_http_url "${OSS_BUCKET}" "${OSS_ENDPOINT}" "$1"
}

oss_credential_mode() {
  local mode="${OSS_CREDENTIAL_MODE:-zerotrust}"
  case "${mode}" in
    zerotrust | zero-trust | zero_trust | sts | "")
      printf 'zerotrust'
      ;;
    aksk | ak-sk | ak_sk | access-key | access_key)
      printf 'aksk'
      ;;
    *)
      oss_die "unsupported OSS credential mode: ${mode}"
      ;;
  esac
}

oss_ensure_ossutil() {
  if ! command -v ossutil64 >/dev/null 2>&1 && ! command -v ossutil >/dev/null 2>&1; then
    echo ">>> Installing ossutil..." >&2
    curl -fsSL "https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil-v1.7.18-linux-amd64.zip" -o /tmp/ossutil.zip
    unzip -o /tmp/ossutil.zip -d /tmp/ossutil >/dev/null
    chmod +x /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64
    cp /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64 /usr/local/bin/ossutil64
  fi
  command -v ossutil64 || command -v ossutil
}

oss_configure_target() {
  local target="$1"
  local credential_mode env_file resolver had_xtrace=""

  case "$-" in
    *x*) had_xtrace="1"; set +x ;;
  esac

  credential_mode="$(oss_credential_mode)"
  echo ">>> Configuring OSS target ${target} with credential mode: ${credential_mode}" >&2

  if [ "${credential_mode}" = "zerotrust" ]; then
    [ -n "${BOOTSTRAP_TOKEN:-}" ] || oss_die "BOOTSTRAP_TOKEN is required when OSS_CREDENTIAL_MODE=zerotrust"
    resolver="${OSS_STS_RESOLVER:-$(oss_helper_dir)/resolve-oss-sts.sh}"
    [ -f "${resolver}" ] || oss_die "OSS STS resolver not found: ${resolver}"
    env_file="$(mktemp)"
    chmod 600 "${env_file}"
    BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN}" \
      ZERO_TRUST_TOOL_URL="${ZERO_TRUST_TOOL_URL:-}" \
      PUBLIC_OSS_STS_ROLE_ARN="${PUBLIC_OSS_STS_ROLE_ARN:-}" \
      FINANCE_OSS_STS_ROLE_ARN="${FINANCE_OSS_STS_ROLE_ARN:-}" \
      PUBLIC_OSS_ENDPOINT="${PUBLIC_OSS_ENDPOINT:-}" \
      PUBLIC_OSS_BUCKET="${PUBLIC_OSS_BUCKET:-}" \
      FINANCE_OSS_ENDPOINT="${FINANCE_OSS_ENDPOINT:-}" \
      FINANCE_OSS_BUCKET="${FINANCE_OSS_BUCKET:-}" \
      bash "${resolver}" "${target}" > "${env_file}"
    # shellcheck disable=SC1090
    . "${env_file}"
    rm -f "${env_file}"
  else
    echo ">>> Using explicit legacy AK/SK OSS credential mode." >&2
    OSS_TARGET="${target}"
    OSS_ENDPOINT="$(oss_target_endpoint "${target}")"
    OSS_BUCKET="$(oss_target_bucket "${target}")"
    OSS_SECURITY_TOKEN=""
    [ -n "${OSS_ACCESS_KEY_ID:-}" ] || oss_die "OSS_ACCESS_KEY_ID is required when OSS_CREDENTIAL_MODE=aksk"
    [ -n "${OSS_ACCESS_KEY_SECRET:-}" ] || oss_die "OSS_ACCESS_KEY_SECRET is required when OSS_CREDENTIAL_MODE=aksk"
  fi

  OSSUTIL="$(oss_ensure_ossutil)"
  if [ -n "${OSS_SECURITY_TOKEN:-}" ]; then
    "${OSSUTIL}" config -e "${OSS_ENDPOINT}" -i "${OSS_ACCESS_KEY_ID}" -k "${OSS_ACCESS_KEY_SECRET}" -t "${OSS_SECURITY_TOKEN}" >/dev/null
  else
    "${OSSUTIL}" config -e "${OSS_ENDPOINT}" -i "${OSS_ACCESS_KEY_ID}" -k "${OSS_ACCESS_KEY_SECRET}" >/dev/null
  fi

  if [ -n "${had_xtrace}" ]; then
    set -x
  fi
}

oss_targets_one_line() {
  oss_upload_targets | paste -sd ' ' -
}
