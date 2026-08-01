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
  if ! run_candidate npm run test --workspace packages/web-shell -- \
    client/components/messages/toolFormatting.drift.test.ts; then
    echo '❌ Web Shell tool-display contract verification failed.'
    fail
  fi
fi
