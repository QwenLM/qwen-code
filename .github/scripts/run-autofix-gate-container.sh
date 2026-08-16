#!/usr/bin/env bash
set -uo pipefail

# Runs the deterministic verification gate inside an EPHEMERAL CONTAINER, and
# translates its verdict back to the host.
#
# WHY (#9089): the gate executes the branch's OWN build/test. Run on the host,
# that code shares the OS user, $HOME, $GITHUB_ENV and $GITHUB_OUTPUT with the
# later PAT-bearing steps of the same job, and several channels fire before any
# in-step guard can run — `BASH_ENV`/`BASH_FUNC_*` and `LD_PRELOAD`/`LD_AUDIT`
# are applied by the shell/loader at startup (the runner's $GITHUB_ENV
# blocklist is NODE_OPTIONS-only), and a forged `outcome=fixed` appended to the
# runner-provided $GITHUB_OUTPUT beats any digest check on the gate script's
# bytes. In a container the branch code reaches none of them: docker does not
# inherit the host environment, so there is no PAT, no $GITHUB_ENV and no host
# $GITHUB_OUTPUT inside, $HOME is a throwaway, and only three paths are mounted.
#
# The trust boundary is the container wall, NOT a job boundary: a job that has
# executed attacker code cannot vouch for anything it emits, so the PAT must
# never be in the same execution context as branch code. What crosses back is
# a host-created verdict file plus the container's EXIT CODE — the exit code
# is the unforgeable half (branch code can append to the mounted verdict file,
# but it cannot make a failing gate exit 0), so a passing verdict is accepted
# only on exit 0. The container wall does not, by itself, make the HOST-side
# translation shell trusted: the agent steps therefore sever the runner's
# $GITHUB_ENV/$GITHUB_PATH/$GITHUB_OUTPUT channels before the branch-code-
# bearing process tree starts (see 'Triage and address'), because a planted
# BASH_ENV is sourced by every later step shell before line 1.
#
# Invoked as a child `bash` from the host verify step, which digest-verifies
# both this script and the gate script first. Inherits its environment from
# that caller: WORKDIR and BRANCH are job-level env, RUNNER_TEMP and
# GITHUB_WORKSPACE/GITHUB_OUTPUT are runner-provided, GATE_IMAGE and
# FOOTPRINT_ENFORCE are step-level env. None is defined here.

VERDICT="${WORKDIR}/gate-verdict"
# The container's own RUNNER_TEMP: a fresh directory holding COPIES of just
# the scripts the gate reads. The real RUNNER_TEMP is never mounted — it holds
# the staged agent runner and the throwaway git/gh configs the PAT-bearing
# steps use, none of which the gate needs and none of which branch code may
# reach or tamper with.
CTEMP="${RUNNER_TEMP}/gate-container-temp"
# Split in two: the staged scripts are mounted READ-ONLY (bash reads a script
# incrementally, so a writable copy of the running gate would let the branch
# code the gate itself executes rewrite its own remaining bytes and hand back a
# forged pass — the exit code would no longer be unforgeable), and a separate
# scratch mount carries everything the gate legitimately writes ($HOME, the
# throwaway git config via GATE_TMPDIR).
CBIN="${CTEMP}/bin"
CRW="${CTEMP}/rw"
# Named so the pool's stale-container janitors (name=qwen-code-*) can see it,
# and torn down explicitly: --rm only fires on a normal exit, but a step
# timeout / job cap / cancel kills the docker CLIENT and leaves the container
# running as the runner uid with rw mounts on the shared workspace.
# `timeout 30` like every other docker call here: the trap fires on the same
# cancel/step-timeout paths where a wedged daemon blocks the CLI indefinitely,
# and a hung teardown is killed with the process group — leaving exactly the
# running leftover the trap exists to remove, which no janitor reaps (they
# skip RUNNING containers).
GATE_CONTAINER="qwen-code-gate-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}-$$"
# Referenced only through `trap` below, which shellcheck's reachability scan
# does not resolve (SC2317, visible under --enable=all).
# shellcheck disable=SC2317
teardown() { timeout 30 docker rm -f "${GATE_CONTAINER}" > /dev/null 2>&1 || true; }
trap teardown EXIT INT TERM

