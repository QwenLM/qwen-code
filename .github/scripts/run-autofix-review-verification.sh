#!/usr/bin/env bash
set -eo pipefail

# Record whether the agent left a commit FIRST — this is a ref-only
# diff, so it runs before the failure.md early-exits and covers an
# agent that commits and then aborts. The failure handoff keys its
# "was NOT pushed / commit discarded" wording on this, NOT on
# outcome=failed: abort / pre-commit-gate paths that never committed
# keep the neutral framing. `git diff --quiet` exits 1 for a real diff
# (committed) but 128 on a bad ref — only 1 counts as a commit, so a
# git error is not misreported as a discarded commit.
committed_rc=0
git diff --quiet "origin/${BRANCH}...${BRANCH}" || committed_rc=$?
if [[ "${committed_rc}" -eq 1 ]]; then
  echo "committed=true" >> "${GITHUB_OUTPUT}"
fi

if [[ -f "${WORKDIR}/failure.md" && -n "$(git status --porcelain)" ]]; then
  echo "❌ Agent wrote failure.md after leaving a dirty workspace:"
  git status --short
  cat "${WORKDIR}/failure.md"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  exit 1
fi

if [[ -f "${WORKDIR}/failure.md" ]]; then
  echo "🛑 Agent aborted intentionally:"
  cat "${WORKDIR}/failure.md"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  exit 1
fi

# Convention: hooks are severed at EVERY host checkout of the PR
# branch (no secret sits in this step's env, but a post-checkout
# hook still runs branch code on the host).
git config core.hooksPath /dev/null
git checkout "${BRANCH}"

# Settings-schema freshness is a STRUCTURAL guard, checked BEFORE the
# no-op/unchanged return: on a stale-schema PR the agent can wrongly
# write no-action.md, and without this the no-op path would report the
# feedback as evaluated (acted=false) while CI stays red — the exact bug
# this PR fixes. So it runs on EVERY path. The gate is shared with the
# issue-fix verify step (rationale + the generator crash guard live in
# the script); the write is on a tracked file compared by `git status`,
# not the commit-level no-op git-diff below, and it is restored on
# failure. On failure it writes outcome=failed and exits 1.
# Run the copy staged from the trusted base checkout: a PR branch
# that predates the script does not contain it (bash would exit 127
# and kill the gate with no outcome), and the gate logic must come
# from the trusted base, not the branch under verification.
bash "${RUNNER_TEMP}/check-settings-schema.sh"
git diff --name-only "origin/main...${BRANCH}" \
  | bash "${RUNNER_TEMP}/check-autofix-contracts.sh"

if git diff --quiet "origin/${BRANCH}...${BRANCH}"; then
  # No new commit. That is only legitimate as a deliberate no-action.
  if [[ -s "${WORKDIR}/no-action.md" ]]; then
    echo "🟰 No action needed:"
    cat "${WORKDIR}/no-action.md"
    echo "outcome=noop" >> "${GITHUB_OUTPUT}"
    exit 0
  fi
  echo "❌ Branch unchanged and no no-action.md — agent produced nothing"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  exit 1
fi

if [[ ! -s "${WORKDIR}/address-summary.md" ]]; then
  echo "❌ Branch changed but address-summary.md is missing"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  exit 1
fi

# Every check below can legitimately REJECT the agent's attempt, so
# each declares that verdict explicitly. That is what lets the handoff
# tell a rejection apart from the gate's OWN death: an empty outcome
# on a failed job means the gate never reached a verdict (its own bug,
# an infra blip), and the agent's work must then be retried rather
# than buried by a watermark advance.
# Capture each check's output. A rejection has to tell the agent WHY
# its change was refused: without that, the next round re-reads only
# the original review feedback and re-makes the same mistake - #7208
# was handed to a human over a two-character TS4111 fix its own
# compiler output already spelled out.
GATE_LOG="${WORKDIR}/gate-output.log"
: > "${GATE_LOG}"
reject_fix() {
  echo "❌ ${1}"
  # Declare the verdict FIRST. The handoff routes on outcome=, and an
  # empty outcome on a failed job means "the gate never reached a
  # verdict" — i.e. a crash, which is RETRIED. So a rejection that
  # dies while writing its detail file would be re-attempted forever
  # instead of reported once. A detail we cannot write is a degraded
  # message; it must never cost the verdict, hence this order and the
  # non-fatal write below.
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  {
    echo "**${1}**"
    echo
    # A four-backtick fence cannot be closed by a ``` line, so
    # captured output containing its own fences stays inside the
    # block when this is posted verbatim as a PR comment.
    echo '````'
    tail -c 3000 "${GATE_LOG}" 2> /dev/null
    echo '````'
  } > "${WORKDIR}/gate-rejection.md" ||
    echo "::warning::could not write the gate rejection detail; the verdict stands."
  exit 1
}
run_check() {
  # pipefail makes the pipeline carry the command's status, not tee's.
  local label="${1}"
  shift
  if ! "$@" 2>&1 | tee -a "${GATE_LOG}"; then
    reject_fix "${label}"
  fi
}

echo '🔬 Re-running deterministic checks (independent of the agent)...'
run_check 'build failed on the agent-committed fix' npm run build
run_check 'typecheck failed on the agent-committed fix' npm run typecheck
run_check 'lint failed on the agent-committed fix' npm run lint

# Test changed/related files for the packages this PR touches.
# --changed follows the import graph so transitive breakage is caught.
# Full regression is covered by regular CI on the PR after the push.
# Map each changed file to its OWNING npm workspace via the trusted
# staged resolver, shared with the other verify gate so both resolve
# packages identically. It expands the on-disk root package.json
# workspaces globs (so a workspace the branch ADDS is included) and
# takes each file's longest-prefix workspace — never a flat
# 'packages/<dir>' (ENOENT-crashes on nested packages) nor a fixture
# package.json inside a workspace's src tree (would skip the owning
# workspace's tests). No '|| true': a resolver error (missing node, an
# unreadable manifest) must fail the gate loudly rather than silently
# skip package tests; legitimate no-match input already exits 0 empty.
CHANGED_PKGS="$(git diff --name-only "origin/main...${BRANCH}" \
  | bash "${RUNNER_TEMP}/resolve-owning-packages.sh")"
if [[ -z "${CHANGED_PKGS}" ]]; then
  echo 'No package changes detected; skipping package tests.'
else
  for p in ${CHANGED_PKGS}; do
    if [[ ! -f "${p}/package.json" ]]; then
      echo "Skipping ${p}: no package.json."
      continue
    fi
    test_script="$(node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.scripts?.test || "");' "${p}/package.json")"
    if [[ "${test_script}" != *vitest* ]]; then
      echo "Skipping ${p}: test script is not Vitest."
      continue
    fi
    echo "🧪 Testing ${p} (changed files only)..."
    run_check "tests failed in ${p}" \
      npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests
  done
fi
echo "outcome=fixed" >> "${GITHUB_OUTPUT}"
