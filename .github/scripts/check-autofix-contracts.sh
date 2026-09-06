#!/usr/bin/env bash
set -uo pipefail

fail() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
}

changed_files="$(cat)"

if ! npm run check-i18n; then
  echo '❌ i18n verification failed.'
  fail
fi

if grep -Fxq 'packages/core/src/tools/tool-names.ts' <<< "${changed_files}"; then
  # Extra vitest flags from the caller. web-shell's vitest config sets no
  # timeouts and has no RUNNER_NAME branch, so without caller flags this
  # drift test runs at vitest's 5s default wherever it runs. The review
  # gate launches it on a saturating shared host and passes its load
  # clamps through this variable; the issue-fix gate and repo-hygiene's
  # docker leg call this script without it and accept the 5s default.
  read -r -a vitest_flags <<< "${AUTOFIX_VITEST_FLAGS:-}"
  if ! npm run test --workspace packages/web-shell -- \
    ${vitest_flags[@]+"${vitest_flags[@]}"} \
    client/components/messages/toolFormatting.drift.test.ts; then
    echo '❌ Web Shell tool-display contract verification failed.'
    fail
  fi
fi
