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
# Two more inherited knobs steer EXECUTION itself, and neither has a
# legitimate setter: BASH_ENV names a file every non-interactive bash
# sources at STARTUP — a body-side unset is one hop late (bash sources a
# plant before line 1), so the verify steps pin it empty at step level AND
# launch this gate through their env -i clean child; the unset here keeps
# the gate's own bash children clean too. BITE_RUNNER selects the bite
# check's runner command, which executes unwrapped with the gate's full
# environment. Strip them with the GIT_* class.
unset BASH_ENV BITE_RUNNER
# The verdict variables are GATE state, not inherited state: a plant of
# AUDIT_VERDICT_RECORDED=true plus a verdict from an earlier step would
# otherwise ride the every-exit re-append back into this step's outputs on
# paths where the gate validated nothing.
unset AUDIT_VERDICT AUDIT_VERDICT_RECORDED
# The runner backs $GITHUB_ENV/$GITHUB_PATH/$GITHUB_STEP_SUMMARY with files
# under $RUNNER_TEMP/_runner_file_commands/ that it reads back at step end.
# The channel strip below removes the VARIABLES from the checks, but the
# files stay discoverable under the inherited (predictable) $RUNNER_TEMP
# and stay WRITABLE — a check that appends there plants environment into
# every later step of this job, the PAT-bearing one included (discovery
# verified on a live runner). Lock the files for the lifetime of this
# step. The $GITHUB_OUTPUT backing file is the ONE exception: the gate
# must keep writing it, and forges against it lose to the every-exit
# re-append below plus the conclusion gate Finalize verification applies
# to outcome. The directory itself stays writable on purpose: the runner
# creates the NEXT step's backing files there at step start, and a locked
# directory would stall every later step of the job; the residual
# rename-over (create + rename onto a locked file) is documented in the
# design doc instead of bought at that price.
if [[ -n "${GITHUB_OUTPUT:-}" && -d "${RUNNER_TEMP}/_runner_file_commands" ]]; then
  for _rfc in "${RUNNER_TEMP}/_runner_file_commands"/*; do
    if [[ -f "${_rfc}" && "${_rfc}" != "${GITHUB_OUTPUT}" ]]; then
      chmod a-w "${_rfc}" 2> /dev/null || true
    fi
  done
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

GATE_LOG="${WORKDIR}/gate-output.log"
: > "${GATE_LOG}"
rm -f "${GATE_LOG}.bite"
# Single reset point for the gate-authored advisory file: every writer
# below APPENDS, so no later section can wipe an earlier section's
# advisory (the footprint advisory used to die to the shrink section's rm).
rm -f "${WORKDIR}/gate-advisories.md"
reject_fix() {
  local label="${1}"
  local preexisting="${2:-false}"
  local retryable="${3:-true}"
  echo "❌ ${label}"
  # Declare the verdict before writing its detail. An empty outcome on a failed
  # step means the gate itself crashed, so losing the detail file must not turn
  # a deterministic rejection into an infrastructure retry.
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  if [[ "${preexisting}" == 'true' ]]; then
    # NOT retryable: the repair agent is only allowed to amend this round's
    # fix, and a failure that exists without the fix is outside that boundary
    # by definition — the 60-minute repair budget cannot reach it. The remedy
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
# Last-writer binding for the audit verdict: the record below happens
# BEFORE the branch's build/tests run, and a check can still discover the
# step-output FILE through the inherited $RUNNER_TEMP (the strip removes
# the variable, not the backing file) and append its own audit_verdict —
# step outputs are last-write-wins. EVERY exit therefore re-appends the
# validated verdict INLINE (no function call: gate snippets extracted by
# the contract suite must stay executable standalone), including the exits
# that run after branch checks (a forge appended mid-check loses to the
# exit's rewrite) — so the gate's copy outwrites any forged append. The
# flag gates it: a verdict rejected BEFORE its record (missing, malformed,
# or a routing violation) never surfaces. kiss_audit rides the same
# discipline (recorded above, re-appended unconditionally at every exit).
# Defended control-bit surface: kiss_audit reaches every later step ONLY
# through this output — recorded HERE, before any branch code runs in this
# step, and re-appended at every exit below with the same last-writer
# discipline as the verdict. A consumer that read steps.prepare's copy
# directly would route the bit around the gate's defenses.
echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"

# Growth-audit verdict gate: a round tagged KISS_AUDIT (its counting window
# is over the growth budget) must carry the audit's machine-readable verdict
# — the audit IS the round's judgment of the over-budget approach, and a
# round that skipped it must not push (the rubber-stamp hole by absence).
# Sits BEFORE the failure.md early-exits below: a conflict round stops
# BLOCKED via failure.md, and its verdict must be validated and surfaced to
# GITHUB_OUTPUT before that exit writes outcome=failed — otherwise the
# conflict trail marker never posts and the idempotent park never engages.
# Also before the build/schema/footprint checks AND the no-commit/no-op
# exits further down: the verdict is required even for a no-op audit round
# whose verdict is sound with nothing left to fix. Malformed is agent
# misbehavior, not a build problem — NON-retryable, so the repair pass is
# never invoked and the next scan simply re-runs the audit.
if [[ "${KISS_AUDIT:-false}" == 'true' ]]; then
  AUDIT_VERDICT=''
  if [[ -f "${WORKDIR}/growth-audit.json" ]]; then
    # Slurp so the document COUNT is part of validation: the per-document
    # parse accepted a valid first document followed by one jq errors on
    # (or shape-filters out) on the FIRST document's verdict — the gate's
    # contract is a single JSON document, so reject every multi-document
    # stream.
    AUDIT_VERDICT="$(jq -rs '
        if length != 1 then empty else .[0]
        | select((.verdict // "") | IN("sound", "drift", "conflict"))
        | select((.kiss.result // "") | IN("pass", "fail"))
        | select((.minimal_change.result // "") | IN("pass", "fail"))
        | select((.verdict != "sound")
            or ((.kiss.result == "pass") and (.minimal_change.result == "pass")))
        | select((.verdict != "drift")
            or ((.kiss.result == "fail") or (.minimal_change.result == "fail")))
        | .verdict end' "${WORKDIR}/growth-audit.json" 2> /dev/null || true)"
  fi
  # Anchor the parsed value (defense in depth now that slurp rejects
  # multi-document streams outright).
  [[ "${AUDIT_VERDICT}" =~ ^(sound|drift|conflict)$ ]] || AUDIT_VERDICT=''
  if [[ -z "${AUDIT_VERDICT}" ]]; then
    {
      echo "Growth-audit round (this counting window is over its growth budget) without a valid growth-audit.json verdict."
      echo "The audit must run BEFORE any edit this round, and the verdict file must be a single JSON document carrying verdict sound|drift|conflict plus kiss.result and minimal_change.result each pass|fail, consistent with the taxonomy (sound requires both axes pass; drift requires at least one axis fail). Re-run the audit and produce the file; do not push without it."
    } >> "${GATE_LOG}"
    reject_fix 'growth-audit round missing a valid growth-audit.json verdict (audit skipped or malformed)' 'false' 'false'
  fi
  echo "🔎 growth-audit verdict: ${AUDIT_VERDICT}"
  # Conflict routing is enforced HERE, not by convention: a conflict verdict
  # must STOP BLOCKED with a handoff (the only growth path to a human). A
  # round that kept fixing and committed would otherwise clear the gate like
  # sound/drift, push the contested code, and park the next scan on a
  # handoff question that was never asked. NON-retryable: re-audit, don't
  # repair.
  if [[ "${AUDIT_VERDICT}" == 'conflict' && ! -f "${WORKDIR}/failure.md" && ! -s "${WORKDIR}/handoff.md" ]]; then
    reject_fix 'growth-audit verdict is conflict but the round did not stop with a handoff; conflict must STOP BLOCKED (no push)' 'false' 'false'
  fi
  # The no-push half of this routing is enforced at the success exit
  # below: a repair pass re-auditing to conflict LEGITIMATELY runs behind
  # the first pass's commit (committed_rc=1), so the push shape cannot be
  # refused here without refusing it — the refusal sits at the push
  # boundary itself.
  # Record the verdict the GATE validated, for the report step to consume
  # via the step output. The report must NOT re-read the file itself: the
  # branch's own build/tests run as the runner user after this point and
  # WORKDIR is a predictable path they can write — the validated verdict is
  # the only verdict that may reach the trail marker and the re-arm.
  echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  AUDIT_VERDICT_RECORDED='true'
fi

if [[ -f "${WORKDIR}/failure.md" && -n "$(git status --porcelain)" ]]; then
  echo "❌ Agent wrote failure.md after leaving a dirty workspace:"
  git status --short
  # Agent-written content on step stdout: both workflow-command syntaxes
  # parse here (`##[` mid-line too — measured on #9761). Same reason
  # 'Show run artifacts' neutralizes these files.
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/failure.md"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
fi

if [[ -f "${WORKDIR}/failure.md" ]]; then
  echo "🛑 Agent aborted intentionally:"
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/failure.md"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
fi

# These three handoff classifications skip a growth-audit CONFLICT verdict:
# that round has its own routing — the verdict gate (stop enforced here) and
# the push-boundary refusal at the success exit — and it must land
# outcome=failed so the conflict trail marker posts and the park engages,
# never the clean outcome=handoff. A plain (non-audit) handoff still takes
# these.
# A handoff claims the round changed NOTHING — dirt beside it is a
# brake-violating partial patch (otherwise reported as a clean stop and
# discarded silently with the runner), and untracked leftovers would trip
# the NEXT round's dirty assert on the persistent pool. The ref-level
# commit diff below is blind to both. Non-retryable like failure.md+dirty
# above (a retryable rejection would engage the repair pass, which deletes
# handoff.md and may commit against the brake), but under its OWN outcome:
# outcome=failed would make the report step dress the rejection as a
# failed FIX ("could not produce a passing fix", or a stale-base retry
# promise) when no fix existed — the report step gives this shape its own
# honest headline.
if [[ -s "${WORKDIR}/handoff.md" && -n "$(git status --porcelain)" \
  && "${AUDIT_VERDICT:-}" != 'conflict' ]]; then
  echo "❌ Agent wrote handoff.md after leaving a dirty workspace:"
  git status --short
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/handoff.md"
  echo "outcome=dirty_handoff" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
fi

# The committed sibling of the brake violation above: the round HAS a commit
# beside handoff.md. Judged by dirt alone it slips both guards — the dirty
# check sees a clean tree, and the no-commit handoff branch below requires
# an unchanged ref — so it would reach the structural checks, where
# reject_fix defaults to retryable and the repair pass deletes
# handoff.md and may commit AGAIN against the brake's stop. Non-retryable
# under its OWN outcome: a commit DID happen, so the dirty-handoff headline
# claiming nothing was committed would misreport it. Same reasoning as the
# dirty guard otherwise.
if [[ -s "${WORKDIR}/handoff.md" && "${committed_rc:-0}" -eq 1 \
  && "${AUDIT_VERDICT:-}" != 'conflict' ]]; then
  echo "❌ Agent wrote handoff.md but the round HAS a commit — a brake violation:"
  git log --oneline "origin/${BRANCH}..${BRANCH}"
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/handoff.md"
  echo "outcome=committed_handoff" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
fi

# No-commit brake handoff, classified BEFORE the structural checks below:
# those judge the PR's OWN diff (core rebuild, schema freshness, contracts)
# and reject_fix on failure, and the growth brake fires on exactly the red
# PRs whose diff trips them. A compliant handoff commits nothing, so
# running the checks first would reclassify it as a retryable failure —
# the repair pass would delete handoff.md and commit against the brake's
# stop. A handoff claims nothing (acted=false, deferred to a human), so
# the checks' false-no-action rationale does not apply. failure.md
# coexistence keeps the failed classification via the exits above.
if git diff --quiet "origin/${BRANCH}...${BRANCH}" \
  && [[ -s "${WORKDIR}/handoff.md" ]] \
  && [[ "${AUDIT_VERDICT:-}" != 'conflict' ]]; then
  echo "🤝 Branch unchanged with a handoff — the agent stopped under instruction and deferred this item to a human:"
  # Agent-written content: both workflow-command syntaxes parse on step
  # stdout — a line-start `::` (::error::, ::add-mask::) AND `##[` even
  # mid-line (a quoted `##[add-matcher]` fails the step; measured on
  #9761). The same reason 'Show run artifacts' neutralizes these files.
  sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/handoff.md"
  echo "outcome=handoff" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 0
fi

# Convention: hooks are severed at EVERY host checkout of the PR
# branch (no secret sits in this step's env, but a post-checkout
# hook still runs branch code on the host).
git config core.hooksPath /dev/null
git checkout "${BRANCH}"
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
  if ! strip_runner_channels "$@" >> "${ab_log}" 2>&1; then
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
    echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
    if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
      echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
    fi
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
# Every check below runs the BRANCH's own code (npm scripts, tests, and
# their lifecycle children) with this step's inherited environment. Strip
# the runner injection channels first: a check appending to GITHUB_OUTPUT
# would overwrite the gate's own outputs last-write-wins (a forged
# audit_verdict=sound after the gate's write), GITHUB_ENV/GITHUB_PATH
# plant environment for the PAT-bearing steps that follow, and
# GITHUB_STEP_SUMMARY lets branch code forge the job summary styled as
# gate output (the display-channel sibling; qwen-triage strips it when
# running external-author branch code for the same reason). Same class the
# deferred-upsert child closes with env -i; targeted -u here because the
# checks need the ordinary environment (PATH, HOME, …) to run at all.
strip_runner_channels() {
  env -u GITHUB_OUTPUT -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY "$@"
}
run_check() {
  # pipefail makes the pipeline carry the command's status, not tee's. The
  # side copy holds THIS check's transcript alone — the identity comparison
  # must not match diagnostics an earlier check left in the shared log.
  local label="${1}"
  shift
  : > "${GATE_LOG}.check"
  if ! strip_runner_channels "$@" 2>&1 | tee -a "${GATE_LOG}" "${GATE_LOG}.check"; then
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
  if ! strip_runner_channels "$@" 2>&1 | tee -a "${GATE_LOG}"; then
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
# this PR fixes. So it runs on every path but the no-commit handoff,
# which claims nothing and exits above. The gate is shared with the
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
  # No new commit. That is only legitimate as a deliberate no-action; the
  # no-commit handoff was classified before the structural checks above.
  if [[ -s "${WORKDIR}/no-action.md" ]]; then
    echo "🟰 No action needed:"
    # Both command syntaxes, like every other echo of agent-written files
    # (`##[` parses mid-line too — #9761).
    sed -e 's/::/;;/g' -e 's/##\[/##［/g' "${WORKDIR}/no-action.md"
    echo "verified_head=$(git rev-parse HEAD)" >> "${GITHUB_OUTPUT}"
    echo "outcome=noop" >> "${GITHUB_OUTPUT}"
    echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
    if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
      echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
    fi
    exit 0
  fi
  echo "❌ Branch unchanged and no no-action.md — agent produced nothing"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
  exit 1
fi

if [[ ! -s "${WORKDIR}/address-summary.md" ]]; then
  echo "❌ Branch changed but address-summary.md is missing"
  echo "outcome=failed" >> "${GITHUB_OUTPUT}"
  echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
  if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
    echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
  fi
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
# "passes". Only the root manifest and DECLARED workspace manifests count
# (resolver-backed, nested workspaces included): fixture manifests deeper
# in a src tree are ordinary test data.
was_workspace_dir() {
  # Pre-round workspace membership without the on-disk resolver: match the
  # dir against the workspaces globs recorded in the REF's root manifest.
  # Used where the tree can no longer answer (deleted manifests/dirs).
  # PATH-AWARE matching: npm workspaces globs are wildmatch-style, where
  # '*' stops at '/'; a bash case '*' would span slashes and swallow
  # nested fixture dirs. Translate to an anchored regex ('**'→.*,
  # '*'→[^/]*, '?'→[^/]). Negated ('!') entries are skipped — ignoring a
  # subtraction only ever classifies MORE dirs as workspaces, the
  # conservative direction for a protection class.
  local ref="${1}" d="${2}" g re
  while IFS= read -r g; do
    [[ -n "${g}" && "${g}" != '!'* ]] || continue
    re="$(printf '%s' "${g}" | sed -e 's/[.^$+(){}|[]/\\&/g' -e 's/]/\\]/g' -e 's/\*\*/\x01/g' -e 's/\*/[^\/]*/g' -e 's/?/[^\/]/g' -e 's/\x01/.*/g')"
    [[ "${d}" =~ ^${re}$ ]] && return 0
  done < <(git show "${ref}:package.json" 2> /dev/null | jq -r '.workspaces[]?' 2> /dev/null)
  return 1
}
at_workspace_root() {
  # True when the path sits at the repo root or at a DECLARED workspace's
  # root (resolved through the same trusted resolver the package-test loop
  # uses — nested workspaces like packages/channels/* included). Deeper
  # copies are fixtures/templates: ordinary data, not machinery.
  local f="${1}" d
  [[ "${f}" == */* ]] || return 0
  d="${f%/*}"
  [[ "$(printf '%s\n' "${f}" | bash "${RUNNER_TEMP}/resolve-owning-packages.sh")" == "${d}" ]]
}
sensitive_class_of() {
  # Prints the class name for a path, or nothing. Kept as one function so
  # the round scan and the PR-footprint scan cannot drift. Classes are
  # NARROW on purpose: a PR that only edits issue templates must not
  # thereby license rounds to rewrite workflows, and the loop's OWN
  # enforcement files are their own classes — no footprint short of
  # touching them themselves licenses a round to rewrite the referee.
  # scripts/tests/** is ordinary test code the gate never executes.
  local f="${1}"
  case "${f}" in
    *$'\n'*)
      # A newline-bearing path cannot round-trip the line-based resolver or
      # the class ledger — fail CLOSED as its own class instead of open.
      echo 'suspicious-path' ;;
    .github/workflows/qwen-autofix*.yml | .github/workflows/qwen-triage*.yml | .github/workflows/qwen-pr-safety-precheck.yml) echo 'autofix-loop' ;;
    .github/scripts/run-autofix-review-verification.sh | .github/scripts/resolve-owning-packages.sh | .github/scripts/check-settings-schema.sh | .github/scripts/check-autofix-contracts.sh | .github/scripts/resolve-sandbox-image.mjs | .github/scripts/pr-safety-precheck.mjs) echo 'autofix-loop' ;;
    .github/workflows/* | .github/actions/*) echo 'ci-workflows' ;;
    .github/scripts/*) echo 'ci-scripts' ;;
    .github/*) echo 'gh-metadata' ;;
    .husky/*) echo 'git-hooks' ;;
    .qwen/*) echo 'agent-skills' ;;
    AGENTS.md | CLAUDE.md) echo 'agent-policy' ;;
    scripts/tests/*) ;;
    scripts/*) echo 'repo-scripts' ;;
    .npmrc | .nvmrc | */.npmrc | */.nvmrc) echo 'toolchain-config' ;;
    package-lock.json | npm-shrinkwrap.json | */package-lock.json | */npm-shrinkwrap.json | patches/*) echo 'supply-chain' ;;
    .gitattributes | */.gitattributes) echo 'measurement-config' ;;
    *) case "${f##*/}" in
      eslint.config.* | eslint.legacy-filenames.mjs | vitest.config.* | tsconfig.json | tsconfig.*.json)
        # Workspace-root configs are machinery; a scaffold template deep in
        # a src tree is test/fixture data (same exemption manifests get).
        if at_workspace_root "${f}"; then
          case "${f##*/}" in
            eslint.config.* | eslint.legacy-filenames.mjs) echo 'lint-config' ;;
            vitest.config.*) echo 'test-config' ;;
            *) echo 'ts-config' ;;
          esac
        fi ;;
    esac ;;
  esac
}
manifest_scripts_changed() {
  # True when the gate-relevant sections of a manifest differ between two
  # refs. For the ROOT manifest that is scripts AND the workspaces array —
  # both steer what the gate's npm commands execute (a negated workspaces
  # entry silently drops a package from build/typecheck). Missing file on
  # either side reads as {}.
  local f="${1}" from="${2}" to="${3}" filt a b
  filt='{s: (.scripts // {}), e: (.exports // {}), m: (.main // ""), t: (.types // "")}'
  [[ "${f}" == 'package.json' ]] && filt='{s: (.scripts // {}), w: (.workspaces // []), e: (.exports // {}), m: (.main // ""), t: (.types // ""), l: (."lint-staged" // {}), c: (.config // {})}'
  a="$(git show "${from}:${f}" 2> /dev/null | jq -cS "${filt}" 2> /dev/null)" || a='{}'
  b="$(git show "${to}:${f}" 2> /dev/null | jq -cS "${filt}" 2> /dev/null)" || b='{}'
  [[ "${a}" != "${b}" ]]
}
ROUND_RANGE="origin/${BRANCH}...${BRANCH}"
PR_RANGE="origin/main...origin/${BRANCH}"
# Content comparisons for the PR footprint anchor at the MERGE BASE, not a
# moving origin/main: main-side drift on a manifest must not read as "the
# PR touched scripts" and license a round to rewrite the command surface.
PR_BASE="$(git merge-base origin/main "origin/${BRANCH}" 2> /dev/null)" || PR_BASE='origin/main'
ROUND_CLASSES=''
while IFS= read -r -d '' f; do
  [[ -n "${f}" ]] || continue
  # A round that merges origin/main makes ROUND_RANGE degenerate (the
  # pre-round head is an ancestor), attributing every incoming main-side
  # change to the round. Content identical to current main is merge
  # freight, not the round's authorship — skip it.
  if git diff --quiet origin/main "${BRANCH}" -- "${f}" 2> /dev/null; then
    continue
  fi
  c="$(sensitive_class_of "${f}")"
  case "${c}" in
    lint-config | test-config | ts-config)
      # Only a config born WITH its round-added workspace is the round's
      # own surface: added into a pre-existing workspace, it is new
      # machinery the gate's legs will execute.
      if ! git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null; then
        d="${f%/*}"; [[ "${f}" != */* ]] && d='.'
        if [[ "${d}" == '.' ]] || git cat-file -e "origin/${BRANCH}:${d}/package.json" 2> /dev/null; then
          : # pre-existing home → keep the class
        else
          c=''
        fi
      fi ;;
  esac
  if [[ -z "${c}" ]]; then
    case "${f}" in
      package.json | */package.json)
        # DELETED workspace manifests never resolve on the round's tree —
        # classify them from pre-round existence instead (deleting a
        # workspace removes command surface the gate dispatched over).
        if [[ ! -e "${f}" ]]; then
          # Same fixture exemption as the alive arm, answered from the
          # PRE-ROUND root manifest's workspaces globs (the on-disk
          # resolver can no longer see a deleted dir): only a deleted
          # DECLARED workspace manifest is command surface.
          if git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null; then
            if [[ "${f}" == 'package.json' ]]; then
              c='manifest-scripts-root'
            elif was_workspace_dir "origin/${BRANCH}" "${f%/package.json}"; then
              c='manifest-scripts-ws'
            fi
          fi
          [[ -n "${c}" ]] && ROUND_CLASSES+="${c} ${f}"$'\n'
          continue
        fi
        # Any DECLARED workspace manifest (nested included) is command
        # surface; fixture manifests deeper in a src tree are data. A
        # manifest the round ADDED (a new workspace) is the round's own
        # new surface, not a rewrite of commands the gate already ran —
        # only edits to a manifest that existed pre-round count. Root and
        # workspace manifests are SEPARATE classes: a workspace-scripts
        # footprint must not license rewriting the root dispatcher.
        at_workspace_root "${f}" || continue
        git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null || continue
        if manifest_scripts_changed "${f}" "origin/${BRANCH}" "${BRANCH}"; then
          c='manifest-scripts-ws'
          [[ "${f}" == 'package.json' ]] && c='manifest-scripts-root'
        fi ;;
    esac
  fi
  [[ -n "${c}" ]] && ROUND_CLASSES+="${c} ${f}"$'\n'
# -z --no-renames: NUL-delimited raw paths (a specially named file is not
# core.quotePath-mangled past the case patterns), and a rename decomposes
# into A+D so the VACATED sensitive path is classified too — moving a
# workflow out of .github/ is a removal of verification machinery.
done < <(git diff --name-only -z --no-renames "${ROUND_RANGE}")
if [[ -n "${ROUND_CLASSES}" ]]; then
  PR_CLASSES=''
  while IFS= read -r -d '' f; do
    [[ -n "${f}" ]] || continue
    c="$(sensitive_class_of "${f}")"
    if [[ -z "${c}" ]]; then
      case "${f}" in
        package.json | */package.json)
          # The footprint describes the PR (main → origin/BRANCH); the
          # round's on-disk tree must not answer for it — a round-deleted,
          # PR-added workspace manifest is alive at origin/BRANCH and its
          # class must stay granted, or the round's own deletion walls.
          if ! git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null; then
            # Deleted BY THE PR itself: membership from the merge base.
            if [[ "${f}" == 'package.json' ]]; then
              c='manifest-scripts-root'
            elif was_workspace_dir "${PR_BASE}" "${f%/package.json}"; then
              c='manifest-scripts-ws'
            fi
            [[ -n "${c}" ]] && PR_CLASSES+="${c}"$'\n'
            continue
          fi
          if [[ -e "${f}" ]]; then
            at_workspace_root "${f}" || continue
          else
            was_workspace_dir "origin/${BRANCH}" "${f%/package.json}" || [[ "${f}" == 'package.json' ]] || continue
          fi
          if manifest_scripts_changed "${f}" "${PR_BASE}" "origin/${BRANCH}"; then
            c='manifest-scripts-ws'
            [[ "${f}" == 'package.json' ]] && c='manifest-scripts-root'
          fi ;;
      esac
    fi
    [[ -n "${c}" ]] && PR_CLASSES+="${c}"$'\n'
  done < <(git diff --name-only -z --no-renames "${PR_RANGE}")
  VIOLATIONS="$(while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    cls="${line%% *}"
    grep -qx "${cls}" <<< "${PR_CLASSES}" || printf '%s\n' "${line}"
  done <<< "${ROUND_CLASSES}")"
  if [[ -n "${VIOLATIONS}" ]]; then
    {
      echo 'This round modified CI/verification machinery in area(s) the PR itself never touched:'
      # Branch-controlled paths in a trusted-voice document: same safe
      # charset as the advisory renderer.
      printf '%s\n' "${VIOLATIONS//[^A-Za-z0-9._\/ -]/?}"
      echo 'Review feedback alone — from ANY author — cannot authorize changes to the loop'"'"'s own guardrails. Revert these files; if the feedback genuinely requires them, escalate it to a maintainer as an open question instead of implementing it.'
    } >> "${GATE_LOG}"
    reject_fix 'round expands into CI/verification machinery outside the PR footprint'
  fi
