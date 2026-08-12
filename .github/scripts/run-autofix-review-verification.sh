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

# --- Content-based validity checks -------------------------------------------
# Feedback validity is judged by CONTENT, never by AUTHOR: a maintainer's
# comment, the review bot's finding, and a model-drafted suggestion pasted by
# a human all drive the agent the same way, so the gate checks what the round
# DID, not who asked for it. Two deterministic checks below (sensitive-area
# footprint here, the bite check after the package tests) plus one advisory
# (test deletion). All three read only git state and run before/around the
# existing deterministic re-checks.

# Sensitive-area footprint: a review round must not EXPAND into CI or
# verification machinery the PR itself was never about — a single review
# comment (any author) must not be able to alter the loop's own guardrails.
# Judged by AREA CLASS, not file: a PR whose own pre-round diff already
# touches a class (an infra PR under takeover) keeps full freedom there;
# a round reaching into a class the PR never touched is rejected. Retryable:
# the repair pass can revert the offending files in a follow-up commit.
# `scripts` sections of workspace manifests are their own class because the
# gate's every command resolves through them (`npm run build/typecheck/
# lint/test`) — a scripts edit can hollow out the gate while every check
# "passes". Only root and first-level `packages/*/package.json` count:
# fixture manifests deeper in a src tree are ordinary test data.
sensitive_class_of() {
  # Prints the class name for a path, or nothing. Kept as one function so
  # the round scan and the PR-footprint scan cannot drift. Classes are
  # NARROW on purpose: a PR that only edits issue templates must not
  # thereby license rounds to rewrite workflows, so executable CI surface,
  # repo scripts, and passive .github metadata are separate capabilities.
  # scripts/tests/** is ordinary test code, not gate machinery — the gate
  # never executes it, and tooling PRs routinely grow tests there.
  local f="${1}"
  case "${f}" in
    .github/workflows/* | .github/actions/*) echo 'ci-workflows' ;;
    .github/scripts/*) echo 'ci-scripts' ;;
    .github/*) echo 'gh-metadata' ;;
    .husky/*) echo 'git-hooks' ;;
    scripts/tests/*) ;;
    # The transitive executable surface of the gate's own commands:
    # `npm run build/lint/…` resolve through manifests INTO these files,
    # and .npmrc steers what npm itself executes.
    scripts/*) echo 'repo-scripts' ;;
    .npmrc | .nvmrc) echo 'toolchain-config' ;;
    *) case "${f##*/}" in
      eslint.config.*) echo 'lint-config' ;;
      vitest.config.*) echo 'test-config' ;;
      tsconfig.json | tsconfig.*.json) echo 'ts-config' ;;
    esac ;;
  esac
}
manifest_scripts_changed() {
  # True when the scripts section of a root/workspace manifest differs
  # between the two refs. Missing file on either side reads as {}.
  local f="${1}" from="${2}" to="${3}" a b
  a="$(git show "${from}:${f}" 2> /dev/null | jq -cS '.scripts // {}' 2> /dev/null)" || a='{}'
  b="$(git show "${to}:${f}" 2> /dev/null | jq -cS '.scripts // {}' 2> /dev/null)" || b='{}'
  [[ "${a}" != "${b}" ]]
}
ROUND_RANGE="origin/${BRANCH}...${BRANCH}"
PR_RANGE="origin/main...origin/${BRANCH}"
ROUND_CLASSES=''
while IFS= read -r f; do
  [[ -n "${f}" ]] || continue
  c="$(sensitive_class_of "${f}")"
  if [[ -z "${c}" ]]; then
    case "${f}" in
      package.json | packages/*/package.json)
        [[ "${f}" == packages/*/*/* ]] && continue
        # A manifest the round ADDED (a new workspace) is the round's own
        # new surface, not a rewrite of commands the gate already ran —
        # only scripts edits to a manifest that existed pre-round count.
        git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null || continue
        manifest_scripts_changed "${f}" "origin/${BRANCH}" "${BRANCH}" &&
          c='manifest-scripts' ;;
    esac
  fi
  [[ -n "${c}" ]] && ROUND_CLASSES+="${c} ${f}"$'\n'
# -z --no-renames: NUL-delimited raw paths (a specially named file is not
# core.quotePath-mangled past the case patterns), and a rename decomposes
# into A+D so the VACATED sensitive path is classified too — moving a
# workflow out of .github/ is a removal of verification machinery.
done < <(git diff --name-only -z --no-renames "${ROUND_RANGE}" | tr '\0' '\n')
if [[ -n "${ROUND_CLASSES}" ]]; then
  PR_CLASSES=''
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    c="$(sensitive_class_of "${f}")"
    if [[ -z "${c}" ]]; then
      case "${f}" in
        package.json | packages/*/package.json)
          [[ "${f}" == packages/*/*/* ]] && continue
          manifest_scripts_changed "${f}" 'origin/main' "origin/${BRANCH}" &&
            c='manifest-scripts' ;;
      esac
    fi
    [[ -n "${c}" ]] && PR_CLASSES+="${c}"$'\n'
  done < <(git diff --name-only -z --no-renames "${PR_RANGE}" | tr '\0' '\n')
  VIOLATIONS="$(while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    cls="${line%% *}"
    grep -qx "${cls}" <<< "${PR_CLASSES}" || printf '%s\n' "${line}"
  done <<< "${ROUND_CLASSES}")"
  if [[ -n "${VIOLATIONS}" ]]; then
    {
      echo 'This round modified CI/verification machinery in area(s) the PR itself never touched:'
      printf '%s\n' "${VIOLATIONS}"
      echo 'Review feedback alone — from ANY author — cannot authorize changes to the loop'"'"'s own guardrails. Revert these files; if the feedback genuinely requires them, escalate it to a maintainer as an open question instead of implementing it.'
    } >> "${GATE_LOG}"
    reject_fix 'round expands into CI/verification machinery outside the PR footprint'
  fi
