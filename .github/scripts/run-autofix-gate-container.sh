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
# only on exit 0.
#
# Invoked as a child `bash` from the host verify step, which digest-verifies
# both this script and the gate script first. Inherits its environment from
# that caller: WORKDIR and BRANCH are job-level env, RUNNER_TEMP and
# GITHUB_WORKSPACE/GITHUB_OUTPUT are runner-provided, GATE_IMAGE and
# FOOTPRINT_ENFORCE are step-level env. None is defined here.

GATE_SCRIPT="${RUNNER_TEMP}/run-autofix-review-verification.sh"
VERDICT="${WORKDIR}/gate-verdict"
# The container's own RUNNER_TEMP: a fresh directory holding COPIES of just
# the scripts the gate reads. The real RUNNER_TEMP is never mounted — it holds
# the staged agent runner and the throwaway git/gh configs the PAT-bearing
# steps use, none of which the gate needs and none of which branch code may
# reach or tamper with.
CTEMP="${RUNNER_TEMP}/gate-container-temp"

if [[ -z "${GATE_IMAGE:-}" ]]; then
  echo "::error::GATE_IMAGE is empty — the sandbox image did not resolve; refusing to run the gate on the host."
  exit 125
fi

: > "${VERDICT}" || {
  echo "::error::could not create the gate verdict file at ${VERDICT}"
  exit 125
}
rm -rf "${CTEMP}"
mkdir -p "${CTEMP}" || exit 125
for staged in run-autofix-review-verification.sh check-settings-schema.sh \
  check-autofix-contracts.sh resolve-owning-packages.sh; do
  cp "${RUNNER_TEMP}/${staged}" "${CTEMP}/${staged}" || {
    echo "::error::could not stage ${staged} for the gate container"
    exit 125
  }
done

# --user: the workspace is bind-mounted, so container writes (dist/, vitest
# caches, the gate log) must land as the runner user or the next steps hit
# root-owned files — the same failure the job's ownership-restore step exists
# for. --env is an explicit allowlist: anything not named here is simply
# absent inside, which is the whole point.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --workdir "${GITHUB_WORKSPACE}" \
  --volume "${GITHUB_WORKSPACE}:${GITHUB_WORKSPACE}" \
  --volume "${WORKDIR}:${WORKDIR}" \
  --volume "${CTEMP}:${CTEMP}" \
  --env HOME="${CTEMP}" \
  --env BRANCH="${BRANCH}" \
  --env WORKDIR="${WORKDIR}" \
  --env RUNNER_TEMP="${CTEMP}" \
  --env GITHUB_OUTPUT="${VERDICT}" \
  --env FOOTPRINT_ENFORCE="${FOOTPRINT_ENFORCE:-advisory}" \
  "${GATE_IMAGE}" \
  bash "${CTEMP}/run-autofix-review-verification.sh"
GATE_RC=$?

echo "🧱 gate container exited ${GATE_RC}"

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
    # The gate's own deterministic rejection: reject_fix always exits 1.
    # Forced to failed regardless of the file, so a forged `outcome=fixed`
    # cannot survive a red gate. The routing flags are forwarded because both
    # branches they select (same-run repair, base-update handoff) stop short
    # of a push.
    echo "outcome=failed" >> "${GITHUB_OUTPUT}"
    [[ "${PREEXISTING}" == 'true' ]] && echo "preexisting=true" >> "${GITHUB_OUTPUT}"
    [[ "${RETRYABLE}" == 'true' ]] && echo "retryable=true" >> "${GITHUB_OUTPUT}"
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