fi

# Merge freight (content identical to current main) is not the round's
# authorship — the same doctrine the class scan applies. Filter it out of
# every bite input so a base-merging round is judged on its own changes.
not_merge_freight() {
  while IFS= read -r -d '' f; do
    git diff --quiet origin/main "${BRANCH}" -- "${f}" 2> /dev/null || printf '%s\0' "${f}"
  done
}
# --- Deny-by-default footprint areas ----------------------------------------
# The class gate above protects an ENUMERATED surface, and enumeration is
# never complete (a denylist is not a boundary). This check inverts the
# default: every file a round touches is mapped to an AREA — its declared
# workspace, else its top-level directory, else the root file itself — and
# any area outside the PR's own footprint is surfaced. Consequence is
# staged via QWEN_AUTOFIX_FOOTPRINT_ENFORCE: 'advisory' (default) writes a
# gate-authored report section; 'reject' turns expansions into a retryable
# rejection. Merge freight is excluded from the round side; deleted
# workspaces degrade to their top-level segment (conservative: mismatch
# surfaces rather than hides).
list_areas() {
  # $1: NUL-separated path file; $2: the REF whose recorded workspaces
  # globs define membership. Ref-anchored on purpose: the round's on-disk
  # manifest must not redefine its own footprint boundary. The ref's globs
  # are read and translated ONCE per invocation (the per-file ancestor
  # walk then matches in-bash — was_workspace_dir per (file×dir) re-ran
  # git+jq+sed each time, ~21 ms a call). Longest ancestor wins (nested
  # workspaces); non-workspace paths under packages/ keep TWO segments so
  # sibling projects stay distinct areas. Emitted keys are printf %q —
  # line-safe AND injective, so two distinct areas can never collapse
  # into one comparison key (a lossy charset map hid expansions).
  local ref="${2}" f d a g re
  local -a ws_res=()
  while IFS= read -r g; do
    [[ -n "${g}" && "${g}" != '!'* ]] || continue
    re="$(printf '%s' "${g}" | sed -e 's/[.^$+(){}|[]/\\&/g' -e 's/]/\\]/g' -e 's/\*\*/\x01/g' -e 's/\*/[^\/]*/g' -e 's/?/[^\/]/g' -e 's/\x01/.*/g')"
    ws_res+=("${re}")
  done < <(git show "${ref}:package.json" 2> /dev/null | jq -r '.workspaces[]?' 2> /dev/null)
  while IFS= read -r -d '' f; do
    [[ -n "${f}" ]] || continue
    a=''
    d="${f%/*}"
    while [[ -n "${d}" && "${d}" != "${f}" ]]; do
      for re in "${ws_res[@]}"; do
        if [[ "${d}" =~ ^${re}$ ]]; then
          a="${d}"
          break 2
        fi
      done
      [[ "${d}" == */* ]] || break
      d="${d%/*}"
    done
    if [[ -z "${a}" ]]; then
      if [[ "${f}" == packages/*/* ]]; then
        a="${f#packages/}"
        a="packages/${a%%/*}"
      elif [[ "${f}" == */* ]]; then
        a="${f%%/*}"
      else
        a="/${f}"
      fi
    fi
    printf '%q\n' "${a}"
  done < "${1}" | sort -u
}
FOOTPRINT_ENFORCE="${FOOTPRINT_ENFORCE:-advisory}"
[[ "${FOOTPRINT_ENFORCE}" == 'reject' ]] || FOOTPRINT_ENFORCE='advisory'
ROUND_FILES_Z="$(mktemp)"
PR_FILES_Z="$(mktemp)"
# Unmeasurable is a STATE here too: a failed producer (no merge base on an
# orphan-history takeover, a transient git error) must skip the check
# loudly, not shrink one side into a verdict — an empty PR side would
# read as "every round area is an expansion".
FOOTPRINT_MEASURED='true'
git diff --name-only -z --no-renames "${ROUND_RANGE}" 2> /dev/null | not_merge_freight > "${ROUND_FILES_Z}" || FOOTPRINT_MEASURED='false'
git diff --name-only -z --no-renames "${PR_RANGE}" 2> /dev/null > "${PR_FILES_Z}" || FOOTPRINT_MEASURED='false'
if [[ "${FOOTPRINT_MEASURED}" != 'true' ]]; then
  echo "🧭 footprint measurement UNAVAILABLE this round (diff producer failed) — check skipped" | tee -a "${GATE_LOG}"
fi
OUT_AREAS="$(comm -23 <(list_areas "${ROUND_FILES_Z}" "origin/${BRANCH}") <(list_areas "${PR_FILES_Z}" "origin/${BRANCH}"))" || OUT_AREAS=''
rm -f "${ROUND_FILES_Z}" "${PR_FILES_Z}"
if [[ "${FOOTPRINT_MEASURED}" == 'true' && -n "${OUT_AREAS}" ]]; then
  if [[ "${FOOTPRINT_ENFORCE}" == 'reject' ]]; then
    {
      echo 'This round modified areas entirely outside the PR footprint:'
      while IFS= read -r a; do [[ -n "${a}" ]] && echo "- ${a}"; done <<< "${OUT_AREAS}"
      echo 'Footprint enforcement is set to reject: revert these files, or escalate the feedback that requires them to a maintainer as an open question.'
    } >> "${GATE_LOG}"
    reject_fix 'round expands into areas outside the PR footprint'
  else
    {
      echo '🧭 **Gate advisory — this round modified areas outside the PR footprint** (machine-measured, not agent-authored):'
      while IFS= read -r a; do [[ -n "${a}" ]] && echo "- ${a}"; done <<< "${OUT_AREAS}"
      echo 'Review the expansion deliberately; the footprint gate is in advisory mode. · 本轮改动了 PR 足迹之外的区域（门自动测量，非 agent 文本），当前足迹门为 advisory 模式，请有意识地审阅该扩张。'
    } >> "${WORKDIR}/gate-advisories.md"
    echo "🧭 footprint expansion (advisory): $(tr '\n' ' ' <<< "${OUT_AREAS}")" | tee -a "${GATE_LOG}"
  fi
fi

# Test-deletion advisory: deleting or shrinking tests is sometimes right
# (the pinned behavior was wrong, or coverage is duplicated) and the agent
# is required to justify it in its summary — but the SURFACING must not be
# the agent's own prose. The gate writes its own advisory into the round
# report so a maintainer always sees exactly which tests disappeared,
# whoever suggested it.
TEST_PATHSPEC=(':(glob)**/*.test.*' ':(glob)**/*.spec.*' ':(glob)**/__snapshots__/**' ':(glob)**/__tests__/**' ':(glob)**/test-utils/**' ':(glob)integration-tests/**')
DELETED_TESTS="$(git diff --name-only -z --no-renames --diff-filter=D "${ROUND_RANGE}" -- "${TEST_PATHSPEC[@]}" |
  not_merge_freight | tr '\0' '\n')"
# Per-file sum with the merge-freight skip the class scan applies: a
# base-merging round must not be charged (or credited) main-side test
# churn in trusted-voice advisory text. -z numstat records are
# add<TAB>del<TAB>path NUL-terminated (renames are disabled above).
NET_TEST_LINES="$(git diff --numstat -z --no-renames "${ROUND_RANGE}" -- "${TEST_PATHSPEC[@]}" |
  { total=0
    while IFS=$'\t' read -r -d '' add del path; do
      [[ -n "${path}" ]] || continue
      git diff --quiet origin/main "${BRANCH}" -- "${path}" 2> /dev/null && continue
      [[ "${add}" != '-' ]] && total=$(( total + add ))
      [[ "${del}" != '-' ]] && total=$(( total - del ))
    done
    echo "${total}"; })"
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
  } >> "${WORKDIR}/gate-advisories.md"
  echo '⚖️ test coverage shrank this round — advisory written for the report' | tee -a "${GATE_LOG}"
fi

# --- Test-weakening gate ----------------------------------------------------
# The advisory above renders in the round report only AFTER the round has
# already been accepted, and the SKILL rule it points at ("deleting or
# weakening tests requires content evidence, not an author's say-so") had no
# deterministic enforcement at all. Relaxing an existing assertion is the
# cheapest way for a fix to reach green while the behaviour it broke goes
# unpinned, and it is structurally invisible to every other check here:
# build/typecheck/lint never read assertions, the package tests run the
# WEAKENED file, and the bite check reads only the tests a round ADDS --
# never the ones it edits away.
#
# So: any pre-existing runnable test file this round deletes, whose assertion
# density it lowers, or into which it introduces a skip/todo marker, must be
# named in <workdir>/test-weakening.json -- a JSON array of
# {"path": "<file>", "reason": "<evidence>"}. The gate judges PRESENCE and a
# non-trivial reason, never the reason's merit: no semantic oracle is
# available here, and turning a silent edit into an explicit attributable
# claim is the whole point -- the reasons ride into the round report, where a
# maintainer reads them against the diff.
#
# Signals, all measured per round COMMIT rather than over the net range:
# each of the round's own commits is diffed against its first parent, so a
# base-merging round is judged on its own changes; the per-commit scan
# enumerates modified, deleted, and typechanged files (a pre-existing test
# replaced by a symlink is status T, not a deletion, and still exists at
# the tip). A merge commit counts only the lines its resolution is
# responsible for -- an added line main's side did not already carry, a
# removed line that is not freight -- where freight is exactly what main
# itself deleted: present at the merge base and absent from main's side of
# the merge (including the modify/delete shape with no blob on main's side
# at all). So freight crossing the merge neither charges the round nor
# shields it, and a weakening introduced while resolving a merge conflict
# IS counted. One exception: a modify/delete resolution that KEEPS the
# file main deleted authors every surviving line itself, so none of its
# removals is freight. Freight attribution applies only when the merge's
# second
# parent is main-derived -- a side-branch merge has no main side, and its
# first-parent diff is the round's own work.
# A file that did not exist at the pre-round ref is not pre-existing
# coverage and is not measured, whichever commit touched it. Per-file
# pathspecs are `:(literal)` -- a branch-controlled filename may carry glob
# magic, and the measurement must see exactly the file's own hunks, not the
# union of every path its name matches.
#   - the file was DELETED;
#   - assertion lines removed exceed assertion lines added, an assertion
#     line being one that carries a THROWING assertion: `expect(` or
#     `expect.poll(` -- with a CALLED matcher chain following on the
#     same line when ADDED, since expect('anything') passes for any
#     value and a property-accessed matcher (expect(x).toBe;) throws
#     nothing, the maximal relaxation, while a bare `expect(` removal
#     still counts (a
#     multi-line-formatted assertion measures as a removal: the
#     fail-closed direction, one ack entry answers it) -- or
#     `assert(`/`assert.member(` with a left boundary, where the member
#     arm requires the CALL: a member access alone (an exported alias
#     like const eq = assert.deepEqual;) executes no assertion, while a
#     member call like console.assert( prints and continues and never
#     fails a test. supertest's `.expect(` is the throwing exception --
#     a MEMBER call whose mismatch rejects the awaited promise -- so it
#     counts too; an over-count from a rare non-throwing .expect( member
#     fails closed, one ack entry answers it. An
#     assertion moved within a file nets zero; one moved OUT of a file
#     nets negative and is answered by naming its new home. Removed lines
#     count RAW and added lines count after comment-and-string-aware
#     stripping: a commented-out copy of a removed assertion must not
#     cancel it, and an over-charge on the raw del side fails closed (one
#     ack entry answers it) while an over-credit on the add side would
#     fail open.
#     The line counts are cross-checked against the assertion density of
#     the string-and-comment-stripped WHOLE BLOBS on every edited file:
#     diff-line grep cannot see tokens that never execute -- an assertion
#     wrapped into a multi-line block comment (the wrapped line stays
#     byte-identical and never appears in a -U0 diff), a string-literal
#     decoy, or a decoy planted inside a block comment opened above the
#     hunk -- while the blob delta under symmetric stripping nets every
#     untouched region to zero. The larger deletion signal wins. Merge
#     commits are freight-attributed like the line counts: main's own
#     density delta neither charges nor shields. The measurement
#     diff is --text: a branch-controlled .gitattributes `-diff`/`binary`
#     rule would otherwise collapse the hunk into a binary banner and zero
#     every counter;
#   - a skip/todo marker was added NET: `it`/`test`/`describe` followed by
#     `.skip`, `.todo`, `.fails`, or `.failing` -- with a `.concurrent`/
#     `.sequential`/`.shuffle` chain AHEAD of the modifier, behind it, or
#     both, optionally chained with `.each`/`.for` (call tail `(`, `<`, a
#     tagged template, or an optional-chaining `?.` before any member dot
#     or the call) -- the computed accessor `it['skip'](` quoted with a
#     single, double, or BACKTICK quote, or `xit(`/`xdescribe(`. Markers
#     are measured on a joined view, so a newline-split member chain
#     (it / .skip( on two lines) counts like the one-line form, and on the
#     comment-stripped view on BOTH sides: a deleted comment line that
#     merely contains marker text earns no removal credit. The line net is
#     cross-checked against the whole-blob marker delta under the same
#     code strip the assertion arm uses -- a line strip cold-starts at the
#     hunk boundary, so block-comment state from unchanged bytes ABOVE the
#     hunk cannot arrive there; the larger addition signal wins. Markers
#     removed in the same file net against markers added, so touching an
#     already-skipped test without adding a marker is not charged.
#     `.skipIf` is deliberately NOT
#     a signal -- it is this repo's standard environment guard (237 uses)
#     and flagging it would charge every platform-conditional test to this
#     gate.
# Snapshots are out of scope on both signals: they carry no assertion token,
# and an obsolete snapshot removed by `vitest -u` is routine bookkeeping.
# Fails OPEN on the measured signals -- a diff the gate cannot read skips
# them rather than rejecting a round it could not measure. The net-range
# deletion arm is independent of that walk and still judges: a deletion is
# proven by the pre-round->tip pair, not by the per-commit producer.
WEAKEN_PATHSPEC=(':(glob)**/*.test.*' ':(glob)**/*.spec.*' ':(exclude,glob)**/__snapshots__/**')
# Member calls like console.assert( print and continue in Node — they
# never fail a test — so the assert forms carry the left-boundary idiom
# the skip RE uses, and the member arm requires the CALL: a member
# access with no call (export const eq = assert.deepEqual;) executes no
# assertion and earns nothing. supertest's .expect( is the throwing
# exception — a member call whose mismatch rejects the awaited promise —
# so the member form counts on every arm. This del-side/blob RE counts a
# bare expect( call. The expect MEMBERS whitelisted beside poll are the
# complete throwing assertions — soft( collects failures and throws at
# test end, assertions(/hasAssertions( throw on a count mismatch,
# unreachable( throws unconditionally — so deleting such a line removes
# a pinning assertion exactly like deleting expect(...).toBe(...). The
# list stays a whitelist on purpose: anything(/any(/arrayContaining(
# are NON-throwing asymmetric matchers and must not count.
WEAKEN_ASSERT_RE='(^|[^A-Za-z0-9_$.])assert(\(|\.[A-Za-z_$][A-Za-z0-9_$]*\()|(^|[^A-Za-z0-9_$.])expect(\.(poll|soft|assertions|hasAssertions|unreachable))?\(|\.expect(\.(poll|soft|assertions|hasAssertions|unreachable))?\('
# Added lines count an expect( only when a CALLED matcher chain follows
# it on the same line: expect('anything') passes for any return value,
# and a matcher that is only property-accessed, never called
# (expect(x).toBe;) throws nothing — the maximal relaxation of an
# assertion. The tail therefore demands the member identifier plus a
# call opener ('(' or an optional-chaining '?'), through any further
# dotted members (expect(x).not.toBe(...)). The del side stays bare on
# purpose: a multi-line-formatted expect(...) then measures as a
# removal — the fail-closed direction, one ack entry answers it. The
# member form .expect( IS its own assertion, but it carries the same
# matcher-tail requirement here on purpose: a bare-added member call
# then measures as removal-only — the fail-closed direction. The
# throwing members need no tail: the CALL itself fails the test, so an
# added expect.unreachable( earns addition credit as written.
# expect.assertions( is NOT whitelisted here: assertions(0) passes
# exactly when ZERO assertions run — the count-mismatch throw is
# unreachable precisely when the test pins nothing, so its add-side
# credit would certify that shape. The del/blob RE above keeps it:
# REMOVING such a line still counts — the fail-closed asymmetry.
WEAKEN_ASSERT_ADD_RE='(^|[^A-Za-z0-9_$.])assert(\(|\.[A-Za-z_$][A-Za-z0-9_$]*\()|(^|[^A-Za-z0-9_$.])expect(\.poll)?\(.*\)[[:space:]]*\.[A-Za-z_$][A-Za-z0-9_$]*([[:space:]]*\.[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*)*[[:space:]]*[(?]|(^|[^A-Za-z0-9_$.])expect\.(soft|hasAssertions|unreachable)\(|\.expect(\.poll)?\(.*\)[[:space:]]*\.[A-Za-z_$][A-Za-z0-9_$]*([[:space:]]*\.[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*)*[[:space:]]*[(?]'
# Marker shapes beyond the dotted one-line form: a concurrent/
# sequential/shuffle chain ahead of the modifier (test.concurrent.skip(),
# describe.concurrent.skip()) or BEHIND it (it.skip.concurrent( — vitest
# registers the skip either way), the optional-chaining spellings
# it?.skip( and it.skip?.(, the tagged-template each tail
# (it.skip.each`table`), and the computed-property accessor quoted with
# a single, double, or BACKTICK quote (it['skip']('a', ...)).
# Newline-split member chains (it / .skip( on two lines — valid JS
# running as it.skip) are measured on the joined view
# weaken_join_markers produces below. Three further disable surfaces:
# suite — vitest's fourth collector — in the collector roots; the
# options-object form test('x', { skip: true }, fn), which carries no
# collector modifier (the value must be the true LITERAL: a
# condition-valued skip is this repo's skipIf environment-guard idiom
# and stays exempt like .skipIf); and the runtime body call skip( —
# ctx.skip() disables a pre-existing test with no collector edit. The
# body arm demands ( immediately after skip so .skipIf( stays exempt.
# shellcheck disable=SC2016  # the $ bytes are regex character-class literals, not shell expansions
WEAKEN_SKIP_RE='(^|[^A-Za-z0-9_$.])(it|test|describe|suite)[[:space:]]*([?]?[.][[:space:]]*(concurrent|sequential|shuffle)[[:space:]]*)*[?]?[.][[:space:]]*(skip|todo|fails|failing)([[:space:]]*[?]?[.][[:space:]]*(each|for|concurrent|sequential|shuffle)[[:space:]]*)*[[:space:]]*([?][.])?[(<`]|(^|[^A-Za-z0-9_$.])(it|test|describe|suite)[[:space:]]*\[[[:space:]]*('\''|"|`)(skip|todo|fails|failing)('\''|"|`)[[:space:]]*\][[:space:]]*([?][.])?[(<`]|(^|[^A-Za-z0-9_$.])x(it|describe)([[:space:]]*\.[[:space:]]*each)?[[:space:]]*\(|(^|[^A-Za-z0-9_$.])(it|test|describe|suite)[[:space:]]*\(.+[{,][[:space:]]*(skip|todo)[[:space:]]*:[[:space:]]*true|(^|[^A-Za-z0-9_$])skip\('
# Measured weakenings travel as parallel indexed arrays, never a
# newline/tab-joined string: filenames are branch-controlled bytes, and a
# name carrying a newline or tab splits a delimited record into fragments
# an ack loop then matches separately -- acknowledging the FRAGMENTS while
# the actually-weakened file carries no evidence.
WEAKENED_PATHS=()
WEAKENED_SIGNALS=()
WEAKENED_CHARGED=()
WEAKEN_MEASURED='true'
# Parallel indexed arrays, not bash-4 associative arrays: this section
# precedes the bite section's mapfile builtin (bash 4.4) -- the first
# bash-4 boundary the test suite's host probe gates. On the bash-3.2 macOS
# lane an unconditional bash-4 builtin here would abort every runGate spawn
# before any verdict.
WEAKEN_FILE_LIST=()
WEAKEN_DEL_ACC=()
WEAKEN_ADD_ACC=()
WEAKEN_SKIP_ADD_ACC=()
WEAKEN_SKIP_DEL_ACC=()
# Test files a main-derived merge of THIS round landed (status A at the
# merge): for the round's own post-merge commits they are pre-existing
# coverage exactly like the pre-round ref's files -- main's newly landed
# tests may not be silently weakened or deleted in the same round.
WEAKEN_MERGE_INTRODUCED=()
# Files measured at a main-derived merge commit: the byte-identity tip
# netting may not drop their charges, because for an --ours resolution
# the damage IS the identity with the pre-round bytes.
WEAKEN_MERGE_TOUCHED=()
# Oldest-first: a merge's WEAKEN_MERGE_INTRODUCED seed must land before
# the post-merge commits that consult it, and a pre-round-baseline re-add
# measurement reads the accumulators the earlier commits filled.
WEAKEN_ROUND_COMMITS="$(git rev-list --first-parent --reverse "origin/${BRANCH}..${BRANCH}" 2> /dev/null)" || WEAKEN_MEASURED='false'
# The accumulator slot holding ${1}'s counts, or failure on first sight.
weaken_file_slot() {
  local f="${1}" weaken_i
  for (( weaken_i = 0; weaken_i < ${#WEAKEN_FILE_LIST[@]}; weaken_i++ )); do
    if [[ "${WEAKEN_FILE_LIST[weaken_i]}" == "${f}" ]]; then
      printf '%s\n' "${weaken_i}"
      return 0
    fi
  done
  return 1
}
# Success when ${1} exactly matches one of the remaining arguments.
weaken_member() {
  local f="${1}" weaken_e
  shift
  for weaken_e in "$@"; do
    if [[ "${weaken_e}" == "${f}" ]]; then
      return 0
    fi
  done
  return 1
}
# Drop comment text so a commented-out copy of a removed assertion neither
# shields an addition nor masks a removal. Both TS comment forms: //-to-EOL
# and /* ... */ spans, the block state carried across lines. String and
# template literals are STATE-tracked — an in-string /* cannot open the
# block state and discard a genuine marker that follows in the same
# stream — but their CONTENTS stay in the output: the skip patterns read
# quoted names (it['skip']) and backtick call tails (it.skip.each`table`),
# and a removed line with an in-string // must still measure. Applied to
# the ADDED side and to the del-side skip-marker count only; the del-side
# ASSERTION count stays raw.
weaken_strip_comments() {
  awk '
    BEGIN { inc = 0; q = ""; tpl = 0 }
    {
      line = $0; out = ""; n = length(line); i = 1
      while (i <= n) {
        ch = substr(line, i, 1); nx = substr(line, i + 1, 1)
        if (inc) {
          if (ch == "*" && nx == "/") { inc = 0; i += 2 } else { i += 1 }
          continue
        }
        if (q != "") {
          if (q == "`" && ch == "$" && nx == "{") { out = out ch nx; tpl += 1; br[tpl] = 0; q = ""; i += 2; continue }
          if (ch == "\\") { out = out ch nx; i += 2; continue }
          out = out ch
          if (ch == q) q = ""
          i += 1
          continue
        }
        if (ch == "}" && tpl > 0) {
          if (br[tpl] > 0) { br[tpl] -= 1 } else { q = "`"; tpl -= 1 }
          out = out ch; i += 1; continue
        }
        if (ch == "/" && nx == "/") break
        if (ch == "/" && nx == "*") { inc = 1; i += 2; continue }
        if (ch == "\047" || ch == "\"" || ch == "`") { q = ch }
        if (ch == "{" && tpl > 0) br[tpl] += 1
        out = out ch; i += 1
      }
      if (q != "`") q = ""
      if (out !~ /^[[:space:]]*$/) print out
    }' | sed -e '/^[[:space:]]*\*/d'
}
# Comment stripping PLUS string-literal contents, applied to WHOLE blobs
# with both states carried across lines -- the blob-density cross-check
# below. A decoy `expect(` inside a string literal must earn no assertion
# credit, and a decoy line inside a block comment opened ABOVE the diff
# hunk is only inside it when the state arrives from the unchanged bytes.
# Regex literals are state-tracked too, keyed on the last significant
# TOKEN, not just the last character: a preceding operator (including a
# division '/'), a regex-head keyword (return/typeof/yield/..., preserved
# across whitespace), a CONTROL-head close paren, or line start opens a
# literal; a value ahead (identifier, number, string, call close paren,
# ']') means division. The char alone cannot tell if (one()) /re/ from
# foo() / 2, so the paren kind is tracked on a depth stack, and cannot
# see through the space in typeof /.../. An inert expect( decoy inside
# /expect(x)?/ thus earns no credit, and a /[...]/ class carrying /*
# cannot open the block state and swallow the assertions that follow.
# Template nesting is tracked by depth: an inner backtick under ${}
# closes the NESTED template, not the outer one, and a hole closes on
# the brace matching ITS ${ -- per-hole brace depth, not the first }
# byte, or an object literal inside the hole re-enters template state
# early and swallows the live code up to the next backtick.
# Single- and double-quoted strings cannot span lines in TS, so a
# dangling quote at EOL closes there; a
# template literal carries on. A regex literal cannot: an unterminated
# one at EOL drops its state rather than swallowing the next line.
weaken_strip_code() {
  awk '
    function flushident() {
      if (ident == "") return
      pltok = ltok
      if (ident ~ /^(return|typeof|yield|await|throw|void|delete|do|else|in|of|case|new|instanceof|if|for|while|switch|catch|with)$/) ltok = ident
      else ltok = "id"
      ident = ""
    }
    BEGIN { inc = 0; q = ""; tpl = 0; regx = 0; rcls = 0; ltok = ""; pltok = ""; ident = ""; pd = 0 }
    {
      line = $0; out = ""; n = length(line); i = 1
      regx = 0; rcls = 0
      while (i <= n) {
        ch = substr(line, i, 1); nx = substr(line, i + 1, 1)
        if (inc) {
          if (ch == "*" && nx == "/") { inc = 0; i += 2 } else { i += 1 }
          continue
        }
        if (regx) {
          if (ch == "\\") { i += 2 }
          else if (rcls) { if (ch == "]") rcls = 0; i += 1 }
          else if (ch == "[") { rcls = 1; i += 1 }
          else if (ch == "/") { regx = 0; ltok = "str"; i += 1 }
          else { i += 1 }
          continue
        }
        if (q != "") {
          if (ch == "\\") { i += 2 }
          else if (q == "`" && ch == "$" && nx == "{") { tpl += 1; br[tpl] = 0; q = ""; ltok = ""; i += 2 }
          else if (ch == q) { q = ""; ltok = "str"; i += 1 }
          else { i += 1 }
          continue
        }
        if (ch == "}" && tpl > 0) {
          flushident()
          if (br[tpl] > 0) { br[tpl] -= 1; out = out ch; ltok = "}"; i += 1; continue }
          q = "`"; tpl -= 1; ltok = ""; i += 1; continue
        }
        if (ch == "/" && nx == "/") break
        if (ch == "/" && nx == "*") { flushident(); inc = 1; i += 2; continue }
        if (ch == "/") {
          flushident()
          if (ltok == "" || ltok == ")ctl" || ltok ~ /^[=(,:;!&|?{}+*%~^<>\[\/-]$/ || ltok ~ /^(return|typeof|yield|await|throw|void|delete|do|else|in|of|case|new|instanceof)$/) { regx = 1; i += 1; continue }
          out = out ch; ltok = "/"; i += 1; continue
        }
        if (ch == "\047" || ch == "\"" || ch == "`") { flushident(); q = ch; i += 1; continue }
        if (ch ~ /[A-Za-z0-9_$]/) { ident = ident ch; out = out ch; i += 1; continue }
        flushident()
        if (ch == "(") { pd += 1; pk[pd] = (ltok ~ /^(if|for|while|switch|catch|with)$/) ? 1 : 0; pltok = ltok; ltok = "(" }
        else if (ch == ")") { ctl = (pd > 0 && pk[pd]); if (pd > 0) pd -= 1; pltok = ltok; ltok = (ctl ? ")ctl" : ")") }
        else if (ch !~ /[[:space:]]/) {
          # Postfix ++/-- (and a TS postfix !) FOLLOW a value: the '/'
          # after n++ / n-- / x! is division, not a regex head. pltok is
          # the token class ahead of the PREVIOUS operator char, so a
          # duplicated + or - with a value behind it resolves as a value
          # itself; an adjacent-byte check keeps n + +x unary (a space
          # breaks adjacency). A prefix ! after an operator or at line
          # start keeps the regex-head behavior.
          if ((ch == "+" || ch == "-") && substr(line, i - 1, 1) == ch && pltok ~ /^(id|str|[)\]])$/) { pltok = ltok; ltok = "id" }
          else if (ch == "!" && ltok ~ /^(id|str|[)\]])$/) { pltok = ltok; ltok = "id" }
          else { pltok = ltok; ltok = ch }
        }
        if (ch == "{" && tpl > 0) br[tpl] += 1
        out = out ch; i += 1
      }
      flushident()
      if (q != "" && q != "`") q = ""
      if (out !~ /^[[:space:]]*$/) print out
    }'
}
# Join newline-split member chains so a marker written across lines
# measures like the one-line form: carry a one-line buffer, appending the
# current line while the joined line still ends in a marker-chain head
# (it/test/describe, an optional modifier chain, a trailing dot).
weaken_join_markers() {
  awk '
    {
      if (buf == "") buf = $0
      else buf = buf $0
      if (buf ~ /(^|[^A-Za-z0-9_$.])(it|test|describe)([[:space:]]*\.[[:space:]]*(concurrent|sequential|shuffle|skip|todo|fails|failing|each|for))*[[:space:]]*\.?[[:space:]]*$/) next
      print buf; buf = ""
    }
    END { if (buf != "") print buf }'
}
# Count the lines of ${1} that match regex ${3} and whose exact text is
# absent from ${2}: the per-line freight census the merge blob arm uses.
# Both blobs arrive through the same strip, so only untouched regions
# net to zero; the sets compare byte-for-byte on the stripped lines.
weaken_count_absent() {
  # The pattern travels through ENVIRON, never -v: POSIX mandates escape
  # processing on -v assignment values, so the shared ERE's \( and \.
  # would arrive rewritten as ( and . — an unbalanced pattern gawk
  # fatals on before END (busybox strips it silently), the substitution
  # captures nothing, and the census silently degrades to zero. ENVIRON
  # values are not escape-processed; the bytes stay identical to the
  # grep -cE sites that consume the same variable.
  WEAKEN_COUNT_RE="${3}" awk '
    BEGIN { re = ENVIRON["WEAKEN_COUNT_RE"] }
    NR == FNR { seen[$0] = 1; next }
    $0 ~ re && !($0 in seen) { c += 1 }
    END { print c + 0 }
  ' <(printf '%s\n' "${2}") <(printf '%s\n' "${1}")
}
# Fold one commit's diff of one test file into the per-file accumulators.
# When ${3} is set the commit is a merge whose second parent is derived
# from origin/main: the same file at that parent decides line authorship,
# keeping only what the merge resolution itself authored.
weaken_count_commit_file() {
  local c="${1}" f="${2}" is_merge="${3}" pre_base="${4:-}" p2='' have_p2='' kept='' mb='' base_blob='' l diff_body add_lines del_lines weaken_slot weaken_has_edits='' weaken_old='' weaken_new='' weaken_old_stripped='' weaken_new_stripped='' weaken_old_n weaken_new_n weaken_o weaken_old_skip_n weaken_new_skip_n weaken_s weaken_mb_stripped='' weaken_p2_stripped='' weaken_freight_del weaken_freight_add weaken_skip_freight_del weaken_skip_freight_add
  # A status-A re-add of a pre-existing path measures against the
  # PRE-ROUND blob, not the commit's parent: main's deletion rode the
  # merge in as freight, so the parent side is empty and the re-add
  # would net as pure addition.
  local old_ref="${c}^"
  if [[ -n "${pre_base}" ]]; then
    old_ref="origin/${BRANCH}"
  fi
  if [[ -n "${is_merge}" ]]; then
    # An empty blob is not a missing one: key the freight filter on git
    # show's exit status, so a modify/delete resolution (main deleted the
    # file, the resolution kept it) cannot degrade p2 to '' and drop EVERY
    # removed line.
    if p2="$(git show "${c}^2:${f}" 2> /dev/null)"; then
      have_p2=1
    else
      p2=''
    fi
    # A modify/delete resolution that KEEPS the file authors every line
    # that survives it: main's side has no blob to freight against, so
    # none of the kept-side removals may hide behind main's deletion.
    # Full freight applies only when the result deletes the file too.
    if [[ -z "${have_p2}" ]] && git cat-file -e "${c}:${f}" 2> /dev/null; then
      kept=1
    fi
  fi
  # --text: a branch-controlled .gitattributes rule (`<file> -diff` or
  # `binary`) otherwise collapses this hunk into the "Binary files differ"
  # banner -- no @@ content, every counter zeroed while the file still
  # enumerates as changed.
  if ! diff_body="$(git diff --text -U0 --no-renames "${old_ref}" "${c}" -- ":(literal)${f}" 2> /dev/null)"; then
    return 1
  fi
  # Everything from the first `@@` on is hunk content, so the ---/+++ file
  # headers are dropped by construction rather than by a `^+[^+]` guard that
  # would also eat the first CONTENT character (and with it every marker
  # anchored at column 1, `it.skip(` among them). -U0 emits no context lines,
  # so each remaining +/- line is a real edit; stripping the marker lets the
  # patterns below anchor on the source line itself.
  diff_body="$(sed -n '/^@@/,$p' <<< "${diff_body}")"
  add_lines="$(sed -n 's/^+//p' <<< "${diff_body}")"
  del_lines="$(sed -n 's/^-//p' <<< "${diff_body}")"
  [[ -n "${add_lines}" || -n "${del_lines}" ]] && weaken_has_edits=1
  # An --ours resolution keeps the branch side byte-identical, so the
  # first-parent diff body is empty -- yet the resolution discarded
  # everything main's side added. The second-parent diff is the edit
  # evidence for the blob-density cross-check in that shape.
  if [[ -n "${is_merge}" ]] &&
    ! git diff --quiet --no-renames "${c}^2" "${c}" -- ":(literal)${f}" 2> /dev/null; then
    weaken_has_edits=1
  fi
  if [[ -n "${is_merge}" ]]; then
    add_lines="$(while IFS= read -r l; do
      if [[ -n "${l}" ]] && ! grep -qxF -- "${l}" <<< "${p2}"; then
        printf '%s\n' "${l}"
      fi
    done <<< "${add_lines}")"
    # A removed line is freight only when MAIN deleted it: present at the
    # merge base and absent from main's side (or main's side has no blob at
    # all). A branch-authored line the resolution dropped is the round's
    # own weakening and is charged -- and when the resolution KEPT a file
    # main deleted (kept above), every surviving line is resolution-
    # authored, so no removal is freight at all.
    mb="$(git merge-base "${c}^" "${c}^2" 2> /dev/null)" || mb=''
    if [[ -n "${mb}" ]]; then
      base_blob="$(git show "${mb}:${f}" 2> /dev/null)" || base_blob=''
    else
      base_blob=''
    fi
    del_lines="$(while IFS= read -r l; do
      if [[ -z "${l}" ]]; then
        continue
      fi
      if [[ -z "${kept}" ]] && grep -qxF -- "${l}" <<< "${base_blob}" &&
        { [[ -z "${have_p2}" ]] || ! grep -qxF -- "${l}" <<< "${p2}"; }; then
        continue
      fi
      printf '%s\n' "${l}"
    done <<< "${del_lines}")"
  fi
  # Assertion counts: removed lines count RAW and added lines count after
  # comment-and-string-aware stripping, so a commented-out copy of a
  # removed assertion cannot cancel it. An over-charge on the raw del side
  # (a commented-out assertion deletion) fails closed -- one ack entry
  # answers it -- while an over-credit on the add side would fail open,
  # which is what the stripping prevents.
  # Skip-marker counts read the stripped view on BOTH sides, and the
  # joined view: sd's over-count SUBTRACTS, so a deleted comment line
  # that merely contains marker text must not earn the removal credit
  # that cancels a genuine marker addition.
  add_lines="$(weaken_strip_comments <<< "${add_lines}")"
  add_lines="$(weaken_join_markers <<< "${add_lines}")"
  local del_stripped
  del_stripped="$(weaken_strip_comments <<< "${del_lines}")"
  del_stripped="$(weaken_join_markers <<< "${del_stripped}")"
  local d a sa sd
  d="$(grep -cE "${WEAKEN_ASSERT_RE}" <<< "${del_lines}" || true)"
  a="$(grep -cE "${WEAKEN_ASSERT_ADD_RE}" <<< "${add_lines}" || true)"
  sa="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${add_lines}" || true)"
  sd="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${del_stripped}" || true)"
  if [[ -n "${weaken_has_edits}" ]]; then
    # The line counters grep diff LINES for assertion tokens, and -U0
    # anchors a byte-identical line as implicit context: an assertion
    # wrapped into a MULTI-line /* ... */ comment never appears in the
    # diff at all, a sibling value change lets the wrap ride on a moved
    # line signal, and a decoy token inside a string literal or a block
    # comment opened above the hunk earns an addition credit that
    # cancels a genuine removal. Cross-check the WHOLE blobs on every
    # edited file instead of only the zero-signal ones: symmetric
    # string-and-comment-aware stripping nets every untouched region to
    # zero, so the blob delta sees exactly what the edits removed, and
    # take whichever signal measures more deletion. The skip-marker net
    # gets the same whole-blob backstop below. A merge's blob delta
    # carries main-side freight exactly like the line counts: subtract
    # main's own density delta so it neither charges nor shields.
    weaken_old="$(git show "${old_ref}:${f}" 2> /dev/null)" || weaken_old=''
    weaken_new="$(git show "${c}:${f}" 2> /dev/null)" || weaken_new=''
    weaken_old_stripped="$(weaken_strip_code <<< "${weaken_old}")"
    weaken_new_stripped="$(weaken_strip_code <<< "${weaken_new}")"
    weaken_old_n="$(grep -cE "${WEAKEN_ASSERT_RE}" <<< "${weaken_old_stripped}" || true)"
    weaken_new_n="$(grep -cE "${WEAKEN_ASSERT_RE}" <<< "${weaken_new_stripped}" || true)"
    weaken_o=$(( weaken_old_n - weaken_new_n ))
    weaken_old_skip_n="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${weaken_old_stripped}" || true)"
    weaken_new_skip_n="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${weaken_new_stripped}" || true)"
    weaken_s=$(( weaken_new_skip_n - weaken_old_skip_n ))
    if [[ -n "${is_merge}" && -z "${kept}" ]]; then
      weaken_mb_stripped="$(weaken_strip_code <<< "${base_blob}")"
      weaken_p2_stripped="$(weaken_strip_code <<< "${p2}")"
      # Freight is classified per LINE, never a subtraction of whole-blob
      # density totals: git keeps an addition that branch AND main both
      # made byte-identically ONCE in the result, so a total-level
      # subtraction counts it twice — a phantom positive weaken_o that
      # rejects an honest merge. Charge what MAIN removed (present at the
      # merge base, absent from main's side) and credit what main added
      # that the branch did not already carry — the same classification
      # the line arm applies per diff line.
      weaken_freight_del="$(weaken_count_absent "${weaken_mb_stripped}" "${weaken_p2_stripped}" "${WEAKEN_ASSERT_RE}")"
      weaken_freight_add="$(weaken_count_absent "${weaken_p2_stripped}" "${weaken_mb_stripped}"$'\n'"${weaken_old_stripped}" "${WEAKEN_ASSERT_RE}")"
      weaken_o=$(( weaken_o - (weaken_freight_del - weaken_freight_add) ))
      # The skip arm gets the same per-marker classification, mirrored
      # for its addition direction: a marker MAIN removed deflates the
      # result census and is added back; a marker main ADDED that the
      # branch did not already carry inflates it and is subtracted. The
      # whole-blob total subtraction this replaces counted a marker both
      # sides added byte-identically ONCE in the result but twice in the
      # totals — deflating a genuine resolution-introduced skip, the
      # shielding direction of the gate's freight invariant.
      weaken_skip_freight_del="$(weaken_count_absent "${weaken_mb_stripped}" "${weaken_p2_stripped}" "${WEAKEN_SKIP_RE}")"
      weaken_skip_freight_add="$(weaken_count_absent "${weaken_p2_stripped}" "${weaken_mb_stripped}"$'\n'"${weaken_old_stripped}" "${WEAKEN_SKIP_RE}")"
      weaken_s=$(( weaken_s - (weaken_skip_freight_add - weaken_skip_freight_del) ))
    fi
    if (( weaken_o > 0 && weaken_o > d - a )); then
      d=$(( a + weaken_o ))
    fi
    # The skip arm's whole-blob backstop, twin of the assertion one: the
    # line counts cold-start their comment strip at the hunk boundary, so
    # a block-comment span opened in unchanged bytes ABOVE the hunk can
    # hand a deleted in-span marker line removal credit it never earned,
    # or swallow a genuine marker addition. The blob delta carries the
    # state in from the unchanged bytes; the larger addition wins.
    if (( weaken_s > 0 && weaken_s > sa - sd )); then
      sa=$(( sd + weaken_s ))
    fi
  fi
  if ! weaken_slot="$(weaken_file_slot "${f}")"; then
    weaken_slot="${#WEAKEN_FILE_LIST[@]}"
    WEAKEN_FILE_LIST[weaken_slot]="${f}"
    WEAKEN_DEL_ACC[weaken_slot]=0
    WEAKEN_ADD_ACC[weaken_slot]=0
    WEAKEN_SKIP_ADD_ACC[weaken_slot]=0
    WEAKEN_SKIP_DEL_ACC[weaken_slot]=0
  fi
  WEAKEN_DEL_ACC[weaken_slot]="$(( WEAKEN_DEL_ACC[weaken_slot] + d ))"
  WEAKEN_ADD_ACC[weaken_slot]="$(( WEAKEN_ADD_ACC[weaken_slot] + a ))"
  WEAKEN_SKIP_ADD_ACC[weaken_slot]="$(( WEAKEN_SKIP_ADD_ACC[weaken_slot] + sa ))"
  WEAKEN_SKIP_DEL_ACC[weaken_slot]="$(( WEAKEN_SKIP_DEL_ACC[weaken_slot] + sd ))"
}
while IFS= read -r c; do
  [[ -n "${c}" ]] || continue
  [[ "${WEAKEN_MEASURED}" == 'true' ]] || break
  if ! git rev-parse -q --verify "${c}^" > /dev/null 2>&1; then
    WEAKEN_MEASURED='false'
    break
  fi
  # Freight attribution only when the second parent is main-derived
  # (--is-ancestor, not equality: origin/main may have advanced past the
  # merge point). A side-branch merge has no main side: its first-parent
  # diff belongs to the round, and treating the weakened side branch as
  # "main's side" would invert the attribution and zero every signal.
  is_merge=''
  if git rev-parse -q --verify "${c}^2" > /dev/null 2>&1 &&
    git merge-base --is-ancestor "${c}^2" origin/main 2> /dev/null; then
    is_merge=1
    # The merge's status-A pathspec files are main's newly landed tests;
    # for the round's OWN post-merge commits they are pre-existing
    # coverage the freight machinery must no longer shield.
    while IFS= read -r -d '' weaken_mf; do
      [[ -n "${weaken_mf}" ]] || continue
      WEAKEN_MERGE_INTRODUCED+=("${weaken_mf}")
    done < <(git diff --name-only -z --no-renames --diff-filter=A "${c}^" "${c}" \
      -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
    # A merge that wholesale DISCARDS a test main added during the round
    # never shows the file at the merge RESULT (absent on both sides):
    # the status-A feeder above misses it, and the pre-existence guard
    # then drops the second-parent enumeration's only listing. Seed the
    # introduction set from what main added relative to the branch side
    # too; the discard then measures as a weakening of main's newly
    # landed coverage, while a merge that KEEPS main's file adds a name
    # both feeders agree on (deduplicated here).
    while IFS= read -r -d '' weaken_mf; do
      [[ -n "${weaken_mf}" ]] || continue
      if ! weaken_member "${weaken_mf}" "${WEAKEN_MERGE_INTRODUCED[@]}"; then
        WEAKEN_MERGE_INTRODUCED+=("${weaken_mf}")
      fi
    done < <(git diff --name-only -z --no-renames --diff-filter=A "${c}^" "${c}^2" \
      -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
  fi
  # M, D, and T: a file deleted in one round commit and re-added weakened in
  # a later one escapes a modify-only scan (the delete commit is D, the
  # re-add A, neither M), and a pre-existing file replaced by a symlink is
  # status T while still matching the pathspec and existing at the tip. The
  # pre-round pre-existence guard below keeps a genuinely round-introduced
  # file out of the D arm of this filter. A main-derived merge additionally
  # enumerates the union of BOTH parents' views: a resolution that keeps
  # the branch side byte-identical (--ours) leaves the first-parent diff
  # empty while discarding main-side additions, so only the second-parent
  # diff lists the file.
  weaken_commit_files=()
  while IFS= read -r -d '' f; do
    [[ -n "${f}" ]] || continue
    weaken_commit_files+=("${f}")
  done < <(git diff --name-only -z --no-renames --diff-filter=MDT "${c}^" "${c}" \
    -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
  if [[ -n "${is_merge}" ]]; then
    while IFS= read -r -d '' f; do
      [[ -n "${f}" ]] || continue
      if ! weaken_member "${f}" "${weaken_commit_files[@]}"; then
        weaken_commit_files+=("${f}")
      fi
    done < <(git diff --name-only -z --no-renames --diff-filter=MDT "${c}^2" "${c}" \
      -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
  fi
  for f in "${weaken_commit_files[@]}"; do
    # Pre-existing means present at the PRE-ROUND ref — or landed by one
    # of this round's own main-derived merges: for the round's post-merge
    # commits, main's newly landed tests are coverage the round owes,
    # whether it weakens them (status M here) or deletes them (status D).
    if ! git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null &&
      ! weaken_member "${f}" "${WEAKEN_MERGE_INTRODUCED[@]}"; then
      continue
    fi
    if [[ -n "${is_merge}" ]]; then
      WEAKEN_MERGE_TOUCHED+=("${f}")
    fi
    if ! weaken_count_commit_file "${c}" "${f}" "${is_merge}"; then
      WEAKEN_MEASURED='false'
      break
    fi
  done
  [[ "${WEAKEN_MEASURED}" == 'true' ]] || break
  # A status-A re-add of a path that WAS pre-existing: main deleted the
  # file, the round merged the deletion in as freight, and the round's own
  # commit re-added the file weakened — status A is outside the MDT
  # enumeration above, and the net-range D arm never lists a file present
  # at the tip. Measured against the PRE-ROUND blob (the fourth argument),
  # the re-add nets exactly what the round's authorship removed. The
  # guard keeps a round-introduced file out: its re-adds have no
  # pre-round coverage to weaken.
  while IFS= read -r -d '' f; do
    [[ -n "${f}" ]] || continue
    if ! git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null; then
      continue
    fi
    if ! weaken_count_commit_file "${c}" "${f}" '' 'preround'; then
      WEAKEN_MEASURED='false'
      break
    fi
  done < <(git diff --name-only -z --no-renames --diff-filter=A "${c}^" "${c}" \
    -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
done <<< "${WEAKEN_ROUND_COMMITS}"
if [[ "${WEAKEN_MEASURED}" == 'true' ]]; then
  # Insertion order is deterministic (round commits in rev-list order, each
  # commit's files in diff order), so the indexed accumulators need no sort.
  for (( weaken_idx = 0; weaken_idx < ${#WEAKEN_FILE_LIST[@]}; weaken_idx++ )); do
    f="${WEAKEN_FILE_LIST[weaken_idx]}"
    # A file byte-identical between the pre-round ref and the tip netted
    # out over the round whichever commit sequence produced it: the
    # per-commit arm charges a deletion by its full line count (the D
    # filter), while a later byte-identical restore is status A, outside
    # that filter, and never earns an offsetting credit. The netting
    # principle reads the tip, not the sequence — and it applies only
    # when the tip reading is meaningful: a file absent at the pre-round
    # ref reads absent-on-both-sides as identity (masking the deletion of
    # a test a round merge landed), and a file a main-derived merge
    # touched is exempt because an --ours resolution's damage IS the
    # identity with the pre-round bytes.
    if git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null &&
      ! weaken_member "${f}" "${WEAKEN_MERGE_TOUCHED[@]}" &&
      git diff --quiet "origin/${BRANCH}" "${BRANCH}" -- ":(literal)${f}" 2> /dev/null; then
      continue
    fi
    w_del="${WEAKEN_DEL_ACC[weaken_idx]}"
    w_add="${WEAKEN_ADD_ACC[weaken_idx]}"
    w_skip_add="${WEAKEN_SKIP_ADD_ACC[weaken_idx]}"
    w_skip_del="${WEAKEN_SKIP_DEL_ACC[weaken_idx]}"
    # The whole-blob backstops adjudicate within a SINGLE commit while
    # the accumulators net credits across ALL round commits: a decoy
    # credit committed as a SIBLING commit to the weakening it cancels
    # escapes both. Recount the whole round at verdict time — stripped
    # pre-round and tip densities per arm, the larger signal wins, the
    # same rule the per-commit arms apply within one commit. Files a
    # main-derived merge touched are exempt: their per-commit result
    # carries the freight attribution, and a pre->tip recount would
    # charge main's own delta that crossed the merge.
    if ! weaken_member "${f}" "${WEAKEN_MERGE_TOUCHED[@]}" &&
      git cat-file -e "origin/${BRANCH}:${f}" 2> /dev/null &&
      git cat-file -e "${BRANCH}:${f}" 2> /dev/null; then
      weaken_round_old="$(git show "origin/${BRANCH}:${f}" 2> /dev/null)" || weaken_round_old=''
      weaken_round_new="$(git show "${BRANCH}:${f}" 2> /dev/null)" || weaken_round_new=''
      weaken_round_old_stripped="$(weaken_strip_code <<< "${weaken_round_old}")"
      weaken_round_new_stripped="$(weaken_strip_code <<< "${weaken_round_new}")"
      weaken_round_old_n="$(grep -cE "${WEAKEN_ASSERT_RE}" <<< "${weaken_round_old_stripped}" || true)"
      weaken_round_new_n="$(grep -cE "${WEAKEN_ASSERT_RE}" <<< "${weaken_round_new_stripped}" || true)"
      if (( weaken_round_old_n - weaken_round_new_n > w_del - w_add )); then
        w_del=$(( w_add + weaken_round_old_n - weaken_round_new_n ))
      fi
      weaken_round_old_skip_n="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${weaken_round_old_stripped}" || true)"
      weaken_round_new_skip_n="$(grep -cE "${WEAKEN_SKIP_RE}" <<< "${weaken_round_new_stripped}" || true)"
      if (( weaken_round_new_skip_n - weaken_round_old_skip_n > w_skip_add - w_skip_del )); then
        w_skip_add=$(( w_skip_del + weaken_round_new_skip_n - weaken_round_old_skip_n ))
      fi
    fi
    if (( w_del > w_add )); then
      WEAKENED_PATHS+=("${f}")
      WEAKENED_SIGNALS+=("net $(( w_del - w_add )) assertion line(s) removed")
      WEAKENED_CHARGED+=("${f}")
    elif (( w_skip_add > w_skip_del )); then
      WEAKENED_PATHS+=("${f}")
      WEAKENED_SIGNALS+=("$(( w_skip_add - w_skip_del )) skip/todo marker(s) added")
      WEAKENED_CHARGED+=("${f}")
    fi
  done
fi
# Deletions cannot use not_merge_freight: its content-equality test reads
# "absent on both sides" as identical, so a round deleting a test the PR
# ITSELF added (the classic round-5-deletes-what-round-3-pinned shape) looks
# like freight and escapes. The distinguishing fact is the MERGE BASE — main
# can only delete what it tracked, so freight is exactly "present at the
# merge base, gone from main's tip". A PR-added test is in neither. When
# the merge base is unresolvable PR_BASE degrades to origin/main above,
# which makes this condition unsatisfiable — every deletion is then
# surfaced rather than silently dropped, and the escape hatch is one
# recorded entry.
while IFS= read -r -d '' f; do
  [[ -n "${f}" ]] || continue
  if git cat-file -e "${PR_BASE}:${f}" 2> /dev/null &&
    ! git cat-file -e "origin/main:${f}" 2> /dev/null; then
    continue
  fi
  # The per-commit arm already charged this file (a single delete, or a
  # delete in one round commit re-added weakened in another): a second
  # entry for the same path would duplicate the rejection and the advisory.
  if weaken_member "${f}" "${WEAKENED_CHARGED[@]}"; then
    continue
  fi
  WEAKENED_PATHS+=("${f}")
  WEAKENED_SIGNALS+=('test file deleted')
done < <(git diff --name-only -z --no-renames --diff-filter=D "origin/${BRANCH}" "${BRANCH}" \
  -- "${WEAKEN_PATHSPEC[@]}" 2> /dev/null)
# Deletions are judged even when the per-commit measurement went
# UNAVAILABLE: the explicit pre-round->tip pair above does not need the
# round's own history to be walkable (a parent-less root in a rebuilt
# branch breaks the rev-list walk, not this net-range diff). UNAVAILABLE
# skips the measured signals only — never a deletion.
if (( ${#WEAKENED_PATHS[@]} > 0 )); then
  # The acknowledgement is the agent's own machine-readable claim, held to
  # the same shape rules as deferred-findings.json: an array, a string path,
  # and a reason with enough substance to be read as evidence. A malformed or
  # unreadable file acknowledges nothing rather than everything.
  # Acknowledged paths travel base64-encoded: newline-safe through the
  # line-based read below, and comparable against the measured set without
  # ever decoding branch-controlled bytes through shell parsing.
  WEAKEN_ACKED=()
  if [[ -s "${WORKDIR}/test-weakening.json" ]]; then
    weaken_ack_b64="$(jq -j '
      if type == "array" then
        .[]
        | select((.path? | type) == "string")
        | select((.path | length) > 0)
        | select((.reason? | type) == "string")
        | select((.reason | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ") | length) >= 40)
        | (.path | @base64) + "\n"
      else empty end' "${WORKDIR}/test-weakening.json" 2> /dev/null)" || weaken_ack_b64=''
    while IFS= read -r weaken_entry; do
      [[ -n "${weaken_entry}" ]] && WEAKEN_ACKED+=("${weaken_entry}")
    done <<< "${weaken_ack_b64}"
  fi
  WEAKEN_MISSING=''
  WEAKEN_OK=''
  WEAKEN_OK_B64=''
  for (( weaken_idx = 0; weaken_idx < ${#WEAKENED_PATHS[@]}; weaken_idx++ )); do
    f="${WEAKENED_PATHS[weaken_idx]}"
    signal="${WEAKENED_SIGNALS[weaken_idx]}"
    # Filenames are branch-controlled bytes rendered inside gate-authored
    # (trusted-voice) documents, so they go through the same conservative
    # safe-character set the shrink advisory above uses.
    if weaken_member "$(printf '%s' "${f}" | base64 | tr -d '\n')" "${WEAKEN_ACKED[@]}"; then
      WEAKEN_OK+="- \`${f//[^A-Za-z0-9._\/ -]/?}\` — ${signal}"$'\n'
      WEAKEN_OK_B64+="$(printf '%s' "${f}" | base64 | tr -d '\n')"$'\n'
    else
      WEAKEN_MISSING+="- \`${f//[^A-Za-z0-9._\/ -]/?}\` — ${signal}"$'\n'
    fi
  done
  if [[ -n "${WEAKEN_MISSING}" ]]; then
    {
      echo 'This round deleted or weakened pre-existing tests without recording the required evidence:'
      printf '%s' "${WEAKEN_MISSING}"
      echo 'Deleting or weakening a test is sound only when the pinned behaviour itself was wrong (show the probe that proves the correct behaviour) or the coverage demonstrably survives in a named surviving test.'
      echo 'Either restore the assertions, or record the evidence: write <workdir>/test-weakening.json — a JSON array of {"path": "<file>", "reason": "<evidence, at least 40 characters>"} carrying one entry for every file listed above.'
    } >> "${GATE_LOG}"
    reject_fix 'round weakened pre-existing tests without recorded evidence'
  fi
  {
    echo '🧪 **Gate advisory — this round weakened or removed pre-existing tests** (machine-measured, not agent-authored):'
    printf '%s' "${WEAKEN_OK}"
    echo
    echo 'The round recorded evidence for each (below, agent-authored). Weakening is sound only when the pinned behaviour itself was wrong or the coverage demonstrably survives elsewhere — read each reason against the diff. · 本轮弱化或删除了既有测试（门自动测量，非 agent 文本）。下列理由由 agent 撰写：仅当被钉住的行为本身有误、或覆盖确有替代时才成立，请对照 diff 逐条审阅。'
    # Agent-authored bytes inside a gate-authored document: neutralize both
    # comment-marker and details/summary forms (a severed <details> would
    # swallow the rest of the posted comment) and cap each reason, the same
    # hygiene the report step applies to failure.md excerpts.
    # Rendered from the MEASURED set, one line per file: the entries are
    # agent-authored and otherwise unbounded, so an ack file stuffed with
    # thousands of junk rows would decide the size of a posted PR comment.
    jq -r --arg ok "${WEAKEN_OK_B64}" '
      ($ok | split("\n") | map(select(length > 0) | @base64d)) as $ok
      | if type == "array" then
          map(select((.path? | type) == "string")
            | select(.path | IN($ok[]))
            | select((.reason? | type) == "string"))
          | unique_by(.path) | .[]
          | "  - \(.path | gsub("[^A-Za-z0-9._/ -]"; "?")): \(.reason | gsub("\\s+"; " "))"
        else empty end' "${WORKDIR}/test-weakening.json" 2> /dev/null |
      cut -b1-300 | iconv -f utf-8 -t utf-8 -c |
      sed -e 's/<!--/<!\\-\\-/g' -e 's/<[dD][eE][tT][aA][iI][lL][sS]/＜details/g' \
        -e 's/<\/[dD][eE][tT][aA][iI][lL][sS]/＜\/details/g' \
        -e 's/<[sS][uU][mM][mM][aA][rR][yY]/＜summary/g' || true
  } >> "${WORKDIR}/gate-advisories.md"
  echo "🧪 test weakening recorded and acknowledged: $(grep -c '^- ' <<< "${WEAKEN_OK}" || true) file(s)" | tee -a "${GATE_LOG}"
elif [[ "${WEAKEN_MEASURED}" != 'true' ]]; then
  echo '🧪 test-weakening measurement UNAVAILABLE this round (diff producer failed) — measured signals skipped' | tee -a "${GATE_LOG}"
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
# non-retryable rejection on all-green — the 60-minute repair pass cannot
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
#     per-test result parsing and is out of scope here. Also known: a
#     re-raised finding whose fix already sits in origin/<branch> is
#     legitimately all-green (SKILL directs re-verified items into
#     resolved-comments.txt); the rejection text tells the agent to
#     resolve such items in a no-code round of their own.
BITE_RUNNER="${BITE_RUNNER:-bite_runner_default}"
bite_runner_default() {
  # $1 = workspace dir, rest = test paths relative to the workspace.
  local ws="${1}"
  shift
  strip_runner_channels npm run test --workspace "${ws}" --if-present -- "$@"
}
mapfile -d '' -t BITE_FILES < <(git diff --name-only -z --no-renames --diff-filter=AM "${ROUND_RANGE}" \
  -- ':(glob)**/*.test.*' ':(glob)**/*.spec.*' ':(exclude,glob)**/__snapshots__/**' \
  ':(exclude,glob)integration-tests/**' | not_merge_freight || true)
# Changed snapshots ride the overlay (a fix proven by a regenerated
# snapshot must not revert to the pre-round snapshot and read as green)
# but are never passed to the runner as test-file arguments.
mapfile -d '' -t BITE_SNAPS < <(git diff --name-only -z --no-renames --diff-filter=AM "${ROUND_RANGE}" \
  -- ':(glob)**/__snapshots__/**' | not_merge_freight || true)
# No blanket *.md exclusion: .qwen/skills/**/*.md is EXECUTABLE agent
# behavior (and scripts/tests pins it), so markdown counts as source; the
# consequence gating above keeps doc-only rounds from ever being rejected.
BITE_SRC="$(git diff --name-only -z --no-renames "${ROUND_RANGE}" \
  -- ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.spec.*' \
  ':(exclude,glob)**/__snapshots__/**' ':(exclude,glob)**/__tests__/**' \
  ':(exclude,glob)**/test-utils/**' ':(exclude,glob)integration-tests/**' |
  not_merge_freight | tr '\0' '\n')"
# Does this round RESOLVE a Critical-tagged or CHANGES_REQUESTED finding in
# code? resolved-comments.txt is the agent's own machine-readable claim of
# what it fixed; rc.json/rv.json carry the thread bodies and review states
# the scan already fetched. Absent/empty inputs read as "no defect claim".
BITE_ENFORCE='false'
if [[ -s "${WORKDIR}/resolved-comments.txt" && -s "${WORKDIR}/rc.json" ]]; then
  # Ids tolerate the rc: prefix and CR the other consumers strip (SKILL
  # tells the agent to write the rc:<id> handle); a reply resolved inside a
  # Critical-rooted thread is a defect claim too, matching how the feedback
  # renderers classify replies.
  BITE_ENFORCE="$(jq -rs --rawfile ids "${WORKDIR}/resolved-comments.txt" \
    --slurpfile reviews "${WORKDIR}/rv.json" '
    (add // []) as $comments
    | ($reviews | add // []) as $reviews
    | ($ids | split("\n")
        | map(sub("^rc:"; "") | sub("\r$"; "")
          | select(test("^[0-9]+$")) | tonumber)) as $resolved
    | def cr_attached($x):
        (($x.pull_request_review_id // null) as $review
          | $review != null
          and any($reviews[]; .id == $review and ((.state // "") == "CHANGES_REQUESTED")));
      def critical($c):
        (($c.body // "") | contains("**[Critical]**"))
        or (($c.in_reply_to_id // null) as $root
          | $root != null
          and any($comments[];
            .id == $root
            and (((.body // "") | contains("**[Critical]**")) or cr_attached(.))))
        or cr_attached($c);
    any($comments[]; (.id as $id | $resolved | index($id) != null) and critical(.))' \
    "${WORKDIR}/rc.json" 2> /dev/null)" || BITE_ENFORCE='false'
  [[ "${BITE_ENFORCE}" == 'true' ]] || BITE_ENFORCE='false'
  # A defect claim whose EVERY resolved-Critical thread sits on a test file
  # is a test-side claim ("this test asserts the wrong behavior"): its fixed
  # test legitimately passes on the pre-round tree, so it takes the advisory
  # arm, never the rejection.
  if [[ "${BITE_ENFORCE}" == 'true' ]]; then
    TESTSIDE="$(jq -rs --rawfile ids "${WORKDIR}/resolved-comments.txt" \
      --slurpfile reviews "${WORKDIR}/rv.json" '
      (add // []) as $comments
      | ($reviews | add // []) as $reviews
      | ($ids | split("\n")
          | map(sub("^rc:"; "") | sub("\r$"; "")
            | select(test("^[0-9]+$")) | tonumber)) as $resolved
      | def cr_attached($x):
          (($x.pull_request_review_id // null) as $review
            | $review != null
            and any($reviews[]; .id == $review and ((.state // "") == "CHANGES_REQUESTED")));
        def critical($c):
          (($c.body // "") | contains("**[Critical]**"))
          or (($c.in_reply_to_id // null) as $root
            | $root != null
            and any($comments[];
              .id == $root
              and (((.body // "") | contains("**[Critical]**")) or cr_attached(.))))
          or cr_attached($c);
      [ $comments[]
        | select(.id as $id | $resolved | index($id) != null)
        | select(critical(.)) | (.path // "") ]
      | (length > 0) and all(.[];
          test("\\.(test|spec)\\.") or test("__tests__/|__snapshots__/|test-utils/|^integration-tests/"))' \
      "${WORKDIR}/rc.json" 2> /dev/null)" || TESTSIDE='false'
    [[ "${TESTSIDE}" == 'true' ]] && BITE_ENFORCE='advisory'
  fi
fi
if [[ -z "${BITE_SRC}" && ( "${BITE_ENFORCE}" == 'true' || "${BITE_ENFORCE}" == 'advisory' ) ]]; then
  # A defect-claim round that changed only tests cannot be bite-checked
  # (a fixed test legitimately passes on the pre-round tree) — surface
  # that the claim went unverified rather than skipping silently.
  {
    echo '🦷 **Gate advisory — this round resolves a Critical/Request-changes finding with test-only changes** (machine-measured): the bite check cannot verify a test-side fix, so the resolution rests on the round summary alone. · 本轮以纯测试改动解决 Critical/Request-changes 反馈（门自动测量）：bite 检查无法验证测试侧修复，该解决仅以轮次摘要为凭。'
  } >> "${WORKDIR}/gate-advisories.md"
  echo "🦷 defect-claim round changed only tests — advisory written (bite not applicable)" \
    | tee -a "${GATE_LOG}"
fi
if [[ "${#BITE_FILES[@]}" -gt 0 && -n "${BITE_SRC}" ]]; then
  BITE_PKGS="$(printf '%s\n' "${BITE_FILES[@]}" "${BITE_SRC}" |
    bash "${RUNNER_TEMP}/resolve-owning-packages.sh")"
  # The resolver silently drops files owned by NO workspace (repo-level
  # scripts, root configs): the single-workspace verdict below would then
  # judge only the workspace subset. Detect strays directly — every input
  # path must live under the one resolved workspace.
  BITE_STRAY='false'
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    [[ "${f}" == "${BITE_PKGS}"/* ]] || BITE_STRAY='true'
  done < <(printf '%s\n' "${BITE_FILES[@]}" "${BITE_SRC}")
  # Read the test script from the PRE-ROUND tree: that is the manifest the
  # detached runner will actually execute (the round tree's copy can
  # differ on infra PRs).
  BITE_TEST_SCRIPT="$(git show "origin/${BRANCH}:${BITE_PKGS}/package.json" 2> /dev/null |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).scripts?.test||"")}catch{}})' 2> /dev/null)" || BITE_TEST_SCRIPT=''
  BITE_SELF_IMPORT='false'
  if [[ -n "${BITE_PKGS}" && -f "${BITE_PKGS}/package.json" ]]; then
    BITE_PKG_NAME="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name||"")' "${BITE_PKGS}/package.json" 2> /dev/null)" || BITE_PKG_NAME=''
    if [[ -n "${BITE_PKG_NAME}" ]] &&
      git grep -qE "[\"']${BITE_PKG_NAME}[\"'/]" "${BRANCH}" -- "${BITE_FILES[@]}" 2> /dev/null; then
      # A test importing its own package BY NAME resolves through the
      # package exports into round-built dist/ on the detached tree — the
      # fix leaks into the "pre-round" run (packages/core has no self-alias
      # in its vitest config). Fail open.
      BITE_SELF_IMPORT='true'
    fi
  fi
  if [[ "$(wc -l <<< "${BITE_PKGS}")" -ne 1 || -z "${BITE_PKGS}" || "${BITE_STRAY}" == 'true' ]]; then
    echo "🦷 bite check skipped: round spans multiple/no workspaces (dist confound)" \
      | tee -a "${GATE_LOG}"
  elif [[ "${BITE_TEST_SCRIPT}" != *vitest* ]]; then
    # Mirrors the deterministic package-test loop's guard: a workspace
    # without a vitest test script would run NOTHING under --if-present
    # (or a non-vitest runner whose exit reflects environment health), and
    # a vacuous "all passed" must never reject a round.
    echo "🦷 bite check skipped: ${BITE_PKGS} test script is not Vitest" \
      | tee -a "${GATE_LOG}"
  elif [[ "${BITE_SELF_IMPORT}" == 'true' ]]; then
    echo "🦷 bite check skipped: changed tests import ${BITE_PKG_NAME} by package name (dist confound)" \
      | tee -a "${GATE_LOG}"
  else
    echo "🦷 bite check: running this round's changed tests on the pre-round tree" \
      | tee -a "${GATE_LOG}"
    git restore -- . 2>> "${GATE_LOG}" || true
    if git checkout --quiet --detach "origin/${BRANCH}" 2>> "${GATE_LOG}"; then
      BITE_BIT='false'
      BITE_RAN='false'
      if git checkout --quiet "${BRANCH}" -- "${BITE_FILES[@]}" "${BITE_SNAPS[@]}" 2>> "${GATE_LOG}"; then
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
        echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
        if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
          echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
        fi
        exit 1
      }
      git reset --quiet 2>> "${GATE_LOG}" || true
      if [[ "${BITE_RAN}" == 'true' && "${BITE_BIT}" == 'false' && "${BITE_ENFORCE}" == 'true' ]]; then
        {
          echo 'Every test this round added or changed ALSO PASSES on the pre-round tree (the branch as pushed, with only your test files overlaid). This round resolves a Critical / Request-changes finding in code, and a defect fix must come with a test that fails before the fix and passes after it — an all-green result here means the claimed defect does not reproduce, no matter who reported it.'
          echo
          echo 'If the finding does not reproduce, do not implement it: decline it (for a disproved finding) or escalate it as an open question, attaching this measurement as the evidence.'
          echo
          echo 'If the finding was already fixed by an EARLIER commit on this branch (a re-raised item you re-verified), resolve it in a round of its own without bundling new code changes — re-verification is a no-code claim and is never bite-checked.'
          echo
          echo 'Changed tests measured:'
          for bf in "${BITE_FILES[@]}"; do
            echo "- ${bf//[^A-Za-z0-9._\/ -]/?}"
          done
          # No fence here: reject_fix wraps this whole tail in its own
          # 4-backtick fence, and CommonMark closes a fence at any inner
          # run of >= the opener's length — so collapse any backtick run in
          # the branch-controlled runner output below the opener's length.
          tail -c 1200 "${GATE_LOG}.bite" 2> /dev/null | sed 's/\x60\x60\x60\x60*/```/g'
        } >> "${GATE_LOG}"
        reject_fix 'bite check: changed tests pass on the pre-round tree (claimed defect does not reproduce)' 'false' 'false'
      elif [[ "${BITE_RAN}" == 'true' && "${BITE_BIT}" == 'false' ]]; then
        # All-green without rejection: either no defect claim (refactor or
        # coverage addition — legitimate) or a TEST-SIDE claim, whose fixed
        # test is EXPECTED to pass pre-round. Say which.
        if [[ "${BITE_ENFORCE}" == 'advisory' ]]; then
          {
            echo '🦷 **Gate advisory — test-side defect claim, changed tests all pass on the pre-round tree** (machine-measured, not agent-authored). Expected when the defect was in the test itself; the resolution rests on the round summary. · 本轮为测试侧缺陷声明，改动的测试在轮前树上全部通过（门自动测量）。若缺陷在测试本身属预期；该解决以轮次摘要为凭。'
          } >> "${WORKDIR}/gate-advisories.md"
          echo "🦷 test-side defect claim — advisory written (all-green is the expected shape)" \
            | tee -a "${GATE_LOG}"
        else
          {
            echo '🦷 **Gate advisory — this round'"'"'s changed tests all pass on the pre-round tree** (machine-measured, not agent-authored). Expected for a refactor or coverage addition; if this round was meant to FIX a defect, that defect did not reproduce. · 本轮改动的测试在轮前树上全部通过（门自动测量，非 agent 文本）。对重构或补充覆盖属正常；若本轮意在修复缺陷，则该缺陷未能复现。'
          } >> "${WORKDIR}/gate-advisories.md"
          echo "🦷 changed tests all pass on the pre-round tree — advisory written (no defect claim in this round)" \
            | tee -a "${GATE_LOG}"
        fi
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
# A conflict verdict must STOP BLOCKED: completing as fixed would push the
# contested code under the PAT while the report posts the park marker —
# the exact outcome the routing check above exists to prevent. The routing
# check cannot see this shape (a planted handoff.md satisfies it), so
# refuse at the push boundary. NON-retryable: re-audit, don't repair.
if [[ "${AUDIT_VERDICT:-}" == 'conflict' ]]; then
  reject_fix 'growth-audit verdict is conflict but the round completed as fixed; conflict must STOP BLOCKED (no push)' 'false' 'false'
fi
echo "verified_head=${VERIFICATION_HEAD}" >> "${GITHUB_OUTPUT}"
echo "outcome=fixed" >> "${GITHUB_OUTPUT}"
echo "kiss_audit=${KISS_AUDIT:-false}" >> "${GITHUB_OUTPUT}"
if [[ "${AUDIT_VERDICT_RECORDED:-false}" == 'true' ]]; then
  echo "audit_verdict=${AUDIT_VERDICT}" >> "${GITHUB_OUTPUT}"
fi
