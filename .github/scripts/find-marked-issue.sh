#!/usr/bin/env bash
# Print the number of the open issue whose body carries ${MARKER_HTML}, or
# nothing when none does.
#
# Shared by the failure reporters that own one long-lived issue apiece —
# .github/scripts/image-build-failure-issue.sh and
# .github/scripts/ecs-fleet-update-failure-issue.sh. Both file into the same
# `scope/ci-cd` label space with the same marker contract, so the lookup lives
# in one place: a guard fixed in one copy and missed in the other makes the
# other start filing duplicate issues — the exact failure dedup exists to
# prevent — while its own suite stays green, because each suite pins only its
# own copy.
#
# Reads REPO, DEDUP_LABEL, MARKER_HTML and RUNNER_TEMP from the environment.
set -euo pipefail

# The marker is matched CLIENT-side, never through a search qualifier: GitHub
# search tokenizes a marker apart (the `:` in `image-build-failure:1.2.3`, the
# dashes in `ecs-fleet-update-failure`), so a search-based lookup never finds
# what these scripts file.
#
# The listing takes every open issue carrying the label rather than a page of
# them. `gh issue list` returns newest-created first, and a marker issue that
# is opened once and only ever commented on drifts toward the oldest slot
# while same-label issues keep being created; under the 200 cap this file used
# to carry, it eventually leaves the window, the lookup comes back empty, and
# the next failure silently files a duplicate. There are 41 open `scope/ci-cd`
# issues today, so the cap below is a ceiling, not a window.
issues_file="${RUNNER_TEMP}/open-issues.json"
gh issue list \
  --repo "${REPO}" \
  --state open \
  --label "${DEDUP_LABEL}" \
  --json number,body \
  --limit 1000 \
  > "${issues_file}"

# `.body // ""`: GitHub types an issue body as `string or null`, and jq's
# `contains()` errors out (exit 5) on null — one bodyless issue carrying the
# shared label would otherwise abort the caller before it files anything.
#
# `last(...)`, not `first(...)`: the listing is newest-first and the match is a
# substring, so an issue that merely QUOTES the marker — a bug report about one
# of these reporters, say — would otherwise outrank the canonical issue forever,
# and every recurrence would comment on (or, for the image-build caller, rewrite
# the body of) the wrong issue while the one operators subscribe to goes silent.
# The oldest open match is the one a reporter opened for itself. `last(...)`
# also keeps the whole selection inside jq, so no pipe can turn a match into a
# SIGPIPE under `pipefail`.
jq -r --arg marker_html "${MARKER_HTML}" \
  'last(.[] | select((.body // "") | contains($marker_html)) | .number) // empty' \
  "${issues_file}"
