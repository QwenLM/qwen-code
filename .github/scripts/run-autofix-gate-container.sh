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

# Unload imported shell functions FIRST: BASH_FUNC_* env carriers cannot be
# pinned by name at step env: level, and an imported function shadows
# sha256sum/stat/bash ahead of any PATH pin — including the caller's, since
# bash re-imports the carriers at every startup (#9214 review).
for _fn in $(compgen -A function); do
  unset -f -- "${_fn}"
done

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
# Read-only snapshot of the host-authored bite inputs, mounted :ro into the
# container so the gate's enforcement decision reads bytes that were
# digest-verified at check time — and which nothing inside the container can
# rewrite — instead of the live WORKDIR copies (#9214 review).
CINPUTS="${CTEMP}/inputs"
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

# The resolver only ever exports a digest-bound reference to the trusted
# image, ghcr.io/qwenlm/qwen-code@sha256:… — validate the shape at this
# consumer. A host watcher can append a forged `image=` line during the
# sandbox step's own window (up to the 10-minute pull), and the runner
# parses the step's output file last-wins at step END, displacing the
# honest value before the gate steps capture it into GATE_IMAGE; running
# the gate in an attacker-chosen image forges the entire verdict. Defense
# in depth — both gate steps validate the same shape (#9214 review).
if [[ ! "${GATE_IMAGE:-}" =~ ^ghcr\.io/qwenlm/qwen-code@sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::GATE_IMAGE is not a digest-bound ghcr.io/qwenlm/qwen-code reference (got '${GATE_IMAGE:-}') — refusing to run the gate."
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
# Pin the file's IDENTITY across the run, not just its type: the gate only
# ever APPENDS to this file (inode preserved), but a pre-staged forgery
# renamed over it after the gate's final write — one atomic rename(2) before
# the container exits — passes every other post-run check (the fingerprint
# set deliberately excludes the verdict, and the type check sees a regular
# file with exactly one of each flag line). A moved inode is a swap (#9214).
VERDICT_INODE="$(stat -c '%i' "${VERDICT}" 2> /dev/null || true)"
# Single host-side reset for the gate-authored rejection detail: the gate
# writes it only on rejection paths, so a copy surviving a run that never
# rejected was planted, and the report steps would publish it as the bot's
# own rejection rationale. (The other gate-authored file resets itself: the
# gate rm -f's gate-advisories.md at its own start.)
rm -f "${WORKDIR}/gate-rejection.md"
rm -rf "${CTEMP}"
mkdir -p "${CBIN}" "${CRW}" "${CINPUTS}" || exit 125
for staged in run-autofix-review-verification.sh check-settings-schema.sh \
  check-autofix-contracts.sh resolve-owning-packages.sh; do
  cp "${RUNNER_TEMP}/${staged}" "${CBIN}/${staged}" || {
    echo "::error::could not stage ${staged} for the gate container"
    exit 125
  }
done
# Verify the COPIES against the staging-time digests before docker run: the
# gate step checked the RUNNER_TEMP bytes at CHECK time, but this cp runs
# afterwards — a watcher overwriting a staged script in that seam would
# otherwise be copied in and execute AS the gate. The digests ride step env
# from GITHUB_OUTPUT, unreachable from a disk write; an empty one fails
# closed. Bounded reads: a watcher swap in the stat→open window is a refusal
# here, not a hang until the step timeout (#9214 review).
copy_digest() { timeout 10 sha256sum "${CBIN}/${1}" 2> /dev/null | cut -d' ' -f1; }
if [[ -z "${VERIFY_RUNNER_SHA256:-}" ]] ||
  [[ "$(copy_digest run-autofix-review-verification.sh)" != "${VERIFY_RUNNER_SHA256}" ]]; then
  echo "::error::the staged gate script copy no longer matches the digest recorded at staging time — refusing to run the gate."
  exit 125
fi
if [[ -z "${GATE_CONTAINER_SHA256:-}" ]] ||
  [[ "$(copy_digest run-autofix-gate-container.sh)" != "${GATE_CONTAINER_SHA256}" ]]; then
  echo "::error::the staged wrapper copy no longer matches the digest recorded at staging time — refusing to run the gate."
  exit 125
fi
HELPERS_COPY_NOW="$(timeout 30 sha256sum "${CBIN}/check-settings-schema.sh" \
  "${CBIN}/check-autofix-contracts.sh" "${CBIN}/resolve-owning-packages.sh" 2> /dev/null |
  sha256sum | cut -d' ' -f1)"
if [[ -z "${GATE_HELPERS_SHA256:-}" ]] || [[ "${HELPERS_COPY_NOW}" != "${GATE_HELPERS_SHA256}" ]]; then
  echo "::error::the staged helper copies no longer match the digest recorded at staging time — refusing to run the gate."
  exit 125
fi

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
  local f type hash
  for f in no-action.md address-summary.md resolved-comments.txt \
    comment-replies.json rc.json rv.json ic.json failure.md handoff.md \
    deferred-feedback.md agent-api-error agent-api-error-kind \
    agent-timeout deferred-findings.json deferred-findings.carry.json; do
    type="$(stat -c '%F' "${WORKDIR}/${f}" 2> /dev/null || true)"
    case "${type}" in
      '') printf '%s:\n' "${f}" ;;
      'regular file' | 'regular empty file')
        # Bounded: a watcher swap landing in the stat→open window must
        # surface as a NONREGULAR refusal, not hang sha256sum's open()
        # until the step timeout (#9214 review).
        hash="$(timeout 10 sha256sum "${WORKDIR}/${f}" 2> /dev/null | cut -d' ' -f1)" ||
          hash='NONREGULAR:read-blocked'
        printf '%s:%s\n' "${f}" "${hash}"
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
# The container mounts the workspace rw at the runner uid, so a detached
# in-container process can move the branch ref to an attacker commit AND
# append verified_head=<it> after the gate's honest final write — the
# extraction below is last-wins, and the push guard compares `git rev-parse
# HEAD` (read from the same rw-mounted .git) against the forwarded value:
# both operands attacker-consistent, and a head the gate never verified
# would ship on the PAT. Pin the host-side HEAD across the run and refuse
# any move, whatever the verdict file says (#9214 review).
HOST_HEAD_BEFORE="$(git rev-parse HEAD 2> /dev/null || true)"
# Snapshot the workspace's .git/config across the run: the mount is rw at
# the runner uid, so the container can plant exec vectors ([diff]
# external=<payload>) that fire in the host's post-run git steps — 'Show
# run artifacts' runs `git diff` before any resanitize. The restore below
# runs immediately after the container exits, whatever the verdict (#9214
# review).
GIT_CONFIG_SNAPSHOT="${CTEMP}/git-config.snapshot"
if [[ -f "${GITHUB_WORKSPACE}/.git/config" ]]; then
  timeout 10 cp "${GITHUB_WORKSPACE}/.git/config" "${GIT_CONFIG_SNAPSHOT}" || {
    echo "::error::could not snapshot the workspace git config — refusing to run the gate."
    exit 125
  }
