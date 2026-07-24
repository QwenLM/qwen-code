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
  "qwen_ref": "${RELEASE_TAG}",
  "qwen_commit": "${RELEASE_COMMIT:-unknown}",
  "score_percent": null
}
EOF
fi
if [[ ! -f "${result_markdown}" ]]; then
  cat > "${result_markdown}" <<EOF
### SWE-bench Verified

- Status: **PIPELINE_ERROR**
- Qwen Code: \`${RELEASE_TAG}\` (\`${RELEASE_COMMIT:-unknown}\`)
- Score: not published because the pipeline did not produce a validated result
- Workflow: ${GITHUB_RUN_URL:-unknown}
EOF
fi

release_json="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}")"
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

jq -n --arg body "${new_body}" '{body: $body}' \
  | gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_DATABASE_ID}" --input -

asset_name="swe-bench-verified-${RELEASE_TAG}.json"
cp "${result_json}" "${output_root}/${asset_name}"
gh release upload "${RELEASE_TAG}" "${output_root}/${asset_name}" \
  --repo "${GITHUB_REPOSITORY}" \
  --clobber