fi

# Test-deletion advisory: deleting or shrinking tests is sometimes right
# (the pinned behavior was wrong, or coverage is duplicated) and the agent
# is required to justify it in its summary — but the SURFACING must not be
# the agent's own prose. The gate writes its own advisory into the round
# report so a maintainer always sees exactly which tests disappeared,
# whoever suggested it.
TEST_PATHSPEC=(':(glob)**/*.test.*' ':(glob)**/*.spec.*' ':(glob)**/__snapshots__/**' ':(glob)integration-tests/**')
DELETED_TESTS="$(git diff --name-only --diff-filter=D "${ROUND_RANGE}" -- "${TEST_PATHSPEC[@]}")"
NET_TEST_LINES="$(git diff --numstat "${ROUND_RANGE}" -- "${TEST_PATHSPEC[@]}" |
  awk '{ if ($1 != "-") a += $1; if ($2 != "-") d += $2 } END { print a - d + 0 }')"
rm -f "${WORKDIR}/gate-advisories.md"
if [[ -n "${DELETED_TESTS}" || "${NET_TEST_LINES}" -le -25 ]]; then
  {
    echo '⚖️ **Gate advisory — test coverage shrank this round** (machine-measured, not agent-authored): '"net ${NET_TEST_LINES} test lines."
    if [[ -n "${DELETED_TESTS}" ]]; then
      echo
      echo 'Deleted test files:'
      # Filenames are branch-controlled bytes rendered inside a gate-authored
      # (trusted-voice) document: a backtick in a legal git filename would
      # close the code span and let the name forge "machine-measured" text.
      # Render through a conservative safe-character set; anything else
      # (backticks, newlines, control bytes) becomes '?'.
      while IFS= read -r f; do
        [[ -n "${f}" ]] && echo "- \`${f//[^A-Za-z0-9._\/ -]/?}\`"
      done <<< "${DELETED_TESTS}"
    fi
    echo
    echo 'The justification must be in the round summary above; a deletion is only sound when the pinned behavior itself was wrong (evidence shown) or the coverage demonstrably survives elsewhere. · 本轮测试覆盖净减少（门自动测量，非 agent 文本）；删除是否成立请对照上方轮次摘要中的理由——仅当被钉住的行为本身有误（需给出证据）或覆盖确有替代时才合理。'
  } > "${WORKDIR}/gate-advisories.md"
  echo '⚖️ test coverage shrank this round — advisory written for the report' | tee -a "${GATE_LOG}"
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