if [[ -z "${GATE_IMAGE:-}" ]]; then
  echo "::error::GATE_IMAGE is empty — the sandbox image did not resolve; refusing to run the gate on the host."
  exit 125
fi

# Explicit unlink before the truncation: the verdict file is the one path
# this wrapper opens pre-run AND post-run, and WORKDIR persists within the
# round — a pre-planted FIFO blocks the truncation's write-open until the
# step timeout (a one-line per-round DoS of the verification loop), and a
# symlink to a fingerprinted input (e.g. rc.json) would truncate the target
# THROUGH the link before the baseline capture below records it, hiding the
# damage from the compare.
rm -f "${VERDICT}"
: > "${VERDICT}" || {
  echo "::error::could not create the gate verdict file at ${VERDICT}"
  exit 125
}
# Single host-side reset for the gate-authored rejection detail: the gate
# writes it only on rejection paths, so a copy surviving a run that never
# rejected was planted, and the report steps would publish it as the bot's
# own rejection rationale. (The other gate-authored file resets itself: the
# gate rm -f's gate-advisories.md at its own start.)
rm -f "${WORKDIR}/gate-rejection.md"
rm -rf "${CTEMP}"
mkdir -p "${CBIN}" "${CRW}" || exit 125
for staged in run-autofix-review-verification.sh check-settings-schema.sh \
  check-autofix-contracts.sh resolve-owning-packages.sh; do
  cp "${RUNNER_TEMP}/${staged}" "${CBIN}/${staged}" || {
    echo "::error::could not stage ${staged} for the gate container"
    exit 125
  }
done

# --user: the workspace is bind-mounted, so container writes (dist/, vitest
# caches, the gate log) must land as the runner user or the next steps hit
# root-owned files — the same failure the job's ownership-restore step exists
# for. --env is an explicit allowlist: anything not named here is simply
# absent inside, which is the whole point.
# The WORKDIR mount is rw, and everything fingerprinted below is a file the
# gate NEVER writes yet some consumer reads after the run — so branch code
# in the container, awake for the whole run, can plant them to steer what
# the host publishes or routes: no-action.md manufactures a noop published
# as the bot's own "no changes needed" rationale, resolved-comments.txt
# closes human review threads, handoff.md is picked by the report step's
# detail chain AHEAD of the fingerprinted summary files, agent-api-error
# forces the model-error retry sentinel and injects its text into the
# published headline, rc.json truncated flips the bite check's BITE_ENFORCE
# off so the bogus-fix round it exists to reject exits 0 as `fixed`, ic.json
# feeds the post-gate consecutive-failure breaker file-preferred, so planted
# bot failure headlines trip its cap and mark the PR terminal, and
# deferred-findings.json feeds the post-gate upsert. Fingerprint them
# before the run and refuse the verdict if they moved. The two gate-
# authored files stay out of the set for the opposite reason (see the
# resets above): fingerprinting them would make the gate's own writes trip
# the compare.
# The type is part of the fingerprint, and non-regular paths are never
# hashed: a symlink to gate-verdict would make the gate's own verdict writes
# trip the compare (exit 125 every round, suppressing the rejection), and a
# FIFO would block sha256sum's open() until the step's 60-minute timeout with
# no diagnostic. Neither needs a capability on the rw mount.
verdict_inputs_digest() {
  local f type
  for f in no-action.md address-summary.md resolved-comments.txt \
    comment-replies.json rc.json rv.json ic.json failure.md handoff.md \
    deferred-feedback.md agent-api-error agent-api-error-kind \
    agent-timeout deferred-findings.json deferred-findings.carry.json; do
    type="$(stat -c '%F' "${WORKDIR}/${f}" 2> /dev/null || true)"
    case "${type}" in
      '' | 'regular file' | 'regular empty file')
        printf '%s:%s\n' "${f}" "$(sha256sum "${WORKDIR}/${f}" 2> /dev/null | cut -d' ' -f1)"
        ;;
      *) printf '%s:NONREGULAR:%s\n' "${f}" "${type}" ;;
    esac
  done
}
INPUTS_BEFORE="$(verdict_inputs_digest)"
if [[ "${INPUTS_BEFORE}" == *':NONREGULAR:'* ]]; then
  echo "::error::a verdict input in ${WORKDIR} is not a regular file — refusing to run the gate."
  exit 125