fi
# Re-verify the host-authored bite inputs against the prepare-time digest,
# then snapshot them for the gate: the gate step checked the live bytes at
# CHECK time, but a surviving host process can truncate rc.json before the
# gate's own read — the truncation would become the wrapper baseline AND
# the gate's capture, flipping BITE_ENFORCE off so the bogus-fix round the
# bite check exists to reject exits 0 as `fixed`. The per-file hashes ride
# the same expression-context digest; the copies are re-digested after the
# cp so a swap in the verify→copy seam is refused too (#9214 review).
VERDICT_INPUTS_DETAIL="$(timeout 30 sha256sum "${WORKDIR}/rc.json" \
  "${WORKDIR}/rv.json" "${WORKDIR}/ic.json" 2> /dev/null)" || VERDICT_INPUTS_DETAIL=''
VERDICT_INPUTS_NOW="$(printf '%s\n' "${VERDICT_INPUTS_DETAIL}" | sha256sum | cut -d' ' -f1)"
if [[ -z "${VERDICT_INPUTS_SHA256:-}" ]] || [[ "${VERDICT_INPUTS_NOW}" != "${VERDICT_INPUTS_SHA256}" ]]; then
  echo "::error::verdict inputs rc.json/rv.json/ic.json no longer match the digest recorded at prepare time — refusing to run the gate."
  exit 125