# Bite check: run this round's changed tests against the PRE-ROUND tree
# (origin/<branch> sources + the round's test files). If EVERY changed test
# also passes there, the tests demonstrate nothing — the classic shape of a
# plausible-but-false finding implemented as a "fix" whose regression test
# was green all along.
#
# INTENT decides the consequence, and intent is read from the round's own
# machine-readable artifacts, not inferred from the diff shape: a round is
# a DEFECT-CLAIM round only when resolved-comments.txt marks a finding
# resolved-in-code whose thread is Critical-tagged or belongs to a
# CHANGES_REQUESTED review (matched in rc.json/rv.json). Those rounds get a
# non-retryable rejection on all-green — the 18-minute repair pass cannot
# make a nonexistent defect reproduce; the next full round re-reads the
# feedback with the evidence in LAST_REJECTION and can decline or escalate
# instead. Every OTHER src+test round (a refactor pinning existing
# behavior, an optional cleanup adding coverage) legitimately produces
# all-green pre-round tests, so all-green there is a gate-authored ADVISORY
# in the report, never a rejection.
# Scope guards (all fail OPEN — only the clean "ran and all passed" verdict
# has consequences):
#   - Runnable unit tests only: *.test.* / *.spec.* files. Snapshots and
#     integration-tests/ are not directly runnable here.
#   - Single-package rounds only: on the detached pre-round tree, gitignored
#     dist/ still carries the ROUND's build, so a cross-package fix leaks
#     into the baseline through dist-resolved imports and would read as
#     "no bite" — the same dist confound that A/B-exempts typecheck above.
#     Same-package imports resolve through vitest src aliases and relative
#     paths, which the detach does revert.
#   - A test that fails on the pre-round tree for ANY reason (assertion,
#     collection, import of a round-added symbol) counts as biting; the
#     check's power is the all-green case, which no honest defect fix
#     produces. KNOWN LIMIT, deliberate: the verdict is existential over
#     the batch, so in a mixed Critical round one genuinely biting test
#     vouches for the batch — binding each behavior to its own probe needs
#     per-test result parsing and is out of scope here.
BITE_RUNNER="${BITE_RUNNER:-bite_runner_default}"
bite_runner_default() {
  # $1 = workspace dir, rest = test paths relative to the workspace.
  local ws="${1}"
  shift
  npm run test --workspace "${ws}" --if-present -- "$@"
}
mapfile -t BITE_FILES < <(git diff --name-only --diff-filter=AM "${ROUND_RANGE}" \
  -- ':(glob)**/*.test.*' ':(glob)**/*.spec.*' | grep -v '__snapshots__' || true)
# No blanket *.md exclusion: .qwen/skills/**/*.md is EXECUTABLE agent
# behavior (and scripts/tests pins it), so markdown counts as source; the
# consequence gating above keeps doc-only rounds from ever being rejected.
BITE_SRC="$(git diff --name-only "${ROUND_RANGE}" \
  -- ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.spec.*' \
  ':(exclude,glob)**/__snapshots__/**' ':(exclude,glob)**/test-utils/**' \
  ':(exclude,glob)integration-tests/**')"
