#!/usr/bin/env bash
set -eo pipefail

# Invoked as a child `bash` from the review-address verify step; inherits its
# environment from the caller. WORKDIR and BRANCH are job-level env;
# GITHUB_OUTPUT and RUNNER_TEMP are runner-provided. None is defined here.

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

GATE_LOG="${WORKDIR}/gate-output.log"
: > "${GATE_LOG}"
reject_fix() {
  local label="${1}"
  local preexisting="${2:-false}"
  echo "❌ ${label}"
  # Declare the verdict before writing its detail. An empty outcome on a failed
  # step means the gate itself crashed, so losing the detail file must not turn
  # a deterministic rejection into an infrastructure retry.
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  if [[ "${preexisting}" == 'true' ]]; then
    # NOT retryable: the repair agent is only allowed to amend this round's
    # fix, and a failure that exists without the fix is outside that boundary
    # by definition — the 18-minute repair budget cannot reach it. The remedy
    # is a base update (merge main into the branch), not a repair.
    echo "preexisting=true" >> "${GITHUB_OUTPUT}"
  else
    echo "retryable=true" >> "${GITHUB_OUTPUT}"
  fi
  # The evidence tail flexes so the WHOLE document stays under the report
  # step's head -c 3900 render cap: truncating the finished document from
  # the outside cuts the closing fence and malforms everything after it in
  # the posted comment. Budget = 3300 minus the preamble, floored at 500.
  local preamble tail_budget
  preamble="**${label}**"
  if [[ "${preexisting}" == 'true' ]]; then
    preamble+="$(printf '\n\nMeasured fact: the same check also fails at \`origin/%s\` (the branch as pushed, before this round) in this environment, with a matching failure signature. The repair pass was skipped because it may only amend the round'"'"'s own fix. If the branch is behind \`main\`, a base update (merge main) is the usual cure; otherwise the failure lives in the branch'"'"'s own pre-round commits.' "${BRANCH}")"
  fi
  tail_budget=$(( 3300 - ${#preamble} ))
  (( tail_budget < 500 )) && tail_budget=500
  {
    printf '%s\n' "${preamble}"
    echo
    # Captured output can contain triple-backtick fences.
    echo '````'
    tail -c "${tail_budget}" "${GATE_LOG}" 2> /dev/null
    echo '````'
  } > "${WORKDIR}/gate-rejection.md" ||
    echo "::warning::could not write the gate rejection detail; the verdict stands."
  exit 1
}
baseline_also_fails() {
  # A deterministic rejection is only chargeable to this round if the same
  # check passes WITHOUT the round's commits. Measured counterexample, run
  # 31276008548: PR #8614's branch predated #8693's tsconfig guard while
  # node_modules came from the post-#8693 trusted base, so `npm run build`
  # was just as red at origin/<branch> — 63 minutes of accepted agent work
  # were discarded and an 18-minute repair burned on a failure the repair
  # agent is forbidden to touch, thirteen rounds in a row.
  # Returns 0 (pre-existing) only when the SAME command demonstrably fails
  # at the pre-round ref; any A/B infrastructure problem returns 1 so the
  # rejection keeps today's semantics (fail closed toward "charge the fix").
  local current baseline rc
  current="$(git rev-parse HEAD)" || return 1
  baseline="$(git rev-parse --quiet --verify "origin/${BRANCH}^{commit}")" ||
    return 1
  # No round commit (schema/contract checks run before the commit gate) —
  # the baseline IS the tree under test; nothing to compare.
  [[ "${baseline}" != "${current}" ]] || return 1
  echo "🔁 Baseline A/B: re-running the failed check at origin/${BRANCH}" \
    "(${baseline})" | tee -a "${GATE_LOG}"
  git checkout --quiet --detach "${baseline}" 2>> "${GATE_LOG}" || return 1
  # The baseline transcript goes to a SIDE log: gate-rejection.md renders
  # `tail -c 3000` of GATE_LOG as the evidence window, and on a green
  # baseline a chatty success transcript would fill it and push the actual
  # failure text out — misdirecting the repair agent, the PR comment, and
  # the next round's LAST_REJECTION block all at once.
  local ab_log="${GATE_LOG}.baseline"
  : > "${ab_log}"
  rc=0
  if ! "$@" >> "${ab_log}" 2>&1; then
    rc=1
  fi
  if ! git checkout --quiet "${BRANCH}" 2>> "${GATE_LOG}"; then
    # The tree is no longer the one under verification and nothing after
    # this point may trust it.
    reject_fix 'could not restore the verification tree after the baseline check'
  fi
  if [[ "${rc}" -ne 1 ]]; then
    echo "🔁 baseline is green — the failure belongs to this round" \
      | tee -a "${GATE_LOG}"
    return 1
  fi
  # A nonzero baseline is NOT enough: the branch can fail there for reason A
  # while the round fails for reason B, and an infrastructure hiccup in the
  # baseline leg is a nonzero exit too. Pre-existing requires the SAME
  # failure identity on both legs — compiler diagnostics normalized to
  # file + error code (line/column shift with the round's edits). No
  # diagnostics on either side means identity cannot be established, and
  # the rejection stays charged to the round (fail closed).
  local sig_head sig_base
  sig_head="$(fail_signature "${GATE_LOG}.check")"
  sig_base="$(fail_signature "${ab_log}")"
  if [[ -z "${sig_head}" || -z "${sig_base}" ]] ||
    ! comm -12 <(printf '%s\n' "${sig_head}") <(printf '%s\n' "${sig_base}") \
      | grep -q .; then
    echo "🔁 baseline fails for a DIFFERENT reason — charged to the round" \
      | tee -a "${GATE_LOG}"
    return 1
  fi
  # Only a FAILING baseline transcript with a matching signature is
  # evidence — merge its tail into the window, where it backs the label.
  tail -c 1500 "${ab_log}" >> "${GATE_LOG}" 2> /dev/null || true
  return 0
}
fail_signature() {
  # Stable identity of a failed check: tsc-style diagnostics with the
  # position stripped ("src/a.ts: error TS2504"). Sorted unique so two
  # transcripts compare with comm(1).
  grep -oE "[^ '\"]+\([0-9]+,[0-9]+\): error TS[0-9]+" "${1}" 2> /dev/null \
    | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u
}
run_check() {
  # pipefail makes the pipeline carry the command's status, not tee's. The
  # side copy holds THIS check's transcript alone — the identity comparison
  # must not match diagnostics an earlier check left in the shared log.
  local label="${1}"
  shift
  : > "${GATE_LOG}.check"
  if ! "$@" 2>&1 | tee -a "${GATE_LOG}" "${GATE_LOG}.check"; then
    if baseline_also_fails "$@"; then
      reject_fix "${label} (pre-existing: also fails without this round's commit)" 'true'
    fi
    reject_fix "${label}"
  fi
}
run_check_no_ab() {
  # A/B-exempt: for checks whose baseline re-run would compare a DIFFERENT
  # computation than the one that failed, so a baseline verdict proves
  # nothing. The contracts check consumes its file list from stdin, which
  # the first run drains — the baseline leg would re-check an empty list
  # and pass vacuously. The schema check reads packages/core/dist, which
  # the core-rebuild guard built from the ROUND's sources and which,
  # being gitignored, survives the detach and confounds the baseline. Their
  # rejections stay charged to the round — which is also where the repair
  # agent can actually act on them (generate:settings-schema is in its
  # allowlist).
  local label="${1}"
  shift
  if ! "$@" 2>&1 | tee -a "${GATE_LOG}"; then
    reject_fix "${label}"
  fi
}
assert_verification_tree() {
  if [[ "$(git rev-parse HEAD)" != "${VERIFICATION_HEAD}" ]]; then
    reject_fix 'HEAD changed during deterministic verification'
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short >> "${GATE_LOG}"
    reject_fix 'workspace became dirty during deterministic verification'
  fi
}

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >> "${GATE_LOG}"
  reject_fix 'workspace is dirty before deterministic verification'
fi
VERIFICATION_HEAD="$(git rev-parse HEAD)"

# The schema generator resolves '@qwen-code/qwen-code-core' to core's DIST
# entry point, which the CLI bundle restored from the TRUSTED BASE. When the
# branch itself changed core's sources, that base-built dist can disagree
# with the branch's committed schema (changed runtime constants) or crash
# the generator (changed exports) — the same false "settings schema is
# stale" rejection class this gate exists to prevent. Rebuild core from
# branch sources in that case: the gate already runs a full `npm run build`
# on branch sources for every commit path, so this widens no trust surface,
# and the build's git-ignored output cannot trip the dirty-tree asserts.
if git diff --name-only "origin/main...${BRANCH}" \
  | grep -Eq '^packages/core/(src/|index\.ts$)'; then
  run_check 'core rebuild failed on the agent-committed fix' \
    npm run build --workspace packages/core
fi

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
run_check_no_ab 'settings schema is stale on the agent-committed fix' \
  bash "${RUNNER_TEMP}/check-settings-schema.sh"
CHANGED_FILES="$(git diff --name-only "origin/main...${BRANCH}")"
run_check_no_ab 'cross-package contract verification failed' \
  bash "${RUNNER_TEMP}/check-autofix-contracts.sh" <<< "${CHANGED_FILES}"
assert_verification_tree

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

echo '🔬 Re-running deterministic checks (independent of the agent)...'
run_check 'build failed on the agent-committed fix' npm run build
# Typecheck consumes core's dist (sdk-typescript resolves
# @qwen-code/qwen-code-core through the package exports to ./dist/*.d.ts),
# and dist is gitignored — it survives the baseline detach carrying the
# ROUND's build, so a baseline typecheck would run reverted sources against
# round-built declarations. Probe-verified three-arm flip on this tree. Same
# class as the schema check: A/B-exempt.
run_check_no_ab 'typecheck failed on the agent-committed fix' npm run typecheck
run_check_no_ab 'lint failed on the agent-committed fix' npm run lint

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
    # A/B-exempt: package tests resolve sibling workspaces through their
    # dist exports (channels/github -> @qwen-code/channel-base/dist), and
    # dist survives the baseline detach carrying the ROUND's build — a
    # baseline leg would test reverted sources against round-built
    # dependencies. (A round-ADDED workspace also has no baseline at all:
    # npm exits 1 there with "No workspaces found".) Their rejections stay
    # charged to the round, where the repair agent can act.
    run_check_no_ab "tests failed in ${p}" \
      npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests
  done
fi
assert_verification_tree
echo "verified_head=${VERIFICATION_HEAD}" >> "${GITHUB_OUTPUT}"
echo "outcome=fixed" >> "${GITHUB_OUTPUT}"
