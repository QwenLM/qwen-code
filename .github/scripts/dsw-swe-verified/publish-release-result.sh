#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_DATABASE_ID:?RELEASE_DATABASE_ID is required}"

output_root="${GITHUB_WORKSPACE:-$(pwd)}/benchmark-output"
result_json="${output_root}/public-result.json"
result_markdown="${output_root}/release-result.md"
marker_start="<!-- qwen-code-dsw-swe-verified:start -->"
marker_end="<!-- qwen-code-dsw-swe-verified:end -->"

mkdir -p "${output_root}"
if [[ ! -f "${result_json}" ]]; then
  cat > "${result_json}" <<EOF
{
  "schema_version": "qwen-code-dsw-swe-verified/v1",
  "status": "PIPELINE_ERROR",
  "qwen_ref": "${QWEN_REF:-${RELEASE_TAG}}",
  "qwen_commit": "${RELEASE_COMMIT:-unknown}",
  "score_percent": null
}
EOF
fi
if [[ ! -f "${result_markdown}" ]]; then
  cat > "${result_markdown}" <<EOF
### SWE-bench Verified

- Status: **PIPELINE_ERROR**
- Qwen Code: \`${QWEN_REF:-${RELEASE_TAG}}\` (\`${RELEASE_COMMIT:-unknown}\`)
- Score: not published because the pipeline did not produce a validated result
- Workflow: ${GITHUB_RUN_URL:-unknown}
EOF
fi

github_api() {
  curl --fail --silent --show-error --location \
    --header "Accept: application/vnd.github+json" \
    --header "Authorization: Bearer ${GH_TOKEN}" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

release_json="$(
  github_api \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}"
)"
current_body="$(jq -r '.body // ""' <<< "${release_json}")"
clean_body="$(
  BODY="${current_body}" START="${marker_start}" END="${marker_end}" python3 - <<'PY'
import os

body = os.environ["BODY"]
start = os.environ["START"]
end = os.environ["END"]
while start in body and end in body:
    prefix, rest = body.split(start, 1)
    _, suffix = rest.split(end, 1)
    body = prefix.rstrip() + suffix
print(body.strip())
PY
)"
benchmark_body="$(cat "${result_markdown}")"
new_body="${clean_body}"
if [[ -n "${new_body}" ]]; then
  new_body+=$'\n\n'
fi
new_body+="${marker_start}"$'\n'"${benchmark_body}"$'\n'"${marker_end}"

payload_path="${output_root}/release-update.json"
jq -n --arg body "${new_body}" '{body: $body}' > "${payload_path}"
github_api \
  --request PATCH \
  --header "Content-Type: application/json" \
  --data-binary "@${payload_path}" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/${RELEASE_DATABASE_ID}" \
  > "${output_root}/release-update-response.json"

asset_name="swe-bench-verified-${RELEASE_TAG}.json"
cp "${result_json}" "${output_root}/${asset_name}"
asset_id="$(
  jq -r --arg name "${asset_name}" \
    '.assets[]? | select(.name == $name) | .id' \
    <<< "${release_json}" \
    | head -n 1
)"
if [[ -n "${asset_id}" ]]; then
  github_api \
    --request DELETE \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
    > /dev/null
fi
curl --fail --silent --show-error --location \
  --request POST \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer ${GH_TOKEN}" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --header "Content-Type: application/json" \
  --data-binary "@${output_root}/${asset_name}" \
  "https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${RELEASE_DATABASE_ID}/assets?name=${asset_name}" \
  > "${output_root}/release-asset-response.json"