# Does this round RESOLVE a Critical-tagged or CHANGES_REQUESTED finding in
# code? resolved-comments.txt is the agent's own machine-readable claim of
# what it fixed; rc.json/rv.json carry the thread bodies and review states
# the scan already fetched. Absent/empty inputs read as "no defect claim".
BITE_ENFORCE='false'
if [[ -s "${WORKDIR}/resolved-comments.txt" && -s "${WORKDIR}/rc.json" ]]; then
  BITE_ENFORCE="$(jq -rs --rawfile ids "${WORKDIR}/resolved-comments.txt" \
    --slurpfile reviews "${WORKDIR}/rv.json" '
    (add // []) as $comments
    | ($reviews | add // []) as $reviews
    | ($ids | split("\n") | map(select(test("^[0-9]+$")) | tonumber)) as $resolved
    | any($comments[];
        (.id as $id | $resolved | index($id) != null)
        and (
          ((.body // "") | contains("**[Critical]**"))
          or ((.pull_request_review_id // null) as $review
            | $review != null
            and any($reviews[]; .id == $review and ((.state // "") == "CHANGES_REQUESTED")))
        ))' "${WORKDIR}/rc.json" 2> /dev/null)" || BITE_ENFORCE='false'
  [[ "${BITE_ENFORCE}" == 'true' ]] || BITE_ENFORCE='false'
fi
if [[ "${#BITE_FILES[@]}" -gt 0 && -n "${BITE_SRC}" ]]; then
  BITE_PKGS="$(printf '%s\n' "${BITE_FILES[@]}" "${BITE_SRC}" |
    bash "${RUNNER_TEMP}/resolve-owning-packages.sh")"
  if [[ "$(wc -l <<< "${BITE_PKGS}")" -ne 1 || -z "${BITE_PKGS}" ]]; then
    echo "🦷 bite check skipped: round spans multiple/no workspaces (dist confound)" \
      | tee -a "${GATE_LOG}"
  else
    echo "🦷 bite check: running this round's changed tests on the pre-round tree" \
      | tee -a "${GATE_LOG}"
    git restore -- . 2>> "${GATE_LOG}" || true
    if git checkout --quiet --detach "origin/${BRANCH}" 2>> "${GATE_LOG}"; then
      BITE_BIT='false'
      BITE_RAN='false'
      if git checkout --quiet "${BRANCH}" -- "${BITE_FILES[@]}" 2>> "${GATE_LOG}"; then
        BITE_ARGS=()
        for f in "${BITE_FILES[@]}"; do
          BITE_ARGS+=("${f#"${BITE_PKGS}"/}")
        done
        BITE_RAN='true'
        if ! "${BITE_RUNNER}" "${BITE_PKGS}" "${BITE_ARGS[@]}" \
          > "${GATE_LOG}.bite" 2>&1; then
          BITE_BIT='true'
        fi
      else
        echo "🦷 bite check skipped: could not overlay the round's tests" \
          | tee -a "${GATE_LOG}"
      fi
      git checkout --quiet --force "${BRANCH}" 2>> "${GATE_LOG}" || {
        # Same crash contract as the baseline A/B: the tree is no longer the
        # one under verification, and a plain outcome=failed would advance
        # the watermark on a verdict the gate never reached. Leave outcome
        # unset so the next scan retries on a fresh checkout.
        echo "❌ could not restore the verification tree after the bite check"
        {
          echo '**could not restore the verification tree after the bite check**'
          echo
          echo '````'
          tail -c 3000 "${GATE_LOG}" 2> /dev/null
          echo '````'
        } > "${WORKDIR}/gate-rejection.md" || true
        exit 1
      }
      git reset --quiet 2>> "${GATE_LOG}" || true
      if [[ "${BITE_RAN}" == 'true' && "${BITE_BIT}" == 'false' && "${BITE_ENFORCE}" == 'true' ]]; then
        {
          echo 'Every test this round added or changed ALSO PASSES on the pre-round tree (the branch as pushed, with only your test files overlaid). This round resolves a Critical / Request-changes finding in code, and a defect fix must come with a test that fails before the fix and passes after it — an all-green result here means the claimed defect does not reproduce, no matter who reported it.'
          echo
          echo 'If the finding does not reproduce, do not implement it: decline it (for a disproved finding) or escalate it as an open question, attaching this measurement as the evidence.'
          echo
          echo 'Changed tests measured:'
          printf -- '- %s\n' "${BITE_FILES[@]}"
          echo '````'
          tail -c 1200 "${GATE_LOG}.bite" 2> /dev/null
          echo '````'
        } >> "${GATE_LOG}"
        reject_fix 'bite check: changed tests pass on the pre-round tree (claimed defect does not reproduce)' 'false' 'false'
      elif [[ "${BITE_RAN}" == 'true' && "${BITE_BIT}" == 'false' ]]; then
        # Not a defect-claim round: all-green pre-round tests are legitimate
        # for a refactor or coverage addition — surface, never reject.
        {
          echo '🦷 **Gate advisory — this round'"'"'s changed tests all pass on the pre-round tree** (machine-measured, not agent-authored). Expected for a refactor or coverage addition; if this round was meant to FIX a defect, that defect did not reproduce. · 本轮改动的测试在轮前树上全部通过（门自动测量，非 agent 文本）。对重构或补充覆盖属正常；若本轮意在修复缺陷，则该缺陷未能复现。'
        } >> "${WORKDIR}/gate-advisories.md"
        echo "🦷 changed tests all pass on the pre-round tree — advisory written (no defect claim in this round)" \
          | tee -a "${GATE_LOG}"
      elif [[ "${BITE_BIT}" == 'true' ]]; then
        echo "🦷 bite confirmed: at least one changed test fails on the pre-round tree" \
          | tee -a "${GATE_LOG}"
      fi
    else
      echo "🦷 bite check skipped: could not detach to the pre-round tree" \
        | tee -a "${GATE_LOG}"
    fi
  fi
fi
assert_verification_tree
echo "verified_head=${VERIFICATION_HEAD}" >> "${GITHUB_OUTPUT}"
echo "outcome=fixed" >> "${GITHUB_OUTPUT}"
