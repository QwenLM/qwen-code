#!/usr/bin/env bash
# Owning-package resolver, shared by the qwen-autofix verify steps
# (.github/workflows/qwen-autofix.yml) so the two gates cannot drift apart.
#
# Reads changed file paths on stdin (one per line, e.g. the output of
# `git diff --name-only`) and emits, sorted and unique on stdout, the OWNING
# package of each: the nearest ancestor directory under packages/ that
# contains a package.json.
#
# A flat `packages/<dir>` assumption is wrong for NESTED packages such as
# packages/channels/base — the container packages/channels has no
# package.json, so a caller that then reads `<dir>/package.json` would
# ENOENT-crash the whole verify gate. Paths outside packages/, and paths
# directly under packages/ with no owning package (e.g. a non-npm container
# like packages/sdk-python), resolve to nothing and are dropped.
#
# Staged to RUNNER_TEMP from the trusted base checkout (never the PR branch)
# alongside check-settings-schema.sh, and invoked with the repository as the
# working directory so the package.json probes hit the checked-out tree.
set -euo pipefail

while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  d="$(dirname "$f")"
  while [[ "$d" == packages/?* ]]; do
    if [[ -f "$d/package.json" ]]; then
      printf '%s\n' "$d"
      break
    fi
    d="$(dirname "$d")"
  done
done | sort -u
