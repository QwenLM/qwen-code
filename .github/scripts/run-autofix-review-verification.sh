#!/usr/bin/env bash
set -eo pipefail

# Invoked as a child `bash` from the review-address verify step; inherits its
# environment from the caller. WORKDIR and BRANCH are job-level env;
# GITHUB_OUTPUT and RUNNER_TEMP are runner-provided. None is defined here.

# Deterministic verification must not read the RUNNER's git config: the
# persistent pool accumulates state, and a leaked global exec knob fails
# branch tests the branch never caused. Measured counterexample, run
# 31516789251: a stray `diff.external=global-driver` in the runner user's
# ~/.gitconfig killed four per-hunk probe tests in packages/cli on #8613 —
# charged to the round (package tests are A/B-exempt), which burned the
# 18-minute repair on a failure no repair can reach and ended the round as
# a timeout. Every git this script or its checks spawn (vitest fixture
# repos included) reads a per-run throwaway global config instead — seeded
# with the workspace safe.directory actions/checkout put in the real one —
# and no system config — any system-level git setting the checks ever
# come to depend on (a CA bundle, a proxy) must be replicated via per-job
# env, not /etc/gitconfig, because the redirect silently drops it. The
# redirect also keeps a branch-authored `git config --global` from writing
# durable state onto the host: it lands in the throwaway file and dies
# with the run. Enforcement is inherited-env only — branch code writing
# the real file directly bypasses it, which is why the PAT-bearing steps
# re-run resanitize-git-config.sh afterwards.
# Environment-carried config outranks BOTH file redirects and defeats
# every file-level guard: GIT_CONFIG_COUNT/_PARAMETERS carry config at
# command-line precedence, GIT_SSL_* / GIT_PROXY_COMMAND steer transport,
# GIT_EXEC_PATH swaps the transport-helper binary, GIT_DIR/GIT_WORK_TREE
# repoint git, GIT_ASKPASS/GIT_SSH* hijack auth/exec — branch code in an
# earlier step can inject any of them through $GITHUB_ENV. Strip them, then
# redirect the file scopes. Keep this env+redirect block equal to the
# issue-fix gate's copy (the contract test pins them).
unset GIT_CONFIG_PARAMETERS GIT_ALLOW_PROTOCOL GIT_PROXY_COMMAND \
  GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_EXEC_PATH GIT_DIR \
  GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_SHALLOW_FILE \
  GIT_ASKPASS GIT_SSH GIT_SSH_COMMAND
export GIT_CONFIG_COUNT=0
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL="${RUNNER_TEMP}/autofix-gate-gitconfig"
: > "${GIT_CONFIG_GLOBAL}"
git config --file "${GIT_CONFIG_GLOBAL}" safe.directory "$(pwd)"
if [ -s /etc/gitconfig ]; then
  echo "::notice::/etc/gitconfig exists but is bypassed by the gate's GIT_CONFIG_SYSTEM redirect — replicate any setting the checks need via per-job env."
