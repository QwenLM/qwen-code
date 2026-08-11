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

# Autofix rejects changes to the committed schema and to a best-effort
# snapshot of the sources that feed it (the protected-path allowlist in
# validate-autofix-verification-outputs.mjs) before this gate runs; the
# snapshot is hand-curated, and the normal schema gate still runs on the
# published PR. Executing the candidate's schema module graph here would let
# module initialization short-circuit the trusted comparison.
# TODO: run-autofix-review-verification.sh still executes the generator
# on candidate code without this wrapper or the protected-path allowlist; the
# review-address chain was scoped out of the targeted E2E redesign and needs
# the same isolation before its schema gate is trusted the same way.
if [[ -n "${AUTOFIX_VERIFY_COMMAND:-}" ]]; then
  echo 'Skipping settings-schema freshness check: Autofix rejects changes to the committed schema and its protected sources before this gate runs.'
  exit 0
else
  # Guard the generator itself: if it CRASHES (e.g. a type error introduced in
  # the schema source), report an explicit gate failure.
  if ! npm run generate:settings-schema; then
    echo "❌ Settings schema generator failed to run."
    fail
  fi
  if ! schema_status="$(git status --porcelain "${SCHEMA_FILE}")"; then
    echo "❌ Failed to inspect ${SCHEMA_FILE} after generation."
    fail
  fi
  if [[ -n "${schema_status}" ]]; then
    echo "❌ ${SCHEMA_FILE} is out of date. Run: npm run generate:settings-schema"
    git --no-pager diff -- "${SCHEMA_FILE}" || true
    git checkout -- "${SCHEMA_FILE}" || true
    fail
  fi
fi
