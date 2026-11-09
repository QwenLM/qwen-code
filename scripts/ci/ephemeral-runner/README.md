# Ephemeral GitHub Actions runners

Each slot registers one just-in-time runner and runs it in a new container.
After at most one job, the manager removes the container and runner registration
before creating the next one. While the manager waits on a container it also
enforces a per-slot deadline and removes a container whose runner does not exit;
a manager crash is covered by reconciling leftover resources on the next start.

Each job has a separate Docker bridge with inter-container communication
disabled. Deleting the network is part of cleanup and a failure blocks slot
replacement. This does not itself prevent access to the host or private
networks: configure and verify the host's external egress controls separately.

Use a dedicated host for untrusted pull requests. Docker shares the host kernel;
jobs must not receive the host Docker socket, host directories, cloud instance
credentials, internal network access, or long-lived secrets. A runner label is a
scheduling selector, not an access-control boundary. Before enabling external
pull requests, verify they cannot select other sensitive runner pools.

## Build the image

The image supports Linux x64 and ARM64. Its Node base is pinned to an OCI index
digest and the runner downloads are checked against pinned SHA-256 digests.
Use BuildKit to select both the base image and runner architecture:

```sh
docker buildx build --platform linux/arm64 --load -t qwen-ephemeral-runner:trial scripts/ci/ephemeral-runner
```

BuildKit supplies `TARGETARCH`. With Docker's legacy builder, build on the target
architecture and pass its matching `TARGETARCH` explicitly (`amd64` or `arm64`).
That argument selects only the runner archive; it does not change the base image
architecture.

The runner image supports ARM64, but full PR CI on this image has not yet been
verified. The repository also selects ARM64 linters; verify the complete CI
toolchain before routing production work to either architecture.

Hosts with restricted upstream connectivity can set `DEBIAN_MIRROR`,
`PIP_INDEX_URL` or `RUNNER_RELEASE_URL` at build time. The runner archive is
still verified against its pinned digest when served from a mirror.

For a real deployment, publish the image to a registry and configure its
immutable `repository@sha256:...` digest. A local `sha256:...` image ID may be
used for a trial. Runner and base versions need routine security updates.

## Configure the manager

Run one manager on each host, managing only that host's Docker socket. Give each
host a unique `poolId`; matching runner labels let GitHub share work across the
hosts without a central scheduler. `slots` is a per-host limit, not a fleet total.
Runner display names use `ecs-qwen-<poolId>-<slot>-<suffix>`, with two-digit
slots and an eight-hex-character suffix, for example
`ecs-qwen-hz4-ephemeral-01-1a2b3c4d`. The suffix is fresh for every
registration, so a leftover registration that still owns an earlier name can
never reject a replacement with HTTP 422; each job also gets a fresh GitHub
runner ID, container and internal UUID for state and diagnostics. The
`ecs-qwen-` prefix preserves existing CI worker caps and timeouts. Restart
recovery accepts the suffixed form, earlier UUID-based runner names, and the
old `qwen-` prefix.

Install Docker, Node 22, `gh`, and `flock` on the host. The manager uses a
dedicated PAT supplied as `GH_TOKEN`. The account must administer the target
repository. Prefer a fine-grained PAT restricted to that repository with
Administration: write and a short expiry. GitHub currently requires this broader
permission for runner registration; it is not a runner-only credential. Some
organization or outside-collaborator policies prevent fine-grained access. Do
not silently replace it with a classic `repo` token, which can cover other
repositories the account can access.

Store `GH_TOKEN=<PAT>` in `/etc/qwen-ephemeral-runner/credentials.env`, owned by
root with mode `600`, inside the root-only configuration directory. The supplied
systemd unit loads this file; do not put it in shell history, config JSON, job
environments or the repository. Replace it and restart the service to rotate or
renew the token. The service fails startup if `GH_TOKEN` is missing. Docker child
environments are allowlisted, and only the one-time JIT configuration enters a
job container. Host root and Docker administrators are trusted and can access
host credentials; ordinary container isolation does not change that boundary.