fi

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
  local retryable="${3:-true}"
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
  elif [[ "${retryable}" == 'true' ]]; then
    echo "retryable=true" >> "${GITHUB_OUTPUT}"
  fi
  # The evidence tail flexes so the WHOLE document stays under the report
  # step's head -c 3900 render cap: truncating the finished document from
  # the outside cuts the closing fence and malforms everything after it in
  # the posted comment. Budget = 3300 minus the preamble, floored at 500.
  local preamble tail_budget
  preamble="**${label}**"
  if [[ "${preexisting}" == 'true' ]]; then
    # shellcheck disable=SC2016
    preamble+="$(printf '\n\nMeasured fact: the same check also fails at `origin/%s` (the branch as pushed, before this round) in this environment, with a matching failure signature. The repair pass may only amend the round'"'"'s own fix, so it cannot reach this failure. If the branch is behind `main`, a base update (merge main) is the usual cure; otherwise the failure lives in the branch'"'"'s own pre-round commits.' "${BRANCH}")"
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
  # No round commit (the core-rebuild check runs before the commit gate and
  # is A/B-eligible) — the baseline IS the tree under test; nothing to
  # compare.
  [[ "${baseline}" != "${current}" ]] || return 1
  # The head transcript is already complete, and an empty head signature
  # fails closed regardless of what the baseline would say — so decide it
  # BEFORE paying the detach + full re-run + restore for a verdict that was
  # never in question (esbuild/vite/crash failures, the KNOWN LIMIT class).
  local sig_head
  sig_head="$(fail_signature "${GATE_LOG}.check")" || true
  if [[ -z "${sig_head}" ]]; then
    echo "🔁 no failure identity in the head transcript — charged to the round" \
      | tee -a "${GATE_LOG}"
    return 1
  fi
  echo "🔁 Baseline A/B: re-running the failed check at origin/${BRANCH}" \
    "(${baseline})" | tee -a "${GATE_LOG}"
  # The build under test may have REWRITTEN tracked artifacts (the vscode
  # companion settings schema is regenerated by scripts/build.js): discard
  # build dirt or the checkout refuses and a real verdict degrades into the
  # restore-failure crash below. Tracked-only, and the tree was asserted
  # clean before the deterministic checks — anything here is build output.
  git restore -- . 2>> "${GATE_LOG}" || true
  git checkout --quiet --detach "${baseline}" 2>> "${GATE_LOG}" || return 1
  # The baseline transcript goes to a SIDE log: gate-rejection.md renders
  # the dynamic `tail_budget` tail of GATE_LOG as the evidence window, and
  # on a green baseline a chatty success transcript would fill it and push the actual
  # failure text out — misdirecting the repair agent, the PR comment, and
  # the next round's LAST_REJECTION block all at once.
  local ab_log="${GATE_LOG}.baseline"
  : > "${ab_log}"
  rc=0
  if ! "$@" >> "${ab_log}" 2>&1; then
    rc=1
  fi
  git restore -- . 2>> "${GATE_LOG}" || true
  if ! git checkout --quiet "${BRANCH}" 2>> "${GATE_LOG}"; then
    # The tree is no longer the one under verification and nothing after
    # this point may trust it — including the repair agent (its commit would
    # orphan on the detached baseline). But a transient git-state failure is
    # NOT a verdict about the failure's origin, and a plain outcome=failed
    # is an EVALUATED rejection: the watermark advances and the item is
    # handed off for good. Leave outcome UNSET so the report's gate-crashed
    # path retries on the next scan's fresh checkout — and write the detail
    # document so the crash comment still explains itself.
    echo "❌ could not restore the verification tree after the baseline check"
    {
      echo '**could not restore the verification tree after the baseline check**'
      echo
      echo '````'
      tail -c 3000 "${GATE_LOG}" 2> /dev/null
      echo '````'
    } > "${WORKDIR}/gate-rejection.md" || true
    exit 1
  fi
  # Every retryable exit below hands the tree to the repair agent with
  # dist/ REBUILT FROM BASELINE SOURCES (the restore checkout brings back
  # tracked files only) — the mirror of the dist confound that exempted
  # typecheck from the A/B. seed_dist_note seeds the repair feedback so
  # the agent rebuilds before it trusts any dist-consuming check. The
  # pre-existing exit is the exception: no repair runs for it, so the
  # note stays out of its document.
  if [[ "${rc}" -ne 1 ]]; then
    seed_dist_note
    echo "🔁 baseline is green — the failure belongs to this round" \
      | tee -a "${GATE_LOG}"
    return 1
  fi
  # A nonzero baseline is NOT enough: the branch can fail there for reason A
  # while the round fails for reason B, and an infrastructure hiccup in the
  # baseline leg is a nonzero exit too. Pre-existing requires the round's
  # failing signatures to be a SUBSET of the baseline's — compiler
  # diagnostics normalized to file + error code + message (line/column shift
  # with the round's edits): a round that ADDS a diagnostic charges the
  # failure to the round even when it also shares baseline diagnostics. The
  # difference is captured before testing — piping `comm` into `grep -q`
  # exits `grep` at the first match and SIGPIPEs `comm` under pipefail once
  # the shared output outruns the pipe buffer, flipping identical large
  # failure sets to NO-MATCH. No diagnostics on either side means identity
  # cannot be established, and the rejection stays charged to the round
  # (fail closed).
  local sig_base new_in_round
  # `|| true`: grep exits 1 on the NORMAL no-match case, and these
  # assignments only survive `set -e` today because this function is called
  # from an `if` condition (which suspends errexit). A future unconditional
  # call site would otherwise turn the documented fail-closed path into a
  # verdict-less gate crash.
  # (sig_head was extracted before the detach.)
  sig_base="$(fail_signature "${ab_log}")" || true
  new_in_round="$(comm -23 <(printf '%s\n' "${sig_head}") <(printf '%s\n' "${sig_base}"))" || {
    seed_dist_note
    echo "🔁 signature comparison failed — fail-closed, charged to the round" \
      | tee -a "${GATE_LOG}"
    return 1
  }
  if [[ -z "${sig_head}" || -z "${sig_base}" ]] || [[ -n "${new_in_round}" ]]; then
    seed_dist_note
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
  # position stripped but the MESSAGE kept ("src/a.ts: error TS2504: …").
  # Position strips because line/column shift with the round's edits; the
  # message stays because file + code alone collide — two unrelated defects
  # in one file sharing a common code (TS2339 is everywhere) would compare
  # as "the same failure" and skip a repair that could have worked. A
  # message naming a round-renamed identifier then under-matches — the
  # fail-closed direction. Sorted unique so two transcripts compare with
  # comm(1). KNOWN LIMIT: only tsc diagnostics carry identity; vite/esbuild
  # failures yield an empty signature and deliberately fail closed (charged
  # to the round) — widening needs their position formats normalized first.
  grep -oE "[^ '\"]+\([0-9]+,[0-9]+\): error TS[0-9]+.*" "${1}" 2> /dev/null \
    | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u
}
# The one emit point for the dist-rebuild steering note — every retryable
# exit of baseline_also_fails after the baseline leg calls this, so the
# guidance cannot drift across exits.
seed_dist_note() {
  echo "⚠️ the baseline leg rebuilt dist/ from baseline sources — run npm run build before typecheck/tests" >> "${GATE_LOG}"
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
