#!/usr/bin/env bash
# Resolve temporary OSS STS credentials from the AoneCI zero-trust bootstrap token.
#
# This script writes shell assignments to stdout for callers to source. Do not
# print the output directly to CI logs.

set -euo pipefail

target="${1:-${OSS_STS_TARGET:-public}}"

ZERO_TRUST_APP_NAME="${ZERO_TRUST_APP_NAME:-lsp-server-outside}"
ZERO_TRUST_APP_GROUP="${ZERO_TRUST_APP_GROUP:-any-value}"
ZERO_TRUST_APP_ENV="${ZERO_TRUST_APP_ENV:-testing}"
ZERO_TRUST_APP_REGION="${ZERO_TRUST_APP_REGION:-cn-hangzhou}"
ZERO_TRUST_TOOL_URL="${ZERO_TRUST_TOOL_URL:-https://apsara-release-build.oss-cn-hangzhou-zmf.aliyuncs.com/aliyun-zerotrust-credential-provider/8654515/zero-trust-credentials-linux-amd64-1.2.5.zip}"

BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:?BOOTSTRAP_TOKEN is required}"

case "${target}" in
  public)
    OSS_STS_ROLE_ARN="${PUBLIC_OSS_STS_ROLE_ARN:-acs:ram::1200759642363824:role/lsp-aoneci-dataworks-datagovernance}"
    OSS_ENDPOINT="${PUBLIC_OSS_ENDPOINT:-https://oss-cn-shanghai.aliyuncs.com}"
    OSS_BUCKET="${PUBLIC_OSS_BUCKET:-dataworks-notebook-cn-shanghai}"
    ;;
  finance)
    OSS_STS_ROLE_ARN="${FINANCE_OSS_STS_ROLE_ARN:-acs:ram::1797822531535220:role/lsp-aoneci-dataworks-finance}"
    OSS_ENDPOINT="${FINANCE_OSS_ENDPOINT:-https://oss-cn-shanghai-finance-1.aliyuncs.com}"
    OSS_BUCKET="${FINANCE_OSS_BUCKET:-dataworks-notebook-cn-shanghai-finance-1}"
    ;;
  *)
    echo "ERROR: unsupported OSS_STS_TARGET: ${target}" >&2
    exit 2
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
config_file="${tmp_dir}/zero-trust.yaml"
provider_zip="${tmp_dir}/zero-trust-credentials.zip"

curl -fsSL "${ZERO_TRUST_TOOL_URL}" -o "${provider_zip}"
unzip -q "${provider_zip}" -d "${tmp_dir}"
provider_bin="$(find "${tmp_dir}" -type f -name aliyun-zerotrust-credential-provider | head -n 1)"
[ -n "${provider_bin}" ] || {
  echo "ERROR: aliyun-zerotrust-credential-provider not found in archive" >&2
  exit 2
}
chmod 755 "${provider_bin}"

cat > "${config_file}" <<EOF
app:
  name: ${ZERO_TRUST_APP_NAME}
  group: ${ZERO_TRUST_APP_GROUP}
  env: ${ZERO_TRUST_APP_ENV}
  region: ${ZERO_TRUST_APP_REGION}
credentials:
  role: ${OSS_STS_ROLE_ARN}
  bootstrap_token: ${BOOTSTRAP_TOKEN}
EOF

secret="$("${provider_bin}" --config-file="${config_file}")"
secret_one_line="$(printf '%s' "${secret}" | tr -d '\n')"
access_key_id="$(printf '%s' "${secret_one_line}" | sed -nE 's/.*"AccessKeyId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
access_key_secret="$(printf '%s' "${secret_one_line}" | sed -nE 's/.*"AccessKeySecret"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
security_token="$(printf '%s' "${secret_one_line}" | sed -nE 's/.*"SecurityToken"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"

if [ -z "${access_key_id}" ] || [ -z "${access_key_secret}" ] || [ -z "${security_token}" ]; then
  echo "ERROR: zero-trust provider response missing AccessKeyId/AccessKeySecret/SecurityToken" >&2
  exit 2
fi

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

printf 'OSS_TARGET=%s\n' "$(shell_quote "${target}")"
printf 'OSS_ENDPOINT=%s\n' "$(shell_quote "${OSS_ENDPOINT}")"
printf 'OSS_BUCKET=%s\n' "$(shell_quote "${OSS_BUCKET}")"
printf 'OSS_ACCESS_KEY_ID=%s\n' "$(shell_quote "${access_key_id}")"
printf 'OSS_ACCESS_KEY_SECRET=%s\n' "$(shell_quote "${access_key_secret}")"
printf 'OSS_SECURITY_TOKEN=%s\n' "$(shell_quote "${security_token}")"

echo "Resolved ${target} OSS STS credentials via zero-trust provider" >&2
