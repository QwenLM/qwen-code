#!/usr/bin/env bash
# Settings-schema freshness gate, shared by the qwen-autofix verify steps
# (.github/workflows/qwen-autofix.yml) so the two gates cannot drift apart.
#
# Mirrors CI's "Check settings schema is up-to-date" step EXACTLY: regenerate,
# then fail if the committed artifact changed. Uses regenerate +
# `git status --porcelain` (NOT the generator's --check, which was reverted
# from main by #7031 — after merge this runs against main's generator, which
# ignores args and would make --check fail-open). Stale schemas are invisible
# to build/typecheck/lint/vitest.
#
# On failure: prints the diff, restores the schema file, writes
# `outcome=failed` to $GITHUB_OUTPUT (when set, matching the calling step's
# contract), and exits 1.
set -uo pipefail

SCHEMA_FILE='packages/vscode-ide-companion/schemas/settings.schema.json'

fail() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
}

# Guard the generator itself: if it CRASHES (e.g. a type error the agent
# introduced in the schema source), a caller running under set -eo pipefail
# would abort before outcome=failed is written, leaving OUTCOME unset. Handle
# it here so the failure is explicit, not inferred from job.status.
if ! npm run generate:settings-schema; then
  echo "❌ Settings schema generator failed to run."
  fail
fi

if [[ -n "$(git status --porcelain "${SCHEMA_FILE}")" ]]; then
  echo "❌ ${SCHEMA_FILE} is out of date. Run: npm run generate:settings-schema"
  git --no-pager diff -- "${SCHEMA_FILE}" || true
  git checkout -- "${SCHEMA_FILE}" || true
  fail
fi