fi
for _vi in rc.json rv.json resolved-comments.txt; do
  if [[ -f "${WORKDIR}/${_vi}" ]]; then
    timeout 10 cp "${WORKDIR}/${_vi}" "${CINPUTS}/${_vi}" || {
      echo "::error::could not snapshot verdict input ${_vi} for the gate container"
      exit 125
    }
  fi
done
for _vi in rc.json rv.json; do
  _vi_expected="$(printf '%s\n' "${VERDICT_INPUTS_DETAIL}" | grep -F " ${WORKDIR}/${_vi}" | cut -d' ' -f1)"
  _vi_now="$(timeout 10 sha256sum "${CINPUTS}/${_vi}" 2> /dev/null | cut -d' ' -f1)"
  if [[ -z "${_vi_expected}" || "${_vi_now}" != "${_vi_expected}" ]]; then
    echo "::error::verdict input snapshot ${_vi} no longer matches the digest recorded at prepare time — refusing to run the gate."
    exit 125
  fi
done

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
  --volume "${CINPUTS}:${CINPUTS}:ro" \
  --volume "${CRW}:${CRW}" \
  --env HOME="${CRW}" \
  --env BRANCH="${BRANCH}" \
  --env WORKDIR="${WORKDIR}" \
  --env RUNNER_TEMP="${CBIN}" \
  --env GATE_TMPDIR="${CRW}" \
  --env GATE_INPUTS="${CINPUTS}" \
  --env GITHUB_OUTPUT="${VERDICT}" \
  --env FOOTPRINT_ENFORCE="${FOOTPRINT_ENFORCE:-advisory}" \
  --env CI=true \
  "${GATE_IMAGE}" \
  bash "${CBIN}/run-autofix-review-verification.sh"
GATE_RC=$?

echo "🧱 gate container exited ${GATE_RC}"

# Restore the workspace git config BEFORE anything else touches the
# workspace (host steps below run `git rev-parse`/`git diff`): the
# container mounts it rw at the runner uid and can plant exec vectors
# a post-run resanitize may not precede (#9214 review).
if [[ -f "${GIT_CONFIG_SNAPSHOT}" ]]; then
  timeout 10 cp "${GIT_CONFIG_SNAPSHOT}" "${GITHUB_WORKSPACE}/.git/config" || {
    echo "::error::could not restore the workspace git config after the gate run — refusing the verdict."
    exit 125
  }
fi

if [[ "$(verdict_inputs_digest)" != "${INPUTS_BEFORE}" ]]; then
  # Something in the container rewrote the agent's verdict inputs. The gate's
  # own exit code is now meaningless as evidence about the fix, so take the
  # crash path (retry) rather than publish a verdict derived from them.
  echo "::error::the gate container modified the agent's verdict inputs in ${WORKDIR} — refusing the verdict; the next scan retries."
  exit 125
fi
# Host-side half of the HEAD pin captured before the run: the container can
# write the workspace's .git (same uid, rw mount), so re-read HEAD here — a
# moved ref means the tree now present is not the one the gate verified, and
# the verdict is refused regardless of its content.
HOST_HEAD_NOW="$(git rev-parse HEAD 2> /dev/null || true)"
if [[ -z "${HOST_HEAD_NOW}" || "${HOST_HEAD_NOW}" != "${HOST_HEAD_BEFORE}" ]]; then
  echo "::error::the workspace HEAD moved during the gate run (${HOST_HEAD_BEFORE:-?} -> ${HOST_HEAD_NOW:-?}) — refusing the verdict; the next scan retries."
  exit 125
fi

# Refuse a REPLACED verdict before anything reads it: the gate's appends
# keep the creation-time inode, a rename(2) swap does not (see the capture
# above). Runs before the type check so a swapped-in FIFO never gets opened.
VERDICT_INODE_NOW="$(stat -c '%i' "${VERDICT}" 2> /dev/null || true)"
if [[ "${VERDICT_INODE_NOW}" != "${VERDICT_INODE}" ]]; then
  echo "::error::the gate verdict file at ${VERDICT} was replaced during the run (inode ${VERDICT_INODE:-?} -> ${VERDICT_INODE_NOW:-?}) — refusing the verdict as tampered."
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

