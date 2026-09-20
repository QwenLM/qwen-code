# Review process isolation

[English](review-process-isolation.md) | [简体中文](review-process-isolation.zh-CN.md)

## Problem

Agent-generated verification code can signal unrelated runners sharing its Unix
user. Two observed mechanisms are an empty `pkill -f` pattern and a mock child
PID of 1 reaching real process-group cleanup as `kill(-1, SIGKILL)`. Separate
working directories and systemd cgroups do not prevent these signals.

## Changes

Reject non-safe-integer PIDs and PIDs below 2 before hook process-group signalling
and liveness checks, including the detached supervisor. Surviving-hook cleanup
also rejects these values before either platform's termination path.

Wrap self-hosted review attempts in bubblewrap user and PID namespaces. Keep the
installed host toolchain read-only and the network available. Only the checkout
and job temporary directory are writable; HOME is attempt-local, with the host
Git configuration mounted read-only. Use a private procfs, device tree, /tmp and
/run; drop capabilities and remove Docker/SSH-agent environment selectors.
Bubblewrap's no_new_privs prevents setuid sudo from regaining host privileges.
QWEN_HOME must remain job-local, as configured by the workflow: namespace PIDs
must not enter a host-shared Qwen ownership database. Hosted jobs are unchanged.

## Boundaries

This protects against accidental cross-job signals, not arbitrary hostile code:
network services and credentials remain available to the review. Do not expose a
host Docker daemon over TCP or mount its socket into the writable job roots.
The runner must use the normal /var/run -> /run layout. Docker-based verification
and host service administration are intentionally unavailable. Interactive CLI
sandbox defaults, conflict resolution, and other agent workflows are unchanged.

## Deployment and risks

Draft: do not merge until Linux acceptance passes. Install bubblewrap and permit
unprivileged user/PID namespaces under the host's AppArmor policy. A read-only
preflight on one affected host currently fails with `setting up uid map:
Permission denied`; no host policy has been changed by this PR. Run preflight as
the runner user, not root. Namespace setup failures stop the review without an
unsandboxed fallback. Test proxy wrappers, gh posting, timeouts, supersede
cancellation, tool discovery and artifact collection before broad rollout.

Automatic service restart is not a fix for cross-job signalling. This PR neither
restarts running jobs nor deploys host configuration. Install the released PID
guard on the fleet; reviews use the installed CLI, not this checkout's core.

## Verification and acceptance

Unit tests mock every signal and cover invalid PIDs on parent exit and abort.
Wrapper tests check namespace/mount arguments, exit status and fail-closed behavior.
Before removing draft status, run actual adversarial probes only in disposable
Linux VMs or containers providing an OUTER PID namespace: keep a sentinel outside
the INNER review namespace, run both empty-pattern pkill and fake-PID cleanup,
and verify the sentinel survives. Never run these probes directly on a shared
runner host. Verify normal review completion, timeout cleanup and uploaded
artifacts too. Argument tests alone do not establish runtime containment.
