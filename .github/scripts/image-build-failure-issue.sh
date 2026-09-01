#!/usr/bin/env bash
# File (or update) one issue per version when the sandbox image build job
# fails. The job gate is the WHOLE build job — checkout, version processing,
# QEMU/buildx setup, metadata extraction, registry login, or either build
# step — so the wording below must not assert which step failed.
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

# Dedup by an exact body marker. The lookup is shared with the sibling
# reporter that files into the same `scope/ci-cd` label space — see
# find-marked-issue.sh for why the marker is matched client-side, why a
# null body cannot abort the lookup, and why the listing is a ceiling
# rather than a newest-first window.
existing="$(
  MARKER_HTML="${marker_html}" \
    bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"
)"

# The machine-owned recurrence block: every recorded failed run is a bullet
# under this marker, newest first. On recurrence ONLY this block is rebuilt —
# hand-written annotations anywhere else in the body survive verbatim. This is
# the same merge contract splitOccurrenceBlock()/renderIssueBody() in
# .github/scripts/ci/main-failure-signature.mjs implements for
# main-ci-failure-issue.yml; a fix to one must be applied to the other.
runs_heading='## Failed runs'
occurrences_marker='<!-- image-build-failure-occurrences -->'
max_runs=10

body_file="${RUNNER_TEMP}/image-build-failure.md"
head_file="${RUNNER_TEMP}/body-head.md"
runs_file="${RUNNER_TEMP}/body-runs.txt"

# The backticks in these formats are literal markdown, not command
# substitution, so shellcheck's SC2016 expansion warning is disabled.
# shellcheck disable=SC2016
write_prose() {
  printf '%s\n' "${marker_html}"
  printf '\n'
  printf 'The release build job for `%s` failed before `ghcr.io/qwenlm/qwen-code:%s` could be published.\n' "${version}" "${version}"
  printf '\n'
  printf 'Until the image exists, every sandbox-based CI lane (`/resolve`, sandboxed review, autofix) crashes with `manifest unknown` when it installs the matching npm version.\n'
  printf '\n'
  printf 'Open the newest run below to see which step failed, then rerun the failed jobs (transient failures — for example buildx `ETXTBSY` races during the build steps — usually pass on retry), or dispatch `Build and Publish Docker Image` with `version=%s`, `publish=true`.\n' "${version}"
}

write_body() {
  {
    cat "${head_file}"
    printf '\n%s\n\n%s\n' "${runs_heading}" "${occurrences_marker}"
    cat "${runs_file}"
  } > "${body_file}"
}

if [[ -z "${existing}" ]]; then
  write_prose > "${head_file}"
  printf -- '- %s\n' "${RUN_URL}" > "${runs_file}"
  write_body
  gh issue create \
    --repo "${REPO}" \
    --title "Sandbox image for ${version} not published: release build job failed" \
    --body-file "${body_file}" \
    --label 'type/bug' \
    --label "${DEDUP_LABEL}"
  exit 0
fi

# Recurrence: re-plan against the existing body instead of overwriting it.
existing_body="${RUNNER_TEMP}/existing-body.md"
gh issue view "${existing}" \
  --repo "${REPO}" \
  --json body \
  --jq '.body' > "${existing_body}"

tail_file="${RUNNER_TEMP}/body-tail.md"
: > "${head_file}"
: > "${runs_file}"
: > "${tail_file}"
# Split head / recorded runs / tail around the occurrences marker. Anything
# that is not a recorded-run bullet below the marker was written by a human;
# it lands in the tail and is re-emitted with the head prose.
awk -v marker="${occurrences_marker}" \
    -v head_f="${head_file}" -v runs_f="${runs_file}" -v tail_f="${tail_file}" '
  BEGIN { state = "head" }
  state == "head" {
    if ($0 == marker) { state = "runs"; next }
    print > head_f
    next
  }
  state == "runs" {
    line = $0
    sub(/^[ \t]+/, "", line)
    sub(/[ \t]+$/, "", line)
    if (line == "") next
    if (line ~ /^- https:\/\/[^ ]+\/actions\/runs\/[0-9]+$/) { print > runs_f; next }
    state = "tail"
  }
  state == "tail" { print > tail_f; next }
' "${existing_body}"

# Drop trailing blank lines, and a stranded heading left behind if the
# occurrences marker line was edited away — the rebuilt block re-emits
# both. sed, not `head -n -1`: BSD head rejects negative line counts.
printf '%s\n' "$(cat "${head_file}")" > "${head_file}"
if [[ "$(tail -n 1 "${head_file}")" == "${runs_heading}" ]]; then
  printf '%s\n' "$(sed '$d' "${head_file}")" > "${head_file}"
fi
# Re-check AFTER the strip, which can itself empty the head: fall back to
# the generated prose so the narrative (and the dedup marker it carries)
# is never lost.
if [[ -z "$(cat "${head_file}")" ]]; then
  write_prose > "${head_file}"
fi

if [[ -s "${tail_file}" ]]; then
  printf '\n' >> "${head_file}"
  cat "${tail_file}" >> "${head_file}"
fi

# Newest first; a re-run of the same run must not add a second line for it.
# awk (not head) applies the cap so the pipeline never dies on SIGPIPE.
{ printf -- '- %s\n' "${RUN_URL}"; cat "${runs_file}"; } \
  | awk -v max="${max_runs}" '!seen[$0]++ && ++n <= max' \
  > "${runs_file}.merged"
mv "${runs_file}.merged" "${runs_file}"

write_body
gh issue edit "${existing}" \
  --repo "${REPO}" \
  --body-file "${body_file}"
echo "Recorded this failure on issue #${existing}."
