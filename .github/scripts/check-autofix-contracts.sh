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
  # Extra vitest flags from the caller. The review gate runs this inside an
  # env -i child that drops RUNNER_NAME, so the ECS load clamps deactivate
  # and this would run at vitest's 5s default on a saturating shared host;
  # it passes its own clamps here. The issue-fix gate runs where
  # RUNNER_NAME is present and leaves the variable empty.
  read -r -a vitest_flags <<< "${AUTOFIX_VITEST_FLAGS:-}"
  if ! npm run test --workspace packages/web-shell -- \
    ${vitest_flags[@]+"${vitest_flags[@]}"} \
    client/components/messages/toolFormatting.drift.test.ts; then
    echo '❌ Web Shell tool-display contract verification failed.'
    fail
  fi
fi