fi

# --network none: the gate only runs build/typecheck/lint/test against
# node_modules already installed on the host side, so it needs no egress —
# and offline operation in this same image is established in-repo by
# repo-hygiene.yml's SANDBOX_ARGS, whose posture (--init, --cap-drop ALL,
# --security-opt no-new-privileges) this mirrors. Without it a malicious
# branch's build script can exfiltrate anything readable in the container
# using the runner's network position.
docker run --rm --name "${GATE_CONTAINER}" \
  --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --workdir "${GITHUB_WORKSPACE}" \
  --volume "${GITHUB_WORKSPACE}:${GITHUB_WORKSPACE}" \
  --volume "${WORKDIR}:${WORKDIR}" \
  --volume "${CBIN}:${CBIN}:ro" \
  --volume "${CRW}:${CRW}" \
  --env HOME="${CRW}" \
  --env BRANCH="${BRANCH}" \
  --env WORKDIR="${WORKDIR}" \
  --env RUNNER_TEMP="${CBIN}" \
  --env GATE_TMPDIR="${CRW}" \
  --env GITHUB_OUTPUT="${VERDICT}" \
  --env FOOTPRINT_ENFORCE="${FOOTPRINT_ENFORCE:-advisory}" \
  --env CI=true \
  "${GATE_IMAGE}" \
  bash "${CBIN}/run-autofix-review-verification.sh"
GATE_RC=$?

echo "🧱 gate container exited ${GATE_RC}"

if [[ "$(verdict_inputs_digest)" != "${INPUTS_BEFORE}" ]]; then
  # Something in the container rewrote the agent's verdict inputs. The gate's
  # own exit code is now meaningless as evidence about the fix, so take the
  # crash path (retry) rather than publish a verdict derived from them.
  echo "::error::the gate container modified the agent's verdict inputs in ${WORKDIR} — refusing the verdict; the next scan retries."
  exit 125
fi

# Mirror the inputs' type discipline on the verdict file itself BEFORE
# anything opens it: the container can swap it after the run — rm + mkfifo
# while holding a reader fd (the gate's appends succeed inside, then the
# grep below blocks its read-open until the step timeout) or a symlink,
# whose target the extraction would then read with host permissions.
VERDICT_TYPE="$(stat -c '%F' "${VERDICT}" 2> /dev/null || true)"
case "${VERDICT_TYPE}" in
  'regular file' | 'regular empty file') : ;;
  *)
    echo "::error::the gate verdict file at ${VERDICT} is not a regular file (${VERDICT_TYPE:-missing}) after the run — refusing to read it."
    exit 125
    ;;
esac

# Verdict translation. Only these keys are forwarded, last value wins (the
# gate appends its final verdict last), and `outcome` is gated on the exit
# code — the file alone is not authority.
verdict_value() {
  grep -E "^${1}=" "${VERDICT}" 2> /dev/null | tail -n 1 | cut -d= -f2-
}
OUTCOME="$(verdict_value outcome)"
COMMITTED="$(verdict_value committed)"
RETRYABLE="$(verdict_value retryable)"
PREEXISTING="$(verdict_value preexisting)"
VERIFIED_HEAD="$(verdict_value verified_head)"

# committed= is a ref-only fact the gate records before any check runs; the
# failure handoff keys its "was NOT pushed" wording on it, so forward it on
# every path (a forged value only changes report wording, never a push).
[[ "${COMMITTED}" == 'true' ]] && echo "committed=true" >> "${GITHUB_OUTPUT}"

