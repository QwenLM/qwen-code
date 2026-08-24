#!/usr/bin/env bash
# File (or update) one issue per version when a sandbox image build fails.
#
# The body below is the 'File or update the image-build failure issue' step
# of the file-failure-issue job in .github/workflows/build-and-publish-image.yml.
# A released npm version without a matching GHCR sandbox image breaks every
# sandbox-based CI lane (/resolve, sandboxed review, autofix) with
# "manifest unknown", and nothing else surfaces that state — see #9898.
set -euo pipefail

# Tag pushes name the version through the tag; manual recovery dispatches
# carry it in the version input.
if [[ "${EVENT_NAME}" == 'push' ]]; then
  version="${TAG_NAME}"
else
  version="${INPUT_VERSION}"
fi
# Both paths may carry a leading `v` (tag names always do; a dispatcher may
# type one). Normalize once so the dedup marker and the image tag — which the
# build job publishes without a `v` — always agree, instead of filing a
# duplicate issue for a `v`-prefixed tag that can never exist.
version="${version#v}"
if [[ -z "${version}" ]]; then
  echo "::error::No version resolved for the image-build failure issue."
  exit 1
fi
marker="image-build-failure:${version}"
marker_html="<!-- ${marker} -->"

# Dedup by an exact body marker, matched CLIENT-side: GitHub search
# tokenizes the colon out of the marker, so a search-based lookup
# never finds the issues this job files.
issues_file="${RUNNER_TEMP}/open-issues.json"
gh issue list \
  --repo "${REPO}" \
  --state open \
  --label "${DEDUP_LABEL}" \
  --json number,body \
  --limit 200 \
  > "${issues_file}"
existing="$(
  jq -r --arg marker_html "${marker_html}" \
    '.[] | select(.body | contains($marker_html)) | .number' \
    "${issues_file}" \
  | head -n 1
)"

body_file="${RUNNER_TEMP}/image-build-failure.md"
{
  printf '%s\n' "${marker_html}"
  printf '\n'
  printf 'The sandbox image build for release `%s` failed, so `ghcr.io/qwenlm/qwen-code:%s` was **not published**.\n' "${version}" "${version}"
  printf '\n'
  printf 'Until the image exists, every sandbox-based CI lane (`/resolve`, sandboxed review, autofix) crashes with `manifest unknown` when it installs the matching npm version.\n'
  printf '\n'
  printf 'Failed run: %s\n' "${RUN_URL}"
  printf '\n'
  printf 'Fix: rerun the failed jobs of the run above (transient buildx races such as `ETXTBSY` usually pass on retry), or dispatch `Build and Publish Docker Image` with `version=%s`, `publish=true`.\n' "${version}"
} > "${body_file}"

if [[ -n "${existing}" ]]; then
  gh issue edit "${existing}" \
    --repo "${REPO}" \
    --body-file "${body_file}"
  echo "Recorded this failure on issue #${existing}."
  exit 0
fi

gh issue create \
  --repo "${REPO}" \
  --title "Sandbox image for ${version} not published: image build failed" \
  --body-file "${body_file}" \
  --label 'type/bug' \
  --label "${DEDUP_LABEL}"