Copy `config.example.json` to `/etc/qwen-ephemeral-runner/config.json` and
replace the placeholders: repository, actual runner group ID, unique host/pool
ID, immutable image reference, and matching architecture and labels. Use a
label set matching the actual CI route. The current ARM64 pool registers only
`self-hosted` and `ecs-qwen-ephemeral`. Omitting generic Linux/ARM64 labels keeps
unrelated ARM64 jobs out of this pool. Validate the existing
CI jobs with these formal labels rather than a separate smoke workflow. The
example runs one slot; hz4 currently maintains ten fixed slots, and the
manager accepts up to 64 slots per host. Keep capacity conservative until real CI execution and resource use are stable. Restrict configuration and
credential directories to the manager account.

If the host requires an HTTP proxy for external access (GitHub, npm, etc.),
optionally add a `proxy` object to the config:

```json
"proxy": {
  "http": "http://proxy.example:7890",
  "https": "http://proxy.example:7890",
  "noProxy": "localhost,127.0.0.1,100.100.100.200"
}
```

Use the host's reachable address (not `127.0.0.1`) so containers can reach it.
The proxy URLs must not embed credentials (`user:pass@`): the values are
injected into every runner container, including containers that execute
untrusted fork PR jobs, so embedded credentials would be exposed. The
manager rejects such URLs at startup.
`noProxy` should include the cloud metadata endpoint (`100.100.100.200`)
to avoid leaking instance credentials through the proxy.

The `ttlSeconds` limit starts when the container starts, including idle time.
A job assigned near the deadline can be interrupted. The manager removes and
replaces the container; GitHub remains authoritative for job status. The
manager logs cleanup but does not distinguish expiry from normal completion.
A nonzero or unknown container exit status delays replenishment by 60 seconds;
a successful short job is replenished immediately. GitHub remains authoritative
for job success. Diagnostic export is best effort: stderr is not archived, and
output exceeding the capture limits is discarded.
`minDiskBytes` applies to the Docker data filesystem. Configure and verify
disk quotas or a dedicated data volume as appropriate for the host.

Failed cycles retry with jittered exponential backoff: 10 s doubling to a
60 s cap, or 30 s doubling to a 300 s cap while GitHub answers HTTP 403/429,
so a rate-limited pool stops sustaining its own rate limit. The backoff
sleep stays interruptible and a shutdown cuts it short.

`stallAlertSeconds` (default 1800, thirty minutes) sets how long a slot may
repeat the same failure before the manager logs `STALL ALERT` instead of the
ordinary retry line. The threshold is wall-clock, so it holds under any retry
cadence, and the default sits well above the 300 s backoff ceiling on purpose:
a pool-wide rate-limit storm stalls every slot at once, and a threshold shorter
than the cadence would put one alert per slot in the journal simultaneously.
The clock resets whenever a cycle succeeds or the failure changes, and each
stall episode alerts once. Because the check happens when a failure is
observed, the alert lands on the first failure at or after the threshold, so
the reported duration is the threshold rounded up to the current cadence. A
stall alert means the slot is serving no jobs and needs reconciliation; the
manager keeps retrying and never exits on its own, so systemd does not restart
it. Alert on that journal marker rather than on service state.

Upgrading: `stallAlertRetries`, the earlier retry-count threshold, is no longer
read. A config that still carries it has no effect and falls back to the
1800 s default, so set `stallAlertSeconds` explicitly if you had tuned it.

## Install and operate

Install `manager.mjs` in `/opt/qwen-ephemeral-runner/`, install the supplied
unit in `/etc/systemd/system/`, and create the configured state/log directories
with permissions restricted to the manager account. From the trusted checkout:

```sh
sudo install -d /opt/qwen-ephemeral-runner
sudo install -d -m 700 /etc/qwen-ephemeral-runner /var/lib/qwen-ephemeral-runner /var/log/qwen-ephemeral-runner
sudo install -m 644 scripts/ci/ephemeral-runner/manager.mjs /opt/qwen-ephemeral-runner/manager.mjs
sudo install -m 644 scripts/ci/ephemeral-runner/qwen-ephemeral-runner.service /etc/systemd/system/qwen-ephemeral-runner.service
```