case "${GATE_RC}" in
  0)
    # A pass must ALSO be a pass in the file: an exit-0 container whose
    # verdict says anything else (or nothing) is a gate that did not reach a
    # verdict, which is the crash path, not a silent success.
    if [[ "${OUTCOME}" == 'fixed' || "${OUTCOME}" == 'noop' ]]; then
      echo "outcome=${OUTCOME}" >> "${GITHUB_OUTPUT}"
      [[ -n "${VERIFIED_HEAD}" ]] && echo "verified_head=${VERIFIED_HEAD}" >> "${GITHUB_OUTPUT}"
    else
      echo "::warning::gate container exited 0 without a verdict (outcome='${OUTCOME}') — treating as a gate crash so the next scan retries."
    fi
    ;;
  1)
    # A deterministic rejection (reject_fix) writes outcome=failed plus BOTH
    # routing flags, exactly once each and mutually exclusive at the source
    # (a pre-existing failure is NOT retryable — the repair agent may only
    # amend this round's fix). Any other shape — a flag line missing,
    # repeated, or both true — is proof the file was touched after the gate
    # wrote it (branch code can append to the mounted verdict file), so
    # refuse the verdict BEFORE forwarding any of it: a lone forged
    # `retryable=true` would otherwise flip a deliberately non-retryable
    # rejection (e.g. the bite check) into a PAT-backed repair round, and a
    # planted `preexisting=true` overriding a genuine `retryable=true` would
    # skip the repair the round is entitled to and permanently misclassify a
    # fixable rejection as a terminal pre-existing failure. The crash path
    # retries with a fresh checkout instead.
    if [[ "${OUTCOME}" == 'failed' ]]; then
      RETRYABLE_LINES="$(grep -c '^retryable=' "${VERDICT}" 2> /dev/null || true)"
      PREEXISTING_LINES="$(grep -c '^preexisting=' "${VERDICT}" 2> /dev/null || true)"
      if [[ "${RETRYABLE_LINES:-0}" -ne 1 ]] ||
        [[ "${PREEXISTING_LINES:-0}" -ne 1 ]] ||
        [[ "${PREEXISTING}" == 'true' && "${RETRYABLE}" == 'true' ]]; then
        echo "::error::verdict carries a forged routing flag (retryable lines: ${RETRYABLE_LINES:-0}, preexisting lines: ${PREEXISTING_LINES:-0}) — refusing the verdict as tampered."
        exit 125
      fi
      echo "outcome=failed" >> "${GITHUB_OUTPUT}"
      [[ "${PREEXISTING}" == 'true' ]] && echo "preexisting=true" >> "${GITHUB_OUTPUT}"
      [[ "${RETRYABLE}" == 'true' ]] && echo "retryable=true" >> "${GITHUB_OUTPUT}"
    else
      # Take `failed` only from the FILE — the gate also has exit-1 paths
      # that deliberately write NO verdict (the baseline-A/B and bite
      # tree-restore failures), where an EVALUATED rejection would advance
      # the watermark and hand the item off for good, and an unset outcome is
      # what routes them to the gate-crashed retry instead. A forged
      # `outcome=fixed` still cannot pass: `fixed` is accepted only on exit 0,
      # so here it leaves the outcome unset and the round retries.
      echo "::warning::gate container exited 1 without a deterministic verdict (outcome='${OUTCOME}') — reporting as a gate crash so the next scan retries."
    fi
    ;;
  *)
    # Docker itself failed (125/126/127), the container was killed (137), or
    # the gate died before reaching a verdict. Leave outcome UNSET: an
    # EVALUATED rejection advances the watermark and hands the item off for
    # good, while an empty outcome takes 'Finalize verification's gate-crashed
    # path and retries on the next scan's fresh checkout.
    echo "::warning::gate container exited ${GATE_RC} without a deterministic verdict — reporting as a gate crash."
    ;;
esac

exit "${GATE_RC}"