# Verdict translation. Rejection routing rides the container's EXIT CODE —
# the gate exits 10 (retryable), 11 (pre-existing handoff) or 12 (terminal),
# and branch code in the container cannot change the code the gate exited
# with, while it CAN rewrite the mounted verdict file in place:
# open(O_WRONLY|O_TRUNC) preserves the inode and the type pinned above, and
# a well-formed rewrite satisfies any line count — so on the rejection arms
# the file is human-facing detail only. A pass is still file-gated on exit
# 0, and every read of the file is bounded: a watcher swap in the type→open
# window is a crash here, not a hang until the step timeout (#9214 review).
verdict_value() {
  timeout 10 grep -E "^${1}=" "${VERDICT}" 2> /dev/null | tail -n 1 | cut -d= -f2-
}
OUTCOME="$(verdict_value outcome)"
COMMITTED="$(verdict_value committed)"
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
      # The same anti-append discipline as the rc=1 arm: every genuine
      # exit-0 verdict writes outcome= and verified_head= exactly once
      # (fixed at the gate's end, noop at the no-action exit), and
      # committed= at most once, so any duplicate is an in-container append.
      # Without the count, a watcher appending `outcome=noop` after the
      # gate's `outcome=fixed` flips last-wins extraction and silently
      # discards a verified fix as no-action (the reverse reports a fix on
      # an unchanged branch), and an appended `verified_head=` is the
      # identity forgery the host-HEAD pin above independently refuses
      # (#9214 review).
      OUTCOME_LINES="$(timeout 10 grep -c '^outcome=' "${VERDICT}" 2> /dev/null || true)"
      VERIFIED_HEAD_LINES="$(timeout 10 grep -c '^verified_head=' "${VERDICT}" 2> /dev/null || true)"
      COMMITTED_LINES="$(timeout 10 grep -c '^committed=' "${VERDICT}" 2> /dev/null || true)"
      if [[ "${OUTCOME_LINES:-0}" -ne 1 ]] ||
        [[ "${VERIFIED_HEAD_LINES:-0}" -ne 1 ]] ||
        [[ "${COMMITTED_LINES:-0}" -gt 1 ]]; then
        echo "::error::verdict carries a forged line (outcome lines: ${OUTCOME_LINES:-0}, verified_head lines: ${VERIFIED_HEAD_LINES:-0}, committed lines: ${COMMITTED_LINES:-0}) — refusing the verdict as tampered."
        exit 125
      fi
      echo "outcome=${OUTCOME}" >> "${GITHUB_OUTPUT}"
      echo "verified_head=${VERIFIED_HEAD}" >> "${GITHUB_OUTPUT}"
    else
      echo "::warning::gate container exited 0 without a verdict (outcome='${OUTCOME}') — treating as a gate crash so the next scan retries."
    fi
    ;;
  10 | 11 | 12)
    # A deterministic rejection: routing comes from the exit code (see the
    # block comment above), never from the rewriteable file. 10 = retryable
    # (repair runs), 11 = pre-existing (base-update handoff, NOT retryable —
    # the repair agent may only amend this round's fix), 12 = terminal
    # evaluated rejection / failure.md handoff (watermark advances, no
    # repair). A forged `retryable=true` rewrite can no longer flip a
    # deliberately non-retryable rejection into a PAT-backed repair round,
    # nor a planted `preexisting=true` misclassify a fixable one.
    echo "outcome=failed" >> "${GITHUB_OUTPUT}"
    [[ "${GATE_RC}" == '10' ]] && echo "retryable=true" >> "${GITHUB_OUTPUT}"
    [[ "${GATE_RC}" == '11' ]] && echo "preexisting=true" >> "${GITHUB_OUTPUT}"
    ;;
  *)
    # Docker itself failed (125/126/127), the container was killed (137),
    # the gate crashed verdict-less (1 — the baseline-A/B and bite
    # tree-restore failures), or it died before reaching a verdict. Leave
    # outcome UNSET: an EVALUATED rejection advances the watermark and hands
    # the item off for good, while an empty outcome takes 'Finalize
    # verification's gate-crashed path and retries on the next scan's fresh
    # checkout. A forged `outcome=fixed` still cannot pass: `fixed` is
    # accepted only on exit 0.
    echo "::warning::gate container exited ${GATE_RC} without a deterministic verdict — reporting as a gate crash."
    ;;
esac

exit "${GATE_RC}"
