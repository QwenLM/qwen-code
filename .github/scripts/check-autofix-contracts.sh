#!/usr/bin/env bash
set -uo pipefail

fail() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
}

changed_files="$(cat)"

run_candidate() {
  if [[ -n "${AUTOFIX_VERIFY_COMMAND:-}" ]]; then
    "${AUTOFIX_VERIFY_COMMAND}" "${GITHUB_WORKSPACE}" "$@"
  else
    "$@"
  fi
}

if ! run_candidate npm run check-i18n; then
  echo '❌ i18n verification failed.'
  fail
fi

if grep -Fxq 'packages/core/src/tools/tool-names.ts' <<< "${changed_files}"; then
  # Coverage and JUnit reporting stay off: the sealed issue verify job
  # audits every ignored artifact a gate leaves behind and rejects them.
  if ! run_candidate npm run test --workspace packages/web-shell -- \
    client/components/messages/toolFormatting.drift.test.ts \
    --coverage.enabled=false --reporter=default; then
    echo '❌ Web Shell tool-display contract verification failed.'
    fail
  fi
fi