Finish the configuration and PAT setup above before starting. A Docker-authorized user
has host-level power; the unit is intended for a trusted dedicated host.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now qwen-ephemeral-runner.service
sudo systemctl status qwen-ephemeral-runner.service
sudo journalctl -u qwen-ephemeral-runner.service -f
```

systemd restarts an unexpectedly exited manager after ten seconds, including a
clean exit. An explicit `systemctl stop` leaves it stopped. This is process
supervision, not hang detection; inspect the journal and runner availability if
slots are not replenishing.

Stopping the service stops replenishment, waits up to the configured grace
period, and cleans up its containers. The next start reconciles abandoned
resources first. A cleanup or ambiguous registration error blocks that slot;
inspect its state and GitHub runner list before manual reconciliation. Never
remove unrelated runners or run a global Docker prune.

A container or network whose slot state was lost is reconciled from its
`qwen.instance` label, so an interrupted `docker create` no longer wedges the
slot permanently. With no slot state, every leftover in the slot's namespace
is an orphan: when the labels disagree about the identity, the whole pile is
swept without a GitHub identity and the slot replenishes. Registrations are
then swept by the slot's naming scheme, but only when every leftover carried
this slot's identity prefix and GitHub reports the registration offline —
this relies on each host having a unique `poolId`, so the prefix cannot name
another host's runners. A foreign or missing identity label still blocks
registration sweeping for manual reconciliation (the foreign resource itself
is removed from the slot namespace). The label carries the instance name, not
the registration's display name, so
recovery matches registrations under both the bare display name written by
older versions and the current suffixed one; an ambiguous match still blocks
the slot rather than deleting anything. A label-recovered match (no recorded
registration name or id) is only deleted when GitHub explicitly reports it
offline; an online, status-less or unknown-status match blocks the slot
instead, because it may belong to a live runner outside this host's view. That
refusal never keeps the container: a retained container would keep its own
runner heartbeating, so an online match backed by this slot's leftover runner
could never reach offline and the refusal would sustain itself. The containers
are removed and a labelled network is kept (or created first, when the pile
had none) as the retry anchor — nothing about a label-recovered identity is
written to a state file, so that network is what brings the slot back into
cleanup on the next cycle. A permanent identity refusal (an ambiguous or
mismatched identity) reclaims the containers the same way and keeps reporting
the same error from the network anchor until a human reconciles; it never
deletes a registration. A runner deletion GitHub rejects (for example while it
still reports the runner busy) keeps either the slot state or, for a
label-recovered identity, the network anchor, and is retried, instead of
dropping the only record that can remove the registration. The identity-less
sweep deletes registrations before removing the resources for the same
reason: a rejected deletion is still retried on the next cycle while the pile
remains.

```sh
sudo systemctl stop qwen-ephemeral-runner.service
```

The existing CI routes untrusted fork PR build, Linux unit tests, lint and no-AK
integration jobs directly to the formal ARM64 disposable label set. No
repository-variable switch, configuration relay or manual smoke workflow is
needed. Trusted and same-repository PRs retain their existing routes. GitHub
queues excess jobs; the manager replaces completed runners within ten fixed
slots, without demand-based autoscaling.

Repository variables are unavailable in fork-triggered CI. Existing global
overrides still work in contexts where their values are available, but cannot
be relied on to roll back these fork jobs. To roll back, change the fork branch
of the CI selector to `pr_test_runner='["ubuntu-latest"]'` while retaining
`lint_runner="${pr_test_runner}"`, and deploy that workflow change. Cancel
already-selected work and trigger fresh CI using the updated workflow; reruns
of saved older workflows retain their old routing. Jobs do not migrate
automatically. Dedicated-host/network and runner-access-policy limitations
remain tracked in #16514.
